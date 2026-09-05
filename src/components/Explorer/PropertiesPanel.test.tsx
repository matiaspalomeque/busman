import { Profiler } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import { useAppStore } from "../../store/appStore";
import { PropertiesPanel } from "./PropertiesPanel";
import type { PeekedMessage } from "../../types";

const runOperation = vi.hoisted(() => vi.fn());
vi.mock("../../hooks/useScript", () => ({ useScript: () => ({ runOperation, isRunning: false }) }));

const message: PeekedMessage = { messageId: "order-1", sequenceNumber: "9007199254740993", body: '{"orderId":42,"status":"retry"}',
  subject: null, contentType: "application/json", correlationId: null, partitionKey: null, traceParent: null,
  applicationProperties: { system: "orders" }, enqueuedTimeUtc: null, expiresAtUtc: null, _source: "Dead Letter Queue: orders",
  deadLetterReason: "Delivery limit", deadLetterErrorDescription: "Payment timed out" };
beforeEach(() => { runOperation.mockReset(); useAppStore.setState(useAppStore.getInitialState()); useAppStore.getState().setSelectedMessage(message); });

describe("message inspection", () => {
  it("opens the body immediately and supports formatting, copy, and find", async () => {
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: copy }, configurable: true });
    render(<PropertiesPanel />);
    const body = screen.getByRole("textbox", { name: "Body" }) as HTMLTextAreaElement;
    expect(body.value).toContain('\n  "orderId": 42');
    fireEvent.click(screen.getByRole("button", { name: "Formatted" }));
    expect(body.value).toBe(message.body);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith(message.body));
    fireEvent.change(screen.getByRole("textbox", { name: "Find in body" }), { target: { value: "retry" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(body.value.slice(body.selectionStart, body.selectionEnd)).toBe("retry");
  });
  it("exposes failure details and preserves exact sequence numbers in Properties", () => {
    render(<PropertiesPanel />);
    fireEvent.click(screen.getByRole("tab", { name: "Failure" }));
    expect(screen.getByText("Payment timed out")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Failure" }), { key: "ArrowLeft" });
    expect(screen.getByText("9007199254740993")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Properties" }));
  });
  it("traps focus in the expanded body and returns to Expand after Escape", () => {
    render(<PropertiesPanel />);
    const expand = screen.getByRole("button", { name: "Expand" });
    expand.focus(); fireEvent.click(expand);
    const dialog = screen.getByRole("dialog", { name: "Body" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(expand);
  });
  it("does not rerender the inspector for unrelated operation progress", () => {
    const renderCount = vi.fn();
    render(<Profiler id="inspector" onRender={renderCount}><PropertiesPanel /></Profiler>);
    const baseline = renderCount.mock.calls.length;
    act(() => { useAppStore.getState().setProgress({ text: "progress", elapsedMs: 1000 }); });
    expect(renderCount).toHaveBeenCalledTimes(baseline);
  });
});


describe("direct resend", () => {
  function setup(subscription = false) {
    const state = useAppStore.getState();
    state.setConnections([{ id: "test", name: "Test", connectionString: "Endpoint=sb://test.servicebus.windows.net/;", env: {} }]);
    state.setActiveConnectionId("test");
    if (subscription) state.setExplorerSubscription("events", "processor");
    else state.setExplorerQueue("orders");
    const target = { ...message, sessionId: "session-1", sourceSubQueue: "deadLetter" as const,
      _source: subscription ? "Dead Letter Subscription: events/processor" : message._source };
    state.setPeekResults([target]);
    state.setSelectedMessage(target);
    render(<PropertiesPanel />);
  }

  it("starts replay with one click and removes the original only after success", async () => {
    let finish!: (result: { exitCode: number }) => void;
    runOperation.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Resend this message" }));
    expect(runOperation).toHaveBeenCalledWith("single_message_action", expect.objectContaining({
      action: "replay", connectionId: "test", queueName: "orders", destQueue: "orders", isDlq: true,
      sequenceNumber: "9007199254740993", messageId: "order-1", sessionId: "session-1", sourceSubQueue: "deadLetter",
    }), expect.objectContaining({ scope: "atomic" }));
    expect(useAppStore.getState().isSendModalOpen).toBe(false);
    expect(useAppStore.getState().peekMessages).toHaveLength(1);
    const busyButton = screen.getByRole("button", { name: "Resending…" }) as HTMLButtonElement;
    expect(busyButton.disabled).toBe(true);
    fireEvent.click(busyButton);
    expect(runOperation).toHaveBeenCalledOnce();
    await act(async () => { finish({ exitCode: 0 }); });
    expect(useAppStore.getState().peekMessages).toHaveLength(0);
    expect(useAppStore.getState().selectedMessage).toBeNull();
    expect(Object.keys(useAppStore.getState().pendingMessageOperations)).toHaveLength(0);
  });

  it("replays a subscription message to its topic", async () => {
    runOperation.mockResolvedValue({ exitCode: 0 });
    setup(true);
    fireEvent.click(screen.getByRole("button", { name: "Resend this message" }));
    await waitFor(() => expect(useAppStore.getState().selectedMessage).toBeNull());
    expect(runOperation).toHaveBeenCalledWith("single_message_action", expect.objectContaining({
      topicName: "events", subscriptionName: "processor", destTopic: "events", isDlq: true,
    }), expect.anything());
  });

  it.each([-1, -2])("retains the message and displays the error for outcome %s", async (exitCode) => {
    runOperation.mockResolvedValue({ exitCode, errorMessage: "Source settlement could not be confirmed" });
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Resend this message" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Source settlement could not be confirmed");
    expect(useAppStore.getState().peekMessages).toHaveLength(1);
    expect(useAppStore.getState().selectedMessage).not.toBeNull();
  });

  it("does not remove a message from a changed browsing context", async () => {
    runOperation.mockResolvedValue({ exitCode: 0, contextCurrent: false });
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Resend this message" }));
    await waitFor(() => expect(Object.keys(useAppStore.getState().pendingMessageOperations)).toHaveLength(0));
    expect(useAppStore.getState().peekMessages).toHaveLength(1);
  });
});


it("shows the processing failure warning on a returned message", () => {
  const state = useAppStore.getState();
  state.setActiveConnectionId("test");
  state.setExplorerQueue("orders");
  state.addEventLogEntry({ id: "resend-1", time: new Date().toISOString(), namespace: "test", entity: "orders #1", entityType: "Queue", operation: "ReplayMessage", status: "success",
    scope: { connectionId: "test", mode: "dlq", destination: "orders", replaySource: '["queue","orders"]' } });
  const returned = { ...message, applicationProperties: { BusmanReplayRunId: "resend-1" } };
  state.setPeekResults([returned]);
  state.setSelectedMessage(returned);
  render(<PropertiesPanel />);
  expect(screen.getByText("Resent successfully, but processing failed again.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Resend this message" })).toBeTruthy();
});
