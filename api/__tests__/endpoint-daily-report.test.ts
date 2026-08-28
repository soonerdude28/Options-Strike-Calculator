// @vitest-environment node

/**
 * HTTP-level tests for GET /api/daily-report (the Periscope Daily Report
 * reader — serves rows the periscope-daily-report cron stored).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  setCacheHeaders: vi.fn(
    (res: { setHeader: (k: string, v: string) => unknown }) => {
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=60');
      res.setHeader('Vary', 'Cookie');
    },
  ),
}));

// The withDbReader wrapper imports the guard from guest-auth.js directly, so
// the guard mock must live there for the wrapper's call to be intercepted.
vi.mock('../_lib/guest-auth.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
}));

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  // sendDbErrorResponse (inside withDbReader's catch) does an
  // `instanceof TransientDbError` check — the class must exist on the
  // mocked module even though these tests only exercise the 500 path.
  TransientDbError: class TransientDbError extends Error {
    constructor(cause: unknown) {
      super(cause instanceof Error ? cause.message : String(cause));
      this.name = 'TransientDbError';
      this.cause = cause;
    }
  },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    withIsolationScope: vi.fn(
      (
        cb: (s: {
          setTransactionName: (n: string) => void;
          setTag: (k: string, v: string) => void;
        }) => unknown,
      ) => cb({ setTransactionName: vi.fn(), setTag: vi.fn() }),
    ),
    captureException: vi.fn(),
  },
  metrics: { request: vi.fn(() => vi.fn()), increment: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import handler from '../daily-report.js';
import { guardOwnerOrGuestEndpoint } from '../_lib/guest-auth.js';
import { setCacheHeaders } from '../_lib/api-helpers.js';

function makeRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    date: '2026-08-26',
    report: { date: '2026-08-26', headline: 'SPX 6467 · range 38pts' },
    created_at: '2026-08-26T22:10:12.000Z',
    ...over,
  };
}

/** Joined text of the Nth tagged-template sql call (strings array). */
function sqlText(call: number): string {
  const strings = mockSql.mock.calls[call]?.[0] as string[] | undefined;
  return (strings ?? []).join(' ');
}

describe('GET /api/daily-report', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
  });

  it('returns 405 for non-GET', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
  });

  it('returns 401 when the guard rejects', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementation(
      async (_req, res) => {
        res.status(401).json({ error: 'Owner only' });
        return true;
      },
    );
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 400 on a malformed date', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '08/26/2026' } }),
      res,
    );
    expect(res._status).toBe(400);
    expect(res._json).toEqual({ error: 'Invalid date' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 404 when no report exists', async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(404);
    expect(res._json).toEqual({ error: 'No report available' });
  });

  it('returns the row for a specific date', async () => {
    mockSql.mockResolvedValueOnce([makeRow()]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026-08-26' } }),
      res,
    );
    expect(res._status).toBe(200);
    expect(sqlText(0)).toContain('WHERE date =');
    expect(mockSql.mock.calls[0]?.[1]).toBe('2026-08-26');
    expect(res._json).toEqual({
      date: '2026-08-26',
      report: { date: '2026-08-26', headline: 'SPX 6467 · range 38pts' },
      createdAt: '2026-08-26T22:10:12.000Z',
    });
    expect(setCacheHeaders).toHaveBeenCalledWith(res, 60);
  });

  it('returns the latest row when no date is given', async () => {
    mockSql.mockResolvedValueOnce([
      makeRow({ created_at: new Date('2026-08-27T22:10:12.000Z') }),
    ]);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(200);
    expect(sqlText(0)).toContain('ORDER BY date DESC');
    expect(sqlText(0)).toContain('LIMIT 1');
    // Date-object created_at (driver variance) still serializes to ISO.
    expect(res._json).toMatchObject({
      createdAt: '2026-08-27T22:10:12.000Z',
    });
  });

  it('returns 500 on a DB error', async () => {
    mockSql.mockRejectedValueOnce(new Error('connection lost'));
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(500);
  });
});
