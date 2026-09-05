import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import { useAppStore } from "../../store/appStore";
import { EventLog } from "./EventLog";
import { OperationOutcomeSchema } from "../../schemas/operation";
import fixture from "../../../contracts/operation-outcome.json";
import { loadOperationJournal } from "../../store/operationJournal";

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("EventLog", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("clears displayed and saved history and accepts new entries afterward", () => {
    const entry = { id: "clear-1", time: new Date().toISOString(), namespace: "test", entity: "q1", entityType: "Queue" as const, operation: "Browse" as const, status: "success" as const };
    useAppStore.getState().addEventLogEntry(entry);
    render(<EventLog />);
    fireEvent.click(screen.getByRole("button", { name: /^Event Log/ }));
    fireEvent.click(screen.getByRole("button", { name: "Clear log" }));
    expect(screen.getByText("No operations recorded yet.")).toBeTruthy();
    expect(useAppStore.getState().eventLog).toEqual([]);
    expect(loadOperationJournal().entries).toEqual([]);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Clear log" }).disabled).toBe(true);
    act(() => useAppStore.getState().addEventLogEntry({ ...entry, id: "clear-2" }));
    expect(screen.getByText("q1")).toBeTruthy();
  });

  it.each(["running", "unknown"] as const)("retains %s operations when clearing is attempted", (status) => {
    useAppStore.getState().addEventLogEntry({ id: "protected", time: new Date().toISOString(), namespace: "test", entity: "q1", entityType: "Queue", operation: "Move", status });
    render(<EventLog />);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Clear log" }).disabled).toBe(true);
    act(() => useAppStore.getState().clearEventLog());
    expect(useAppStore.getState().eventLog).toHaveLength(1);
    act(() => {
      if (status === "unknown") useAppStore.getState().reconcileOperation("protected");
      else useAppStore.getState().updateEventLogEntry("protected", "success");
    });
    fireEvent.click(screen.getByRole("button", { name: "Clear log" }));
    expect(useAppStore.getState().eventLog).toEqual([]);
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

  it("opens partial results in a focused dialog and preserves uncertainty after review", () => {
    const outcome = OperationOutcomeSchema.parse(fixture);
    useAppStore.getState().addEventLogEntry({ id: outcome.runId, time: new Date().toISOString(), namespace: "demo", entity: "orders", entityType: "Queue", operation: "Move", status: "unknown", outcome });
    render(<EventLog />);
    fireEvent.click(screen.getByRole("button", { name: /Review unknown outcomes/ }));
    const open = screen.getByRole("button", { name: "View result" });
    open.focus();
    fireEvent.click(open);
    const dialog = screen.getByRole("dialog", { name: "View result" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(within(dialog).getByText(/Confirmed sent: 5/)).toBeTruthy();
    expect(within(dialog).getByText(/Unconfirmed.*0 sends.*1 removals/)).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(open);
    fireEvent.click(screen.getByRole("button", { name: "I checked the broker" }));
    expect(useAppStore.getState().eventLog[0]).toMatchObject({ status: "unknown", reconciledAt: expect.any(String) });
    expect(screen.queryByRole("button", { name: /Review unknown outcomes/ })).toBeNull();
  });
});


it("shows returned resend feedback even when the log is collapsed", () => {
  useAppStore.setState(useAppStore.getInitialState());
  useAppStore.getState().addEventLogEntry({ id: "resend-1", time: new Date().toISOString(), namespace: "test", entity: "orders #1",
    entityType: "Queue", operation: "ReplayMessage", status: "success",
    scope: { connectionId: "test", mode: "dlq", destination: "orders", replaySource: '["queue","orders"]' },
    replayReturn: { observedAt: new Date().toISOString(), sequenceNumber: "9007199254740993" } });
  render(<EventLog />);
  fireEvent.click(screen.getByRole("button", { name: "1 resend returned to DLQ" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText("Resent successfully, but processing failed again.")).toBeTruthy();
  expect(within(dialog).getByText(/9007199254740993/)).toBeTruthy();
});

it("keeps processing unverified until a resend is actually seen in the dead-letter queue", () => {
  useAppStore.setState(useAppStore.getInitialState());
  useAppStore.getState().addEventLogEntry({ id: "resend-1", time: new Date().toISOString(), namespace: "test", entity: "orders #1",
    entityType: "Queue", operation: "ReplayMessage", status: "success",
    scope: { connectionId: "test", mode: "dlq", destination: "orders", replaySource: '["queue","orders"]' } });
  render(<EventLog />);
  fireEvent.click(screen.getByRole("button", { name: /^Event Log/ }));
  expect(screen.getByText("Resent")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "View result" }));
  expect(screen.getByText("Resent successfully. Processing outcome is not yet known.")).toBeTruthy();
  expect(screen.getByText(/Busman checks for a return when you browse/)).toBeTruthy();
  expect(screen.queryByText("Resent successfully, but processing failed again.")).toBeNull();
});
