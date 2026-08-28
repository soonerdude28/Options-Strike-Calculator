/**
 * End-of-day report assembly for the Periscope Daily Report
 * (docs/superpowers/specs/periscope-daily-report-2026-08-27.md).
 *
 * `buildDailyReport` aggregates everything the day already wrote to Neon —
 * session candles + cone, the latest auto playbook, dealer positioning, flow
 * closes, the option tape, and the signal scoreboards — into one JSON blob
 * the 22:10 UTC cron stores in `daily_reports` and pushes to the owner's
 * phone. Assembling at close matters for more than convenience:
 * ws_option_trades is pruned at T+2, so the tape section is unrecoverable
 * unless it is materialized on the day it happened.
 *
 * Failure model: every section fetcher fails SOFT. A broken table (or a
 * transient Neon blip on one query) nulls that section and appends
 * `'<section>: <message>'` to `dataQuality.notes` — it never sinks the
 * report. The dataQuality row counts fail soft to 0 the same way, so the
 * report always materializes and the footer tells you what is missing.
 *
 * All NUMERIC/BIGINT coercion happens IN SQL (`::float8`, `count(*)::int`,
 * `::text`) — the Neon driver returns those types as JS strings otherwise,
 * which has caused four production bugs here (see CLAUDE.md). The `num`/
 * `str` helpers below are a defensive second boundary, not the primary one.
 */

import type { getDb } from './db.js';
import { gexCtDayFilter } from './gex-strike-day.js';
import { ctSessionBounds } from '../../src/components/LotteryFinder/ct-window.js';

type Sql = ReturnType<typeof getDb>;

/** Whale print threshold: premium (price * size * 100) at or above this. */
const WHALE_PREMIUM_USD = 500_000;

/** Lottery/silent-boom win line: peak ceiling ≥ 20% over entry. */
const WIN_PEAK_CEILING_PCT = 20;

/** Narrative is push/panel copy, not an essay — hard cap in SQL. */
const NARRATIVE_MAX_CHARS = 600;

/**
 * to_char pattern producing strict ISO-8601 UTC ('2026-08-27T20:50:00Z').
 * A bare `::text` on TIMESTAMPTZ yields Postgres' '2026-08-27 20:50:00+00'
 * form, whose `new Date()` parsing is implementation-defined — every
 * timestamp string in the report JSON goes through this instead. Always
 * pair it with `<col> AT TIME ZONE 'UTC'` so the trailing literal Z is
 * true.
 */
const ISO_UTC_FMT = 'YYYY-MM-DD"T"HH24:MI:SS"Z"';

/** flow_data sources whose day-close (last cumulative row) we report. */
const FLOW_CLOSE_SOURCES = [
  'market_tide',
  'spx_flow',
  'spy_flow',
  'qqq_flow',
  'zero_dte_index',
];

/** flow_data ETF-tide sources reported as latest−earliest delta of ncp+npp. */
const ETF_TIDE_SOURCES = ['spy_etf_tide', 'qqq_etf_tide'];

/**
 * The stored/served daily report shape. Field names are the contract with
 * the cron (api/cron/periscope-daily-report.ts), the GET endpoint
 * (api/daily-report.ts), and the frontend panel — do not rename casually.
 * Every section is nullable: null means "could not be built" (see the
 * failure model above), and `dataQuality.notes` says why.
 */
