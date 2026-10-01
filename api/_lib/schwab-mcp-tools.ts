/**
 * Schwab Trader + Market Data tools for the MCP connector (`/api/mcp/[key]`).
 *
 * Calls api.schwabapi.com directly with the owner's OAuth token from
 * `getAccessToken()` — deliberately NOT through `schwabFetch`, whose
 * market-data paths are served by the UW/Theta facade. A connector that
 * claims to be "Schwab" should return Schwab's own data.
 *
 * Order tools (place/replace/cancel) are real-money writes:
 *   - gated by `SCHWAB_MCP_TRADING_ENABLED=true` (kill switch, default off)
 *   - require `confirm: true` in the arguments
 *   - annotated `destructiveHint` so the client asks the user first
 *   - never retried — a timeout on POST could otherwise double-submit
 */

import { getAccessToken } from './schwab.js';
import { TIMEOUTS } from './constants.js';
import logger from './logger.js';

const TRADER_BASE = 'https://api.schwabapi.com/trader/v1';
const MARKET_BASE = 'https://api.schwabapi.com/marketdata/v1';

type JsonSchema = Record<string, unknown>;
type Args = Record<string, unknown>;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
  };
}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

interface ToolDef extends McpTool {
  run: (args: Args) => Promise<ToolResult>;
}

// ============================================================
// HTTP
// ============================================================

async function schwabRequest(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
): Promise<ToolResult> {
  const auth = await getAccessToken();
  if ('error' in auth) {
    return errorResult(
      `Schwab not connected: ${auth.error.message} ` +
        'Open https://options-strike-calculator-hazel.vercel.app/api/auth/init to log in again.',
    );
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${auth.token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUTS.SCHWAB_API),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(
      method === 'GET'
        ? `Schwab network error: ${msg}`
        : `Schwab network error during ${method}: ${msg}. The request may or may not have reached Schwab — check get_orders before retrying.`,
    );
  }

  const text = await res.text();
  if (!res.ok) {
    return errorResult(
      `Schwab API error ${res.status}: ${text || res.statusText}`,
    );
  }

  // Order create/replace return 201 with an empty body and the new order
  // URL in Location; surface the id so Claude can follow up.
  const location = res.headers.get('location');
  if (!text) {
    const orderId = location?.split('/').pop();
    return textResult(
      JSON.stringify(
        { status: res.status, ...(orderId ? { orderId, location } : {}) },
        null,
        2,
      ),
    );
  }
  return textResult(text);
}

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

// ============================================================
// ARG HELPERS
// ============================================================

class ArgError extends Error {}

function str(args: Args, key: string, required = false): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw new ArgError(`Missing required argument: ${key}`);
    return undefined;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v !== 'string') throw new ArgError(`${key} must be a string`);
  return v;
}

