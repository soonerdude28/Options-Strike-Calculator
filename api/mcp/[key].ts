/**
 * POST /api/mcp/:key
 *
 * Remote MCP server (Streamable HTTP, stateless, JSON responses) that
 * exposes the owner's Schwab Trader + Market Data APIs to Claude. Add it
 * in claude.ai → Settings → Connectors → Add custom connector with URL
 * `${APP_URL}/api/mcp/<SCHWAB_MCP_KEY>`.
 *
 * Auth: claude.ai custom connectors can't send a static header, so the
 * secret rides in the path. It is a dedicated key (not OWNER_SECRET) so
 * it can be rotated without logging the browser out. Clients that can
 * send headers (Claude Code) may use `Authorization: Bearer <key>` with
 * any path key.
 *
 * Tools live in `_lib/schwab-mcp-tools.ts`.
 */

import { timingSafeEqual } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Sentry, metrics } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import { callTool, listTools } from '../_lib/schwab-mcp-tools.js';

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = {
  name: 'schwab',
  title: 'Schwab Trader & Market Data',
  version: '1.0.0',
};
const INSTRUCTIONS =
  'Schwab brokerage + market data for the account owner. Call get_account_numbers first to get the accountHash. ' +
  'For thinkScript work, use get_price_history / get_quotes / get_option_chain to check logic against real data. ' +
  'place_order, replace_order and cancel_order hit the LIVE account: always run preview_order, show the user the exact order, ' +
  'and only pass confirm: true after they explicitly approve it.';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function isAuthorized(req: VercelRequest, secret: string): boolean {
  const pathKey = req.query.key;
  if (typeof pathKey === 'string' && safeEqual(pathKey, secret)) return true;
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return safeEqual(header.slice(7), secret);
  }
  return false;
}

function rpcResult(id: JsonRpcRequest['id'], result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: JsonRpcRequest['id'], code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

async function dispatch(msg: JsonRpcRequest): Promise<object | null> {
  // Notifications (no id) get no response body.
  const isNotification = msg.id === undefined;
  switch (msg.method) {
    case 'initialize': {
      const requested = msg.params?.protocolVersion;
      const protocolVersion =
        typeof requested === 'string' && SUPPORTED_VERSIONS.includes(requested)
          ? requested
          : SUPPORTED_VERSIONS[0];
      return rpcResult(msg.id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return rpcResult(msg.id, {});
    case 'tools/list':
      return rpcResult(msg.id, { tools: listTools() });
    case 'tools/call': {
      const name = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      if (typeof name !== 'string')
        return rpcError(msg.id, -32602, 'Missing tool name');
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        return rpcError(msg.id, -32602, 'arguments must be an object');
      }
      const result = await callTool(name, args as Record<string, unknown>);
      if (!result) return rpcError(msg.id, -32602, `Unknown tool: ${name}`);
      return rpcResult(msg.id, result);
    }
    default:
      if (isNotification) return null;
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('POST /api/mcp/[key]');
    const done = metrics.request('/api/mcp');
    try {
      const secret = process.env.SCHWAB_MCP_KEY;
      if (!secret || secret.length < 32) {
        done({ status: 503 });
        return res.status(503).json({ error: 'SCHWAB_MCP_KEY not configured' });
      }
      if (!isAuthorized(req, secret)) {
        done({ status: 401 });
        return res.status(401).json({ error: 'Unauthorized' });
      }

      res.setHeader('Cache-Control', 'no-store');

      // Stateless server: no SSE stream, no sessions to delete.
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        done({ status: 405 });
        return res.status(405).json({ error: 'POST only' });
      }

      let body: unknown = req.body;
      if (typeof body === 'string') {
        try {
          body = JSON.parse(body);
        } catch {
          done({ status: 400 });
          return res.status(400).json(rpcError(null, -32700, 'Parse error'));
        }
      }

      const messages = Array.isArray(body) ? body : [body];
      const responses: object[] = [];
      for (const m of messages) {
        if (!m || typeof m !== 'object') {
          responses.push(rpcError(null, -32600, 'Invalid request'));
          continue;
        }
        const out = await dispatch(m as JsonRpcRequest);
        if (out) responses.push(out);
      }

      if (responses.length === 0) {
        done({ status: 202 });
        return res.status(202).end();
      }
      done({ status: 200 });
      return res
        .status(200)
        .json(Array.isArray(body) ? responses : responses[0]);
    } catch (err) {
      done({ status: 500, error: 'unhandled' });
      logger.error({ err }, 'MCP handler failed');
      Sentry.captureException(err);
      return res.status(500).json(rpcError(null, -32603, 'Internal error'));
    }
  });
}
