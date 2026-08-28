# Periscope Daily Report — EOD assembly, push, and panel (2026-08-27)

## Goal

Every trading day after the close, assemble a full end-of-day report from data
already in Neon, store it, push it to the owner's phone via the existing web
push plumbing, and render it in the app — our own version of UW's daily
Periscope digest. The 2026-05-11 daily-debrief spec was never built; this
ships the deliverable form of it.

## Phases

Single phase, one commit, ~14 files. Backend core → (cron+endpoint ∥
frontend) → review.

## Data sources (verified 2026-08-27 by parallel code survey)

| Section | Source | Read pattern |
| --- | --- | --- |
| Session OHLC | `index_candles_1m` (symbol='SPX', market_time='r') | MIN/MAX/first-open/last-close aggregate for the ET date. `day_embeddings` OHLC lands at 23:00 UTC — too late; aggregate candles directly. Prefer `spx_schwab_price` anchor via `COALESCE(spx_schwab_price, close)` for the closing bar. |
| Cone | `cone_levels` (date PK) + `cone_breach_events` (first breach per direction) | closed-inside computed from last RTH close vs bounds |
| Playbook | `periscope_analyses` | latest `auto_generated=TRUE AND status='complete'` row for the date (post-close that IS the debrief); counts of complete/failed slots. `trading_date` comes back as a JS Date — use the `toIsoDate` convention. |
| Positioning | `spot_exposures` last row (÷1e6 → $M), `zero_gamma_levels` last SPX row in session ts-range, `gex_strike_0dte` top strikes at last CT-day tick | MUST use the CT-day filter (`gexCtDayFilter` in `api/_lib/gex-strike-day.ts`) — bare `date=X` returns mis-stamped prior-evening rows. Net per strike = `call_gamma_oi + put_gamma_oi`, top 5 by ABS, ÷1e6. |
| Flow closes | `flow_data` — values are CUMULATIVE; day close = last row per (date, source). Sources: `market_tide`, `spx_flow`/`spy_flow`/`qqq_flow`, `spy_etf_tide`/`qqq_etf_tide` (delta = latest−earliest of ncp+npp), `zero_dte_index`. | `SELECT DISTINCT ON (source) … ORDER BY source, created_at DESC` pattern (see `analyze-context-formatters.ts:466`) |
| Tape | `ws_option_trades` (2-day retention — same-day query is safe) | premium = `price::float8 * size * 100` (see `flow-regime-rows.ts:139`); whale = premium ≥ 500_000; sweep = `raw_payload->'tags' ? 'sweep'`; bound by `ctSessionBounds(date)` (`src/components/LotteryFinder/ct-window.ts`) and `canceled = FALSE`. Top 3 prints by premium. |
| Signals | `lottery_finder_fires` (win = enriched AND `peak_ceiling_pct >= 20`; NULL peak with enriched_at set = no-tick, excluded from both win and loss; enrichment only PARTIAL until ~23:55 UTC — report `partial: true` when enriched < fires), `periscope_lottery_fires` (enriched 21:50 — complete by 22:10; win = `outcome_locked AND realized_r_peak > 0`, mirroring the enrich cron's own convention if one exists), `ws_gamma_setup_fires` (no date col — filter `fired_at` in the ET day; resolved = `ret_30m IS NOT NULL`, win = `ret_30m > 0`), `silent_boom_alerts` (enriched 21:45, ≤300/day; win = non-NULL `peak_ceiling_pct >= 20`) | counts cast `count(*)::int` in SQL |
| Data quality | row counts for the day: SPX candles, gex_strike_0dte ticks, flow_data rows, ws_option_trades prints, playbook slots complete/failed | plus free-text `notes[]` collecting per-section failures |

All NUMERIC/BIGINT casts happen **in SQL** (`::float8`, `count(*)::int`) —
no new bare `as Row[]` casts (sql-cast-ratchet).

## Files

### 1. Migration #195 (`api/_lib/db-migrations.ts`) + `api/__tests__/db.test.ts`

```sql
CREATE TABLE IF NOT EXISTS daily_reports (
  date        DATE PRIMARY KEY,
  report      JSONB NOT NULL,
  push_sent   BOOLEAN NOT NULL DEFAULT FALSE,
  push_result JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
```

One CREATE statement + tracking INSERT. db.test.ts: append `{ id: 195 }` to
the applied mock, append `#195: <description>` to the expected list, bump
`toHaveBeenCalledTimes(688)` → 690 and `transaction` 181 → 182 (comment tally
too).

### 2. `api/_lib/daily-report.ts` (+ `api/__tests__/daily-report.test.ts`)

Exports `DailyReport` type and `buildDailyReport(sql, date): Promise<DailyReport>`:

```ts
export interface DailyReport {
  date: string; generatedAt: string; headline: string;
  session: { open; high; low; close; rangePts; rangePct; candleCount;
    cone: { lower; upper; closedInside } | null;
    coneBreaches: { direction; breachTime; ptsPastBound }[] } | null;
  playbook: { mode; slotCapturedAt; bias; regime; confidence;
    gammaFloor; gammaCeiling; magnet; charmZero;
    recommended: string[]; avoid: string[]; narrative /* ≤600 chars */;
    slotsComplete: number; slotsFailed: number } | null;
  positioning: { netGammaMM; netCharmMM; netVannaMM; spotAtLast;
    zeroGamma: { level; spot; ts } | null;
    topStrikes: { strike; netGammaMM }[] } | null;
  flow: { marketTide: { ncp; npp } | null;
    netFlowClose: { spx; spy; qqq };
    etfTideDelta: { spy; qqq };
    zeroDteNet: number | null;
    tape: { whaleCount; whalePremium; sweepCount;
      topPrints: { ticker; optionType; strike; expiry; premium; side }[] } | null } | null;
  signals: { lottery: { fires; enriched; wins; losses; partial };
    periscopeLottery: { fires; locked; wins };
    gammaSetups: { fires; resolved; wins };
    silentBoom: { alerts; enriched; wins } } | null;
  dataQuality: { spxCandles; gexTicks; flowRows; wsTrades;
    playbookSlots; notes: string[] };
}
```

Each section fetcher is its own function, fails SOFT (catch → section null +
note pushed to `dataQuality.notes`) so one broken table never kills the
report. `headline` is a one-line compact summary for the push body, e.g.
`SPX 6467 · range 38pts · bias two-sided · net GEX −$1.2B · cone held ·
3919 fires`. Tests: per-section unit tests with a sql mock routed by
statement content (order-independent), one all-sections-fail test proving
the report still materializes with notes.

### 3. `api/cron/periscope-daily-report.ts` (+ test) · `vercel.json` · `api/_lib/cron-schedules.ts`

- Schedule `10 22 * * 1-5` — post-close year-round (17:10 ET in EDT, 18:10 in
  EST... check: 22:10 UTC = 18:10 EDT / 17:10 EST — both after close), after
  periscope-lottery enrichment (21:50) and capture-flow-regime-daily (21:55);
  lottery enrichment still running → `partial` flag covers it.
- `withCronInstrumentation('periscope-daily-report', …, { marketHours: false,
  requireApiKey: false })`; inside, gate on `isTradingDay(getETDateStr(new
  Date()))` (fetch-outcomes precedent) → `{ status: 'skipped',
  message: 'not_trading_day' }`.
- Build report for the ET date → UPSERT `daily_reports` (ON CONFLICT (date)
  DO UPDATE report/updated_at) → push via `sendPushToOwner({ title:
  'SPX Daily Report — <date>', body: headline, tag: 'daily-report',
  requireInteraction: true, url: '/#sec-daily-report' })` in try/catch
  (VAPID-missing throws must NOT fail the run: catch → Sentry + logger.error,
  push_result = { error }). Record push_sent/push_result on the row.
- Metadata: which sections are non-null, push FanOutResult.
- SCHEDULE_MAP entry: `{ schedule: '10 22 * * 1-5', checkinMargin:
  DEFAULT_MARGIN, maxRuntime: DEFAULT_MAX_RUNTIME }` (cron-schedules.test.ts
  cross-checks vercel.json verbatim).
- Cron test: 401 guard, holiday skip, happy path (report built → upsert +
  push called → 200 with metadata), push-throw still succeeds, DB error → 500.

### 4. `api/daily-report.ts` GET endpoint (+ test) · `src/main.tsx`

- `withDbReader('/api/daily-report', 'daily_report', 'owner-or-guest', …)`.
- `?date=YYYY-MM-DD` optional, regex-validated inline (greek-exposure-strike
  precedent); invalid → 400; no date → latest row; none → 404
  `{ error: 'No report available' }` with `done({ status: 404 })`.
- Response `{ date, report, createdAt }`; `setCacheHeaders(res, 60)` if that
  helper is the local convention.
- Add `{ path: '/api/daily-report', method: 'GET' }` to the initBotId
  protect array (the owner-or-guest guard calls checkBot server-side, so the
  client must arm the header).

### 5. Frontend: `src/hooks/useDailyReport.ts`, `src/components/DailyReport/DailyReportPanel.tsx` (+ smoke test), `src/constants/panel-registry.ts` (+ its test), `src/App.tsx`

- Hook: `getAccessMode()` gate (owner or guest), fetch on mount and on date
  change; validated parse per the repo's fetch-parse convention; no polling.
- Panel: SectionBox card `Daily Report` (group 'Market Context', id
  `sec-daily-report`) rendering headline, session stats, playbook summary,
  positioning, flow, signals (with "partial until ~6pm CT" note when
  `partial`), data-quality footer; native date input for past reports.
- Registry: one-line entry mirroring the sec-periscope-exposure gating
  pattern; update `panel-registry.test.ts` / `App.panel-render.test.tsx`
  counts as needed.
- App.tsx: lazy import with `.catch()` reload-prompt (PWA stale-chunk rule),
  GatedSection wrapper.

## Constraints

- Explicit `.js` extensions on every relative import in api/ and in any
  `src/` module the cron imports (`marketHours.js`, `ct-window.js` are
  already compliant).
- `flow_data` values are cumulative — never SUM a day.
- `gex_strike_0dte` needs the CT-day filter, not bare `date=`.
- Neon returns NUMERIC/BIGINT as strings — cast in SQL.
- Tests ship in the same commit; `npm run build` AND `npm run review` before
  done; push to remote `fork`, not `origin`.

## Verification

Full loop: implement → `npm run build` + `npm run review` → reviewer
subagent → commit → push fork. Deploy via `vercel deploy --prod` (user runs
it). First live report: next trading day 22:10 UTC.
