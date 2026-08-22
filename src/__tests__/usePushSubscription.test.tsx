// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import { usePushSubscription } from '../hooks/usePushSubscription';

// ── Helpers ────────────────────────────────────────────────────

interface MockSubscription {
  endpoint: string;
  unsubscribe: ReturnType<typeof vi.fn>;
  toJSON: () => {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };
}

function makeSubscription(
  endpoint = 'https://fcm.googleapis.com/fcm/send/abc',
): MockSubscription {
  return {
    endpoint,
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    toJSON: () => ({
      endpoint,
      keys: { p256dh: 'p256-key', auth: 'auth-key' },
    }),
  };
}

function mockServiceWorker(opts: {
  existing?: MockSubscription | null;
  subscribeResult?: MockSubscription;
}) {
  const getSubscription = vi.fn().mockResolvedValue(opts.existing ?? null);
  const subscribe = vi
    .fn()
    .mockResolvedValue(opts.subscribeResult ?? makeSubscription());
  Object.defineProperty(globalThis.navigator, 'serviceWorker', {
    configurable: true,
    value: {
      ready: Promise.resolve({
        pushManager: { getSubscription, subscribe },
      }),
    },
  });
  return { getSubscription, subscribe };
}

function setNotificationPermission(p: NotificationPermission): void {
  const requestPermission = vi.fn().mockResolvedValue(p);
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: Object.assign(
      function Notification() {
        /* stub */
      },
      { permission: p, requestPermission },
    ),
  });
}

function mockPushManager(): void {
  // Mark PushManager as present on globalThis so hasPushSupport returns true.
  Object.defineProperty(globalThis, 'PushManager', {
    configurable: true,
    value: function PushManager() {
      /* stub */
    },
  });
}

function mockFetch(ok = true): ReturnType<typeof vi.fn> {
  const fetch = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: vi.fn().mockResolvedValue({}),
  });
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
  return fetch;
}

beforeEach(() => {
  import.meta.env.VITE_VAPID_PUBLIC_KEY = 'BJsxxx-test-vapid-pubkey-base64';
  setNotificationPermission('default');
  mockPushManager();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (import.meta.env as Record<string, unknown>).VITE_VAPID_PUBLIC_KEY;
  // The owner-gate test flips DEV; put it back so ordering cannot matter.
  (import.meta.env as Record<string, unknown>).DEV = true;
});

describe('usePushSubscription mount check', () => {
  it('reports subscribed=false when no existing subscription', async () => {
    mockServiceWorker({ existing: null });
    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => {
      expect(result.current.subscribed).toBe(false);
    });
  });

  it('reports subscribed=true when an existing subscription is found', async () => {
    mockServiceWorker({ existing: makeSubscription() });
    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => {
      expect(result.current.subscribed).toBe(true);
    });
  });

  it('falls back to subscribed=false when serviceWorker is unsupported', async () => {
    // Remove the navigator.serviceWorker shim entirely.
    Object.defineProperty(globalThis.navigator, 'serviceWorker', {
      configurable: true,
      value: undefined,
    });
    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => {
      expect(result.current.subscribed).toBe(false);
    });
  });
});

describe('repair on mount', () => {
  // The state the UI could not leave: permission granted (from the
  // in-tab-notification era), no push subscription, and the only
  // Enable button hidden because permission is no longer 'default'.
  it('registers a subscription when permission is already granted', async () => {
    setNotificationPermission('granted');
    const { subscribe } = mockServiceWorker({ existing: null });
    const fetchMock = mockFetch();

    const { result } = renderHook(() => usePushSubscription());

    await waitFor(() => expect(result.current.subscribed).toBe(true));
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/push/subscribe',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.current.error).toBeNull();
  });

  it('does not repair when permission has not been granted', async () => {
    setNotificationPermission('default');
    const { subscribe } = mockServiceWorker({ existing: null });
    const fetchMock = mockFetch();

    const { result } = renderHook(() => usePushSubscription());

    await waitFor(() => expect(result.current.subscribed).toBe(false));
    expect(subscribe).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not repair when a subscription already exists', async () => {
    setNotificationPermission('granted');
    const { subscribe } = mockServiceWorker({ existing: makeSubscription() });
    const fetchMock = mockFetch();

    const { result } = renderHook(() => usePushSubscription());

    await waitFor(() => expect(result.current.subscribed).toBe(true));
    expect(subscribe).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not repair while VAPID is unconfigured', async () => {
    import.meta.env.VITE_VAPID_PUBLIC_KEY = '';
    setNotificationPermission('granted');
    const { subscribe } = mockServiceWorker({ existing: null });

    const { result } = renderHook(() => usePushSubscription());

    await waitFor(() => expect(result.current.subscribed).toBe(false));
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('reports subscribed=false when the repair is rejected by the server', async () => {
    setNotificationPermission('granted');
    mockServiceWorker({ existing: null });
    mockFetch(false);

    const { result } = renderHook(() => usePushSubscription());

    await waitFor(() => expect(result.current.subscribed).toBe(false));
    // The row that offers a manual retry keys off exactly this pair.
    expect(result.current.error).toMatch(/500/);
  });

  it('does not repair for a visitor who is not the owner', async () => {
    // POST /api/push/subscribe is guardOwnerEndpoint. A guest browser
    // auto-subscribing would collect a 401 and show an error about
    // something it never asked for. (DEV=false + no sc-hint cookie in
    // jsdom is what checkIsOwner() reads as "not the owner".)
    (import.meta.env as Record<string, unknown>).DEV = false;
    setNotificationPermission('granted');
    const { subscribe } = mockServiceWorker({ existing: null });
    const fetchMock = mockFetch();

    const { result } = renderHook(() => usePushSubscription());

    await waitFor(() => expect(result.current.subscribed).toBe(false));
    expect(subscribe).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports support so callers can offer the iOS install hint', async () => {
    setNotificationPermission('granted');
    mockServiceWorker({ existing: makeSubscription() });
    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.subscribed).toBe(true));
    expect(result.current.supported).toBe(true);
  });

  it('reports supported=false when the browser has no PushManager', async () => {
    // iOS Safari outside a Home Screen install.
    Reflect.deleteProperty(globalThis, 'PushManager');
    setNotificationPermission('granted');
    const { subscribe } = mockServiceWorker({ existing: null });

    const { result } = renderHook(() => usePushSubscription());

    await waitFor(() => expect(result.current.subscribed).toBe(false));
    expect(result.current.supported).toBe(false);
    expect(subscribe).not.toHaveBeenCalled();
  });
});

