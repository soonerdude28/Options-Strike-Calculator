# Slim `ws_option_trades.raw_payload` — 27 GB → ~5 GB

**Status:** planned, not started. Written 2026-08-23 during a platform audit.
**Do not start this mid-week.** It touches the live ingest path.

## Goal

`ws_option_trades` is 27 GB — 75% of a 36 GB Neon database — and only ~1.2 days
of data. Promote the five JSONB keys anything actually reads into typed columns,
stop writing the full blob, and drop the column. Expected: **27 GB → ~5 GB**, and
the whole database **36 GB → ~13 GB**.

## Evidence (measured 2026-08-23)

```
heap 22 GB · indexes 5.5 GB · total 27 GB · 11.8M rows
avg raw_payload   985 bytes
avg full row     1136 bytes      -> raw_payload is 87% of the heap
retention window 2026-08-20 16:33Z .. 2026-08-21 21:00Z   (~1.2 days)
```

Retention is already correct and working: `api/cron/backup-tables.ts` is unrelated;
`api/cron/cleanup-ws-option-trades.ts` runs `5 12 * * 1-5` with `RETENTION_DAYS = 2`.
The size is not a leak — it is ~11 GB/trading-day of duplicated JSON.

## The whole surface

Only **five** keys are ever read out of the blob. Verified by
`grep -rhoE "raw_payload\s*->>?\s*'[a-z_]+'"` across `api/ scripts/ ml/ classifier/ uw-stream/`:

| key                    | read by                                                                                 | added in        |
| ---------------------- | --------------------------------------------------------------------------------------- | --------------- |
| `gamma`                | `detect-lottery-fires`, `detect-silent-boom`, `_lib/lottery-finder`, `_lib/silent-boom` | migration #168  |
| `trade_code`           | `detect-silent-boom` (multi-leg filter)                                                 | —               |
| `nbbo_bid`, `nbbo_ask` | `detect-silent-boom` (`spread_in_bucket`)                                               | migration ~#169 |
| `report_flags`         | `_lib/opening-flow-evaluator` (commented as a _future_ need — confirm before keeping)   | —               |

Reading files: `api/lottery-finder.ts`, `api/_lib/lottery-finder.ts`,
`api/_lib/silent-boom.ts`, `api/_lib/opening-flow-evaluator.ts`,
`api/cron/detect-lottery-fires.ts`, `api/cron/detect-silent-boom.ts`.

Writer: `uw-stream/` (asyncpg COPY). It promotes the other 14 fields to typed
columns already and passes the blob through verbatim — these five were simply
never added to the promote list.

## Phases (each independently shippable)

**Phase 1 — add columns, dual-write.** Migration #193 adds
`gamma NUMERIC`, `trade_code TEXT`, `nbbo_bid NUMERIC`, `nbbo_ask NUMERIC`,
`report_flags TEXT` (all nullable). uw-stream promotes them into the COPY tuple
_and_ keeps writing `raw_payload`. Nothing reads the new columns yet. Zero risk.

**Phase 2 — cut readers over.** Rewrite the six reading files to use the typed
columns, with `COALESCE(gamma, NULLIF(raw_payload->>'gamma','')::numeric)` so
rows written before Phase 1 still resolve. Ship, then let a full trading day pass
and diff fire counts against the prior week before continuing.

**Phase 3 — stop writing the blob.** uw-stream drops `raw_payload` from the COPY
tuple. Migration #194 makes the column nullable (it is currently `NOT NULL` —
see `db-migrations.ts:3069`). Size starts falling immediately; within
`RETENTION_DAYS = 2` the old rows age out on their own.

**Phase 4 — drop the column.** Migration #195 `DROP COLUMN raw_payload`, then
`VACUUM FULL` (or accept gradual reuse). Remove the COALESCE fallbacks.

## Risks

- **`NOT NULL` on `raw_payload`** — Phase 3 fails without the Phase 3 migration.
  Order matters.
- **Silent fire-count regression.** `combined_score` on `lottery_finder_fires` is
  a GENERATED expression keyed off `gamma_at_trigger` (migration #168). If Phase 2
  changes what gamma resolves to, scores shift and the change is invisible.
  The Phase 2 gate is a fire-count diff, not a passing test suite.
- **`report_flags` may be dead.** The only reference is a comment describing a
  hypothetical future use. Confirm before spending a column on it.
- **uw-stream has its own pytest suite** (`uw-stream/tests/`) and is deployed by
  CLI upload, not git — it will not redeploy on push. Deploy it explicitly.

## Not in scope

`ws_gex_strike_expiry` (4.1 GB) has the same `raw_payload` pattern and the same
fix available. Handle it separately once this one has proven out.
