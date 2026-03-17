import { useCallback, useEffect, useRef } from "react";
import { useAppStore, selectActiveConnection } from "../store/appStore";
import {
  safeInvoke,
  ListEntitiesResultSchema,
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
    setEntityCounts,
    setEntityCountsLoading,
  } = useAppStore();

  const fetchingConnRef = useRef<string | null>(null);

  const fetchCounts = useCallback(
    async (result: ListEntitiesResult, connId: string) => {
      const subscriptions = Object.entries(result.topics).flatMap(([topic, subs]) =>
        subs.map((name) => ({ topic, name }))
      );
      setEntityCountsLoading(true);
      try {
        const counts = await safeInvoke(
          "get_entity_counts",
          EntityCountsResultSchema,
          { args: { connectionId: connId, queues: result.queues, subscriptions } }
        );
        if (selectActiveConnection(useAppStore.getState())?.id !== connId) return;
        setEntityCounts(counts);
      } catch {
        // Counts are best-effort — silently ignore failures (e.g. insufficient permissions)
      } finally {
        if (selectActiveConnection(useAppStore.getState())?.id === connId) {
          setEntityCountsLoading(false);
        }
      }
    },
    [setEntityCounts, setEntityCountsLoading]
  );

  const fetchEntities = useCallback(async () => {
    if (!conn || fetchingConnRef.current === conn.id) return;
    fetchingConnRef.current = conn.id;
    const connId = conn.id;
    setEntitiesLoading(true);
    setEntitiesError(null);
    setEntityCounts(null);
    try {
      const result = await safeInvoke(
        "list_entities",
        ListEntitiesResultSchema,
        { args: { connectionId: connId } }
      );
      if (selectActiveConnection(useAppStore.getState())?.id !== connId) return;
      setEntities(result);
      void fetchCounts(result, connId);
    } catch (err) {
      if (selectActiveConnection(useAppStore.getState())?.id !== connId) return;
      setEntitiesError(String(err));
    } finally {
      if (fetchingConnRef.current === connId) {
        setEntitiesLoading(false);
        fetchingConnRef.current = null;
      }
    }
  }, [conn, setEntities, setEntitiesLoading, setEntitiesError, setEntityCounts, fetchCounts]);

  useEffect(() => {
    if (conn) {
      void fetchEntities();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn?.id]);

  return { entities, entitiesLoading, entitiesError, refreshEntities: fetchEntities };
}