export interface DailyReport {
  /** ET trading date, YYYY-MM-DD. */
  date: string;
  /** ISO instant this report was assembled. */
  generatedAt: string;
  /** One-line compact summary used as the push notification body. */
  headline: string;
  session: {
    open: number;
    high: number;
    low: number;
    close: number;
    rangePts: number;
    /** High-low range as a percent of the close (e.g. 0.6). */
    rangePct: number;
    candleCount: number;
    cone: { lower: number; upper: number; closedInside: boolean } | null;
    coneBreaches: {
      direction: 'upper' | 'lower';
      breachTime: string;
      ptsPastBound: number;
    }[];
  } | null;
  playbook: {
    mode: string;
    slotCapturedAt: string | null;
    bias: string | null;
    regime: string | null;
    confidence: string | null;
    gammaFloor: number | null;
    gammaCeiling: number | null;
    magnet: number | null;
    charmZero: number | null;
    recommended: string[];
    avoid: string[];
    narrative: string | null;
    slotsComplete: number;
    slotsFailed: number;
  } | null;
  positioning: {
    /** spot_exposures last-row greeks in $M (value / 1e6). */
    netGammaMM: number | null;
    netCharmMM: number | null;
    netVannaMM: number | null;
    spotAtLast: number | null;
    zeroGamma: { level: number | null; spot: number; ts: string } | null;
    /** Top 5 gex_strike_0dte strikes by |net gamma| at the day's last tick. */
    topStrikes: { strike: number; netGammaMM: number }[];
  } | null;
  flow: {
    marketTide: { ncp: number; npp: number } | null;
    /** Day-close net flow (ncp − npp) per index source. */
    netFlowClose: {
      spx: number | null;
      spy: number | null;
      qqq: number | null;
    };
    /** latest − earliest of (ncp + npp) per ETF tide source. */
    etfTideDelta: { spy: number | null; qqq: number | null };
    zeroDteNet: number | null;
    tape: {
      whaleCount: number;
      whalePremium: number;
      sweepCount: number;
      topPrints: {
        ticker: string;
        optionType: string;
        strike: number;
        expiry: string;
        premium: number;
        side: string;
      }[];
    } | null;
  } | null;
  signals: {
    lottery: {
      fires: number;
      enriched: number;
      wins: number;
      losses: number;
      /** True while enrichment lags fires (runs until ~23:55 UTC). */
      partial: boolean;
    };
    periscopeLottery: { fires: number; locked: number; wins: number };
    gammaSetups: { fires: number; resolved: number; wins: number };
    silentBoom: { alerts: number; enriched: number; wins: number };
  } | null;
  dataQuality: {
    spxCandles: number;
    gexTicks: number;
    flowRows: number;
    wsTrades: number;
    playbookSlots: { complete: number; failed: number };
    notes: string[];
  };
}

// ── Coercion helpers (defensive boundary; SQL casts are the primary one) ──

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function int(v: unknown): number {
  return Math.trunc(num(v) ?? 0);
}

function str(v: unknown): string | null {
  return v == null ? null : String(v);
}

