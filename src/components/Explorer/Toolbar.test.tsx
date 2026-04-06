import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import { useAppStore } from "../../store/appStore";
import { Toolbar } from "./Toolbar";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../../hooks/useConnections", () => ({
  useConnections: () => ({
    setActive: vi.fn(),
  }),
}));

vi.mock("../../hooks/useScript", () => ({
  useScript: () => ({
    runOperation: vi.fn(),
    stop: vi.fn(),
  }),
}));

const CONN = {
  id: "conn-1",
  name: "Test",
  connectionString: "Endpoint=sb://test.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=dGVzdA==",
  env: {},
};

describe("Toolbar", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    useAppStore.getState().setConnections([CONN]);
    useAppStore.getState().setActiveConnectionId(CONN.id);
  });

  it("disables Manage Rules unless a subscription is selected", () => {
    render(<Toolbar />);
    expect((screen.getByRole("button", { name: "Manage Rules" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("enables Manage Rules for subscriptions and opens the modal", () => {
    useAppStore.getState().setExplorerSubscription("billing", "processor");

    render(<Toolbar />);

    const button = screen.getByRole("button", { name: "Manage Rules" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    fireEvent.click(button);

    expect(useAppStore.getState().isSubscriptionRulesModalOpen).toBe(true);
  });
});
