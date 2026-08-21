# Periscope: repoint ingestion from dead GEXBot onto Unusual Whales

**Date:** 2026-08-21
**Status:** Plan
**Branch:** `fix/flow-regime-baseline-relocation` (new branch to be cut)

## Goal

Restore the Periscope data stack — currently 100% dark — by repointing
per-strike gamma/charm/vanna ingestion from the expired GEXBot trial onto
the Unusual Whales API that already feeds this project, and backfill the
full ~3 years of history UW will serve.

## Diagnosis (verified 2026-08-21)

`periscope_snapshots` is the hub table every Periscope feature reads. It has
**0 rows**. The chain feeding it is broken at the source:

```
fetch-gexbot-strikes → gexbot_api_capture (0 rows)
                     → populate-periscope-from-gexbot
                     → periscope_snapshots (0 rows)
```

`GEXBOT_API_KEY` returns **HTTP 401 `{"error":"Invalid API key."}`** — the
trial documented in `gexbot-trial-capture-2026-05-16.md` has expired.

Everything downstream is consequently dark:

| Consumer                                                         | Reads                 | State   |
| ---------------------------------------------------------------- | --------------------- | ------- |
| `/api/periscope-strikes` → `usePeriscopeStrikes`                 | `periscope_snapshots` | empty   |
| `/api/periscope-exposure` → `usePeriscopeExposure` (time-travel) | `periscope_snapshots` | empty   |
| `/api/periscope-map` → `usePeriscopeExposure` (live 1-min)       | `gexbot_api_capture`  | empty   |
| `detect-periscope-call-lottery` / `-put-lottery`                 | `periscope_snapshots` | 0 fires |
| `detect-gamma-setups`                                            | `periscope_snapshots` | 0 fires |

By contrast the UW-fed tables are healthy (as of 2026-08-20):

| Table                   | Rows    | UW endpoint                                                 |
| ----------------------- | ------- | ----------------------------------------------------------- |
| `gex_strike_0dte`       | 56,816  | `/stock/SPX/spot-exposures/expiry-strike` (1-min, SPX 0DTE) |
| `greek_exposure_strike` | 689     | `/stock/SPX/greek-exposure/strike-expiry`                   |
| `ws_gex_strike_expiry`  | 114,877 | UW websocket (QQQ/NDX/SPY/IWM/SMH — **no SPX**)             |

Note this Neon DB was provisioned ~2026-08-17 (190 migrations applied, ~4
days of data everywhere). The "~6-month history" asserted in
`api/periscope-map.ts:9` refers to the upstream project's DB, not this one.

## The scale hazard (drives the whole design)

The two UW per-strike sources use **different units and conventions**. Same
date (2026-08-20), same strike, net call+put:

| strike 7600 | `greek_exposure_strike` (EOD) | `gex_strike_0dte` (1-min) |
| ----------- | ----------------------------- | ------------------------- |
| gamma       | −431.96                       | −0.10                     |
| charm       | +3,200,795                    | −6,477,287,668            |
| vanna       | −242,323                      | +1,667,214                |

`greek-exposure/strike-expiry` returns normalized values (raw API: `0.0355`,
`-0.1326`); `spot-exposures/expiry-strike` returns raw dollar exposure.
(Part of the charm/vanna sign delta is legitimate intraday drift — the two
captures are at different times of day — but the ~1000x gamma magnitude gap
is a unit difference, not drift.)

**Consequence:** backfilled EOD rows and forward 1-min rows must never share
a delta series. They are tagged by `source` and read separately.

## Phases

### Phase 1 — Migration #191: `source` column

- Add `source TEXT NOT NULL DEFAULT 'gexbot'` to `periscope_snapshots`
  (CHECK IN `'gexbot'`, `'uw_spot'`, `'uw_eod'`).
- Drop and recreate the UNIQUE constraint as
  `(captured_at, expiry, panel, strike, source)`.
- Index `(source, expiry, panel, captured_at, strike)` for the read paths.
- Update `api/__tests__/db.test.ts` per the CLAUDE.md migration checklist
  (applied-migrations mock, expected-output list, SQL call count).

### Phase 2 — Shared mapper `api/_lib/periscope-uw.ts`

