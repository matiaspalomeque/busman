import { useEffect, useRef } from "react";
import { useAppStore, SUBSCRIPTION_KEY_SEP } from "../store/appStore";

/**
 * Polls entity counts at a configurable interval and highlights entities whose counts changed.
 * Must be called from a component that also calls useEntityList (so entities + counts are loaded).
 */
export function useAutoRefresh(refreshAllCounts: () => void) {
  const {
    autoRefreshEnabled,
    autoRefreshInterval,
    activeConnectionId,
    entities,
    setChangedEntities,
    recordEntityCountHistory,
  } = useAppStore();

  const refreshInFlightRef = useRef(false);
  const snapshotRef = useRef<{
    queues: Record<string, { active: number; dlq: number }>;
    subs: Record<string, { active: number; dlq: number }>;
  } | null>(null);

  // Watch entityCountsLoading to detect refresh completion
  const entityCountsLoading = useAppStore((s) => s.entityCountsLoading);

  useEffect(() => {
    if (!refreshInFlightRef.current || entityCountsLoading > 0) return;
    refreshInFlightRef.current = false;

    const snapshot = snapshotRef.current;
    if (!snapshot) return;
    snapshotRef.current = null;

    const state = useAppStore.getState();
    const changed: string[] = [];

    // Compare queue counts
    for (const [name, cur] of Object.entries(state.queueCounts)) {
      const prev = snapshot.queues[name];
      if (!prev || prev.active !== cur.active || prev.dlq !== cur.dlq) {
        changed.push(`queue:${name}`);
      }
    }

    // Compare subscription counts
    for (const [key, cur] of Object.entries(state.subscriptionCounts)) {
      const prev = snapshot.subs[key];
      if (!prev || prev.active !== cur.active || prev.dlq !== cur.dlq) {
        // Convert internal "\0" separator to "/" for UI key
        changed.push(`sub:${key.replace(SUBSCRIPTION_KEY_SEP, "/")}`);
      }
    }

    if (changed.length > 0) {
      setChangedEntities(changed);
    }
    recordEntityCountHistory();
  }, [entityCountsLoading, setChangedEntities, recordEntityCountHistory]);

  // Main polling interval
  useEffect(() => {
    if (!autoRefreshEnabled || !activeConnectionId || !entities) return;

    const tick = () => {
      if (refreshInFlightRef.current) return; // skip if previous refresh still running

      // Snapshot current counts before refresh
      const state = useAppStore.getState();
      snapshotRef.current = {
        queues: { ...state.queueCounts },
        subs: { ...state.subscriptionCounts },
      };
      refreshInFlightRef.current = true;
      refreshAllCounts();
    };

    const id = setInterval(tick, autoRefreshInterval * 1000);
    return () => {
      clearInterval(id);
    };
  }, [autoRefreshEnabled, autoRefreshInterval, activeConnectionId, entities, refreshAllCounts]);
}