describe('subscribe()', () => {
  it('runs grant + register + POST when permission granted', async () => {
    const newSub = makeSubscription();
    const { subscribe } = mockServiceWorker({
      existing: null,
      subscribeResult: newSub,
    });
    setNotificationPermission('default');
    const requestPermission = vi
      .fn()
      .mockResolvedValue('granted' as NotificationPermission);
    (
      Notification as unknown as { requestPermission: typeof requestPermission }
    ).requestPermission = requestPermission;
    const fetch = mockFetch(true);

    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => {
      expect(result.current.subscribed).not.toBeNull();
    });

    await act(async () => {
      await result.current.subscribe();
    });

    expect(requestPermission).toHaveBeenCalled();
    expect(subscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        userVisibleOnly: true,
        // Decoded VAPID key arrives as the underlying ArrayBuffer per
        // the BufferSource cast in usePushSubscription — see the
        // PushManager TS lib typing.
        applicationServerKey: expect.any(ArrayBuffer),
      }),
    );
    expect(fetch).toHaveBeenCalledWith(
      '/api/push/subscribe',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    expect(result.current.subscribed).toBe(true);
  });

  it('sets error when permission is denied', async () => {
    mockServiceWorker({ existing: null });
    const requestPermission = vi
      .fn()
      .mockResolvedValue('denied' as NotificationPermission);
    (
      Notification as unknown as { requestPermission: typeof requestPermission }
    ).requestPermission = requestPermission;
    mockFetch(true);

    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => {
      expect(result.current.subscribed).not.toBeNull();
    });

    await act(async () => {
      await result.current.subscribe();
    });

    expect(result.current.error).toContain('denied');
    expect(result.current.subscribed).toBe(false);
  });

  it('is a silent no-op when VITE_VAPID_PUBLIC_KEY is empty', async () => {
    import.meta.env.VITE_VAPID_PUBLIC_KEY = '';
    mockServiceWorker({ existing: null });
    const fetch = mockFetch(true);

    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => {
      expect(result.current.subscribed).not.toBeNull();
    });

    await act(async () => {
      await result.current.subscribe();
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });

  it('reuses an existing subscription without calling pushManager.subscribe()', async () => {
    const existing = makeSubscription();
    const { subscribe } = mockServiceWorker({ existing });
    const requestPermission = vi
      .fn()
      .mockResolvedValue('granted' as NotificationPermission);
    (
      Notification as unknown as { requestPermission: typeof requestPermission }
    ).requestPermission = requestPermission;
    mockFetch(true);

    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => {
      expect(result.current.subscribed).toBe(true);
    });

    await act(async () => {
      await result.current.subscribe();
    });

    expect(subscribe).not.toHaveBeenCalled(); // existing reused
    expect(result.current.subscribed).toBe(true);
  });

  it('reports server rejection as an error', async () => {
    mockServiceWorker({ existing: null });
    const requestPermission = vi
      .fn()
      .mockResolvedValue('granted' as NotificationPermission);
    (
      Notification as unknown as { requestPermission: typeof requestPermission }
    ).requestPermission = requestPermission;
    mockFetch(false); // server returns 500

    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => {
      expect(result.current.subscribed).not.toBeNull();
    });

    await act(async () => {
      await result.current.subscribe();
    });

    expect(result.current.error).toContain('500');
  });
});

describe('unsubscribe()', () => {
  it('calls browser.unsubscribe() and POSTs to server', async () => {
    const existing = makeSubscription();
    mockServiceWorker({ existing });
    const fetch = mockFetch(true);

    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => {
      expect(result.current.subscribed).toBe(true);
    });

    await act(async () => {
      await result.current.unsubscribe();
    });

    expect(existing.unsubscribe).toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      '/api/push/unsubscribe',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    expect(result.current.subscribed).toBe(false);
  });

  it('no-ops when no subscription exists', async () => {
    mockServiceWorker({ existing: null });
    const fetch = mockFetch(true);

    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => {
      expect(result.current.subscribed).toBe(false);
    });

    await act(async () => {
      await result.current.unsubscribe();
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(result.current.subscribed).toBe(false);
  });
});