- `PANEL_SOURCE_COLUMNS`: panel → (call col, put col) for each source.
- `netValue(row, panel)` → `call + put`, finite-guarded.
- `formatTimeframe(capturedAt)` — reuse the CT 10-min slot label from
  `populate-periscope-from-gexbot.ts` (extract, don't duplicate).
- `SOURCE_UW_SPOT` / `SOURCE_UW_EOD` constants.
- Guard: `periscope_snapshots.value` was `NUMERIC(14,2)`; SPX charm reaches
  ~1e10, which fits (13 digits). Clamp + log rather than let an insert throw.
  **Revised during review:** clamping saturates rather than rejects, and a
  saturated row is by construction the largest magnitude in the table — it
  would rank first in the lottery finder's `PERCENTILE_CONT` delta pool and
  in the display Top-N as the biggest dealer wall on the board. A fabricated
  extreme is worse than the true value or an absent row. **Migration #192**
  therefore widens the column to `NUMERIC(20,4)`, matching the
  `gex_strike_0dte` `DECIMAL(20,4)` source columns exactly, so nothing the
  source can hold can overflow the target. `clampSnapshotValue` stays as an
  unreachable defensive backstop with `SNAPSHOT_VALUE_MAX` raised to the new
  bound.

### Phase 3 — Forward cron `api/cron/populate-periscope-from-uw.ts`

- Mirrors the existing gexbot adapter's contract: 10-min RTH cadence,
  `withCronInstrumentation`, `timeCheck: isFuturesRthCt`, maxDuration 30.
- Reads the latest `gex_strike_0dte` tick within a staleness window; writes
  gamma/charm/vanna panels with `source='uw_spot'`.
- `ON CONFLICT DO NOTHING` for idempotency.
- TDD: auth-guard + happy-path test first (`api/cron/*` rule).

### Phase 4 — Repoint `/api/periscope-map` live path

- Swap its `gexbot_api_capture` read for `gex_strike_0dte` (1-min, already
  1-min native — no cadence loss).
- Preserve the prior-slice lookup used for sign-flip detection.
- Keep `STALENESS_CUTOFF_MS` semantics.

### Phase 5 — Backfill `scripts/backfill-periscope-from-uw.mjs`

- Walk trading days backward from today to the UW history floor.
- **Verified floor (2026-08-21):** UW enforces a _rolling 730-trading-day_
  window and says so explicitly. Requesting an out-of-range date returns
  HTTP 403 with a machine-readable body:

  ```json
  {
    "code": "historic_data_access_missing",
    "message": "The earliest date currently available to you is 2023-09-21 (730 trading days) ..."
  }
  ```

  So the backfill is ~730 trading days / ~730 API calls, and the floor
  MOVES FORWARD each day. Do not hardcode a start date — stop when the
  response carries `code === 'historic_data_access_missing'`. Parse the
  earliest-available date out of the message for the run log.

- Write `source='uw_eod'`. **`captured_at` must be synthesized:**
  `/greek-exposure/strike-expiry` returns only `date` — it has NO `time`
  field (verified: keys are date, expiry, strike, call_gex, put_gex,
  call_delta, put_delta, call_charm, put_charm, call_vanna, put_vanna,
  dte). Use that trading day's regular-session close in CT (15:00 CT)
  converted to UTC, so the row sorts correctly against live `uw_spot`
  rows. Set `timeframe` to a constant `'EOD'` label rather than a
  fabricated 10-min slot.
- Rate-limit politely; resumable (skip days already present).

### Phase 6 — Source-filter the read paths

Slice-over-slice consumers must pin a single source so backfill rows never
enter a delta computation:

- `api/_lib/periscope-lottery-finder.ts`
- `api/_lib/gamma-detector.ts`
- `api/_lib/periscope-format.ts`
- `api/_lib/periscope-synthesize.ts`
- `api/periscope-exposure.ts`, `api/periscope-strikes.ts`

### Phase 7 — `vercel.json`

- Add `populate-periscope-from-uw` on the same three schedules the gexbot
  adapter uses (`30,40,50 13`, `*/10 14-20`, `*/10 21`, Mon–Fri).
- Add `"api/cron/populate-periscope-from-uw.ts": { "maxDuration": 30 }`.
- **Keep the GEXBot crons scheduled** (user decision — subscription may be
  renewed). They no-op against a 401 today.

## Data dependencies

- `UW_API_KEY` (already present).
- No new tables; one new column via migration #191.
- No new env vars.

## Open questions / risks

1. **~~Detector thresholds are calibrated on GEXBot magnitudes.~~
   RESOLVED 2026-08-21 — full threshold audit done.** The original worry
   was that the v3 lottery chain and the gamma-setup detector were shot
   through with absolute-dollar cutoffs tuned on GEXBot's `gamma_zero`
   scale, and the default pick was to flag them all rather than touch
   them. The audit found that was too pessimistic: **exactly one**
   threshold was scale-dependent.

   **Scale-invariant — audited, left alone:**

   | Threshold                                     | Why it survives            |
   | --------------------------------------------- | -------------------------- |
   | `PERISCOPE_LOTTERY_THRESHOLDS.*.DAY_TOP_PCT`  | percentile-based           |
   | `PERISCOPE_LOTTERY_THRESHOLDS.*.RANK_FLOOR`   | `PERCENT_RANK`-based       |
   | `STRIKE_DIST_MIN_PTS`, `TRADE_OFFSET_PTS`     | SPX points, not dollars    |
   | `HOLD_MINUTES`, `TP_MULTIPLE`                 | time / multiple            |
   | `CALL_RATIO_MAX`, `QQQ_BALANCE_BADGE_MIN_ABS` | ratio / already normalized |
   | `ENTRY_PX_MAX`                                | option price, not exposure |

   So the entire lottery chain is rank/percentile-driven and needed no
   change — the rank-based filters didn't just "survive", they were the
   whole filter.

   **`GEX_DOLLARS_MAX = 1e9` was never GEXBot-scaled.** It reads
   `gex_target_features.gex_dollars`, which is built from
   `gex_strike_0dte` — i.e. it has _always_ been on the UW raw-dollar
   scale, before and after this repoint. Verified against live data: it
   passes 27.1% of rows. Unaffected, left alone.

   **Sign convention verified.** In `gex_strike_0dte`, positive net
   gamma concentrates above spot (77.5% of above-spot strikes positive
   vs 2.0% below) — the standard GEX convention, matching what the
   detectors assume. `value > 0` genuinely identifies +γ nodes; there is
   no sign-flip bug hiding in the repoint.

   **The one genuinely broken threshold: `PCS_MAX_ABS_GEX = 500_000`**
   (`api/_lib/gamma-detector.ts`, consumed by `detectPcsMonday`).
   Semantics: "only fire on a SMALL +γ floor". It was eyeballed on
   GEXBot's scale, its origin is undocumented (nothing in this spec or
   the detector spec explains the 500k), and the GEXBot-era intent is
   **unrecoverable** — `GEXBOT_API_KEY` returns 401 and
   `periscope_snapshots` held zero gexbot rows, so there is no sample to
   re-derive an equivalent cutoff from.

   Measured on live `uw_spot` data (`gex_strike_0dte`, 56,816
   strike-ticks), the positive-γ node population (n=22,326) is:

   | pctile | value      |
   | ------ | ---------- |
   | p05    | 2,874      |
   | p10    | 100,451    |
   | p25    | 3,592,921  |
   | p50    | 26,314,201 |

   The old 500,000 constant passes **15.5%** of positive nodes — it
   lands near p15.

   **How it was ported.** The absolute constant was deleted and replaced
   with `PCS_SMALL_WALL_PCTILE = 0.15`, applied as a quantile of the
   **current slice's own** node values via an exported, tested pure
   helper `smallWallCutoff(values, pctile)` (type-7 linear interpolation,
   matching Postgres `percentile_cont` so it agrees with the
   `PERCENTILE_CONT` percentiles used elsewhere in the codebase). Because
   the cutoff is derived from the same numbers it filters, the gate is
   **scale-invariant**: any future units change scales cutoff and data
   together and changes no decision. A dedicated test multiplies every
   node value by 1000 and asserts identical fire/no-fire outcomes — that
   is the regression guard for this entire class of bug.

   Degenerate-input policy, deliberately chosen: empty slice → no fire;
   fewer than `PCS_MIN_NODES_FOR_PCTILE = 5` nodes → no fire (a p15 over
   2–3 points is an interpolation between arbitrary observations, and
   firing on an unrepresentative slice is worse than not firing on a
   low-frequency Monday-only setup). The old `Math.abs(node.value)` was
   dropped: `loadPositiveGammaNodes` already filters `value > 0` in SQL,
   so it was dead weight, and on a signed input it would have folded
   large _negative_ short-gamma ceilings into the "small floor" bucket.

   **Caveat — this is a SELECTIVITY-PRESERVING PORT, not a calibration.**
   0.15 reproduces the pass rate we were unknowingly running; nothing
   here establishes that 15% maximises PCS edge. Real calibration is
   still owed and requires outcomes: sweep the quantile once
   `ws_gamma_setup_fires` has accumulated forward returns via the
   `backfill-gamma-setup-outcomes` cron. Cf.
   `periscope-rules-study-2026-05-21.md`, where zero rules cleared
   F1 ≥ 0.60.

