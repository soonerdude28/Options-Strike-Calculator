---
status: Implemented
date: 2026-08-22
---

# Push subscription repair — the state the UI could not leave

## Goal

A browser that has already granted notification permission must be able to
register a Web Push subscription. Today it cannot, and there is no control
anywhere in the app that lets the owner fix it.

## The defect

`pushSub.subscribe()` has exactly one caller in the entire frontend — the
Enable button inside `NotificationPermission` (`src/App.tsx:1506`). That
component returns `null` unless `Notification.permission === 'default'`
(`src/components/NotificationPermission.tsx:34`).

So the moment permission is answered — Allow _or_ Block — the only path to a
push subscription disappears. A browser that granted permission during the
Phase 3 in-tab-notification era, before Web Push v2 shipped, lands in a state
it cannot leave: permission `granted`, zero push subscriptions, banner hidden
forever. `usePushSubscription`'s mount effect only _reads_
`getSubscription()`; it never creates one.

Observed 2026-08-22: `SELECT count(*) FROM push_subscriptions` → **0**, while
`POST /api/push/notify` accepts payloads and reports `sent: 0`. Every push
the app has ever sent went nowhere, and nothing in the UI said so.

## Fix

**1. Repair on mount (`usePushSubscription`).** When the mount check finds no
subscription, and push is supported, and VAPID is configured, and
`Notification.permission === 'granted'`, and the visitor is the owner — call
`subscribe()` once. Permission is already granted, so the browser shows no
prompt: this is silent, and it is the whole fix for anyone already in the
dead-end state.

Owner-gated because `POST /api/push/subscribe` is `guardOwnerEndpoint`; a
guest auto-subscribing would earn a 401 and a visible error for nothing.
Guarded by a ref so React StrictMode's double-invoked effect does not double
POST.

**2. Make the state visible (`NotificationPermission`).** The component grows
from one state to four, so it can say what is wrong instead of vanishing:

| variant       | condition                                   | offers                          |
| ------------- | ------------------------------------------- | ------------------------------- |
| `ask`         | `permission === 'default'`                  | Enable / Not now (unchanged)    |
| `repair`      | owner, `granted`, supported, not subscribed | Register / Not now              |
| `unsupported` | owner, `granted`, **not** supported         | iOS Home-Screen hint / Dismiss  |
| `blocked`     | owner, `denied`                             | reset-permission hint / Dismiss |

`repair` is the manual fallback for when the automatic repair could not run or
failed (VAPID missing, server rejected). `unsupported` exists because iOS only
exposes `PushManager` to a site installed on the Home Screen, which is the
actual answer for an iPhone and is otherwise unguessable.

Non-owners keep seeing exactly what they see today: the `ask` prompt or
nothing.

## Files

| file                                                       | change                                                                                                   |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `src/hooks/usePushSubscription.ts`                         | `supported` on the returned state; repair-on-mount; `subscribe` moved above the effect that now calls it |
| `src/components/NotificationPermission.tsx`                | four variants, new props                                                                                 |
| `src/App.tsx`                                              | pass `pushSubscribed`, `pushSupported`, `isOwner`                                                        |
| `src/components/notification-variant.ts`                   | new — variant rules + copy, split out so the component file exports only a component                     |
| `src/__tests__/usePushSubscription.test.tsx`               | repair-path tests                                                                                        |
| `src/__tests__/components/NotificationPermission.test.tsx` | variant resolution + the new rows                                                                        |

## Not in scope

- Recovering a `denied` permission from inside the page. A browser-level block
  is not revocable by script, by design; the row says so and stops there.
- Server-side pruning of stale subscription rows. `sendPushToOwner` already
  counts `expired` and the table is small.
