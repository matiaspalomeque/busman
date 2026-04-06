import { describe, it, expect } from "vitest";
import {
  PeekResultSchema,
  ListEntitiesResultSchema,
  QueueCountResultSchema,
  SubscriptionCountResultSchema,
  TopicSubscriptionCountsResultSchema,
  ConnectionsConfigSchema,
  ListSubscriptionRulesResultSchema,
  ManageSubscriptionRuleSchema,
} from "./ipc";

describe("IPC schemas", () => {
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
        filename: "messages.json",
        savedAt: "2025-01-01T00:00:00Z",
      };
      const result = PeekResultSchema.parse(data);
      expect(result.messages).toHaveLength(1);
      expect(result.filename).toBe("messages.json");
    });

    it("accepts empty messages array", () => {
      const data = { messages: [], filename: "empty.json", savedAt: "2025-01-01" };
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
