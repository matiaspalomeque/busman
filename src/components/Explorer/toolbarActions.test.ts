import { describe, expect, it } from "vitest";
import {
  buildEmptyMessagesParams,
  buildReplayParams,
  buildRepublishSubscriptionDlqParams,
  canManageRulesSelection,
  canReplaySelection,
  canRepublishSelection,
  getDisplayEntity,
} from "./toolbarActions";
import type { ExplorerSelection } from "../../types";

const queueSelection: ExplorerSelection = {
  kind: "queue",
  queueName: "orders",
  topicName: null,
  subscriptionName: null,
};

const subscriptionSelection: ExplorerSelection = {
  kind: "subscription",
  queueName: null,
  topicName: "billing",
  subscriptionName: "processor",
};

const noneSelection: ExplorerSelection = {
  kind: "none",
  queueName: null,
  topicName: null,
  subscriptionName: null,
};

describe("toolbarActions", () => {
  it("builds queue replay params only for queues", () => {
    expect(buildReplayParams(queueSelection, "conn-1")).toEqual({
      sourceQueue: "orders",
      destQueue: "orders",
      mode: "dlq",
      connectionId: "conn-1",
    });
    expect(buildReplayParams(subscriptionSelection, "conn-1")).toBeNull();
  });

  it("builds republish params only for subscriptions", () => {
    expect(buildRepublishSubscriptionDlqParams(subscriptionSelection, "conn-1")).toEqual({
      topicName: "billing",
      subscriptionName: "processor",
      connectionId: "conn-1",
    });
    expect(buildRepublishSubscriptionDlqParams(queueSelection, "conn-1")).toBeNull();
  });

  it("builds receive params for queues and subscriptions", () => {
    expect(buildEmptyMessagesParams(queueSelection, "both", "conn-1")).toEqual({
      queueName: "orders",
      mode: "both",
      connectionId: "conn-1",
    });
    expect(buildEmptyMessagesParams(subscriptionSelection, "dlq", "conn-1")).toEqual({
      topicName: "billing",
      subscriptionName: "processor",
      mode: "dlq",
      connectionId: "conn-1",
    });
    expect(buildEmptyMessagesParams(noneSelection, "normal", "conn-1")).toBeNull();
  });

  it("reports entity display names and action availability correctly", () => {
    expect(getDisplayEntity(queueSelection)).toBe("orders");
    expect(getDisplayEntity(subscriptionSelection)).toBe("billing/processor");
    expect(getDisplayEntity(noneSelection)).toBeNull();

    expect(canReplaySelection(queueSelection)).toBe(true);
    expect(canReplaySelection(subscriptionSelection)).toBe(false);
    expect(canRepublishSelection(subscriptionSelection)).toBe(true);
    expect(canRepublishSelection(queueSelection)).toBe(false);
    expect(canManageRulesSelection(subscriptionSelection)).toBe(true);
    expect(canManageRulesSelection(queueSelection)).toBe(false);
  });
});
