import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import { useAppStore } from "../../store/appStore";
import { SubscriptionRulesModal } from "./SubscriptionRulesModal";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../../schemas/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../schemas/ipc")>();
  return {
    ...actual,
    safeInvoke: vi.fn(),
  };
});

import { invoke } from "@tauri-apps/api/core";
import { safeInvoke } from "../../schemas/ipc";

const mockInvoke = vi.mocked(invoke);
const mockSafeInvoke = vi.mocked(safeInvoke);

const CONN = {
  id: "conn-1",
  name: "Test",
  connectionString: "Endpoint=sb://test.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=dGVzdA==",
  env: {},
};

describe("SubscriptionRulesModal", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
    useAppStore.getState().setConnections([CONN]);
    useAppStore.getState().setActiveConnectionId(CONN.id);
    useAppStore.getState().setExplorerSubscription("billing", "processor");
    useAppStore.getState().setIsSubscriptionRulesModalOpen(true);
    vi.stubGlobal("confirm", vi.fn(() => true));
  });

  it("loads rules and keeps existing rule names read-only", async () => {
    mockSafeInvoke.mockResolvedValueOnce({
      topicName: "billing",
      subscriptionName: "processor",
      rules: [{ name: "$Default", filter: { kind: "true" }, action: null }],
    });

    render(<SubscriptionRulesModal />);

    await screen.findByText("Subscription Rules");
    expect((screen.getByDisplayValue("$Default") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("Existing rule names are read-only in v1.")).toBeTruthy();
  });

  it("creates a new SQL rule", async () => {
    mockSafeInvoke
      .mockResolvedValueOnce({
        topicName: "billing",
        subscriptionName: "processor",
        rules: [{ name: "$Default", filter: { kind: "true" }, action: null }],
      })
      .mockResolvedValueOnce({
        topicName: "billing",
        subscriptionName: "processor",
        rules: [
          { name: "$Default", filter: { kind: "true" }, action: null },
          {
            name: "only-blue",
            filter: { kind: "sql", expression: "sys.Label = @label", parameters: { label: "blue" } },
            action: null,
          },
        ],
      });
    mockInvoke.mockResolvedValue(undefined);

    render(<SubscriptionRulesModal />);

    await screen.findByText("Subscription Rules");
    fireEvent.click(screen.getByRole("button", { name: "New Rule" }));
    fireEvent.change(screen.getByLabelText("Rule Name"), { target: { value: "only-blue" } });
    fireEvent.change(screen.getByLabelText("SQL Expression"), { target: { value: "sys.Label = @label" } });
    fireEvent.change(screen.getByLabelText("SQL Parameters (JSON)"), { target: { value: '{"label":"blue"}' } });
    fireEvent.click(screen.getByRole("button", { name: "Save Rule" }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("create_subscription_rule", {
        args: {
          connectionId: CONN.id,
          topicName: "billing",
          subscriptionName: "processor",
          rule: {
            name: "only-blue",
            filter: {
              kind: "sql",
              expression: "sys.Label = @label",
              parameters: { label: "blue" },
            },
            action: null,
          },
        },
      });
    });
  });

  it("updates an existing correlation rule", async () => {
    mockSafeInvoke
      .mockResolvedValueOnce({
        topicName: "billing",
        subscriptionName: "processor",
        rules: [
          {
            name: "tenant-filter",
            filter: {
              kind: "correlation",
              contentType: null,
              correlationId: "tenant-a",
              messageId: null,
              replyTo: null,
              replyToSessionId: null,
              sessionId: null,
              subject: "invoice.created",
              to: null,
              applicationProperties: { tenant: "blue" },
            },
            action: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        topicName: "billing",
        subscriptionName: "processor",
        rules: [
          {
            name: "tenant-filter",
            filter: {
              kind: "correlation",
              contentType: null,
              correlationId: "tenant-a",
              messageId: null,
              replyTo: null,
              replyToSessionId: null,
              sessionId: null,
              subject: "invoice.updated",
              to: null,
              applicationProperties: { tenant: "blue", priority: "high" },
            },
            action: null,
          },
        ],
      });
    mockInvoke.mockResolvedValue(undefined);

    render(<SubscriptionRulesModal />);

    await screen.findByDisplayValue("tenant-filter");
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "invoice.updated" } });
    fireEvent.change(screen.getByLabelText("Application Properties (JSON)"), {
      target: { value: '{"tenant":"blue","priority":"high"}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Rule" }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("update_subscription_rule", {
        args: {
          connectionId: CONN.id,
          topicName: "billing",
          subscriptionName: "processor",
          rule: {
            name: "tenant-filter",
            filter: {
              kind: "correlation",
              contentType: null,
              correlationId: "tenant-a",
              messageId: null,
              replyTo: null,
              replyToSessionId: null,
              sessionId: null,
              subject: "invoice.updated",
              to: null,
              applicationProperties: { tenant: "blue", priority: "high" },
            },
            action: null,
          },
        },
      });
    });
  });

  it("shows a localized validation error for invalid parameter JSON", async () => {
    mockSafeInvoke.mockResolvedValueOnce({
      topicName: "billing",
      subscriptionName: "processor",
      rules: [],
    });

    render(<SubscriptionRulesModal />);

    await screen.findByText("Subscription Rules");
    fireEvent.click(screen.getByRole("button", { name: "New Rule" }));
    fireEvent.change(screen.getByLabelText("Rule Name"), { target: { value: "bad-rule" } });
    fireEvent.change(screen.getByLabelText("SQL Expression"), { target: { value: "1 = 1" } });
    fireEvent.change(screen.getByLabelText("SQL Parameters (JSON)"), {
      target: { value: '{"nested":{"bad":true}}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Rule" }));

    await waitFor(() => {
      expect(screen.getByText("JSON values must be strings, numbers, or booleans.")).toBeTruthy();
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
