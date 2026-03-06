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

  // Guard against concurrent calls without closing over entitiesLoading state,
  // which would create a circular dependency (loading → callback recreated → re-fetch).
  const fetchingRef = useRef(false);

  const fetchCounts = useCallback(
    async (result: ListEntitiesResult, env: Record<string, string>) => {
      const subscriptions = Object.entries(result.topics).flatMap(([topic, subs]) =>
        subs.map((name) => ({ topic, name }))
      );
      setEntityCountsLoading(true);
      try {
        const counts = await invoke<EntityCountsResult>("get_entity_counts", {
          args: { env, queues: result.queues, subscriptions },
        });
        setEntityCounts(counts);
      } catch {
        // Counts are best-effort — silently ignore failures (e.g. insufficient permissions)
      } finally {
        setEntityCountsLoading(false);
      }
    },
    [setEntityCounts, setEntityCountsLoading]
  );

  const fetchEntities = useCallback(async () => {
    if (!conn || fetchingRef.current) return;
    fetchingRef.current = true;
    setEntitiesLoading(true);
    setEntitiesError(null);
    setEntityCounts(null);
    try {
      const env = {
        SERVICE_BUS_CONNECTION_STRING: conn.connectionString,
        ...conn.env,
      };
      const result = await invoke<ListEntitiesResult>("list_entities", { env });
      setEntities(result);
      // Fire counts fetch in background — does not block or delay tree rendering
      void fetchCounts(result, env);
    } catch (err) {
      setEntitiesError(String(err));
    } finally {
      setEntitiesLoading(false);
      fetchingRef.current = false;
    }
  }, [conn, setEntities, setEntitiesLoading, setEntitiesError, setEntityCounts, fetchCounts]);

  // Auto-fetch when a connection becomes available and we have no data.
  useEffect(() => {
    if (conn && !entities && !entitiesLoading && !entitiesError) {
      void fetchEntities();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn?.id]); // intentionally re-runs only when the active connection changes

  return { entities, entitiesLoading, entitiesError, refreshEntities: fetchEntities };
}
