/**
 * Which notification row to show, and what it says.
 *
 * Split out of `NotificationPermission.tsx` so that file exports only a
 * component (react-refresh/only-export-components), and so the rules can
 * be read and tested without rendering anything — the same split as
 * `PanelPrefsModal/drag-resolver.ts`.
 *
 * Spec: docs/superpowers/specs/push-subscription-repair-2026-08-22.md
 */

export type NotificationVariant = 'ask' | 'repair' | 'unsupported' | 'blocked';

export interface VariantInputs {
  permission: NotificationPermission | 'unsupported';
  /**
   * From `usePushSubscription`. `null` while the mount check (and any
   * silent repair it triggers) is still in flight — no push variant
   * renders until it settles, so the row never flashes on a load that
   * is about to register a subscription anyway.
   */
  pushSubscribed?: boolean | null;
  /** From `usePushSubscription`. False in a browser without PushManager. */
  pushSupported?: boolean;
  /** Non-owners only ever see the `ask` prompt. */
  isOwner?: boolean;
}

/**
 * The row to render, or `null` for silence.
 *
 * Order matters. `ask` comes first because an unanswered permission is
 * the only state a non-owner can act on. Everything below it is
 * owner-only: `POST /api/push/subscribe` is owner-gated, so a guest
 * pressing Register would collect a 401 about something they never
 * asked for.
 */
export function resolveVariant({
  permission,
  pushSubscribed = null,
  pushSupported = false,
  isOwner = false,
}: VariantInputs): NotificationVariant | null {
  if (permission === 'default') return 'ask';
  if (!isOwner) return null;
  if (permission === 'denied') return 'blocked';
  if (permission === 'granted' && pushSubscribed === false) {
    return pushSupported ? 'repair' : 'unsupported';
  }
  return null;
}

export const NOTIFICATION_COPY: Record<
  NotificationVariant,
  { message: string; action?: string; dismiss: string }
> = {
  ask: {
    message: 'Enable desktop notifications for real-time market alerts',
    action: 'Enable',
    dismiss: 'Not now',
  },
  repair: {
    message:
      "Notifications are on, but alerts can't reach this browser — push isn't registered",
    action: 'Register',
    dismiss: 'Not now',
  },
  unsupported: {
    message:
      'This browser cannot receive push. On iPhone, add this app to your Home Screen and enable notifications there',
    dismiss: 'Dismiss',
  },
  blocked: {
    message:
      'Notifications are blocked for this site. Reset the permission in your browser settings, then reload',
    dismiss: 'Dismiss',
  },
};
