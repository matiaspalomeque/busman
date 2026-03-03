import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore, selectActiveConnection } from "../store/appStore";

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
  } = useAppStore();

  // Guard against concurrent calls without closing over entitiesLoading state,
  // which would create a circular dependency (loading → callback recreated → re-fetch).
  const fetchingRef = useRef(false);

  const fetchEntities = useCallback(async () => {
    if (!conn || fetchingRef.current) return;
    fetchingRef.current = true;
    setEntitiesLoading(true);
    setEntitiesError(null);
    try {
      const result = await invoke<ListEntitiesResult>("list_entities", {
        env: {
          SERVICE_BUS_CONNECTION_STRING: conn.connectionString,
          ...conn.env,
        },
      });
      setEntities(result);
    } catch (err) {
      setEntitiesError(String(err));
    } finally {
      setEntitiesLoading(false);
      fetchingRef.current = false;
    }
  }, [conn, setEntities, setEntitiesLoading, setEntitiesError]);

  // Auto-fetch when a connection becomes available and we have no data.
  useEffect(() => {
    if (conn && !entities && !entitiesLoading && !entitiesError) {
      void fetchEntities();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn?.id]); // intentionally re-runs only when the active connection changes

  return { entities, entitiesLoading, entitiesError, refreshEntities: fetchEntities };
}
