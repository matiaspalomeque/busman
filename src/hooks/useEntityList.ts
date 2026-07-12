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

export function useEntityList() {
  const conn = useAppStore(selectActiveConnection);
  const {
    entities,
    entitiesLoading,
    entitiesError,
    setEntities,
    setEntitiesLoading,
    setEntitiesError,
    clearEntityCounts,
    batchSetCounts,
    incrementCountsLoading,
    decrementCountsLoading,
  } = useAppStore();

  const fetchingConnRef = useRef<string | null>(null);

  const fetchCounts = useCallback(
    (result: ListEntitiesResult, connId: string) => {
      const isStale = () => selectActiveConnection(useAppStore.getState())?.id !== connId;
      const topicNames = Object.keys(result.topics);
      const totalEntities = result.queues.length + topicNames.length;
      if (totalEntities === 0) return false;
      if (useAppStore.getState().entityCountsLoading > 0) return false;

      incrementCountsLoading();
      void safeInvoke("get_entity_counts", EntityCountsResultSchema, {
        args: { connectionId: connId, queueNames: result.queues, topicNames },
      })
        .then((counts) => {
          if (isStale()) return;
          batchSetCounts(counts.queues, counts.subscriptions);
          for (const failure of counts.errors) {
            console.warn(`[fetchCounts] ${failure.kind} ${failure.name} failed: ${failure.error}`);
          }
        })
        .catch((err) => {
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
    if (!conn || fetchingConnRef.current === conn.id) return;
    fetchingConnRef.current = conn.id;
    const connId = conn.id;
    setEntitiesLoading(true);
    setEntitiesError(null);
    clearEntityCounts();
    try {
      const result = await safeInvoke(
        "list_entities",
        ListEntitiesResultSchema,
        { args: { connectionId: connId } }
      );
      if (selectActiveConnection(useAppStore.getState())?.id !== connId) return;
      setEntities(result);
      fetchCounts(result, connId);
    } catch (err) {
      if (selectActiveConnection(useAppStore.getState())?.id !== connId) return;
      setEntitiesError(String(err));
    } finally {
      if (fetchingConnRef.current === connId) {
        setEntitiesLoading(false);
        fetchingConnRef.current = null;
      }
    }
  }, [conn, setEntities, setEntitiesLoading, setEntitiesError, clearEntityCounts, fetchCounts]);

  useEffect(() => {
    if (conn) {
      void fetchEntities();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn?.id]);

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
    const connId = conn?.id;
    if (!connId) return;

    try {
      if (target.type === "queue") {
        const r = await safeInvoke("get_queue_count", QueueCountResultSchema, {
          args: { connectionId: connId, queueName: target.name },
        });
        batchSetCounts([{ name: r.name, active: r.active, dlq: r.dlq }], []);
      } else {
        const r = await safeInvoke("get_subscription_count", SubscriptionCountResultSchema, {
          args: { connectionId: connId, topicName: target.topicName, subscriptionName: target.subscriptionName },
        });
        batchSetCounts([], [{ topic: r.topic, subscription: r.subscription, active: r.active, dlq: r.dlq }]);
      }
    } catch (err) {
      console.warn("[refreshEntityCount] failed:", err);
    }
  }, [conn?.id, batchSetCounts]);

  return { entities, entitiesLoading, entitiesError, refreshEntities: fetchEntities, refreshEntityCount, refreshAllCounts };
}
