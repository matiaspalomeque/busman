import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore, selectActiveConnection } from "../store/appStore";
import type { EntityCountsResult } from "../types";

interface ListEntitiesResult {
  queues: string[];
  topics: Record<string, string[]>;
}

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

  // Tracks which connection ID is currently being fetched, or null if idle.
  // Prevents duplicate fetches for the same connection while allowing a new
  // connection to supersede an in-flight fetch.
  const fetchingConnRef = useRef<string | null>(null);

  const fetchCounts = useCallback(
    async (result: ListEntitiesResult, env: Record<string, string>, connId: string) => {
      const subscriptions = Object.entries(result.topics).flatMap(([topic, subs]) =>
        subs.map((name) => ({ topic, name }))
      );
      setEntityCountsLoading(true);
      try {
        const counts = await invoke<EntityCountsResult>("get_entity_counts", {
          args: { env, queues: result.queues, subscriptions },
        });
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
      const env = {
        SERVICE_BUS_CONNECTION_STRING: conn.connectionString,
        ...conn.env,
      };
      const result = await invoke<ListEntitiesResult>("list_entities", { env });
      // Discard stale results if the active connection changed during the fetch
      if (selectActiveConnection(useAppStore.getState())?.id !== connId) return;
      setEntities(result);
      // Fire counts fetch in background — does not block or delay tree rendering
      void fetchCounts(result, env, connId);
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

  // Auto-fetch when the active connection changes.
  useEffect(() => {
    if (conn) {
      void fetchEntities();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn?.id]); // intentionally re-runs only when the active connection changes

  return { entities, entitiesLoading, entitiesError, refreshEntities: fetchEntities };
}
