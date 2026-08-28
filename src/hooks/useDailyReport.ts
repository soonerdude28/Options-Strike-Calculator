/**
 * useDailyReport — fetches the stored end-of-day Periscope Daily Report
 * from /api/daily-report (owner-or-guest, cookie auth).
 *
 * The report is assembled once per trading day by the 22:10 UTC cron
 * (api/cron/periscope-daily-report.ts) and stored in `daily_reports`,
 * so there is nothing to poll — the hook fetches on mount and again
 * whenever the selected date changes. `selectedDate = null` means
 * "latest report"; a YYYY-MM-DD string requests that specific day.
 * A 404 is the server's documented "no report for that day" response
 * and surfaces as `notFound`, not as an error.
 *
 * Validation mirrors `parsePeriscopeResponse` (usePeriscopeExposure):
 * the panel formats numbers through `.toFixed()` and maps over the
 * section arrays before any empty state renders, so a shapeless body
 * used to be an App-blanking crash class in this repo. Policy:
 *
 *   REQUIRED (missing/wrong type ⇒ payload rejected ⇒ error state):
 *     envelope `date` / `createdAt` strings, and the report's `date`,
 *     `generatedAt`, `headline` strings.
 *   DEGRADED (invalid ⇒ safe default, report survives):
 *     every section object → null (the panel's quiet "no data"
 *     placeholder), invalid rows filtered out of arrays, nullable
 *     numerics → null, counts → 0, `dataQuality` → zeroed footer.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getAccessMode } from '../utils/auth';
import { getErrorMessage } from '../utils/error';

// ── Report shape ────────────────────────────────────────────────────
// Structural copy of `DailyReport` from api/_lib/daily-report.ts —
// kept local (rather than imported) to respect the frontend→backend
// module boundary, matching how useGexbotData / useFlowRegime /
// IvSparkline mirror their server shapes. Update BOTH files when the
// contract changes.

export interface DailyReportSession {
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
}

export interface DailyReportPlaybook {
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
}

export interface DailyReportPositioning {
  /** spot_exposures last-row greeks in $M (value / 1e6). */
  netGammaMM: number | null;
  netCharmMM: number | null;
  netVannaMM: number | null;
  spotAtLast: number | null;
  zeroGamma: { level: number | null; spot: number; ts: string } | null;
  /** Top gex_strike_0dte strikes by |net gamma| at the day's last tick. */
  topStrikes: { strike: number; netGammaMM: number }[];
}

export interface DailyReportTapePrint {
  ticker: string;
  optionType: string;
  strike: number;
  expiry: string;
  premium: number;
  side: string;
}

export interface DailyReportFlow {
  marketTide: { ncp: number; npp: number } | null;
  /** Day-close net flow (ncp − npp) per index source. */
  netFlowClose: { spx: number | null; spy: number | null; qqq: number | null };
  /** latest − earliest of (ncp + npp) per ETF tide source. */
  etfTideDelta: { spy: number | null; qqq: number | null };
  zeroDteNet: number | null;
  tape: {
    whaleCount: number;
    whalePremium: number;
    sweepCount: number;
    topPrints: DailyReportTapePrint[];
  } | null;
}

export interface DailyReportSignals {
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
}

export interface DailyReportDataQuality {
  spxCandles: number;
  gexTicks: number;
  flowRows: number;
  wsTrades: number;
  playbookSlots: { complete: number; failed: number };
  notes: string[];
}

export interface DailyReport {
  /** ET trading date, YYYY-MM-DD. */
  date: string;
  /** ISO instant this report was assembled. */
  generatedAt: string;
  /** One-line compact summary (also the push notification body). */
  headline: string;
  session: DailyReportSession | null;
  playbook: DailyReportPlaybook | null;
  positioning: DailyReportPositioning | null;
  flow: DailyReportFlow | null;
  signals: DailyReportSignals | null;
  dataQuality: DailyReportDataQuality;
}

