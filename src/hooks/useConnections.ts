import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useCallback } from "react";
import { useAppStore } from "../store/appStore";
import { ConnectionSchema, ConnectionsConfigSchema, safeInvoke } from "../schemas/ipc";
import type { Connection, ConnectionsConfig } from "../types";
import { logHandledError } from "../utils/logging";

export function useConnections() {
  const { setConnections, setActiveConnectionId } = useAppStore();

  const applyConfig = useCallback(
    (config: ConnectionsConfig) => {
      setConnections(config.connections);
      setActiveConnectionId(config.activeConnectionId);
    },
    [setConnections, setActiveConnectionId]
  );

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
    async (connection: Partial<Connection> & { name: string; connectionString: string }) => {
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
      setConnections(config.connections);
    },
    [setConnections]
  );

  const deleteConnection = useCallback(
    async (id: string) => {
      const config = await safeInvoke("delete_connection", ConnectionsConfigSchema, { id });
      // Clean up per-connection localStorage keys to prevent stale data accumulation.
      try { localStorage.removeItem(`pins:${id}`); } catch {}
      try { localStorage.removeItem(`dlqThresholds:${id}`); } catch {}
      applyConfig(config);
    },
    [applyConfig]
  );

  const setActive = useCallback(
    async (id: string | null) => {
      const config = await safeInvoke("set_active_connection", ConnectionsConfigSchema, { id });
      applyConfig(config);
    },
    [applyConfig]
  );

  const exportConnections = useCallback(async (password: string): Promise<void> => {
    const path = await save({
      filters: [{ name: "Busman Export", extensions: ["busman"] }],
      defaultPath: "connections.busman",
    });
    if (!path) return;
    try {
      await invoke("export_connections", { path, password });
    } catch (error) {
      logHandledError("Failed to export connections", error, { path });
      throw error;
    }
  }, []);

  const importConnections = useCallback(
    async (password: string, merge: boolean): Promise<number> => {
      const path = await open({
        filters: [{ name: "Busman Export", extensions: ["busman"] }],
        multiple: false,
      });
      if (!path) return 0;
      const before = useAppStore.getState().connections.length;
      const config = await safeInvoke("import_connections", ConnectionsConfigSchema, {
        path,
        password,
        merge,
      });
      setConnections(config.connections);
      setActiveConnectionId(config.activeConnectionId);
      return config.connections.length - (merge ? before : 0);
    },
    [setConnections, setActiveConnectionId]
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
