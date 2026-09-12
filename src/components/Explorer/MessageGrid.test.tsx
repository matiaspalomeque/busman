import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import { useAppStore } from "../../store/appStore";
import type { Connection, PeekedMessage } from "../../types";
import { messageOperationKey } from "../../utils/messageOperation";
import { MessageGrid } from "./MessageGrid";
import { AtomicOperationBanner, OperationStatusTray } from "./OperationStatus";
import { invoke } from "@tauri-apps/api/core";
import fixture from "../../../contracts/operation-outcome.json";
import { OperationOutcomeSchema } from "../../schemas/operation";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));

const CONN: Connection = {
  id: "conn-1",
  name: "Test",
  connectionString: "Endpoint=sb://test.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=dGVzdA==",
  env: {},
};

function message(sequenceNumber: string, source: string): PeekedMessage {
  return {
    messageId: `msg-${sequenceNumber}`,
    sequenceNumber,
    body: { ok: true },
    subject: null,
    contentType: "application/json",
    correlationId: null,
    partitionKey: null,
    traceParent: null,
    applicationProperties: null,
    enqueuedTimeUtc: "2026-01-01T00:00:00.000Z",
    expiresAtUtc: null,
    deadLetterReason: source.startsWith("Dead Letter") ? "failed" : null,
    deadLetterErrorDescription: null,
    _source: source,
  };
}