// ── Validation ──────────────────────────────────────────────────────

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Nullable numeric field: finite number survives, anything else → null. */
function numOrNull(v: unknown): number | null {
  return isFiniteNumber(v) ? v : null;
}

/** Count field: finite number survives, anything else → 0. */
function countOrZero(v: unknown): number {
  return isFiniteNumber(v) ? v : 0;
}

/** Nullable text field: string survives, anything else → null. */
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

/** Filter an unknown array down to its valid rows. A non-array (or a
 *  missing field) yields an empty list rather than a fatal. */
function validateRows<T>(
  raw: unknown,
  validate: (row: unknown) => T | null,
): T[] {
  if (!Array.isArray(raw)) return [];
  const out: T[] = [];
  for (const candidate of raw) {
    const row = validate(candidate);
    if (row != null) out.push(row);
  }
  return out;
}

function validateBreach(
  raw: unknown,
): DailyReportSession['coneBreaches'][number] | null {
  if (!isRecord(raw)) return null;
  if (raw.direction !== 'upper' && raw.direction !== 'lower') return null;
  if (typeof raw.breachTime !== 'string') return null;
  return {
    direction: raw.direction,
    breachTime: raw.breachTime,
    ptsPastBound: countOrZero(raw.ptsPastBound),
  };
}

function validateSession(raw: unknown): DailyReportSession | null {
  if (!isRecord(raw)) return null;
  const { open, high, low, close, rangePts, rangePct } = raw;
  // OHLC + range feed `.toFixed()` calls directly — all-or-nothing.
  if (
    !isFiniteNumber(open) ||
    !isFiniteNumber(high) ||
    !isFiniteNumber(low) ||
    !isFiniteNumber(close) ||
    !isFiniteNumber(rangePts) ||
    !isFiniteNumber(rangePct)
  ) {
    return null;
  }
  const coneRaw = raw.cone;
  const cone =
    isRecord(coneRaw) &&
    isFiniteNumber(coneRaw.lower) &&
    isFiniteNumber(coneRaw.upper)
      ? {
          lower: coneRaw.lower,
          upper: coneRaw.upper,
          closedInside: coneRaw.closedInside === true,
        }
      : null;
  return {
    open,
    high,
    low,
    close,
    rangePts,
    rangePct,
    candleCount: countOrZero(raw.candleCount),
    cone,
    coneBreaches: validateRows(raw.coneBreaches, validateBreach),
  };
}

function validatePlaybook(raw: unknown): DailyReportPlaybook | null {
  if (!isRecord(raw)) return null;
  return {
    mode: strOrNull(raw.mode) ?? 'unknown',
    slotCapturedAt: strOrNull(raw.slotCapturedAt),
    bias: strOrNull(raw.bias),
    regime: strOrNull(raw.regime),
    confidence: strOrNull(raw.confidence),
    gammaFloor: numOrNull(raw.gammaFloor),
    gammaCeiling: numOrNull(raw.gammaCeiling),
    magnet: numOrNull(raw.magnet),
    charmZero: numOrNull(raw.charmZero),
    recommended: stringArray(raw.recommended),
    avoid: stringArray(raw.avoid),
    narrative: strOrNull(raw.narrative),
    slotsComplete: countOrZero(raw.slotsComplete),
    slotsFailed: countOrZero(raw.slotsFailed),
  };
}

function validateTopStrike(
  raw: unknown,
): DailyReportPositioning['topStrikes'][number] | null {
  if (!isRecord(raw)) return null;
  if (!isFiniteNumber(raw.strike) || raw.strike <= 0) return null;
  if (!isFiniteNumber(raw.netGammaMM)) return null;
  return { strike: raw.strike, netGammaMM: raw.netGammaMM };
}

