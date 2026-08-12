import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import { useAppStore } from "../../store/appStore";
import type { Connection } from "../../types";
import { CreateEntityModal } from "./CreateEntityModal";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  refreshEntities: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("../../hooks/useEntityList", () => ({
  useEntityList: () => ({ refreshEntities: mocks.refreshEntities }),
}));

const CONN: Connection = {
  id: "conn-1",
  name: "Test",
  connectionString:
    "Endpoint=sb://test.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=dGVzdA==",
  env: {},
};

function renderModal() {
  const store = useAppStore.getState();
  store.setConnections([CONN]);
  store.setActiveConnectionId(CONN.id);
  store.setEntities({ queues: ["existing-queue"], topics: { orders: ["existing-subscription"] } });
  render(<CreateEntityModal />);
  fireEvent.click(screen.getByRole("button", { name: "Advanced Options" }));
}

function inputFor(label: string): HTMLInputElement {
  const input = screen.getByText(label).parentElement?.querySelector("input");
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing input for ${label}`);
  return input;
}

describe("CreateEntityModal", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    mocks.invoke.mockReset().mockResolvedValue(undefined);
    mocks.refreshEntities.mockReset().mockResolvedValue(undefined);
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "00000000-0000-0000-0000-000000000001" as `${string}-${string}-${string}-${string}-${string}`,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("submits Lock Duration for queues", async () => {
    renderModal();

    fireEvent.change(inputFor("Name"), { target: { value: "new-queue" } });
    fireEvent.change(inputFor("Lock Duration"), { target: { value: "PT45S" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("create_queue", {
        args: {
          connectionId: CONN.id,
          name: "new-queue",
          options: expect.objectContaining({ lockDuration: "PT45S" }),
        },
      });
    });
  });

  it("submits Lock Duration for subscriptions", async () => {
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Subscription" }));

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "orders" } });
    fireEvent.change(inputFor("Name"), { target: { value: "new-subscription" } });
    fireEvent.change(inputFor("Lock Duration"), { target: { value: "PT30S" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("create_subscription", {
        args: {
          connectionId: CONN.id,
          topicName: "orders",
          subscriptionName: "new-subscription",
          options: expect.objectContaining({ lockDuration: "PT30S" }),
        },
      });
    });
  });

  it("hides and omits Lock Duration for topics", async () => {
    renderModal();
    fireEvent.change(inputFor("Lock Duration"), { target: { value: "PT45S" } });
    fireEvent.click(screen.getByRole("button", { name: "Topic" }));

    expect(screen.queryByText("Lock Duration")).toBeNull();
    fireEvent.change(inputFor("Name"), { target: { value: "new-topic" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("create_topic", expect.anything()));
    const topicCall = mocks.invoke.mock.calls.find(([command]) => command === "create_topic");
    const options = (topicCall?.[1] as { args: { options: Record<string, unknown> } }).args.options;
    expect(options).not.toHaveProperty("lockDuration");
  });
});
