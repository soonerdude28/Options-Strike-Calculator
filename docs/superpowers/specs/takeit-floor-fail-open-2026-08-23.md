# TAKE-IT floor must fail open when no model is published

**Status:** in progress, 2026-08-23.

## Goal

When no TAKE-IT model is published, the default 0.70 floor silently empties both
the Lottery Finder and Silent Boom feeds. Make the floor fail **open** in that
one case, and tell the UI so it can say why.

## The bug

`takeit/latest.json` and the model bundles do not exist in the Vercel Blob store
(`takeit-models` holds only `backups/` and `gexbot/`). `getBundle()` returns null,
so `detect-lottery-fires` and `detect-silent-boom` write `takeit_prob = NULL` on
every row — verified: 16,858/16,858 lottery fires and 634/634 silent boom alerts
over Aug 17–21 are unscored.

The floor is applied server-side:

```sql
-- api/lottery-finder.ts:726, :790
AND (${minTakeitProb}::numeric IS NULL OR f.chain_max_takeit >= ${minTakeitProb}::numeric)
-- api/silent-boom-feed.ts:454, :521
AND (${minTakeitProb}::numeric IS NULL OR takeit_prob >= ${minTakeitProb}::numeric)
```

`NULL >= 0.70` is NULL, so every row is excluded. At the default floor both feeds
return **zero rows**. Excluding NULLs is correct when a model exists (unscored
really is below the floor) — the bug is only that a _totally absent_ model reads
as "everything failed the filter" instead of "there is no filter to apply".

## Design

New `api/_lib/takeit-availability.ts`:

```ts
export type TakeitFeed = 'lottery' | 'silent_boom';
export interface TakeitCoverage {
  total: number; // rows for that feed+date
  scored: number; // rows with takeit_prob IS NOT NULL
  unavailable: boolean; // total > 0 && scored === 0
}
export async function getTakeitCoverage(
  db,
  feed,
  date,
): Promise<TakeitCoverage>;
```

`unavailable` deliberately requires `total > 0`: a day with no fires at all must
NOT report "model unavailable", or every weekend and holiday shows a false banner.

Both endpoints then:

```ts
const requestedFloor =
  q.minTakeitProb != null && q.minTakeitProb > 0 ? q.minTakeitProb : null;
// Only pay for the probe when a floor is actually on.
const coverage =
  requestedFloor == null ? null : await getTakeitCoverage(db, feed, date);
const takeitUnavailable = coverage?.unavailable === true;
const minTakeitProb = takeitUnavailable ? null : requestedFloor;
```

and return `takeitUnavailable: boolean` at the top level of the response.
`applied.minTakeitProb` keeps reporting what was _actually_ applied (null when
bypassed) — it is named "applied", and `takeitUnavailable` carries the reason.

## Files

| file                                            | change                                   |
| ----------------------------------------------- | ---------------------------------------- |
| `api/_lib/takeit-availability.ts`               | new — the probe                          |
| `api/__tests__/takeit-availability.test.ts`     | new — unit table                         |
| `api/lottery-finder.ts`                         | bypass + `takeitUnavailable` in response |
| `api/silent-boom-feed.ts`                       | same                                     |
| `api/__tests__/lottery-finder-endpoint.test.ts` | bypass + flag cases                      |
| `api/__tests__/silent-boom-feed.test.ts`        | same                                     |
| `src/components/LotteryFinder/types.ts`         | `takeitUnavailable?: boolean`            |
| `src/components/SilentBoom/types.ts`            | same                                     |
| `src/components/LotteryFinder/index.tsx`        | notice by the TAKE-IT chips              |
| `src/components/SilentBoom/index.tsx`           | same                                     |

## Decisions

- **Date-scoped, not global.** A historical date that _was_ scored keeps filtering
  correctly; only the unscored date fails open.
- **Bypass, not "treat NULL as passing".** Rewriting the predicate to
  `(chain_max_takeit IS NULL OR chain_max_takeit >= floor)` would also let genuinely
  unscored rows through on days when a model _does_ exist. That is a different and
  wrong behavior change.
- **One extra query, only when a floor is on.** Both endpoints already issue
  several queries; a `count(*) / count(takeit_prob)` on an indexed `date` is cheap,
  and the common floor-off path pays nothing.

## Follow-up: the three siblings this originally missed (2026-08-24)

The first pass guarded only `api/lottery-finder.ts` and `api/silent-boom-feed.ts`.
Three more endpoints bind the **identical** predicate and were left unguarded, so
with no model published they returned zero rows while the feeds showed data:

| endpoint                              | line | predicate                              |
| ------------------------------------- | ---- | -------------------------------------- |
| `api/lottery-finder-ticker-counts.ts` | 196  | `chain_max_takeit >= ${minTakeitProb}` |
| `api/silent-boom-ticker-counts.ts`    | 178  | `takeit_prob >= ${minTakeitProb}`      |
| `api/silent-boom-export.ts`           | 172  | `takeit_prob >= ${minTakeitProb}`      |

User-visible effect: both ticker chip strips empty, and the CSV export produced
nothing, at the default 0.70 floor.

All three now call `getTakeitCoverage` and fail the floor open on the same terms.
`silent-boom-export` has no body field to carry the flag on its CSV path, so it
sets an `X-Takeit-Unavailable: 1` response header there; its `format=json` path
carries `takeitUnavailable` like the others.

**Lesson for the next predicate change:** grep for the _predicate_, not the
endpoint. `grep -rn 'minTakeitProb' api --include='*.ts' | grep -v __tests__`
lists every binding site in one shot and would have caught all five at once.

## Out of scope

Retraining. Silent Boom has zero labeled rows and lottery has one week (16,858),
against an original 626K training set — see the audit notes. This change makes the
missing model survivable, it does not replace it.
