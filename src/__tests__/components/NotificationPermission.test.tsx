import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import NotificationPermission from '../../components/NotificationPermission';
import { resolveVariant } from '../../components/notification-variant';

// ── Lifecycle ─────────────────────────────────────────────

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
});

// ============================================================
// RENDERING CONDITIONS
// ============================================================

describe('NotificationPermission: rendering conditions', () => {
  it('renders when permission is default', () => {
    render(<NotificationPermission permission="default" onRequest={vi.fn()} />);

    expect(
      screen.getByText(
        'Enable desktop notifications for real-time market alerts',
      ),
    ).toBeInTheDocument();
  });

  it('does NOT render when permission is granted', () => {
    const { container } = render(
      <NotificationPermission permission="granted" onRequest={vi.fn()} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('does NOT render when permission is denied', () => {
    const { container } = render(
      <NotificationPermission permission="denied" onRequest={vi.fn()} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('does NOT render when permission is unsupported', () => {
    const { container } = render(
      <NotificationPermission permission="unsupported" onRequest={vi.fn()} />,
    );
    expect(container.innerHTML).toBe('');
  });
});

// ============================================================
// ENABLE BUTTON
// ============================================================

describe('NotificationPermission: Enable button', () => {
  it('calls onRequest when Enable button is clicked', async () => {
    const user = userEvent.setup();
    const onRequest = vi.fn().mockResolvedValue(undefined);

    render(
      <NotificationPermission permission="default" onRequest={onRequest} />,
    );

    const enableBtn = screen.getByRole('button', { name: 'Enable' });
    await user.click(enableBtn);

    expect(onRequest).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// DISMISS BEHAVIOR
// ============================================================

describe('NotificationPermission: dismiss behavior', () => {
  it('hides after clicking "Not now"', async () => {
    const user = userEvent.setup();

    const { container } = render(
      <NotificationPermission permission="default" onRequest={vi.fn()} />,
    );

    // Visible before dismiss
    expect(
      screen.getByText(
        'Enable desktop notifications for real-time market alerts',
      ),
    ).toBeInTheDocument();

    const notNowBtn = screen.getByRole('button', { name: 'Not now' });
    await user.click(notNowBtn);

    // Should be hidden after dismiss
    expect(container.innerHTML).toBe('');
  });

  it('sets localStorage key on dismiss', async () => {
    const user = userEvent.setup();

    render(<NotificationPermission permission="default" onRequest={vi.fn()} />);

    const notNowBtn = screen.getByRole('button', { name: 'Not now' });
    await user.click(notNowBtn);

    expect(localStorage.getItem('notif-prompt-dismissed')).not.toBeNull();
    const ts = Number(localStorage.getItem('notif-prompt-dismissed'));
    // Timestamp should be a recent value (within last 5 seconds)
    expect(Date.now() - ts).toBeLessThan(5000);
  });
});

// ============================================================
// LOCALSTORAGE PERSISTENCE
// ============================================================

describe('NotificationPermission: localStorage persistence', () => {
  it('does NOT render when localStorage says recently dismissed', () => {
    // Set a recent dismiss timestamp
    localStorage.setItem('notif-prompt-dismissed', String(Date.now()));

    const { container } = render(
      <NotificationPermission permission="default" onRequest={vi.fn()} />,
    );

    expect(container.innerHTML).toBe('');
  });

  it('renders again after 24 hours have passed since dismiss', () => {
    vi.useFakeTimers();

    // Set dismiss timestamp to 25 hours ago
    const twentyFiveHoursAgo = Date.now() - 25 * 60 * 60 * 1000;
    localStorage.setItem('notif-prompt-dismissed', String(twentyFiveHoursAgo));

    render(<NotificationPermission permission="default" onRequest={vi.fn()} />);

    expect(
      screen.getByText(
        'Enable desktop notifications for real-time market alerts',
      ),
    ).toBeInTheDocument();
  });

  it('does NOT render when dismissed less than 24 hours ago', () => {
    vi.useFakeTimers();

    // Set dismiss timestamp to 23 hours ago
    const twentyThreeHoursAgo = Date.now() - 23 * 60 * 60 * 1000;
    localStorage.setItem('notif-prompt-dismissed', String(twentyThreeHoursAgo));

    const { container } = render(
      <NotificationPermission permission="default" onRequest={vi.fn()} />,
    );

    expect(container.innerHTML).toBe('');
  });

  it('handles corrupt localStorage value gracefully', () => {
    localStorage.setItem('notif-prompt-dismissed', 'not-a-number');

    render(<NotificationPermission permission="default" onRequest={vi.fn()} />);

    // NaN arithmetic makes isDismissed() return false, so it renders
    expect(
      screen.getByText(
        'Enable desktop notifications for real-time market alerts',
      ),
    ).toBeInTheDocument();
  });
});

// ============================================================
// BUTTONS PRESENT
// ============================================================

describe('NotificationPermission: button presence', () => {
  it('renders both Enable and Not now buttons', () => {
    render(<NotificationPermission permission="default" onRequest={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Enable' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument();
  });
});

// ============================================================
// PUSH-SUBSCRIPTION VARIANTS
// ============================================================
//
// The states added by the push-subscription repair. Before them this
// component vanished the moment permission was answered, which left the
// only caller of `subscribe()` unreachable and the owner with no way to
// register a device.
//
// Spec: docs/superpowers/specs/push-subscription-repair-2026-08-22.md

describe('resolveVariant', () => {
  it("asks whenever permission is still 'default', owner or not", () => {
    expect(resolveVariant({ permission: 'default' })).toBe('ask');
    expect(resolveVariant({ permission: 'default', isOwner: true })).toBe(
      'ask',
    );
  });

  it('offers to repair a granted browser with no subscription', () => {
    expect(
      resolveVariant({
        permission: 'granted',
        pushSubscribed: false,
        pushSupported: true,
        isOwner: true,
      }),
    ).toBe('repair');
  });

  it('explains instead of offering when the browser cannot do push', () => {
    // iOS Safari outside a Home Screen install: a Register button here
    // could not work, so the row must not show one.
    expect(
      resolveVariant({
        permission: 'granted',
        pushSubscribed: false,
        pushSupported: false,
        isOwner: true,
      }),
    ).toBe('unsupported');
  });

  it('reports a browser-level block', () => {
    expect(resolveVariant({ permission: 'denied', isOwner: true })).toBe(
      'blocked',
    );
  });

  it('says nothing while the subscription check is still in flight', () => {
    // pushSubscribed === null. Rendering "push isn't registered" here
    // would flash on every load of a perfectly healthy browser.
    expect(
      resolveVariant({
        permission: 'granted',
        pushSubscribed: null,
        pushSupported: true,
        isOwner: true,
      }),
    ).toBeNull();
  });

  it('says nothing when a subscription already exists', () => {
    expect(
      resolveVariant({
        permission: 'granted',
        pushSubscribed: true,
        pushSupported: true,
        isOwner: true,
      }),
    ).toBeNull();
  });

  it('shows a non-owner nothing beyond the initial ask', () => {
    // /api/push/subscribe is owner-gated; a guest pressing Register
    // would collect a 401 about something they never asked for.
    for (const permission of ['granted', 'denied'] as const) {
      expect(
        resolveVariant({
          permission,
          pushSubscribed: false,
          pushSupported: true,
          isOwner: false,
        }),
      ).toBeNull();
    }
  });
});

describe('NotificationPermission: push repair rows', () => {
  it('offers Register when push is granted but not subscribed', async () => {
    const onRequest = vi.fn().mockResolvedValue(undefined);
    render(
      <NotificationPermission
        permission="granted"
        pushSubscribed={false}
        pushSupported
        isOwner
        onRequest={onRequest}
      />,
    );

    expect(
      screen.getByTestId('notification-permission-repair'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Register' }));
    expect(onRequest).toHaveBeenCalledTimes(1);
  });

  it('gives the unsupported browser no button it cannot honour', () => {
    render(
      <NotificationPermission
        permission="granted"
        pushSubscribed={false}
        pushSupported={false}
        isOwner
        onRequest={vi.fn()}
      />,
    );

    expect(screen.getByText(/Home Screen/i)).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });

  it('tells a blocked owner where the fix lives', () => {
    render(
      <NotificationPermission
        permission="denied"
        isOwner
        onRequest={vi.fn()}
      />,
    );

    expect(screen.getByText(/blocked for this site/i)).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('stays quiet for 24 hours after a dismissal, whatever the variant', () => {
    localStorage.setItem('notif-prompt-dismissed', String(Date.now()));
    const { container } = render(
      <NotificationPermission
        permission="granted"
        pushSubscribed={false}
        pushSupported
        isOwner
        onRequest={vi.fn()}
      />,
    );

    expect(container.innerHTML).toBe('');
  });
});

describe('NotificationPermission: failure feedback', () => {
  it('shows why the last registration failed', () => {
    // Without this the row offers a button, the press fails inside the
    // hook, and the user sees nothing move — which is exactly how the
    // first version of this fix presented as "it won't let me click".
    render(
      <NotificationPermission
        permission="granted"
        pushSubscribed={false}
        pushSupported
        isOwner
        pushError="Server rejected subscription: 403"
        onRequest={vi.fn()}
      />,
    );

    expect(
      screen.getByTestId('notification-permission-error'),
    ).toHaveTextContent('Server rejected subscription: 403');
  });

  it('says it is working and refuses a second press while in flight', async () => {
    const onRequest = vi.fn().mockResolvedValue(undefined);
    render(
      <NotificationPermission
        permission="granted"
        pushSubscribed={false}
        pushSupported
        isOwner
        pushPending
        onRequest={onRequest}
      />,
    );

    const button = screen.getByRole('button', { name: 'Working…' });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(onRequest).not.toHaveBeenCalled();
  });

  it('carries no failure line when there is no failure', () => {
    render(
      <NotificationPermission
        permission="granted"
        pushSubscribed={false}
        pushSupported
        isOwner
        onRequest={vi.fn()}
      />,
    );

    expect(
      screen.queryByTestId('notification-permission-error'),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Register' })).toBeEnabled();
  });
});