describe("MessageGrid", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    const store = useAppStore.getState();
    store.setConnections([CONN]);
    store.setActiveConnectionId(CONN.id);
    store.setExplorerQueue("q1");
  });

  it("shows an empty browse result without relying on a persisted filename", () => {
    const store = useAppStore.getState();
    expect(store.hasBrowsed).toBe(false);
    store.setPeekResults([]);

    render(<><AtomicOperationBanner /><MessageGrid /><OperationStatusTray /></>);

    expect(useAppStore.getState().hasBrowsed).toBe(true);
    expect(screen.getByText("No messages found. This queue appears to be empty.")).toBeTruthy();
  });

  it("keeps the grid visible and renders pending message rows as loading rows", () => {
    const pending = message("42", "Dead Letter Queue: q1");
    const available = message("43", "Dead Letter Queue: q1");
    const pendingKey = messageOperationKey(pending);
    expect(pendingKey).toBeTruthy();

    const store = useAppStore.getState();
    store.setPeekResults([pending, available]);
    store.startMessageOperation(pendingKey!, {
      runId: "run-1",
      operation: "ReplayMessage",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    store.startOperationRun("run-1", "atomic");

    render(<><AtomicOperationBanner /><MessageGrid /><OperationStatusTray /></>);

    expect(screen.getByText("1 message operation running")).toBeTruthy();
    expect(screen.getByText(/Replaying/)).toBeTruthy();
    expect(screen.queryByText("msg-42")).toBeNull();
    expect(screen.getByText("msg-43")).toBeTruthy();

    fireEvent.click(screen.getByText(/Replaying/).closest("tr")!);
    expect(useAppStore.getState().selectedMessage).toBeNull();

    fireEvent.click(screen.getByText("msg-43"));
    expect(useAppStore.getState().selectedMessage?.messageId).toBe("msg-43");

    fireEvent.keyDown(screen.getByText("msg-43").closest("tr")!, { key: "Enter" });
    expect(useAppStore.getState().selectedMessage).toBeNull();
  });

  it("keeps the message grid mounted while a bulk operation runs and shows its result until dismissed", () => {
    const available = message("43", "Dead Letter Queue: q1");
    const store = useAppStore.getState();
    store.setPeekResults([available]);
    store.addEventLogEntry({
      id: "bulk-run-1",
      time: "2026-01-01T00:00:00.000Z",
      namespace: "test",
      entity: "q1",
      entityType: "Queue",
      operation: "Replay",
      status: "running",
    });
    store.setRunning(true, "bulk-run-1", "bulk");
    store.setProgress({ text: "Localized progress without numeric parsing", elapsedMs: 3_000,
      counts: { sent: 12, settled: 12, sendUnconfirmed: 0, settlementUnconfirmed: 0, sources: {} } });

    render(<><AtomicOperationBanner /><MessageGrid /><OperationStatusTray /></>);

    expect(screen.getByText("msg-43")).toBeTruthy();
    expect(screen.getByText("Replay in progress")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();

    act(() => {
      useAppStore.getState().setRunning(false);
      useAppStore.getState().updateEventLogEntry("bulk-run-1", "success");
    });

    expect(screen.getByText("msg-43")).toBeTruthy();
    expect(screen.getByText("OK")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText("OK")).toBeNull();
  });

  function startReplay() {
    const store = useAppStore.getState();
    store.setPeekResults([]);
    store.addEventLogEntry({ id: "replay-run", time: new Date().toISOString(), namespace: "test",
      entity: "q1", entityType: "Queue", operation: "Replay", status: "running" });
    store.startOperationRun("replay-run", "bulk");
    store.setRunning(true, "replay-run", "bulk");
    return store;
  }

  it.each(["Receive", "Replay", "Move", "Republish"] as const)("keeps in-flight acknowledgments out of running %s warnings", (operation) => {
    const store = startReplay();
    useAppStore.setState((state) => ({ eventLog: state.eventLog.map((entry) => ({ ...entry, operation })) }));
    render(<><AtomicOperationBanner /><MessageGrid /><OperationStatusTray /></>);
    for (const pending of [3, 0, 5, 0]) {
      act(() => store.setProgress({ text: "", elapsedMs: 10_000,
        counts: { sent: 12, settled: 12, sendUnconfirmed: pending, settlementUnconfirmed: pending, sources: {} } }));
      expect(screen.getByText(operation === "Receive" ? "Confirmed removed: 12" : "Confirmed sent: 12 · Removed: 12")).toBeTruthy();
      expect(screen.queryByText(/unconfirmed|could not be confirmed|retrying|duplicates/i)).toBeNull();
    }
  });

  it("shows a fast operation result even when it finishes before the next render", () => {
    render(<><AtomicOperationBanner /><MessageGrid /><OperationStatusTray /></>);
    act(() => {
      const store = startReplay();
      store.recordOperationOutcome("replay-run", OperationOutcomeSchema.parse({ ...fixture, runId: "replay-run" }));
      store.finishOperationRun("replay-run");
      store.setRunning(false);
    });
    expect(screen.getByText("Outcome unknown")).toBeTruthy();
    expect(screen.getByText(/Up to 1 removal could not be confirmed/)).toBeTruthy();
  });

  it("keeps a completed result and its dismissal across remounts", () => {
    const store = startReplay();
    const view = render(<><AtomicOperationBanner /><MessageGrid /><OperationStatusTray /></>);
    act(() => {
      store.recordOperationOutcome("replay-run", OperationOutcomeSchema.parse({ ...fixture, runId: "replay-run" }));
      store.finishOperationRun("replay-run");
      store.setRunning(false);
    });
    view.unmount();
    const remount = render(<><AtomicOperationBanner /><MessageGrid /><OperationStatusTray /></>);
    expect(screen.getByText("Outcome unknown")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    remount.unmount();
    render(<><AtomicOperationBanner /><MessageGrid /><OperationStatusTray /></>);
    expect(screen.queryByText("Outcome unknown")).toBeNull();
  });

  it("explains stopped Receive counts without send or destination warnings", () => {
    const store = startReplay();
    useAppStore.setState((state) => ({ eventLog: state.eventLog.map((entry) => ({ ...entry, operation: "Receive" as const })) }));
    render(<OperationStatusTray />);
    act(() => {
      store.recordOperationOutcome("replay-run", OperationOutcomeSchema.parse({ ...fixture, runId: "replay-run", errorCode: "cancelled", errorMessage: "complete message error: context canceled",
        counts: { sent: 0, settled: 12204, sendUnconfirmed: 0, settlementUnconfirmed: 3, sources: {} } }));
      store.finishOperationRun("replay-run");
      store.setRunning(false);
    });
    const tray = screen.getByRole("status");
    expect(within(tray).getByText("Stopped · review needed")).toBeTruthy();
    expect(within(tray).getByText("Confirmed removed: 12,204")).toBeTruthy();
    expect(within(tray).getByText("Up to 3 removals could not be confirmed. Check the source queue before running this again.")).toBeTruthy();
    expect(within(tray).queryByText(/sent|sends|destination|duplicates/i)).toBeNull();
    expect(within(tray).getByText("complete message error: context canceled").closest("details")?.open).toBe(false);
  });

  it.each([false, true])("shows a requested stop clearly with uncertain work: %s", async (uncertain) => {
    const store = startReplay();
    render(<><AtomicOperationBanner /><MessageGrid /><OperationStatusTray /></>);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Stop" })));
    expect(invoke).toHaveBeenCalledWith("stop_current_operation", { runId: "replay-run" });
    expect(screen.queryByText("Running…")).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Stopping…" }).disabled).toBe(true);
    expect(screen.getByText("Finishing work already started. No new messages will be processed.")).toBeTruthy();
    expect(useAppStore.getState().isRunning).toBe(true);

    const errorMessage = "move stopped after 30745 confirmed messages: send message batch error: context canceled";
    const outcome = OperationOutcomeSchema.parse({ ...fixture, runId: "replay-run", status: uncertain ? "unknown" : "stopped",
      errorCode: "cancelled", errorMessage,
      counts: { sent: 30745, settled: 30745, sendUnconfirmed: uncertain ? 3 : 0, settlementUnconfirmed: 0, sources: {} } });
    act(() => {
      store.recordOperationOutcome("replay-run", outcome);
      store.updateEventLogEntry("replay-run", outcome.status, errorMessage);
      store.finishOperationRun("replay-run");
      store.setRunning(false);
    });
    const tray = screen.getByRole("status");
    expect(within(tray).getByText(uncertain ? "Stopped · review needed" : "Stopped")).toBeTruthy();
    expect(within(tray).queryByRole("alert")).toBeNull();
    expect(within(tray).getByText(errorMessage).closest("details")?.open).toBe(false);
    if (uncertain) {
      expect(within(tray).getByText(/Up to 3 sends could not be confirmed/)).toBeTruthy();
      expect(within(tray).getAllByText(/before retrying/)).toHaveLength(1);
      expect(within(tray).queryByText(/0 removals/)).toBeNull();
    } else {
      expect(within(tray).queryByText(/before retrying/)).toBeNull();
    }
  });

  it.each(["error", "unknown"] as const)("does not present a genuine %s outcome as a requested stop", (status) => {
    const store = startReplay();
    render(<><AtomicOperationBanner /><MessageGrid /><OperationStatusTray /></>);
    const errorMessage = "Service Bus connection lost";
    const outcome = OperationOutcomeSchema.parse({ ...fixture, runId: "replay-run", status,
      errorCode: status === "unknown" ? "broker_acknowledgment_unknown" : "operation_failed", errorMessage });
    act(() => {
      store.recordOperationOutcome("replay-run", outcome);
      store.updateEventLogEntry("replay-run", status, errorMessage);
      store.finishOperationRun("replay-run");
      store.setRunning(false);
    });
    expect(screen.getByText(status === "unknown" ? "Outcome unknown" : "Error")).toBeTruthy();
    expect(screen.queryByText(/^Stopped/)).toBeNull();
    if (status === "error") {
      expect(within(screen.getByRole("alert")).getByText(errorMessage).closest("details")).toBeNull();
    }
  });
});
