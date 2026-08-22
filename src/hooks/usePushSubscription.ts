/**
 * usePushSubscription — manages the browser's Web Push subscription
 * for SPXW Interval B/A alerts v2.
 *
 * Lifecycle:
 *   1. On mount, checks `serviceWorker.ready.pushManager.getSubscription()`
 *      to see if the user already has a live subscription (e.g. from a
 *      previous session). Updates `subscribed` accordingly.
 *   2. `subscribe()` runs the full grant + register + POST flow:
 *      a. `Notification.requestPermission()`
 *      b. `registration.pushManager.subscribe({...})`
 *      c. POST the subscription JSON to `/api/push/subscribe`
 *   3. `unsubscribe()` reverses the steps and notifies the server.
 *
 * Repair on mount: if the check in step 1 finds no subscription while
 * `Notification.permission` is already `granted`, the owner is in a
 * state the UI used to have no way out of — the "Enable notifications"
 * banner only renders while permission is `default`, and it is the sole
 * caller of `subscribe()`. So step 1 runs step 2 itself. Permission is
 * already granted, so the browser shows no prompt; the effect is
 * invisible and creates the subscription that should have existed.
 * Owner-only, because `POST /api/push/subscribe` is owner-gated and a
 * guest would earn a 401 for nothing.
 *
 * Spec: docs/superpowers/specs/push-subscription-repair-2026-08-22.md
 *
 * `VITE_VAPID_PUBLIC_KEY` must be set in the build env for any of
 * this to work — when empty, `subscribe()` no-ops silently. That keeps
 * v2 dormant until the operator wires up VAPID keys on both
 * Vercel + the build pipeline, mirroring the Phase 1 `interval_ba_enabled`
 * pattern in uw-stream.
 *
 * Spec: docs/superpowers/specs/interval-ba-push-v2-2026-05-12.md (Phase 4e).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { captureUnlessAuth } from '../lib/sentry-helpers';
import { checkIsOwner } from '../utils/auth';

export interface PushSubscriptionState {
  /**
   * `null` while the initial check is in flight; `true` if a live
   * subscription exists on the browser; `false` if none / permission
   * denied / Web Push unsupported.
   */
  subscribed: boolean | null;
  /**
   * Whether this browser can do Web Push at all. False in a browser
   * without `PushManager` — notably iOS Safari, which exposes it only to
   * a site installed on the Home Screen. Callers use it to offer the
   * install hint instead of a button that cannot work.
   */
  supported: boolean;
  /** User-clickable trigger that does the full grant + subscribe flow. */
  subscribe: () => Promise<void>;
  /** Reverse the subscription, notify the server. */
  unsubscribe: () => Promise<void>;
  /** Last error from a subscribe/unsubscribe call (display-only). */
  error: string | null;
  /**
   * True while a subscribe/unsubscribe is in flight. Worth surfacing:
   * `navigator.serviceWorker.ready` can hang indefinitely if the worker
   * never activates, and without this the button looks inert — the user
   * clicks, nothing moves, and there is no way to tell "working" from
   * "broken".
   */
  pending: boolean;
}

/**
 * Convert URL-safe base64 (the VAPID public key wire format) to the
 * Uint8Array shape `pushManager.subscribe`'s `applicationServerKey`
 * expects. See https://www.rfc-editor.org/rfc/rfc8292#section-2.
 */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const base64Padded = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = globalThis.atob(base64Padded);
  const out = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    out[i] = rawData.charCodeAt(i);
  }
  return out;
}

function hasPushSupport(): boolean {
  return (
    typeof Notification !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    navigator.serviceWorker != null &&
    'PushManager' in globalThis
  );
}

async function postSubscription(subscription: PushSubscription): Promise<void> {
  const body = subscription.toJSON();
  if (!body.endpoint || !body.keys) {
    throw new Error('Browser returned subscription without endpoint/keys');
  }
  const res = await fetch('/api/push/subscribe', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      endpoint: body.endpoint,
      keys: body.keys,
      user_agent: navigator.userAgent,
    }),
  });
  if (!res.ok) {
    const error = new Error(
      `Server rejected subscription: ${res.status}`,
    ) as Error & { status?: number };
    error.status = res.status;
    throw error;
  }
}

