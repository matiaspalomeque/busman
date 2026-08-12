import { describe, it, expect } from "vitest";
import {
  PeekResultSchema,
  ListEntitiesResultSchema,
  QueueCountResultSchema,
  SubscriptionCountResultSchema,
  TopicSubscriptionCountsResultSchema,
  EntityCountsResultSchema,
  ConnectionsConfigSchema,
  ListSubscriptionRulesResultSchema,
  ManageSubscriptionRuleSchema,
  SequenceNumberSchema,
  SessionStateResultSchema,
} from "./ipc";
import type { PeekedMessage } from "../types";

describe("IPC schemas", () => {
  describe("SessionStateResultSchema", () => {
    it("accepts lossless base64 state and explicit cleared state", () => {
      expect(
        SessionStateResultSchema.parse({
          encoding: "base64",
          stateBase64: "AP+A",
          byteLength: 3,
          hasState: true,
        }),
      ).toMatchObject({ stateBase64: "AP+A", byteLength: 3, hasState: true });
      expect(
        SessionStateResultSchema.parse({
          encoding: "base64",
          stateBase64: "",
          byteLength: 0,
          hasState: false,
        }),
      ).toMatchObject({ stateBase64: "", byteLength: 0, hasState: false });
    });

    it("rejects invalid encoding, mismatched length, and non-empty cleared state", () => {
      expect(() =>
        SessionStateResultSchema.parse({
          encoding: "utf8",
          stateBase64: "AP+A",
          byteLength: 3,
          hasState: true,
        }),
      ).toThrow();
      expect(() =>
        SessionStateResultSchema.parse({
          encoding: "base64",
          stateBase64: "AP+A",
          byteLength: 2,
          hasState: true,
        }),
      ).toThrow();
      expect(() =>
        SessionStateResultSchema.parse({
          encoding: "base64",
          stateBase64: "AA==",
          byteLength: 1,
          hasState: false,
        }),
      ).toThrow();
    });

    it.each(["AB==", "AAB="])(
      "rejects noncanonical session-state pad bits in %s",
      (stateBase64) => {
        expect(() =>
          SessionStateResultSchema.parse({
            encoding: "base64",
            stateBase64,
            byteLength: stateBase64 === "AB==" ? 1 : 2,
            hasState: true,
          }),
        ).toThrow();
      },
    );
  });

  describe("ListEntitiesResultSchema", () => {
    it("accepts valid result", () => {
      const data = {
        queues: ["q1", "q2"],
        topics: { t1: ["s1", "s2"], t2: [] },
      };
      expect(ListEntitiesResultSchema.parse(data)).toEqual(data);
    });

    it("rejects missing queues", () => {
      expect(() => ListEntitiesResultSchema.parse({ topics: {} })).toThrow();
    });
  });

  describe("QueueCountResultSchema", () => {
    it("accepts valid queue count", () => {
      const data = { name: "q1", active: 10, dlq: 2 };
      expect(QueueCountResultSchema.parse(data)).toEqual(data);
    });

    it("rejects non-numeric counts", () => {
      expect(() => QueueCountResultSchema.parse({ name: "q1", active: "ten", dlq: 0 })).toThrow();
    });
  });

  describe("SubscriptionCountResultSchema", () => {
    it("accepts valid subscription count", () => {
      const data = { topic: "t1", subscription: "s1", active: 5, dlq: 0 };
      expect(SubscriptionCountResultSchema.parse(data)).toEqual(data);
    });

    it("rejects missing subscription field", () => {
      expect(() =>
        SubscriptionCountResultSchema.parse({ topic: "t1", active: 5, dlq: 0 })
      ).toThrow();
    });
  });

  describe("TopicSubscriptionCountsResultSchema", () => {
    it("accepts valid batch result", () => {
      const data = {
        topic: "t1",
        subscriptions: [
          { topic: "t1", subscription: "s1", active: 5, dlq: 0 },
          { topic: "t1", subscription: "s2", active: 10, dlq: 3 },
        ],
      };
      const result = TopicSubscriptionCountsResultSchema.parse(data);
      expect(result.subscriptions).toHaveLength(2);
      expect(result.topic).toBe("t1");
    });

    it("accepts empty subscriptions array", () => {
      const data = { topic: "t1", subscriptions: [] };
      expect(TopicSubscriptionCountsResultSchema.parse(data).subscriptions).toEqual([]);
    });

    it("rejects missing topic field", () => {
      expect(() =>
        TopicSubscriptionCountsResultSchema.parse({ subscriptions: [] })
      ).toThrow();
    });

    it("rejects invalid subscription entry", () => {
      expect(() =>
        TopicSubscriptionCountsResultSchema.parse({
          topic: "t1",
          subscriptions: [{ topic: "t1", active: 5, dlq: 0 }],
        })
      ).toThrow();
    });
  });

  describe("EntityCountsResultSchema", () => {
    it("accepts partial count results with per-entity errors", () => {
      const result = EntityCountsResultSchema.parse({
        queues: [{ name: "orders", active: 10, dlq: 2 }],
        subscriptions: [{ topic: "billing", subscription: "worker", active: 3, dlq: 1 }],
        errors: [{ kind: "topic", name: "archived", error: "timed out" }],
      });
      expect(result.queues).toHaveLength(1);
      expect(result.errors[0].name).toBe("archived");
    });

    it("rejects unknown count error kinds", () => {
      expect(() => EntityCountsResultSchema.parse({
        queues: [],
        subscriptions: [],
        errors: [{ kind: "subscription", name: "bad", error: "failed" }],
      })).toThrow();
    });
  });

  describe("SequenceNumberSchema", () => {
    it("preserves boundary strings exactly", () => {
      for (const value of ["9007199254740993", "9288674231451771", "9223372036854775807"]) {
        expect(SequenceNumberSchema.parse(value)).toBe(value);
      }
    });

    it("normalizes safe legacy numbers without accepting rounded values", () => {
      expect(SequenceNumberSchema.parse(42)).toBe("42");
      expect(() => SequenceNumberSchema.parse(Number.MAX_SAFE_INTEGER + 1)).toThrow();
      expect(() => SequenceNumberSchema.parse("9223372036854775808")).toThrow();
      expect(() => SequenceNumberSchema.parse("01")).toThrow();
    });
  });

  describe("PeekResultSchema", () => {
    it("accepts valid peek result with messages", () => {
      const data = {
        messages: [
          {
            messageId: "msg-1",
            body: { key: "value" },
            subject: null,
            contentType: "application/json",
            correlationId: null,
            partitionKey: null,
            traceParent: null,
            applicationProperties: null,
            enqueuedTimeUtc: "2025-01-01T00:00:00Z",
            expiresAtUtc: null,
            _source: "Active",
          },
        ],
      };
      const result = PeekResultSchema.parse(data);
      expect(result.messages).toHaveLength(1);
    });

    it("accepts optional metadata needed for single-message actions", () => {
      const result = PeekResultSchema.parse({
        messages: [
          {
            messageId: "msg-1",
            sequenceNumber: 42,
            body: { key: "value" },
            subject: null,
            contentType: "application/json",
            correlationId: null,
            partitionKey: null,
            sessionId: "session-a",
            state: "deferred",
            deliveryCount: 2,
            lockedUntilUtc: "2025-01-01T00:01:00Z",
            sourceSubQueue: "deadLetter",
            traceParent: null,
            applicationProperties: null,
            enqueuedTimeUtc: "2025-01-01T00:00:00Z",
            expiresAtUtc: null,
            _source: "Dead Letter Queue: q1",
          },
        ],
      });

      const msg: PeekedMessage = result.messages[0];
      expect(msg.sequenceNumber).toBe("42");
      expect(msg.messageId).toBe("msg-1");
      expect(msg.sessionId).toBe("session-a");
      expect(msg.state).toBe("deferred");
      expect(msg.deliveryCount).toBe(2);
      expect(msg.lockedUntilUtc).toBe("2025-01-01T00:01:00Z");
      expect(msg.sourceSubQueue).toBe("deadLetter");
    });

    it("accepts empty messages array", () => {
      const data = { messages: [] };
      expect(PeekResultSchema.parse(data).messages).toEqual([]);
    });
  });

  describe("ConnectionsConfigSchema", () => {
    it("accepts valid config", () => {
      const data = {
        connections: [
          {
            id: "abc",
            name: "Dev",
            connectionString: "Endpoint=sb://...",
            env: {},
          },
        ],
        activeConnectionId: "abc",
      };
      expect(ConnectionsConfigSchema.parse(data).connections).toHaveLength(1);
    });

    it("defaults env to empty object", () => {
      const data = {
        connections: [
          { id: "1", name: "X", connectionString: "cs" },
        ],
        activeConnectionId: null,
      };
      const result = ConnectionsConfigSchema.parse(data);
      expect(result.connections[0].env).toEqual({});
    });
  });

  describe("subscription rule schemas", () => {
    it("accepts valid list results with sql and true filters", () => {
      const result = ListSubscriptionRulesResultSchema.parse({
        topicName: "billing",
        subscriptionName: "processor",
        rules: [
          {
            name: "$Default",
            filter: { kind: "true" },
            action: null,
          },
          {
            name: "only-blue",
            filter: {
              kind: "sql",
              expression: "sys.Label = @label",
              parameters: { label: "blue", retries: 2, enabled: true },
            },
            action: {
              expression: "SET priority = 'high'",
              parameters: {},
            },
          },
        ],
      });

      expect(result.rules).toHaveLength(2);
      expect(result.rules[1].filter.kind).toBe("sql");
    });

    it("accepts valid manage payloads for correlation filters", () => {
      const result = ManageSubscriptionRuleSchema.parse({
        name: "corr-rule",
        filter: {
          kind: "correlation",
          contentType: "application/json",
          correlationId: "corr-1",
          messageId: null,
          replyTo: null,
          replyToSessionId: null,
          sessionId: "session-a",
          subject: "invoice.created",
          to: null,
          applicationProperties: { tenant: "blue", attempt: 3, enabled: true },
        },
        action: null,
      });

      expect(result.filter.kind).toBe("correlation");
      if (result.filter.kind !== "correlation") {
        throw new Error("expected correlation filter");
      }
      expect(result.filter.applicationProperties.attempt).toBe(3);
    });

    it("rejects non-primitive parameter maps", () => {
      expect(() =>
        ManageSubscriptionRuleSchema.parse({
          name: "bad-rule",
          filter: {
            kind: "sql",
            expression: "1 = 1",
            parameters: { nested: { no: "thanks" } },
          },
          action: null,
        })
      ).toThrow();
    });
  });
});
