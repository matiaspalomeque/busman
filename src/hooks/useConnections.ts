import { useShallow } from "zustand/react/shallow";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useCallback } from "react";
import { useAppStore } from "../store/appStore";
import { ConnectionSchema, ConnectionsConfigSchema, safeInvoke } from "../schemas/ipc";
import type { Connection } from "../types";
import { logHandledError } from "../utils/logging";

export function useConnections() {
  const { setConnections, setActiveConnectionId } = useAppStore(useShallow((state) => ({
    setConnections: state.setConnections,
    setActiveConnectionId: state.setActiveConnectionId,
  })));

  const loadConnections = useCallback(async () => {
    const config = await safeInvoke("load_connections", ConnectionsConfigSchema);
    setConnections(config.connections);
    // Do not auto-select a persisted connection on startup.
    setActiveConnectionId(null);
  }, [setConnections, setActiveConnectionId]);

  const getConnectionForEdit = useCallback(async (id: string) => {
    return safeInvoke("get_connection_for_edit", ConnectionSchema, { id });
  }, []);

  const saveConnection = useCallback(
    async (connection: Partial<Connection> & { name: string; connectionString: string }, originalConnectionString?: string) => {
      const payload: Connection = {
        id: "",
        env: {},
        ...connection,
      };
      const config = await safeInvoke("save_connection", ConnectionsConfigSchema, {
        connection: payload,
      });
      // Do not apply activeConnectionId from backend — saving a connection should
      // never auto-select one. Only sync the connections list.
      const credentialsChanged = originalConnectionString !== undefined
        && originalConnectionString.trim() !== payload.connectionString.trim();
      setConnections(config.connections, credentialsChanged ? payload.id : undefined);
    },
    [setConnections]
  );

  const deleteConnection = useCallback(
    async (id: string) => {
      const config = await safeInvoke("delete_connection", ConnectionsConfigSchema, { id });
      // Clean up per-connection localStorage keys to prevent stale data accumulation.
      try { localStorage.removeItem(`pins:${id}`); } catch {}
      try { localStorage.removeItem(`dlqThresholds:${id}`); } catch {}
      setConnections(config.connections);
    },
    [setConnections]
  );

  const setActive = useCallback(
    async (id: string | null) => {
      const config = await safeInvoke("set_active_connection", ConnectionsConfigSchema, { id });
      setConnections(config.connections);
      setActiveConnectionId(config.activeConnectionId);
    },
    [setConnections, setActiveConnectionId]
  );

  const exportConnections = useCallback(async (password: string): Promise<boolean> => {
    const path = await save({
      filters: [{ name: "Busman Export", extensions: ["busman"] }],
      defaultPath: "connections.busman",
    });
    if (!path) return false;
    try {
      await invoke("export_connections", { path, password });
      return true;
    } catch (error) {
      logHandledError("Failed to export connections", error, { path });
      throw error;
    }
  }, []);

  const importConnections = useCallback(
    async (password: string, merge: boolean): Promise<number | null> => {
      const path = await open({
        filters: [{ name: "Busman Export", extensions: ["busman"] }],
        multiple: false,
      });
      if (!path) return null;
      const before = useAppStore.getState().connections.length;
      const config = await safeInvoke("import_connections", ConnectionsConfigSchema, {
        path,
        password,
        merge,
      });
      setConnections(config.connections);
      return config.connections.length - (merge ? before : 0);
    },
    [setConnections]
  );

  return {
    loadConnections,
    getConnectionForEdit,
    saveConnection,
    deleteConnection,
    setActive,
    exportConnections,
    importConnections,
  };
}
