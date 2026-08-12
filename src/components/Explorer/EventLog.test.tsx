import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import "../../i18n";
import { useAppStore } from "../../store/appStore";
import { EventLog } from "./EventLog";

describe("EventLog", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("preserves its collapsed state when the first operation is added", () => {
    render(<EventLog />);

    const toggle = screen.getByRole("button", { name: "Event Log" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    act(() => {
      useAppStore.getState().addEventLogEntry({
        id: "run-1",
        time: "2026-01-01T00:00:00.000Z",
        namespace: "test",
        entity: "q1",
        entityType: "Queue",
        operation: "Replay",
        status: "running",
      });
    });

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("table")).toBeNull();
  });
});