2. **`positions` panel remains unavailable.** Neither UW endpoint exposes a
   positions series; the CHECK constraint still permits it. Unchanged gap.
3. **SPX is absent from the websocket feed**, so `ws_gex_strike_expiry`
   cannot serve as an SPX fallback.
4. **Deferred follow-up — same-scale historical backfill.**
   `/spot-exposures/expiry-strike` also accepts a historical `date` and
   returns data back to ~Jan 2025 (verified: 0 rows at 2024-12-17, 500
   rows at 2025-02-18) in the SAME raw-dollar units as the forward feed,
   with real timestamps. It is capped at `limit=500` (higher values
   silently fall back to 50) and returns only 2–4 snapshots per day near
   the close, paginated across (time, strike) — so it needs pagination
   work. Not in scope here; `greek-exposure` is chosen for the primary
   backfill because it reaches 730 trading days vs ~400, and because a
   one-slice-per-day series cannot drive intraday deltas at any scale.

## Thresholds / constants

- Staleness cutoff: reuse `STALENESS_CUTOFF_MS` = 5 min.
- Backfill termination: stop on HTTP 403 + `code ===
'historic_data_access_missing'` (authoritative, not a heuristic). A 403
  WITHOUT that code is a real auth failure — fail loudly, do not treat it
  as end-of-history.
- Backfill floor: rolling, ~2023-09-21 as of 2026-08-21. Never hardcoded.
