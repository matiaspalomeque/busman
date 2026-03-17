import { useCallback, useEffect, useRef } from "react";
import { useAppStore, selectActiveConnection } from "../store/appStore";
import {
  safeInvoke,
  ListEntitiesResultSchema,
  QueueCountResultSchema,
  SubscriptionCountResultSchema,
} from "../schemas/ipc";
import type { z } from "zod";

type ListEntitiesResult = z.infer<typeof ListEntitiesResultSchema>;

const FLUSH_MS = 1000;

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

      // Local buffers — flushed to store in one batched update every FLUSH_MS
      const queueBuf: { name: string; active: number; dlq: number }[] = [];
      const subBuf: { topic: string; subscription: string; active: number; dlq: number }[] = [];

      const flush = () => {
        if ((queueBuf.length === 0 && subBuf.length === 0) || isStale()) return;
        batchSetCounts(queueBuf.splice(0), subBuf.splice(0));
      };

      const totalEntities =
        result.queues.length +
        Object.values(result.topics).reduce((n, subs) => n + subs.length, 0);
      let completed = 0;
      const intervalId = totalEntities > 0
        ? setInterval(() => { if (isStale()) cleanup(); else flush(); }, FLUSH_MS)
        : null;

      const cleanup = () => {
        if (intervalId !== null) clearInterval(intervalId);
      };

      const onDone = () => {
        if (!isStale()) decrementCountsLoading();
        if (++completed >= totalEntities) {
          cleanup();
          flush(); // final flush for any results not yet emitted
        }
      };

      if (totalEntities > 0) incrementCountsLoading(totalEntities);

      for (const queueName of result.queues) {
        safeInvoke("get_queue_count", QueueCountResultSchema, {
          args: { connectionId: connId, queueName },
        })
          .then((r) => { if (!isStale()) queueBuf.push({ name: r.name, active: r.active, dlq: r.dlq }); })
          .catch((err) => { console.warn(`[fetchCounts] get_queue_count(${queueName}) failed:`, err); })
          .finally(onDone);
      }

      for (const [topicName, subs] of Object.entries(result.topics)) {
        for (const subscriptionName of subs) {
          safeInvoke("get_subscription_count", SubscriptionCountResultSchema, {
            args: { connectionId: connId, topicName, subscriptionName },
          })
            .then((r) => { if (!isStale()) subBuf.push({ topic: r.topic, subscription: r.subscription, active: r.active, dlq: r.dlq }); })
            .catch((err) => { console.warn(`[fetchCounts] get_subscription_count(${topicName}/${subscriptionName}) failed:`, err); })
            .finally(onDone);
        }
      }
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

  return { entities, entitiesLoading, entitiesError, refreshEntities: fetchEntities };
}