async function postUnsubscribe(endpoint: string): Promise<void> {
  // Best-effort — the server-side row is mostly housekeeping; the
  // actual push delivery stops the moment subscription.unsubscribe()
  // succeeds in the browser. We surface server-side failures as a
  // hook error but the browser is already unsubscribed.
  const res = await fetch('/api/push/unsubscribe', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  });
  if (!res.ok) {
    const error = new Error(
      `Server rejected unsubscribe: ${res.status}`,
    ) as Error & { status?: number };
    error.status = res.status;
    throw error;
  }
}

/**
 * Whether a missing subscription should be repaired without being asked.
 *
 * Every clause is load-bearing: no VAPID key means v2 is dormant;
 * a permission other than `granted` means repairing would put a prompt
 * in front of someone who did not click anything; and a non-owner cannot
 * POST to the owner-gated subscribe endpoint.
 */
function canRepairSilently(): boolean {
  return (
    Boolean(import.meta.env.VITE_VAPID_PUBLIC_KEY) &&
    typeof Notification !== 'undefined' &&
    Notification.permission === 'granted' &&
    checkIsOwner()
  );
}

export function usePushSubscription(): PushSubscriptionState {
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const mountedRef = useRef(true);
  const repairedRef = useRef(false);
  const supported = hasPushSupport();

  const subscribe = useCallback(async () => {
    setError(null);
    setPending(true);
    try {
      const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;
      if (!vapidKey) {
        // v2 dormant — VAPID not configured. Silent return so the
        // existing "Enable notifications" CTA stays functional for
        // the legacy in-tab Notification path (Phase 3).
        return;
      }
      if (!hasPushSupport()) {
        setError('Web Push not supported in this browser');
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setError(`Permission ${permission}`);
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          // PushManager's TS def requires BufferSource (ArrayBufferView<
          // ArrayBuffer>). Uint8Array<ArrayBufferLike> is structurally
          // compatible at runtime but the strict lib types reject the
          // cast — pass the underlying buffer explicitly.
          applicationServerKey: urlBase64ToUint8Array(vapidKey)
            .buffer as ArrayBuffer,
        }));
      await postSubscription(subscription);
      if (mountedRef.current) setSubscribed(true);
    } catch (e) {
      captureUnlessAuth(e, { tags: { context: 'push_subscription' } });
      const msg = e instanceof Error ? e.message : String(e);
      if (mountedRef.current) setError(msg);
    } finally {
      if (mountedRef.current) setPending(false);
    }
  }, []);

  // Declared after `subscribe` because it calls it. `subscribe` is a
  // `useCallback` with no dependencies, so its identity is stable and
  // this effect still runs exactly once per mount.
  useEffect(() => {
    mountedRef.current = true;
    if (!hasPushSupport()) {
      setSubscribed(false);
      return;
    }
    navigator.serviceWorker.ready
      .then(async (reg) => {
        const sub = await reg.pushManager.getSubscription();
        if (!mountedRef.current) return;
        if (sub != null) {
          setSubscribed(true);
          return;
        }
        if (repairedRef.current || !canRepairSilently()) {
          setSubscribed(false);
          return;
        }
        // The repair. `subscribed` is deliberately left null until this
        // resolves: flipping it to false first would flash the "push
        // isn't registered" row on every load for a browser that is
        // about to register one.
        repairedRef.current = true; // StrictMode invokes effects twice
        await subscribe();
        // subscribe() sets true on success and leaves it alone on
        // failure, so this only lands when the repair did not take.
        if (mountedRef.current) setSubscribed((prev) => prev ?? false);
      })
      .catch(() => {
        if (mountedRef.current) setSubscribed(false);
      });
    return () => {
      mountedRef.current = false;
    };
  }, [subscribe]);

  const unsubscribe = useCallback(async () => {
    setError(null);
    setPending(true);
    try {
      if (!hasPushSupport()) {
        if (mountedRef.current) setSubscribed(false);
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        if (mountedRef.current) setSubscribed(false);
        return;
      }
      const endpoint = subscription.endpoint;
      await subscription.unsubscribe();
      await postUnsubscribe(endpoint);
      if (mountedRef.current) setSubscribed(false);
    } catch (e) {
      captureUnlessAuth(e, { tags: { context: 'push_subscription' } });
      const msg = e instanceof Error ? e.message : String(e);
      if (mountedRef.current) setError(msg);
    } finally {
      if (mountedRef.current) setPending(false);
    }
  }, []);

  return { subscribed, supported, subscribe, unsubscribe, error, pending };
}
