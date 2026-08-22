# UW `periscope` WebSocket channel — findings, and whether to adopt it

**Date:** 2026-08-21
**Status:** investigation only — nothing implemented
**Source:** UW OpenAPI docs via the MCP docs search
(`https://api.unusualwhales.com/docs/operations/PublicApi.SocketController.periscope`)

## Why this exists

`populate-periscope-from-uw` was written against the REST
`spot-exposures/expiry-strike` endpoint. A WebSocket `periscope` channel also
exists and was not considered at the time. This records its contract, an
honest comparison against what we already run, and the one question that
blocks adoption.

## The contract

Connect to `wss://api.unusualwhales.com/socket?token=<API_TOKEN>` and `join`
either `periscope` (every index ticker) or `periscope:SPX` (one ticker).
Requires the **Advanced** plan — which `uw-stream` already uses for its
existing channels. Explicitly unavailable on enterprise / enterprise-startup.

| Field                                | Type           | Notes                                     |
| ------------------------------------ | -------------- | ----------------------------------------- |
| `ticker`                             | string         | **SPX, VIX, XSP, NANOS only**             |
| `timestamp`                          | int (ms)       | shared by every frame of one snapshot     |
| `total_rows`                         | int            | row count of the whole snapshot           |
| `has_more`                           | bool           | `false` on the final frame of a snapshot  |
| `rows[]`                             | array          | ≤ 1024 rows per frame                     |
| `rows[].strike`                      | decimal string |                                           |
| `rows[].expiry`                      | `YYYY-MM-DD`   |                                           |
| `rows[].gamma` / `.charm` / `.vanna` | float          | MM greek exposure at that strike & expiry |

**Framing is the trap.** A snapshot spans multiple frames. All frames of one
snapshot share a `timestamp`; `has_more` is `true` on every frame but the
last. A consumer that treats one frame as a complete board silently produces
a partial GEX surface — and a board truncated at 1024 rows would look
plausible, not broken. The docs give an integrity check worth using: sum
`rows` lengths across frames sharing a `timestamp` and compare to
`total_rows` before publishing the board.

This is adjacent to a bug we already hit: `12ce25da`
("periscope: sum repeat strikes instead of discarding") was a
multiple-rows-per-strike assumption failure. Multi-frame snapshots are the
same shape of mistake one level up.

Snapshots publish roughly once a minute.

## Honest comparison with what we already run

An earlier read of this overstated the win as "1-min push vs 10-min poll".
That is wrong and worth correcting. The real pipeline is:

```
UW /stock/SPX/spot-exposures/expiry-strike
  → gex_strike_0dte          (upstream fetch cron, ALREADY ~1-min cadence)
  → populate-periscope-from-uw (adapter, 10-min RTH)
  → periscope_snapshots
```

The 10-minute figure is the **adapter**, not the source. Source freshness for
SPX is already ~1 min, so the WS channel does not meaningfully improve it —
and if fresher panels are wanted, running the existing adapter more often is
a far smaller change than a new WS consumer.

What the WS channel would genuinely add:

- **Multi-ticker in one subscription.** The REST endpoint serves one ticker
  per call; `periscope` streams SPX, VIX, XSP and NANOS together. The poller's
  header calls the per-ticker limit out as a known gap.
- **A built-in completeness check** (`total_rows`), which the REST path has no
  equivalent of.
- **Push instead of poll**, removing a cron from the critical path.

What it does **not** solve:

- **The `positions` panel** is still unserved — the channel carries only
  gamma / charm / vanna, the same three the poller already fans out.
- **NDX and RUT are absent** from the channel's ticker list, so any consumer
  needing them still needs the REST path.

## The blocking question — units

`populate-periscope-from-uw` carries an explicit warning: `spot-exposures` is
**raw dollar** exposure, roughly 1000× the normalized `greek-exposure` scale
the EOD backfill writes as `uw_eod`. That is why every row is tagged with
`source` and read paths pin exactly one — a mixed-scale delta series would
fabricate phantom sign flips.

**The WS docs do not state units.** They say only "Market-maker greek exposure
at this strike & expiry". Until that is resolved, WS rows cannot safely share
a series with either existing source, and adopting the channel would mean a
third `source` tag plus its own detector calibration — the recalibration
already tracked separately for `uw_spot` (`195350e0`).

This must be answered empirically (subscribe, compare a snapshot against the
same-minute `gex_strike_0dte` tick) before any adoption work starts.

## Recommendation

**Do not adopt yet.** The freshness argument does not survive scrutiny, the
`positions` gap is unchanged, and the units question is unanswered. The
multi-ticker win is real but currently unused — nothing downstream consumes
periscope for VIX / XSP / NANOS.

Revisit if either becomes true:

1. Periscope coverage is wanted for VIX / XSP / NANOS — then the channel is
   clearly the right shape, and the one-subscription fan-out is the win.
2. The per-ticker REST fan-out starts costing rate limit or latency.

If adopted, it belongs in `uw-stream/` (which already owns Advanced-tier WS
consumption, a connector → router → per-channel handler queue → asyncpg COPY
pipeline) and **not** in a Vercel cron.

## Incidental confirmation

CLAUDE.md warns the flow-alerts channel is `flow-alerts` with a hyphen, "note
hyphen, not `flow_alerts`". Confirmed from the source: the docs _page_ is
filed at `/api/socket/flow_alerts`, but its body reads "This is the
documentation for websocket channel `flow-alerts`" and the join example uses
the hyphen. The underscore is a doc-URL artifact only. That note was
previously empirical; it now has a citation.
