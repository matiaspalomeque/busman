import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore, selectActiveConnection } from "./appStore";

// Reset store to initial state before each test.
beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
});

describe("appStore", () => {
  // ─── Connections ────────────────────────────────────────────────────

  describe("setConnections", () => {
    it("sorts connections by name (case-insensitive)", () => {
      useAppStore.getState().setConnections([
        { id: "1", name: "Zeta", connectionString: "", env: {} },
        { id: "2", name: "alpha", connectionString: "", env: {} },
        { id: "3", name: "Beta", connectionString: "", env: {} },
      ]);
      const names = useAppStore.getState().connections.map((c) => c.name);
      expect(names).toEqual(["alpha", "Beta", "Zeta"]);
    });
  });

  describe("selectActiveConnection", () => {
    it("returns null when no active connection", () => {
      expect(selectActiveConnection(useAppStore.getState())).toBeNull();
    });

    it("returns the active connection", () => {
      useAppStore.getState().setConnections([
        { id: "a", name: "A", connectionString: "cs", env: {} },
      ]);
      useAppStore.getState().setActiveConnectionId("a");
      const conn = selectActiveConnection(useAppStore.getState());
      expect(conn?.id).toBe("a");
    });
  });

  // ─── Explorer selection ─────────────────────────────────────────────

  describe("setExplorerQueue", () => {
    it("sets queue selection and clears grid state", () => {
      const state = useAppStore.getState();
      state.setExplorerQueue("my-queue");

      const updated = useAppStore.getState();
      expect(updated.explorerSelection).toEqual({
        kind: "queue",
        queueName: "my-queue",
        topicName: null,
        subscriptionName: null,
      });
      expect(updated.peekMessages).toEqual([]);
      expect(updated.gridPage).toBe(1);
      expect(updated.lastBrowseError).toBeNull();
    });

    it("is idempotent for the same queue", () => {
      const state = useAppStore.getState();
      state.setExplorerQueue("q1");
      // Manually set some grid state
      useAppStore.getState().setGridPage(5);
      // Re-selecting the same queue should NOT reset grid state
      useAppStore.getState().setExplorerQueue("q1");
      expect(useAppStore.getState().gridPage).toBe(5);
    });
  });

  describe("setExplorerSubscription", () => {
    it("sets subscription selection", () => {
      useAppStore.getState().setExplorerSubscription("topic1", "sub1");

      const { explorerSelection } = useAppStore.getState();
      expect(explorerSelection).toEqual({
        kind: "subscription",
        queueName: null,
        topicName: "topic1",
        subscriptionName: "sub1",
      });
    });

    it("is idempotent for the same subscription", () => {
      useAppStore.getState().setExplorerSubscription("t", "s");
      useAppStore.getState().setGridPage(3);
      useAppStore.getState().setExplorerSubscription("t", "s");
      expect(useAppStore.getState().gridPage).toBe(3);
    });
  });

  describe("clearExplorerSelection", () => {
    it("resets to none", () => {
      useAppStore.getState().setExplorerQueue("q");
      useAppStore.getState().clearExplorerSelection();
      expect(useAppStore.getState().explorerSelection.kind).toBe("none");
    });
  });

  // ─── Grid state ─────────────────────────────────────────────────────

  describe("grid filters", () => {
    it("setGridFilter resets page to 1", () => {
      useAppStore.getState().setGridPage(5);
      useAppStore.getState().setGridFilter("messageId", "abc");
      expect(useAppStore.getState().gridPage).toBe(1);
      expect(useAppStore.getState().gridFilters.messageId).toBe("abc");
    });

    it("clearGridFilters resets all filters and page", () => {
      useAppStore.getState().setGridFilter("body", "test");
      useAppStore.getState().setGridPage(3);
      useAppStore.getState().clearGridFilters();
      const { gridFilters, gridPage } = useAppStore.getState();
      expect(gridFilters).toEqual({
        messageId: "",
        deadLetterReason: "",
        deadLetterErrorDescription: "",
        body: "",
      });
      expect(gridPage).toBe(1);
    });
  });

  // ─── Output lines ──────────────────────────────────────────────────

  describe("appendOutputLine", () => {
    it("caps at 2000 lines", () => {
      const state = useAppStore.getState();
      for (let i = 0; i < 2050; i++) {
        state.appendOutputLine(`line ${i}`, false, i);
      }
      expect(useAppStore.getState().outputLines.length).toBeLessThanOrEqual(2000);
    });
  });

  // ─── Event log ─────────────────────────────────────────────────────

  describe("event log", () => {
    it("caps at 500 entries", () => {
      const state = useAppStore.getState();
      for (let i = 0; i < 550; i++) {
        state.addEventLogEntry({
          id: String(i),
          time: new Date().toISOString(),
          namespace: "ns",
          entity: "e",
          entityType: "Queue",
          operation: "Browse",
          status: "running",
        });
      }
      expect(useAppStore.getState().eventLog.length).toBeLessThanOrEqual(500);
    });

    it("updateEventLogEntry updates status", () => {
      useAppStore.getState().addEventLogEntry({
        id: "log1",
        time: new Date().toISOString(),
        namespace: "ns",
        entity: "q",
        entityType: "Queue",
        operation: "Browse",
        status: "running",
      });
      useAppStore.getState().updateEventLogEntry("log1", "success");
      const entry = useAppStore.getState().eventLog.find((e) => e.id === "log1");
      expect(entry?.status).toBe("success");
    });
  });

  // ─── Entity removal ────────────────────────────────────────────────

  describe("removeEntity", () => {
    beforeEach(() => {
      useAppStore.getState().setEntities({
        queues: ["q1", "q2"],
        topics: { t1: ["s1", "s2"], t2: ["s3"] },
      });
    });

    it("removes a queue", () => {
      useAppStore.getState().removeEntity("queue", "q1");
      expect(useAppStore.getState().entities?.queues).toEqual(["q2"]);
    });

    it("removes a topic and its subscriptions", () => {
      useAppStore.getState().removeEntity("topic", "t1");
      const topics = useAppStore.getState().entities?.topics;
      expect(topics).not.toHaveProperty("t1");
      expect(topics).toHaveProperty("t2");
    });

    it("removes a subscription from a topic", () => {
      useAppStore.getState().removeEntity("subscription", "s1", "t1");
      expect(useAppStore.getState().entities?.topics.t1).toEqual(["s2"]);
    });
  });

  // ─── Active connection reset ───────────────────────────────────────

  describe("setActiveConnectionId", () => {
    it("clears entities and selection when switching connections", () => {
      useAppStore.getState().setEntities({ queues: ["q"], topics: {} });
      useAppStore.getState().setExplorerQueue("q");
      useAppStore.getState().setActiveConnectionId("new-id");

      const state = useAppStore.getState();
      expect(state.entities).toBeNull();
      expect(state.explorerSelection.kind).toBe("none");
      expect(state.peekMessages).toEqual([]);
    });

    it("sets page to connections when id is null", () => {
      useAppStore.getState().setActiveConnectionId(null);
      expect(useAppStore.getState().currentPage).toBe("connections");
    });

    it("sets page to peek when id is set", () => {
      useAppStore.getState().setActiveConnectionId("some-id");
      expect(useAppStore.getState().currentPage).toBe("peek");
    });
  });
});
