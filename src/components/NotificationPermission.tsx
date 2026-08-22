/**
 * NotificationPermission — the one place the app tells the owner that
 * alerts cannot reach this browser, and offers the fix.
 *
 * It used to render only while `Notification.permission === 'default'`,
 * which meant it disappeared the moment the question was answered — and
 * since its Enable button is the only caller of `usePushSubscription`'s
 * `subscribe()`, a browser that had granted permission before Web Push
 * shipped could never register a subscription and nothing on the page
 * said so. Four states now, so each dead end has a way out: `ask`,
 * `repair`, `unsupported`, `blocked`. The rules and the copy live in
 * `notification-variant.ts`.
 *
 * "Not now" / "Dismiss" suppresses the strip for 24 hours via
 * localStorage — one key for every variant, so dismissing means "stop
 * telling me about notifications today", not "stop telling me about
 * this one thing".
 *
 * Spec: docs/superpowers/specs/push-subscription-repair-2026-08-22.md
 */

import { useState } from 'react';
import {
  NOTIFICATION_COPY,
  resolveVariant,
  type VariantDisplay,
  type VariantInputs,
} from './notification-variant';

const STORAGE_KEY = 'notif-prompt-dismissed';
const DISMISS_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

function isDismissed(): boolean {
  try {
    const ts = localStorage.getItem(STORAGE_KEY);
    if (!ts) return false;
    return Date.now() - Number(ts) < DISMISS_DURATION_MS;
  } catch {
    return false;
  }
}

interface NotificationPermissionProps extends VariantInputs, VariantDisplay {
  onRequest: () => Promise<void>;
}

export default function NotificationPermission({
  permission,
  pushSubscribed = null,
  pushSupported = false,
  isOwner = false,
  pushError = null,
  pushPending = false,
  onRequest,
}: Readonly<NotificationPermissionProps>) {
  const [dismissed, setDismissed] = useState(isDismissed);

  const variant = resolveVariant({
    permission,
    pushSubscribed,
    pushSupported,
    isOwner,
  });
  if (variant == null || dismissed) return null;

  const handleDismiss = () => {
    try {
      localStorage.setItem(STORAGE_KEY, String(Date.now()));
    } catch {
      // localStorage unavailable
    }
    setDismissed(true);
  };

  const copy = NOTIFICATION_COPY[variant];

  return (
    <div
      data-testid={`notification-permission-${variant}`}
      className="border-edge bg-surface mx-auto mt-2 flex max-w-2xl items-center gap-3 rounded-lg border p-2.5 px-4 font-sans text-xs"
    >
      <span className="text-secondary flex-1">
        {copy.message}
        {pushError ? (
          <span
            className="text-tertiary block"
            data-testid="notification-permission-error"
          >
            Last attempt failed: {pushError}
          </span>
        ) : null}
      </span>
      {copy.action ? (
        <button
          onClick={onRequest}
          disabled={pushPending}
          className="bg-accent rounded px-3 py-1 font-semibold text-white transition-opacity hover:opacity-80 disabled:opacity-50"
        >
          {pushPending ? 'Working…' : copy.action}
        </button>
      ) : null}
      <button
        onClick={handleDismiss}
        className="text-tertiary transition-opacity hover:opacity-80"
      >
        {copy.dismiss}
      </button>
    </div>
  );
}
