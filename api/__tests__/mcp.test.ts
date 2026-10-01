// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/schwab.js', () => ({
  getAccessToken: vi.fn(async () => ({ token: 'tok' })),
}));

import handler from '../mcp/[key].js';
import { getAccessToken } from '../_lib/schwab.js';

const KEY = 'k'.repeat(40);
const ORIGINAL_ENV = { ...process.env };
const fetchMock = vi.fn();

function rpc(body: unknown, key = KEY) {
  return mockRequest({ method: 'POST', query: { key }, body } as never);
}

async function call(name: string, args: Record<string, unknown>) {
  const res = mockResponse();
  await handler(
    rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
    res,
  );
  return res._json as {
    result: { content: { text: string }[]; isError?: boolean };
  };
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, SCHWAB_MCP_KEY: KEY };
  delete process.env.SCHWAB_MCP_TRADING_ENABLED;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response('{"ok":1}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

describe('/api/mcp/[key] auth', () => {
  it('503s when SCHWAB_MCP_KEY is unset', async () => {
    delete process.env.SCHWAB_MCP_KEY;
    const res = mockResponse();
    await handler(rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }), res);
    expect(res._status).toBe(503);
  });

  it('401s on a wrong path key', async () => {
    const res = mockResponse();
    await handler(rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, 'wrong'), res);
    expect(res._status).toBe(401);
  });

  it('accepts a bearer header', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'POST',
        query: { key: 'x' },
        headers: { authorization: `Bearer ${KEY}` },
        body: { jsonrpc: '2.0', id: 1, method: 'ping' },
      } as never),
      res,
    );
    expect(res._status).toBe(200);
  });
});

describe('/api/mcp/[key] protocol', () => {
  it('initializes with the requested supported version', async () => {
    const res = mockResponse();
    await handler(
      rpc({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26' },
      }),
      res,
    );
    const json = res._json as {
      result: { protocolVersion: string; capabilities: object };
    };
    expect(json.result.protocolVersion).toBe('2025-03-26');
    expect(json.result.capabilities).toHaveProperty('tools');
  });

  it('returns 202 for notifications', async () => {
    const res = mockResponse();
    await handler(
      rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      res,
    );
    expect(res._status).toBe(202);
  });

  it('lists tools with order tools marked destructive', async () => {
    const res = mockResponse();
    await handler(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), res);
    const tools = (
      res._json as {
        result: {
          tools: { name: string; annotations: { destructiveHint: boolean } }[];
        };
      }
    ).result.tools;
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.get_quotes!.annotations.destructiveHint).toBe(false);
    expect(byName.place_order!.annotations.destructiveHint).toBe(true);
    expect(byName.cancel_order!.annotations.destructiveHint).toBe(true);
  });

  it('errors on unknown tools', async () => {
    const res = mockResponse();
    await handler(
      rpc({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'nope' },
      }),
      res,
    );
    expect((res._json as { error: { code: number } }).error.code).toBe(-32602);
  });
});

describe('/api/mcp/[key] tools', () => {
  it('get_quotes hits Schwab market data directly', async () => {
    const out = await call('get_quotes', { symbols: '$SPX,SPY' });
    expect(out.result.isError).toBeUndefined();
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://api.schwabapi.com/marketdata/v1/quotes?symbols=%24SPX%2CSPY',
    );
  });

  it('reports a missing required argument', async () => {
    const out = await call('get_quotes', {});
    expect(out.result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('url-encodes the account hash', async () => {
    await call('get_account', { accountHash: 'a/b', fields: 'positions' });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://api.schwabapi.com/trader/v1/accounts/a%2Fb?fields=positions',
    );
  });

  it('tells the user to re-login when Schwab tokens are gone', async () => {
    vi.mocked(getAccessToken).mockResolvedValueOnce({
      error: { type: 'expired_refresh', message: 'Refresh token expired.' },
    } as never);
    const out = await call('get_quotes', { symbols: 'SPY' });
    expect(out.result.isError).toBe(true);
    expect(out.result.content[0]!.text).toContain('/api/auth/init');
  });
});

describe('/api/mcp/[key] order safety', () => {
  const order = { orderType: 'MARKET', orderLegCollection: [] };

  it('refuses orders while the kill switch is off', async () => {
    const out = await call('place_order', {
      accountHash: 'h',
      order,
      confirm: true,
    });
    expect(out.result.isError).toBe(true);
    expect(out.result.content[0]!.text).toContain('SCHWAB_MCP_TRADING_ENABLED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses orders without confirm: true', async () => {
    process.env.SCHWAB_MCP_TRADING_ENABLED = 'true';
    const out = await call('place_order', {
      accountHash: 'h',
      order,
      confirm: 'yes',
    });
    expect(out.result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('places once, returns the order id, and never retries', async () => {
    process.env.SCHWAB_MCP_TRADING_ENABLED = 'true';
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 201,
        headers: {
          location:
            'https://api.schwabapi.com/trader/v1/accounts/h/orders/12345',
        },
      }),
    );
    const out = await call('place_order', {
      accountHash: 'h',
      order,
      confirm: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual(order);
    expect(JSON.parse(out.result.content[0]!.text).orderId).toBe('12345');
  });

  it('does not retry an order on network failure', async () => {
    process.env.SCHWAB_MCP_TRADING_ENABLED = 'true';
    fetchMock.mockRejectedValueOnce(new Error('timeout'));
    const out = await call('place_order', {
      accountHash: 'h',
      order,
      confirm: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.result.isError).toBe(true);
    expect(out.result.content[0]!.text).toContain('check get_orders');
  });

  it('preview_order works without the kill switch', async () => {
    const out = await call('preview_order', { accountHash: 'h', order });
    expect(out.result.isError).toBeUndefined();
    expect(fetchMock.mock.calls[0]![0]).toContain('/accounts/h/previewOrder');
  });
});