function validatePositioning(raw: unknown): DailyReportPositioning | null {
  if (!isRecord(raw)) return null;
  const zgRaw = raw.zeroGamma;
  const zeroGamma =
    isRecord(zgRaw) &&
    isFiniteNumber(zgRaw.spot) &&
    typeof zgRaw.ts === 'string'
      ? { level: numOrNull(zgRaw.level), spot: zgRaw.spot, ts: zgRaw.ts }
      : null;
  return {
    netGammaMM: numOrNull(raw.netGammaMM),
    netCharmMM: numOrNull(raw.netCharmMM),
    netVannaMM: numOrNull(raw.netVannaMM),
    spotAtLast: numOrNull(raw.spotAtLast),
    zeroGamma,
    topStrikes: validateRows(raw.topStrikes, validateTopStrike),
  };
}

function validateTapePrint(raw: unknown): DailyReportTapePrint | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.ticker !== 'string') return null;
  if (!isFiniteNumber(raw.strike) || !isFiniteNumber(raw.premium)) return null;
  return {
    ticker: raw.ticker,
    optionType: strOrNull(raw.optionType) ?? '',
    strike: raw.strike,
    expiry: strOrNull(raw.expiry) ?? '',
    premium: raw.premium,
    side: strOrNull(raw.side) ?? '',
  };
}

function validateFlow(raw: unknown): DailyReportFlow | null {
  if (!isRecord(raw)) return null;
  const tideRaw = raw.marketTide;
  const marketTide =
    isRecord(tideRaw) &&
    isFiniteNumber(tideRaw.ncp) &&
    isFiniteNumber(tideRaw.npp)
      ? { ncp: tideRaw.ncp, npp: tideRaw.npp }
      : null;
  const closeRaw = isRecord(raw.netFlowClose) ? raw.netFlowClose : {};
  const etfRaw = isRecord(raw.etfTideDelta) ? raw.etfTideDelta : {};
  const tapeRaw = raw.tape;
  const tape = isRecord(tapeRaw)
    ? {
        whaleCount: countOrZero(tapeRaw.whaleCount),
        whalePremium: countOrZero(tapeRaw.whalePremium),
        sweepCount: countOrZero(tapeRaw.sweepCount),
        topPrints: validateRows(tapeRaw.topPrints, validateTapePrint),
      }
    : null;
  return {
    marketTide,
    netFlowClose: {
      spx: numOrNull(closeRaw.spx),
      spy: numOrNull(closeRaw.spy),
      qqq: numOrNull(closeRaw.qqq),
    },
    etfTideDelta: { spy: numOrNull(etfRaw.spy), qqq: numOrNull(etfRaw.qqq) },
    zeroDteNet: numOrNull(raw.zeroDteNet),
    tape,
  };
}

function validateSignals(raw: unknown): DailyReportSignals | null {
  if (!isRecord(raw)) return null;
  const lottery = isRecord(raw.lottery) ? raw.lottery : {};
  const peri = isRecord(raw.periscopeLottery) ? raw.periscopeLottery : {};
  const gamma = isRecord(raw.gammaSetups) ? raw.gammaSetups : {};
  const boom = isRecord(raw.silentBoom) ? raw.silentBoom : {};
  return {
    lottery: {
      fires: countOrZero(lottery.fires),
      enriched: countOrZero(lottery.enriched),
      wins: countOrZero(lottery.wins),
      losses: countOrZero(lottery.losses),
      partial: lottery.partial === true,
    },
    periscopeLottery: {
      fires: countOrZero(peri.fires),
      locked: countOrZero(peri.locked),
      wins: countOrZero(peri.wins),
    },
    gammaSetups: {
      fires: countOrZero(gamma.fires),
      resolved: countOrZero(gamma.resolved),
      wins: countOrZero(gamma.wins),
    },
    silentBoom: {
      alerts: countOrZero(boom.alerts),
      enriched: countOrZero(boom.enriched),
      wins: countOrZero(boom.wins),
    },
  };
}

function validateDataQuality(raw: unknown): DailyReportDataQuality {
  const rec = isRecord(raw) ? raw : {};
  const slots = isRecord(rec.playbookSlots) ? rec.playbookSlots : {};
  return {
    spxCandles: countOrZero(rec.spxCandles),
    gexTicks: countOrZero(rec.gexTicks),
    flowRows: countOrZero(rec.flowRows),
    wsTrades: countOrZero(rec.wsTrades),
    playbookSlots: {
      complete: countOrZero(slots.complete),
      failed: countOrZero(slots.failed),
    },
    notes: stringArray(rec.notes),
  };
}

