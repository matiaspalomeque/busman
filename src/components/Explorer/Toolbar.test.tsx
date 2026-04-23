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

  it("hides Manage Rules unless a subscription is selected", () => {
    render(<Toolbar />);

    // With no selection the More dropdown is disabled, so Manage Rules is not reachable.
    const moreButton = screen.getByRole("button", { name: /More/ }) as HTMLButtonElement;
    expect(moreButton.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Manage Rules" })).toBeNull();
  });

  it("shows Manage Rules for subscriptions and opens the modal", () => {
    useAppStore.getState().setExplorerSubscription("billing", "processor");

    render(<Toolbar />);

    const moreButton = screen.getByRole("button", { name: /More/ }) as HTMLButtonElement;
    expect(moreButton.disabled).toBe(false);
    fireEvent.click(moreButton);

    const manageRulesButton = screen.getByRole("button", { name: "Manage Rules" }) as HTMLButtonElement;
    expect(manageRulesButton.disabled).toBe(false);

    fireEvent.click(manageRulesButton);

    expect(useAppStore.getState().isSubscriptionRulesModalOpen).toBe(true);
  });
});
