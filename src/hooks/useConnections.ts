import { invoke } from "@tauri-apps/api/core";
import { useCallback } from "react";
import { useAppStore } from "../store/appStore";
import type { Connection, ConnectionsConfig } from "../types";

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
    const config = await invoke<ConnectionsConfig>("load_connections");
    setConnections(config.connections);
    // Do not auto-select a persisted connection on startup.
    setActiveConnectionId(null);
  }, [setConnections, setActiveConnectionId]);

  const saveConnection = useCallback(
    async (connection: Partial<Connection> & { name: string; connectionString: string }) => {
      const payload: Connection = {
        id: "",
        env: {},
        ...connection,
      };
      const config = await invoke<ConnectionsConfig>("save_connection", {
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
      const config = await invoke<ConnectionsConfig>("delete_connection", { id });
      applyConfig(config);
    },
    [applyConfig]
  );

  const setActive = useCallback(
    async (id: string | null) => {
      const config = await invoke<ConnectionsConfig>("set_active_connection", { id });
      applyConfig(config);
    },
    [applyConfig]
  );

  return { loadConnections, saveConnection, deleteConnection, setActive };
}