function validateReport(raw: unknown): DailyReport | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.date !== 'string') return null;
  if (typeof raw.generatedAt !== 'string') return null;
  if (typeof raw.headline !== 'string') return null;
  return {
    date: raw.date,
    generatedAt: raw.generatedAt,
    headline: raw.headline,
    session: validateSession(raw.session),
    playbook: validatePlaybook(raw.playbook),
    positioning: validatePositioning(raw.positioning),
    flow: validateFlow(raw.flow),
    signals: validateSignals(raw.signals),
    dataQuality: validateDataQuality(raw.dataQuality),
  };
}

interface ParsedDailyReportResponse {
  date: string;
  report: DailyReport;
  createdAt: string;
}

/**
 * Validate the /api/daily-report 200 envelope. Returns null when the
 * body isn't the documented `{ date, report, createdAt }` shape — the
 * caller turns that into the hook's normal error state.
 */
function parseDailyReportResponse(
  raw: unknown,
): ParsedDailyReportResponse | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.date !== 'string') return null;
  if (typeof raw.createdAt !== 'string') return null;
  const report = validateReport(raw.report);
  if (report == null) return null;
  return { date: raw.date, report, createdAt: raw.createdAt };
}

// ── Hook ────────────────────────────────────────────────────────────

export interface UseDailyReportReturn {
  /** The validated report, or null (loading / notFound / error / public). */
  report: DailyReport | null;
  /** ET trading date of the served report (server envelope `date`). */
  reportDate: string | null;
  /** ISO instant the served report row was created. */
  createdAt: string | null;
  loading: boolean;
  error: string | null;
  /** True when the server said 404 — no report exists for the request. */
  notFound: boolean;
  /** YYYY-MM-DD to view a specific day; null = latest report. */
  selectedDate: string | null;
  setSelectedDate: (date: string | null) => void;
}

export function useDailyReport(): UseDailyReportReturn {
  // Owner OR guest — /api/daily-report is a read-only data endpoint
  // gated by withDbReader('owner-or-guest') server-side.
  const accessMode = getAccessMode();
  const canFetch = accessMode === 'owner' || accessMode === 'guest';
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [report, setReport] = useState<DailyReport | null>(null);
  const [reportDate, setReportDate] = useState<string | null>(null);
  const [createdAt, setCreatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchReport = useCallback(async () => {
    if (!canFetch) return;
    setLoading(true);
    try {
      const url =
        selectedDate != null
          ? `/api/daily-report?date=${selectedDate}`
          : '/api/daily-report';
      const res = await fetch(url, { method: 'GET' });
      // 404 is the documented "no report for that day" response — an
      // empty state, not an error. Clear any stale report so the panel
      // never shows day A's numbers under day B's date.
      if (res.status === 404) {
        if (!mountedRef.current) return;
        setReport(null);
        setReportDate(null);
        setCreatedAt(null);
        setNotFound(true);
        setError(null);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw: unknown = await res.json();
      if (!mountedRef.current) return;
      const body = parseDailyReportResponse(raw);
      if (body == null) throw new Error('Unexpected response shape');
      setReport(body.report);
      setReportDate(body.date);
      setCreatedAt(body.createdAt);
      setNotFound(false);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(getErrorMessage(err));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [canFetch, selectedDate]);

  // Fetch on mount + refetch when the selected date changes. No polling
  // — the report is written once per day by the post-close cron.
  useEffect(() => {
    if (!canFetch) return;
    void fetchReport();
  }, [canFetch, fetchReport]);

  return useMemo(
    () => ({
      report,
      reportDate,
      createdAt,
      loading,
      error,
      notFound,
      selectedDate,
      setSelectedDate,
    }),
    [report, reportDate, createdAt, loading, error, notFound, selectedDate],
  );
}
