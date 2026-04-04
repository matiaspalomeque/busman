import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../store/appStore";
import type { PeekedMessage } from "../../types";
import { Explorer } from "./index";

vi.mock("../../hooks/useEntityProperties", () => ({
  useEntityProperties: vi.fn(),
}));

vi.mock("./Sidebar", () => ({
  Sidebar: () => <div>Sidebar</div>,
}));

vi.mock("./Toolbar", () => ({
  Toolbar: () => <div>Toolbar</div>,
}));

vi.mock("./MessageGrid", () => ({
  MessageGrid: () => <div>MessageGrid</div>,
}));

vi.mock("./PropertiesPanel", () => ({
  PropertiesPanel: () => <div>PropertiesPanel</div>,
}));

vi.mock("./EventLog", () => ({
  EventLog: () => <div>EventLog</div>,
}));

vi.mock("./SendMessageModal", () => ({
  SendMessageModal: () => <div>SendMessageModal</div>,
}));

vi.mock("./MoveMessagesModal", () => ({
  MoveMessagesModal: () => <div>MoveMessagesModal</div>,
}));

vi.mock("./ConnectionsModal", () => ({
  ConnectionsModal: () => <div>ConnectionsModal</div>,
}));

vi.mock("./CreateEntityModal", () => ({
  CreateEntityModal: () => <div>CreateEntityModal</div>,
}));

vi.mock("./DeleteEntityDialog", () => ({
  DeleteEntityDialog: () => <div>DeleteEntityDialog</div>,
}));

vi.mock("../Common/AboutModal", () => ({
  AboutModal: () => <div>AboutModal</div>,
}));

const selectedMessageFixture: PeekedMessage = {
  messageId: "msg-1",
  sequenceNumber: "10",
  body: { hello: "world" },
  subject: "subject",
  contentType: "application/json",
  correlationId: "corr-1",
  partitionKey: null,
  traceParent: null,
  applicationProperties: { env: "test" },
  enqueuedTimeUtc: "2026-04-03T12:00:00.000Z",
  expiresAtUtc: "2026-04-04T12:00:00.000Z",
  deadLetterReason: null,
  deadLetterErrorDescription: null,
  _source: "Queue",
};

describe("Explorer", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("does not render the properties panel when no message is selected", () => {
    render(<Explorer />);

    expect(screen.getByText("Sidebar")).toBeTruthy();
    expect(screen.getByText("MessageGrid")).toBeTruthy();
    expect(screen.queryByText("PropertiesPanel")).toBeNull();
  });

  it("renders the properties panel when a message is selected", () => {
    useAppStore.setState({ selectedMessage: selectedMessageFixture });

    render(<Explorer />);

    expect(screen.getByText("PropertiesPanel")).toBeTruthy();
  });
});
