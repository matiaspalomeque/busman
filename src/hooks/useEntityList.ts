import { useShallow } from "zustand/react/shallow";
import { useCallback, useEffect, useRef } from "react";
import { useAppStore, selectActiveConnection } from "../store/appStore";
import {
  safeInvoke,
  ListEntitiesResultSchema,
  QueueCountResultSchema,
  SubscriptionCountResultSchema,
  EntityCountsResultSchema,
} from "../schemas/ipc";
import type { z } from "zod";

type ListEntitiesResult = z.infer<typeof ListEntitiesResultSchema>;

// Shared across consumers (the sidebar and entity-creation dialog).
let countRequestSequence = 0;

export function useEntityList() {
  const conn = useAppStore(selectActiveConnection);
  const {
    entities,
    entitiesLoading,
    entitiesError,
    setEntities,
    setEntitiesLoading,
    setEntitiesError,
    batchSetCounts,
    incrementCountsLoading,
    decrementCountsLoading,
  } = useAppStore(useShallow((state) => ({
    entities: state.entities,
    entitiesLoading: state.entitiesLoading,
    entitiesError: state.entitiesError,
    setEntities: state.setEntities,
    setEntitiesLoading: state.setEntitiesLoading,
    setEntitiesError: state.setEntitiesError,
    batchSetCounts: state.batchSetCounts,
    incrementCountsLoading: state.incrementCountsLoading,
    decrementCountsLoading: state.decrementCountsLoading,
  })));

  const generation = useAppStore((state) => state.connectionGeneration);
  const fetchingConnRef = useRef<number | null>(null);

  const fetchCounts = useCallback(
    (result: ListEntitiesResult, connId: string) => {
      const requestGeneration = useAppStore.getState().connectionGeneration;
      const isStale = () => useAppStore.getState().connectionGeneration !== requestGeneration;
      const requestId = ++countRequestSequence;
      const keys = [...result.queues.map((name) => `queue:${name}`), ...Object.entries(result.topics).flatMap(([topic, subs]) => subs.map((sub) => `subscription:${topic}\0${sub}`))];
      const mark = (key: string, error?: string) => {
        if (isStale() || useAppStore.getState().countRefresh[key]?.requestId !== requestId) return;
        const state = useAppStore.getState();
        state.setCountRefresh(key, { requestId, updatedAt: error ? state.countRefresh[key]?.updatedAt : new Date().toISOString(), error });
      };
      const topicNames = Object.keys(result.topics);
      const totalEntities = result.queues.length + topicNames.length;
      if (totalEntities === 0) return false;
      if (useAppStore.getState().entityCountsLoading > 0) return false;

      for (const key of keys) {
        const state = useAppStore.getState();
        state.setCountRefresh(key, { ...state.countRefresh[key], requestId });
      }
      incrementCountsLoading();
      void safeInvoke("get_entity_counts", EntityCountsResultSchema, {
        args: { connectionId: connId, queueNames: result.queues, topicNames },
      })
        .then((counts) => {
          if (isStale()) return;
          const queues = counts.queues.filter((q) => useAppStore.getState().countRefresh[`queue:${q.name}`]?.requestId === requestId);
          const subscriptions = counts.subscriptions.filter((s) => useAppStore.getState().countRefresh[`subscription:${s.topic}\0${s.subscription}`]?.requestId === requestId);
          batchSetCounts(queues, subscriptions);
          for (const q of queues) mark(`queue:${q.name}`);
          for (const s of subscriptions) mark(`subscription:${s.topic}\0${s.subscription}`);
          for (const failure of counts.errors) {
            const failedKeys = failure.kind === "queue" ? [`queue:${failure.name}`] : (result.topics[failure.name] ?? []).map((sub) => `subscription:${failure.name}\0${sub}`);
            for (const key of failedKeys) mark(key, failure.error);
            console.warn(`[fetchCounts] ${failure.kind} ${failure.name} failed: ${failure.error}`);
          }
        })
        .catch((err) => {
          for (const key of keys) mark(key, String(err));
          console.warn("[fetchCounts] batch refresh failed:", err);
        })
        .finally(() => {
          if (!isStale()) decrementCountsLoading();
        });

      return true;
    },
    [batchSetCounts, incrementCountsLoading, decrementCountsLoading]
  );

  const fetchEntities = useCallback(async () => {
    const state = useAppStore.getState();
    const currentConn = selectActiveConnection(state);
    const requestGeneration = state.connectionGeneration;
    if (!currentConn || fetchingConnRef.current === requestGeneration) return;
    fetchingConnRef.current = requestGeneration;
    const connId = currentConn.id;
    setEntitiesLoading(true);
    setEntitiesError(null);
    try {
      const result = await safeInvoke(
        "list_entities",
        ListEntitiesResultSchema,
        { args: { connectionId: connId } }
      );
      if (useAppStore.getState().connectionGeneration !== requestGeneration) return;
      setEntities(result);
      fetchCounts(result, connId);
    } catch (err) {
      if (useAppStore.getState().connectionGeneration !== requestGeneration) return;
      setEntitiesError(String(err));
    } finally {
      if (fetchingConnRef.current === requestGeneration) {
        if (useAppStore.getState().connectionGeneration === requestGeneration) setEntitiesLoading(false);
        fetchingConnRef.current = null;
      }
    }
  }, [setEntities, setEntitiesLoading, setEntitiesError, fetchCounts]);

  useEffect(() => {
    void fetchEntities();
  }, [conn?.id, generation, fetchEntities]);

  const refreshAllCounts = useCallback(() => {
    const state = useAppStore.getState();
    const connId = selectActiveConnection(state)?.id;
    if (!connId || !state.entities) return false;

    return fetchCounts(state.entities, connId);
  }, [fetchCounts]);

  type RefreshTarget =
    | { type: "queue"; name: string }
    | { type: "subscription"; topicName: string; subscriptionName: string };

  const refreshEntityCount = useCallback(async (target: RefreshTarget) => {
    const state = useAppStore.getState();
    const connId = selectActiveConnection(state)?.id;
    if (!connId) return;
    const requestGeneration = state.connectionGeneration;
    const key = target.type === "queue" ? `queue:${target.name}` : `subscription:${target.topicName}\0${target.subscriptionName}`;
    const requestId = ++countRequestSequence;
    state.setCountRefresh(key, { ...state.countRefresh[key], requestId });
    const isCurrent = () => useAppStore.getState().connectionGeneration === requestGeneration && useAppStore.getState().countRefresh[key]?.requestId === requestId;

    try {
      if (target.type === "queue") {
        const r = await safeInvoke("get_queue_count", QueueCountResultSchema, {
          args: { connectionId: connId, queueName: target.name },
        });
        if (!isCurrent()) return;
        batchSetCounts([{ name: r.name, active: r.active, dlq: r.dlq }], []);
      } else {
        const r = await safeInvoke("get_subscription_count", SubscriptionCountResultSchema, {
          args: { connectionId: connId, topicName: target.topicName, subscriptionName: target.subscriptionName },
        });
        if (!isCurrent()) return;
        batchSetCounts([], [{ topic: r.topic, subscription: r.subscription, active: r.active, dlq: r.dlq }]);
      }
      if (isCurrent()) state.setCountRefresh(key, { requestId, updatedAt: new Date().toISOString() });
    } catch (err) {
      if (isCurrent()) state.setCountRefresh(key, { requestId, updatedAt: useAppStore.getState().countRefresh[key]?.updatedAt, error: String(err) });
      console.warn("[refreshEntityCount] failed:", err);
    }
  }, [batchSetCounts]);

  return { entities, entitiesLoading, entitiesError, refreshEntities: fetchEntities, refreshEntityCount, refreshAllCounts };
}