function query(args: Args, keys: string[]): string {
  const params = new URLSearchParams();
  for (const k of keys) {
    const v = str(args, k);
    if (v !== undefined) params.set(k, v);
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

function seg(args: Args, key: string): string {
  return encodeURIComponent(str(args, key, true)!);
}

function orderBody(args: Args): unknown {
  const order = args.order;
  if (!order || typeof order !== 'object' || Array.isArray(order)) {
    throw new ArgError('order must be a Schwab order JSON object');
  }
  return order;
}

function tradingGate(args: Args, action: string): ToolResult | null {
  if (process.env.SCHWAB_MCP_TRADING_ENABLED !== 'true') {
    return errorResult(
      `Order tools are disabled. Set SCHWAB_MCP_TRADING_ENABLED=true in Vercel to allow ${action}.`,
    );
  }
  if (args.confirm !== true) {
    return errorResult(
      `Refusing to ${action} without confirm: true. Show the user the exact order and get explicit approval first.`,
    );
  }
  return null;
}

// ============================================================
// SCHEMAS
// ============================================================

const S = {
  string: (description: string): JsonSchema => ({
    type: 'string',
    description,
  }),
  int: (description: string): JsonSchema => ({ type: 'integer', description }),
  bool: (description: string): JsonSchema => ({ type: 'boolean', description }),
  enum: (values: string[], description: string): JsonSchema => ({
    type: 'string',
    enum: values,
    description,
  }),
};

function obj(properties: Record<string, JsonSchema>, required: string[] = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

const ACCOUNT_HASH = S.string(
  'Encrypted account hash from get_account_numbers (NOT the plain account number).',
);
const ORDER_ID = S.string('Schwab order id.');
const CONFIRM = {
  type: 'boolean',
  const: true,
  description:
    'Must be true. Only set after the user explicitly approved this exact order in chat.',
};
const ORDER = {
  type: 'object',
  description:
    'Schwab order JSON, e.g. {"orderType":"LIMIT","session":"NORMAL","duration":"DAY","price":"1.25","orderStrategyType":"SINGLE","orderLegCollection":[{"instruction":"BUY_TO_OPEN","quantity":1,"instrument":{"symbol":"SPXW  261002C05800000","assetType":"OPTION"}}]}',
};

function read(
  name: string,
  title: string,
  description: string,
  inputSchema: JsonSchema,
  run: (args: Args) => Promise<ToolResult>,
): ToolDef {
  return {
    name,
    description,
    inputSchema,
    annotations: {
      title,
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    run,
  };
}

function write(
  name: string,
  title: string,
  description: string,
  inputSchema: JsonSchema,
  run: (args: Args) => Promise<ToolResult>,
): ToolDef {
  return {
    name,
    description,
    inputSchema,
    annotations: {
      title,
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    run,
  };
}

// ============================================================
// TOOLS
// ============================================================

const TOOLS: ToolDef[] = [
  // ---------------- Market Data ----------------
  read(
    'get_quotes',
    'Get quotes',
    'Real-time Schwab quotes for one or more symbols (equities, ETFs, indexes like $SPX, options like "SPXW  261002C05800000", futures like /ES).',
    obj(
      {
        symbols: S.string('Comma-separated symbols, e.g. "$SPX,SPY,/ES".'),
        fields: S.string(
          'Optional: quote,fundamental,extended,reference,regular. Default all.',
        ),
        indicative: S.bool('Include indicative ETF quotes.'),
      },
      ['symbols'],
    ),
    (a) => {
      str(a, 'symbols', true);
      return schwabRequest(
        'GET',
        `${MARKET_BASE}/quotes${query(a, ['symbols', 'fields', 'indicative'])}`,
      );
    },
  ),
  read(
    'get_option_chain',
    'Get option chain',
    'Schwab option chain with greeks, IV, OI and volume. Keep it small with strikeCount and a date range — full SPX chains are huge.',
    obj(
      {
        symbol: S.string('Underlying, e.g. "$SPX", "SPY", "AAPL".'),
        contractType: S.enum(['CALL', 'PUT', 'ALL'], 'Default ALL.'),
        strikeCount: S.int('Strikes above and below ATM. Recommended 10-40.'),
        fromDate: S.string('Expirations from, yyyy-MM-dd.'),
        toDate: S.string('Expirations to, yyyy-MM-dd.'),
        includeUnderlyingQuote: S.bool('Include underlying quote.'),
        strategy: S.enum(
          [
            'SINGLE',
            'ANALYTICAL',
            'COVERED',
            'VERTICAL',
            'CALENDAR',
            'STRANGLE',
            'STRADDLE',
            'BUTTERFLY',
            'CONDOR',
            'DIAGONAL',
            'COLLAR',
            'ROLL',
          ],
          'Default SINGLE.',
        ),
        interval: S.string('Strike interval for spread strategies.'),
        strike: S.string('A single strike price.'),
        range: S.enum(['ITM', 'NTM', 'OTM', 'ALL'], 'Moneyness filter.'),
        expMonth: S.string('JAN..DEC or ALL.'),
        optionType: S.string('S (standard), NS (non-standard), ALL.'),
      },
      ['symbol'],
    ),
    (a) => {
      str(a, 'symbol', true);
      return schwabRequest(
        'GET',
        `${MARKET_BASE}/chains${query(a, ['symbol', 'contractType', 'strikeCount', 'fromDate', 'toDate', 'includeUnderlyingQuote', 'strategy', 'interval', 'strike', 'range', 'expMonth', 'optionType'])}`,
      );
    },
  ),
  read(
    'get_option_expirations',
    'Get option expirations',
    'List all option expiration dates for an underlying.',
    obj({ symbol: S.string('Underlying, e.g. "$SPX".') }, ['symbol']),
    (a) => {
      str(a, 'symbol', true);
      return schwabRequest(
        'GET',
        `${MARKET_BASE}/expirationchain${query(a, ['symbol'])}`,
      );
    },
  ),
  read(
    'get_price_history',
    'Get price history',
    'OHLCV candles from Schwab. Use this to sanity-check thinkScript logic against real bars. Dates are epoch milliseconds.',
    obj(
      {
        symbol: S.string('Symbol, e.g. "$SPX", "SPY", "/ES".'),
        periodType: S.enum(['day', 'month', 'year', 'ytd'], 'Period unit.'),
        period: S.int('Number of periodType units.'),
        frequencyType: S.enum(
          ['minute', 'daily', 'weekly', 'monthly'],
          'Bar unit.',
        ),
        frequency: S.int('Bar size: minute → 1,5,10,15,30; otherwise 1.'),
        startDate: S.int('Start, epoch ms.'),
        endDate: S.int('End, epoch ms.'),
        needExtendedHoursData: S.bool('Include extended hours.'),
        needPreviousClose: S.bool('Include previous close.'),
      },
      ['symbol'],
    ),
    (a) => {
      str(a, 'symbol', true);
      return schwabRequest(
        'GET',
        `${MARKET_BASE}/pricehistory${query(a, ['symbol', 'periodType', 'period', 'frequencyType', 'frequency', 'startDate', 'endDate', 'needExtendedHoursData', 'needPreviousClose'])}`,
      );
    },
  ),
  read(
    'get_movers',
    'Get movers',
    'Top movers for an index.',
    obj(
      {
        index: S.enum(
          [
            '$DJI',
            '$COMPX',
            '$SPX',
            'NYSE',
            'NASDAQ',
            'OTCBB',
            'INDEX_ALL',
            'EQUITY_ALL',
            'OPTION_ALL',
            'OPTION_PUT',
            'OPTION_CALL',
          ],
          'Index.',
        ),
        sort: S.enum(
          ['VOLUME', 'TRADES', 'PERCENT_CHANGE_UP', 'PERCENT_CHANGE_DOWN'],
          'Sort.',
        ),
        frequency: S.int('0,1,5,10,30,60 — minimum % change.'),
      },
      ['index'],
    ),
    (a) =>
      schwabRequest(
        'GET',
        `${MARKET_BASE}/movers/${seg(a, 'index')}${query(a, ['sort', 'frequency'])}`,
      ),
  ),
  read(
    'get_market_hours',
    'Get market hours',
    'Market session hours for a date.',
    obj(
      {
        markets: S.string('Comma-separated: equity,option,bond,future,forex.'),
        date: S.string('yyyy-MM-dd. Default today.'),
      },
      ['markets'],
    ),
    (a) => {
      str(a, 'markets', true);
      return schwabRequest(
        'GET',
        `${MARKET_BASE}/markets${query(a, ['markets', 'date'])}`,
      );
    },
  ),
  read(
    'search_instruments',
    'Search instruments',
    'Look up instruments by symbol, regex, description or CUSIP.',
    obj(
      {
        symbol: S.string('Search text.'),
        projection: S.enum(
          [
            'symbol-search',
            'symbol-regex',
            'desc-search',
            'desc-regex',
            'search',
            'fundamental',
          ],
          'Search type.',
        ),
      },
      ['symbol', 'projection'],
    ),
    (a) => {
      str(a, 'symbol', true);
      str(a, 'projection', true);
      return schwabRequest(
        'GET',
        `${MARKET_BASE}/instruments${query(a, ['symbol', 'projection'])}`,
      );
    },
  ),

  // ---------------- Trader: read ----------------
  read(
    'get_account_numbers',
    'Get account numbers',
    'List accounts with their encrypted hash. Call this first — every other account tool needs the hash.',
    obj({}),
    () => schwabRequest('GET', `${TRADER_BASE}/accounts/accountNumbers`),
  ),
  read(
    'get_accounts',
    'Get accounts',
    'Balances for all linked accounts, optionally with positions.',
    obj({
      fields: S.enum(['positions'], 'Set to "positions" to include positions.'),
    }),
    (a) =>
      schwabRequest('GET', `${TRADER_BASE}/accounts${query(a, ['fields'])}`),
  ),
  read(
    'get_account',
    'Get account',
    'Balances (and optionally positions) for one account.',
    obj(
      {
        accountHash: ACCOUNT_HASH,
        fields: S.enum(
          ['positions'],
          'Set to "positions" to include positions.',
        ),
      },
      ['accountHash'],
    ),
    (a) =>
      schwabRequest(
        'GET',
        `${TRADER_BASE}/accounts/${seg(a, 'accountHash')}${query(a, ['fields'])}`,
      ),
  ),
  read(
    'get_orders',
    'Get orders',
    'Orders in a time window (max 60 days back). Omit accountHash for all accounts. Times are ISO-8601, e.g. 2026-09-30T00:00:00.000Z.',
    obj(
      {
        accountHash: ACCOUNT_HASH,
        fromEnteredTime: S.string('ISO-8601 start.'),
        toEnteredTime: S.string('ISO-8601 end.'),
        status: S.string(
          'Optional status filter, e.g. WORKING, FILLED, CANCELED.',
        ),
        maxResults: S.int('Default 3000.'),
      },
      ['fromEnteredTime', 'toEnteredTime'],
    ),
    (a) => {
      str(a, 'fromEnteredTime', true);
      str(a, 'toEnteredTime', true);
      const q = query(a, [
        'fromEnteredTime',
        'toEnteredTime',
        'status',
        'maxResults',
      ]);
      const hash = str(a, 'accountHash');
      return schwabRequest(
        'GET',
        hash
          ? `${TRADER_BASE}/accounts/${encodeURIComponent(hash)}/orders${q}`
          : `${TRADER_BASE}/orders${q}`,
      );
    },
  ),
  read(
    'get_order',
    'Get order',
    'One order by id.',
    obj({ accountHash: ACCOUNT_HASH, orderId: ORDER_ID }, [
      'accountHash',
      'orderId',
    ]),
    (a) =>
      schwabRequest(
        'GET',
        `${TRADER_BASE}/accounts/${seg(a, 'accountHash')}/orders/${seg(a, 'orderId')}`,
      ),
  ),
  read(
    'get_transactions',
    'Get transactions',
    'Account transactions (fills, dividends, transfers). Times are ISO-8601.',
    obj(
      {
        accountHash: ACCOUNT_HASH,
        startDate: S.string('ISO-8601 start.'),
        endDate: S.string('ISO-8601 end.'),
        types: S.string(
          'e.g. TRADE, RECEIVE_AND_DELIVER, DIVIDEND_OR_INTEREST.',
        ),
        symbol: S.string('Optional symbol filter.'),
      },
      ['accountHash', 'startDate', 'endDate', 'types'],
    ),
    (a) => {
      str(a, 'startDate', true);
      str(a, 'endDate', true);
      str(a, 'types', true);
      return schwabRequest(
        'GET',
        `${TRADER_BASE}/accounts/${seg(a, 'accountHash')}/transactions${query(a, ['startDate', 'endDate', 'types', 'symbol'])}`,
      );
    },
  ),
  read(
    'get_user_preferences',
    'Get user preferences',
    'Schwab user preferences and streamer info.',
    obj({}),
    () => schwabRequest('GET', `${TRADER_BASE}/userPreference`),
  ),
  read(
    'preview_order',
    'Preview order',
    'Ask Schwab to validate an order and estimate commissions/buying-power impact WITHOUT placing it. Always run this before place_order.',
    obj({ accountHash: ACCOUNT_HASH, order: ORDER }, ['accountHash', 'order']),
    (a) =>
      schwabRequest(
        'POST',
        `${TRADER_BASE}/accounts/${seg(a, 'accountHash')}/previewOrder`,
        orderBody(a),
      ),
  ),

  // ---------------- Trader: write (real money) ----------------
  write(
    'place_order',
    'Place order (LIVE)',
    "Places a REAL order in the user's Schwab account. Only call after preview_order and after the user explicitly approves the exact order in chat. Requires confirm: true.",
    obj({ accountHash: ACCOUNT_HASH, order: ORDER, confirm: CONFIRM }, [
      'accountHash',
      'order',
      'confirm',
    ]),
    async (a) => {
      const gate = tradingGate(a, 'place an order');
      if (gate) return gate;
      const url = `${TRADER_BASE}/accounts/${seg(a, 'accountHash')}/orders`;
      const body = orderBody(a);
      logger.warn(
        { tool: 'place_order', order: body },
        'MCP: placing live Schwab order',
      );
      return schwabRequest('POST', url, body);
    },
  ),
  write(
    'replace_order',
    'Replace order (LIVE)',
    'Cancels and replaces a working order with a new one. Requires confirm: true after explicit user approval.',
    obj(
      {
        accountHash: ACCOUNT_HASH,
        orderId: ORDER_ID,
        order: ORDER,
        confirm: CONFIRM,
      },
      ['accountHash', 'orderId', 'order', 'confirm'],
    ),
    async (a) => {
      const gate = tradingGate(a, 'replace an order');
      if (gate) return gate;
      const url = `${TRADER_BASE}/accounts/${seg(a, 'accountHash')}/orders/${seg(a, 'orderId')}`;
      const body = orderBody(a);
      logger.warn(
        { tool: 'replace_order', orderId: a.orderId, order: body },
        'MCP: replacing live Schwab order',
      );
      return schwabRequest('PUT', url, body);
    },
  ),
  write(
    'cancel_order',
    'Cancel order (LIVE)',
    'Cancels a working order. Requires confirm: true after explicit user approval.',
    obj({ accountHash: ACCOUNT_HASH, orderId: ORDER_ID, confirm: CONFIRM }, [
      'accountHash',
      'orderId',
      'confirm',
    ]),
    async (a) => {
      const gate = tradingGate(a, 'cancel an order');
      if (gate) return gate;
      const url = `${TRADER_BASE}/accounts/${seg(a, 'accountHash')}/orders/${seg(a, 'orderId')}`;
      logger.warn(
        { tool: 'cancel_order', orderId: a.orderId },
        'MCP: cancelling live Schwab order',
      );
      return schwabRequest('DELETE', url);
    },
  ),
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function listTools(): McpTool[] {
  return TOOLS.map(({ name, description, inputSchema, annotations }) => ({
    name,
    description,
    inputSchema,
    annotations,
  }));
}

export async function callTool(
  name: string,
  args: Args,
): Promise<ToolResult | null> {
  const tool = BY_NAME.get(name);
  if (!tool) return null;
  try {
    return await tool.run(args);
  } catch (err) {
    if (err instanceof ArgError) return errorResult(err.message);
    throw err;
  }
}
