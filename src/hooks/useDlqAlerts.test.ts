import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useDlqAlerts } from "./useDlqAlerts";
import { useAppStore, SUBSCRIPTION_KEY_SEP } from "../store/appStore";

// Mock the notification plugin — covers the dynamic import inside the hook.
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));

import { isPermissionGranted, sendNotification } from "@tauri-apps/plugin-notification";

const mockIsPermissionGranted = vi.mocked(isPermissionGranted);
const mockSendNotification = vi.mocked(sendNotification);

const CONN = {
  id: "conn-1",
  name: "Test",
  connectionString: "Endpoint=sb://test.servicebus.windows.net/;",
  env: {},
};

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState(useAppStore.getInitialState());
  vi.clearAllMocks();
  mockIsPermissionGranted.mockResolvedValue(true);
  useAppStore.getState().setConnections([CONN]);
  useAppStore.getState().setActiveConnectionId(CONN.id);
  useAppStore.getState().setDlqNotificationsEnabled(true);
});

describe("useDlqAlerts", () => {
  it("does not send a notification when DLQ notifications are disabled", async () => {
    useAppStore.getState().setDlqNotificationsEnabled(false);
    useAppStore.getState().setDlqThreshold("queue:my-queue", 3);

    renderHook(() => useDlqAlerts());

    act(() => {
      useAppStore.getState().batchSetCounts(
        [{ name: "my-queue", active: 0, dlq: 5 }],
        [],
      );
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it("does not send a notification when no thresholds are configured", async () => {
    renderHook(() => useDlqAlerts());

    act(() => {
      useAppStore.getState().batchSetCounts(
        [{ name: "my-queue", active: 0, dlq: 99 }],
        [],
      );
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it("sends a notification when a queue DLQ count exceeds its threshold", async () => {
    useAppStore.getState().setDlqThreshold("queue:my-queue", 3);

    renderHook(() => useDlqAlerts());

    act(() => {
      useAppStore.getState().batchSetCounts(
        [{ name: "my-queue", active: 0, dlq: 5 }],
        [],
      );
    });

    await waitFor(() => expect(mockSendNotification).toHaveBeenCalledOnce());

    expect(mockSendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "DLQ Threshold Alert",
        body: expect.stringContaining("my-queue"),
      }),
    );
  });

  it("does not re-notify for the same breach within the same session", async () => {
    useAppStore.getState().setDlqThreshold("queue:my-queue", 3);
    renderHook(() => useDlqAlerts());

    // First breach
    act(() => {
      useAppStore.getState().batchSetCounts([{ name: "my-queue", active: 0, dlq: 5 }], []);
    });
    await waitFor(() => expect(mockSendNotification).toHaveBeenCalledOnce());

    // Second count update — still above threshold but already notified
    act(() => {
      useAppStore.getState().batchSetCounts([{ name: "my-queue", active: 0, dlq: 6 }], []);
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(mockSendNotification).toHaveBeenCalledOnce(); // no additional call
  });

  it("allows re-notification after the count drops back to or below the threshold", async () => {
    useAppStore.getState().setDlqThreshold("queue:my-queue", 3);
    renderHook(() => useDlqAlerts());

    // First breach
    act(() => {
      useAppStore.getState().batchSetCounts([{ name: "my-queue", active: 0, dlq: 5 }], []);
    });
    await waitFor(() => expect(mockSendNotification).toHaveBeenCalledOnce());

    // Recovery: count drops to threshold
    act(() => {
      useAppStore.getState().batchSetCounts([{ name: "my-queue", active: 0, dlq: 3 }], []);
    });

    // Second breach
    act(() => {
      useAppStore.getState().batchSetCounts([{ name: "my-queue", active: 0, dlq: 5 }], []);
    });
    await waitFor(() => expect(mockSendNotification).toHaveBeenCalledTimes(2));
  });

  it("sends a notification for subscription DLQ breaches", async () => {
    const subKey = `my-topic${SUBSCRIPTION_KEY_SEP}my-sub`;
    useAppStore.getState().setDlqThreshold(`subscription:${subKey}`, 2);
    renderHook(() => useDlqAlerts());

    act(() => {
      useAppStore.getState().batchSetCounts(
        [],
        [{ topic: "my-topic", subscription: "my-sub", active: 0, dlq: 10 }],
      );
    });

    await waitFor(() => expect(mockSendNotification).toHaveBeenCalledOnce());
    expect(mockSendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("my-topic/my-sub"),
      }),
    );
  });

  it("clears the notified set when the active connection changes", async () => {
    const CONN_B = { id: "conn-2", name: "B", connectionString: "sb://b", env: {} };
    useAppStore.getState().setConnections([CONN, CONN_B]);
    // threshold must be > 0 (store ignores <= 0)
    useAppStore.getState().setDlqThreshold("queue:q", 3);
    renderHook(() => useDlqAlerts());

    // First breach on CONN
    act(() => {
      useAppStore.getState().batchSetCounts([{ name: "q", active: 0, dlq: 5 }], []);
    });
    await waitFor(() => expect(mockSendNotification).toHaveBeenCalledOnce());

    // Switch to CONN_B — clears the notified set, queueCounts, and dlqThresholds
    act(() => { useAppStore.getState().setActiveConnectionId("conn-2"); });

    // Switch back to CONN — setActiveConnectionId reloads thresholds from localStorage
    // (empty in tests), so we must re-apply the threshold
    act(() => { useAppStore.getState().setActiveConnectionId(CONN.id); });
    act(() => { useAppStore.getState().setDlqThreshold("queue:q", 3); });

    // Second breach — notified set was cleared, so this fires again
    act(() => {
      useAppStore.getState().batchSetCounts([{ name: "q", active: 0, dlq: 5 }], []);
    });
    await waitFor(() => expect(mockSendNotification).toHaveBeenCalledTimes(2));
  });

  it("does not send a notification when permission is denied", async () => {
    mockIsPermissionGranted.mockResolvedValue(false);
    // requestPermission also returns denied
    const { requestPermission } = await import("@tauri-apps/plugin-notification");
    vi.mocked(requestPermission).mockResolvedValue("denied");

    useAppStore.getState().setDlqThreshold("queue:q", 0);
    renderHook(() => useDlqAlerts());

    act(() => {
      useAppStore.getState().batchSetCounts([{ name: "q", active: 0, dlq: 1 }], []);
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(mockSendNotification).not.toHaveBeenCalled();
  });
});