function strArray(v: unknown): string[] {
  let parsed: unknown = v;
  if (typeof v === 'string') {
    try {
      parsed = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((x): x is string => typeof x === 'string');
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Section fetchers ──────────────────────────────────────────────────────

async function fetchSession(
  sql: Sql,
  date: string,
  notes: string[],
): Promise<DailyReport['session']> {
  // One aggregate pass over the RTH candles: first open / last close via
  // ordered array_agg, close anchored to the Schwab-verified SPX price
  // when present (the raw feed's closing bar can drift from cash).
  const rows = await sql`
    SELECT
      count(*)::int AS candle_count,
      min(low)::float8 AS session_low,
      max(high)::float8 AS session_high,
      (array_agg(open ORDER BY timestamp ASC))[1]::float8 AS session_open,
      (array_agg(COALESCE(spx_schwab_price, close) ORDER BY timestamp DESC))[1]::float8
        AS session_close
    FROM index_candles_1m
    WHERE symbol = 'SPX' AND date = ${date} AND market_time = 'r'
  `;
  const agg = rows[0];
  const candleCount = int(agg?.candle_count);
  const open = num(agg?.session_open);
  const high = num(agg?.session_high);
  const low = num(agg?.session_low);
  const close = num(agg?.session_close);
  if (candleCount === 0 || open == null || high == null || low == null) {
    return null;
  }
  if (close == null) return null;

  // Cone fails independently: candles without a cone is still a session.
  let cone: NonNullable<DailyReport['session']>['cone'] = null;
  let coneBreaches: NonNullable<DailyReport['session']>['coneBreaches'] = [];
  try {
    const coneRows = await sql`
      SELECT cone_lower::float8 AS cone_lower, cone_upper::float8 AS cone_upper
      FROM cone_levels
      WHERE date = ${date}
    `;
    const c = coneRows[0];
    const lower = num(c?.cone_lower);
    const upper = num(c?.cone_upper);
    if (lower != null && upper != null) {
      cone = { lower, upper, closedInside: close >= lower && close <= upper };
    }
    const breachRows = await sql`
      SELECT direction,
             to_char(breach_time AT TIME ZONE 'UTC', ${ISO_UTC_FMT})
               AS breach_time,
             pts_past_bound::float8 AS pts_past_bound
      FROM cone_breach_events
      WHERE date = ${date}
      ORDER BY breach_time ASC
    `;
    coneBreaches = breachRows.map((r) => ({
      direction: r.direction === 'lower' ? ('lower' as const) : 'upper',
      breachTime: str(r.breach_time) ?? '',
      ptsPastBound: num(r.pts_past_bound) ?? 0,
    }));
  } catch (err) {
    notes.push(`cone: ${errMessage(err)}`);
  }

  const rangePts = high - low;
  return {
    open,
    high,
    low,
    close,
    rangePts,
    rangePct: close !== 0 ? (rangePts / close) * 100 : 0,
    candleCount,
    cone,
    coneBreaches,
  };
}

async function fetchPlaybook(
  sql: Sql,
  date: string,
): Promise<{
  section: DailyReport['playbook'];
  slots: { complete: number; failed: number };
}> {
  // The post-close auto read IS the debrief — latest complete auto slot wins.
  const rows = await sql`
    SELECT mode,
           to_char(slot_captured_at AT TIME ZONE 'UTC', ${ISO_UTC_FMT})
             AS slot_captured_at,
           bias, regime_tag,
           confidence,
           (key_levels->>'gamma_floor')::float8 AS gamma_floor,
           (key_levels->>'gamma_ceiling')::float8 AS gamma_ceiling,
           (key_levels->>'magnet')::float8 AS magnet,
           (key_levels->>'charm_zero')::float8 AS charm_zero,
           trade_types_recommended, trade_types_avoided,
           LEFT(panel_payload->>'narrative', ${NARRATIVE_MAX_CHARS}) AS narrative
    FROM periscope_analyses
    WHERE trading_date = ${date}
      AND auto_generated = TRUE
      AND status = 'complete'
    ORDER BY slot_captured_at DESC
    LIMIT 1
  `;
  const countRows = await sql`
    SELECT
      (count(*) FILTER (WHERE status = 'complete'))::int AS complete,
      (count(*) FILTER (WHERE status IN ('failed', 'truncated')))::int AS failed
    FROM periscope_analyses
    WHERE trading_date = ${date} AND auto_generated = TRUE
  `;
  const slots = {
    complete: int(countRows[0]?.complete),
    failed: int(countRows[0]?.failed),
  };

  const row = rows[0];
  if (!row) return { section: null, slots };
  return {
    section: {
      mode: str(row.mode) ?? 'unknown',
      slotCapturedAt: str(row.slot_captured_at),
      bias: str(row.bias),
      regime: str(row.regime_tag),
      confidence: str(row.confidence),
      gammaFloor: num(row.gamma_floor),
      gammaCeiling: num(row.gamma_ceiling),
      magnet: num(row.magnet),
      charmZero: num(row.charm_zero),
      recommended: strArray(row.trade_types_recommended),
      avoid: strArray(row.trade_types_avoided),
      narrative: str(row.narrative),
      slotsComplete: slots.complete,
      slotsFailed: slots.failed,
    },
    slots,
  };
}

async function fetchPositioning(
  sql: Sql,
  date: string,
): Promise<DailyReport['positioning']> {
  const bounds = ctSessionBounds(date);
  const [spotRows, zgRows, strikeRows] = await Promise.all([
    sql`
      SELECT (gamma_oi / 1e6)::float8 AS net_gamma_mm,
             (charm_oi / 1e6)::float8 AS net_charm_mm,
             (vanna_oi / 1e6)::float8 AS net_vanna_mm,
             price::float8 AS price
      FROM spot_exposures
      WHERE date = ${date} AND ticker = 'SPX'
      ORDER BY timestamp DESC
      LIMIT 1
    `,
    sql`
      SELECT zero_gamma::float8 AS zero_gamma, spot::float8 AS spot,
             to_char(ts AT TIME ZONE 'UTC', ${ISO_UTC_FMT}) AS ts
      FROM zero_gamma_levels
      WHERE ticker = 'SPX' AND ts >= ${bounds.min} AND ts <= ${bounds.max}
      ORDER BY ts DESC
      LIMIT 1
    `,
    // The day's last tick, guarded by the CT-day filter — a bare date=X
    // picks up a mis-stamped prior-evening snapshot (see gex-strike-day.ts).
    sql`
      WITH last_tick AS (
        SELECT max(timestamp) AS ts
        FROM gex_strike_0dte
        WHERE ${gexCtDayFilter(sql, date)}
      )
      SELECT g.strike::float8 AS strike,
             ((COALESCE(g.call_gamma_oi, 0) + COALESCE(g.put_gamma_oi, 0)) / 1e6)::float8
               AS net_gamma_mm
      FROM gex_strike_0dte g
      WHERE ${gexCtDayFilter(sql, date, 'g.date', 'g.timestamp')}
        AND g.timestamp = (SELECT ts FROM last_tick)
      ORDER BY ABS(COALESCE(g.call_gamma_oi, 0) + COALESCE(g.put_gamma_oi, 0)) DESC
      LIMIT 5
    `,
  ]);

  const spot = spotRows[0];
  const zg = zgRows[0];
  const zgSpot = num(zg?.spot);
  const zgTs = str(zg?.ts);
  const topStrikes = strikeRows.flatMap((r) => {
    const strike = num(r.strike);
    const netGammaMM = num(r.net_gamma_mm);
    return strike != null && netGammaMM != null ? [{ strike, netGammaMM }] : [];
  });

  if (!spot && !zg && topStrikes.length === 0) return null;
  return {
    netGammaMM: num(spot?.net_gamma_mm),
    netCharmMM: num(spot?.net_charm_mm),
    netVannaMM: num(spot?.net_vanna_mm),
    spotAtLast: num(spot?.price),
    zeroGamma:
      zg && zgSpot != null && zgTs != null
        ? { level: num(zg.zero_gamma), spot: zgSpot, ts: zgTs }
        : null,
    topStrikes,
  };
}

async function fetchFlow(
  sql: Sql,
  date: string,
  notes: string[],
): Promise<DailyReport['flow']> {
  // flow_data values are CUMULATIVE — the day close is the LAST row per
  // source, never a SUM.
  const closeRows = await sql`
    SELECT DISTINCT ON (source) source, ncp::float8 AS ncp, npp::float8 AS npp
    FROM flow_data
    WHERE date = ${date} AND source = ANY(${FLOW_CLOSE_SOURCES})
    ORDER BY source, created_at DESC
  `;
  const bySource = new Map(closeRows.map((r) => [str(r.source), r]));
  const net = (source: string): number | null => {
    const row = bySource.get(source);
    const ncp = num(row?.ncp);
    const npp = num(row?.npp);
    return ncp != null && npp != null ? ncp - npp : null;
  };
  const tideRow = bySource.get('market_tide');
  const tideNcp = num(tideRow?.ncp);
  const tideNpp = num(tideRow?.npp);

  const etfRows = await sql`
    SELECT source,
           (array_agg(ncp + npp ORDER BY created_at ASC))[1]::float8 AS earliest,
           (array_agg(ncp + npp ORDER BY created_at DESC))[1]::float8 AS latest
    FROM flow_data
    WHERE date = ${date} AND source = ANY(${ETF_TIDE_SOURCES})
    GROUP BY source
  `;
  const etfDelta = (source: string): number | null => {
    const row = etfRows.find((r) => str(r.source) === source);
    const earliest = num(row?.earliest);
    const latest = num(row?.latest);
    return earliest != null && latest != null ? latest - earliest : null;
  };

  // Tape fails independently of the cumulative-flow tables.
  let tape: NonNullable<DailyReport['flow']>['tape'] = null;
  try {
    const bounds = ctSessionBounds(date);
    const [aggRows, printRows] = await Promise.all([
      sql`
        SELECT
          (count(*) FILTER (WHERE price::float8 * size * 100 >= ${WHALE_PREMIUM_USD}))::int
            AS whale_count,
          COALESCE(
            sum(price::float8 * size * 100)
              FILTER (WHERE price::float8 * size * 100 >= ${WHALE_PREMIUM_USD}),
            0
          )::float8 AS whale_premium,
          (count(*) FILTER (WHERE raw_payload->'tags' ? 'sweep'))::int AS sweep_count
        FROM ws_option_trades
        WHERE canceled = FALSE
          AND executed_at >= ${bounds.min} AND executed_at <= ${bounds.max}
      `,
      sql`
        SELECT ticker, option_type, strike::float8 AS strike,
               expiry::text AS expiry,
               (price::float8 * size * 100) AS premium, side
        FROM ws_option_trades
        WHERE canceled = FALSE
          AND executed_at >= ${bounds.min} AND executed_at <= ${bounds.max}
        ORDER BY price::float8 * size * 100 DESC
        LIMIT 3
      `,
    ]);
    const agg = aggRows[0];
    tape = {
      whaleCount: int(agg?.whale_count),
      whalePremium: num(agg?.whale_premium) ?? 0,
      sweepCount: int(agg?.sweep_count),
      topPrints: printRows.map((r) => ({
        ticker: str(r.ticker) ?? '',
        optionType: str(r.option_type) ?? '',
        strike: num(r.strike) ?? 0,
        expiry: str(r.expiry) ?? '',
        premium: num(r.premium) ?? 0,
        side: str(r.side) ?? '',
      })),
    };
  } catch (err) {
    notes.push(`tape: ${errMessage(err)}`);
  }

  const tapeEmpty =
    tape == null || (tape.topPrints.length === 0 && tape.whaleCount === 0);
  if (closeRows.length === 0 && etfRows.length === 0 && tapeEmpty) return null;

  return {
    marketTide:
      tideNcp != null && tideNpp != null
        ? { ncp: tideNcp, npp: tideNpp }
        : null,
    netFlowClose: {
      spx: net('spx_flow'),
      spy: net('spy_flow'),
      qqq: net('qqq_flow'),
    },
    etfTideDelta: {
      spy: etfDelta('spy_etf_tide'),
      qqq: etfDelta('qqq_etf_tide'),
    },
    zeroDteNet: net('zero_dte_index'),
    tape,
  };
}

async function fetchSignals(
  sql: Sql,
  date: string,
): Promise<DailyReport['signals']> {
  const bounds = ctSessionBounds(date);
  const [lotteryRows, periRows, gammaRows, sbRows] = await Promise.all([
    // NULL peak with enriched_at set = no-tick: excluded from win AND loss.
    sql`
      SELECT count(*)::int AS fires,
        (count(*) FILTER (WHERE enriched_at IS NOT NULL))::int AS enriched,
        (count(*) FILTER (WHERE peak_ceiling_pct IS NOT NULL
                            AND peak_ceiling_pct >= ${WIN_PEAK_CEILING_PCT}))::int AS wins,
        (count(*) FILTER (WHERE peak_ceiling_pct IS NOT NULL
                            AND peak_ceiling_pct < ${WIN_PEAK_CEILING_PCT}))::int AS losses
      FROM lottery_finder_fires
      WHERE date = ${date}
    `,
    sql`
      SELECT count(*)::int AS fires,
        (count(*) FILTER (WHERE outcome_locked))::int AS locked,
        (count(*) FILTER (WHERE outcome_locked AND realized_r_peak > 0))::int AS wins
      FROM periscope_lottery_fires
      WHERE fire_time >= ${bounds.min} AND fire_time <= ${bounds.max}
    `,
    sql`
      SELECT count(*)::int AS fires,
        (count(*) FILTER (WHERE ret_30m IS NOT NULL))::int AS resolved,
        (count(*) FILTER (WHERE ret_30m > 0))::int AS wins
      FROM ws_gamma_setup_fires
      WHERE fired_at >= ${bounds.min} AND fired_at <= ${bounds.max}
    `,
    sql`
      SELECT count(*)::int AS alerts,
        (count(*) FILTER (WHERE enriched_at IS NOT NULL))::int AS enriched,
        (count(*) FILTER (WHERE peak_ceiling_pct IS NOT NULL
                            AND peak_ceiling_pct >= ${WIN_PEAK_CEILING_PCT}))::int AS wins
      FROM silent_boom_alerts
      WHERE date = ${date}
    `,
  ]);

  const lottery = lotteryRows[0];
  const fires = int(lottery?.fires);
  const enriched = int(lottery?.enriched);
  return {
    lottery: {
      fires,
      enriched,
      wins: int(lottery?.wins),
      losses: int(lottery?.losses),
      partial: enriched < fires,
    },
    periscopeLottery: {
      fires: int(periRows[0]?.fires),
      locked: int(periRows[0]?.locked),
      wins: int(periRows[0]?.wins),
    },
    gammaSetups: {
      fires: int(gammaRows[0]?.fires),
      resolved: int(gammaRows[0]?.resolved),
      wins: int(gammaRows[0]?.wins),
    },
    silentBoom: {
      alerts: int(sbRows[0]?.alerts),
      enriched: int(sbRows[0]?.enriched),
      wins: int(sbRows[0]?.wins),
    },
  };
}

async function fetchDataQualityCounts(
  sql: Sql,
  date: string,
  notes: string[],
): Promise<Omit<DailyReport['dataQuality'], 'playbookSlots' | 'notes'>> {
  const count = async (
    label: string,
    query: () => ReturnType<Sql>,
  ): Promise<number> => {
    try {
      const rows = await query();
      return int(rows[0]?.n);
    } catch (err) {
      notes.push(`${label}: ${errMessage(err)}`);
      return 0;
    }
  };
  const [spxCandles, gexTicks, flowRows, wsTrades] = await Promise.all([
    count(
      'dq.spxCandles',
      () => sql`
        SELECT count(*)::int AS n
        FROM index_candles_1m
        WHERE symbol = 'SPX' AND date = ${date}
      `,
    ),
    count(
      'dq.gexTicks',
      () => sql`
        SELECT count(*)::int AS n
        FROM gex_strike_0dte
        WHERE ${gexCtDayFilter(sql, date)}
      `,
    ),
    count(
      'dq.flowRows',
      () => sql`
        SELECT count(*)::int AS n
        FROM flow_data
        WHERE date = ${date}
      `,
    ),
    count('dq.wsTrades', () => {
      const bounds = ctSessionBounds(date);
      return sql`
        SELECT count(*)::int AS n
        FROM ws_option_trades
        WHERE canceled = FALSE
          AND executed_at >= ${bounds.min} AND executed_at <= ${bounds.max}
      `;
    }),
  ]);
  return { spxCandles, gexTicks, flowRows, wsTrades };
}

// ── Headline ──────────────────────────────────────────────────────────────

/**
 * Compact dollar-gamma formatter for the headline. Input is $M (the report's
 * netGammaMM unit): -1200 → "-$1.2B", 850 → "$850M".
 */
function formatGammaDollars(mm: number): string {
  const sign = mm < 0 ? '-' : '';
  const abs = Math.abs(mm);
  if (abs >= 1000) {
    const billions = (abs / 1000).toFixed(1);
    return `${sign}$${billions}B`;
  }
  return `${sign}$${Math.round(abs)}M`;
}

/**
 * One-line push-notification body composed from whatever sections built,
 * e.g. `SPX 6467 · range 38pts (0.6%) · bias two-sided · net GEX -$1.2B ·
 * cone held · 3919 fires`. Missing sections are simply omitted.
 */
function buildHeadline(
  date: string,
  session: DailyReport['session'],
  playbook: DailyReport['playbook'],
  positioning: DailyReport['positioning'],
  signals: DailyReport['signals'],
): string {
  const parts: string[] = [];
  if (session) {
    const rangePct = session.rangePct.toFixed(1);
    parts.push(
      `SPX ${Math.round(session.close)}`,
      `range ${Math.round(session.rangePts)}pts (${rangePct}%)`,
    );
  }
  if (playbook?.bias != null) parts.push(`bias ${playbook.bias}`);
  if (positioning?.netGammaMM != null) {
    parts.push(`net GEX ${formatGammaDollars(positioning.netGammaMM)}`);
  }
  if (session?.cone) {
    if (session.coneBreaches.length > 0) {
      const dirs = [
        ...new Set(
          session.coneBreaches.map((b) =>
            b.direction === 'upper' ? 'up' : 'down',
          ),
        ),
      ];
      parts.push(`cone breached ${dirs.join('+')}`);
    } else {
      parts.push('cone held');
    }
  }
  if (signals) parts.push(`${signals.lottery.fires} fires`);
  return parts.length > 0 ? parts.join(' · ') : `No data for ${date}`;
}

// ── Assembly ──────────────────────────────────────────────────────────────

/**
 * Build the full end-of-day report for `date` (ET trading date,
 * YYYY-MM-DD). Never throws for data problems: each section fails soft to
 * null with a note in `dataQuality.notes` (see the failure model in the
 * module header). The caller injects `sql` so the cron, the endpoint, and
 * tests share one code path.
 */
export async function buildDailyReport(
  sql: Sql,
  date: string,
): Promise<DailyReport> {
  const notes: string[] = [];
  const soft = async <T>(
    label: string,
    fn: () => Promise<T>,
  ): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      notes.push(`${label}: ${errMessage(err)}`);
      return null;
    }
  };

  const [session, playbookResult, positioning, flow, signals, counts] =
    await Promise.all([
      soft('session', () => fetchSession(sql, date, notes)),
      soft('playbook', () => fetchPlaybook(sql, date)),
      soft('positioning', () => fetchPositioning(sql, date)),
      soft('flow', () => fetchFlow(sql, date, notes)),
      soft('signals', () => fetchSignals(sql, date)),
      fetchDataQualityCounts(sql, date, notes),
    ]);

  const playbook = playbookResult?.section ?? null;
  return {
    date,
    generatedAt: new Date().toISOString(),
    headline: buildHeadline(date, session, playbook, positioning, signals),
    session,
    playbook,
    positioning,
    flow,
    signals,
    dataQuality: {
      ...counts,
      playbookSlots: playbookResult?.slots ?? { complete: 0, failed: 0 },
      notes,
    },
  };
}
