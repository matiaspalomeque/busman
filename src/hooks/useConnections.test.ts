import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useConnections } from "./useConnections";
import { useAppStore } from "../store/appStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

const mockInvoke = vi.mocked(invoke);
const mockOpen = vi.mocked(open);
const mockSave = vi.mocked(save);

const CONN_A = {
  id: "a",
  name: "Alpha",
  connectionString: "Endpoint=sb://alpha.servicebus.windows.net/;",
  env: {},
};
const CONN_B = {
  id: "b",
  name: "Beta",
  connectionString: "Endpoint=sb://beta.servicebus.windows.net/;",
  env: {},
};

function makeConfig(
  connections = [CONN_A],
  activeConnectionId: string | null = null,
) {
  return { connections, activeConnectionId };
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.clearAllMocks();
  localStorage.clear();
});

describe("useConnections", () => {
  describe("loadConnections", () => {
    it("fetches connections and syncs the list without auto-selecting", async () => {
      mockInvoke.mockResolvedValueOnce(makeConfig([CONN_A], "a"));

      const { result } = renderHook(() => useConnections());
      await act(async () => { await result.current.loadConnections(); });

      expect(mockInvoke).toHaveBeenCalledWith("load_connections");
      expect(useAppStore.getState().connections).toHaveLength(1);
      // The persisted activeConnectionId from the backend must NOT be applied on load.
      expect(useAppStore.getState().activeConnectionId).toBeNull();
    });
  });

  describe("saveConnection", () => {
    it("invokes save_connection and syncs the connections list", async () => {
      mockInvoke.mockResolvedValueOnce(makeConfig([CONN_A, CONN_B]));

      const { result } = renderHook(() => useConnections());
      await act(async () => {
        await result.current.saveConnection({
          name: "Beta",
          connectionString: "Endpoint=sb://beta.servicebus.windows.net/;",
        });
      });

      expect(mockInvoke).toHaveBeenCalledWith(
        "save_connection",
        expect.objectContaining({
          connection: expect.objectContaining({ name: "Beta" }),
        }),
      );
      expect(useAppStore.getState().connections).toHaveLength(2);
      // Saving a connection must not auto-select it.
      expect(useAppStore.getState().activeConnectionId).toBeNull();
    });

    it("fills in default id and env when they are absent", async () => {
      mockInvoke.mockResolvedValueOnce(makeConfig([CONN_A]));

      const { result } = renderHook(() => useConnections());
      await act(async () => {
        await result.current.saveConnection({ name: "Alpha", connectionString: "sb://x" });
      });

      expect(mockInvoke).toHaveBeenCalledWith(
        "save_connection",
        expect.objectContaining({
          connection: expect.objectContaining({ id: "", env: {} }),
        }),
      );
    });
  });

  describe("deleteConnection", () => {
    it("invokes delete_connection and removes its localStorage keys", async () => {
      localStorage.setItem("pins:a", "[]");
      localStorage.setItem("dlqThresholds:a", "{}");
      mockInvoke.mockResolvedValueOnce(makeConfig([], null));

      const { result } = renderHook(() => useConnections());
      await act(async () => { await result.current.deleteConnection("a"); });

      expect(mockInvoke).toHaveBeenCalledWith("delete_connection", { id: "a" });
      expect(localStorage.getItem("pins:a")).toBeNull();
      expect(localStorage.getItem("dlqThresholds:a")).toBeNull();
      expect(useAppStore.getState().connections).toHaveLength(0);
    });
  });

  describe("setActive", () => {
    it("invokes set_active_connection and applies the returned config", async () => {
      mockInvoke.mockResolvedValueOnce(makeConfig([CONN_A], "a"));

      const { result } = renderHook(() => useConnections());
      await act(async () => { await result.current.setActive("a"); });

      expect(mockInvoke).toHaveBeenCalledWith("set_active_connection", { id: "a" });
      expect(useAppStore.getState().activeConnectionId).toBe("a");
    });

    it("accepts null to deselect the active connection", async () => {
      mockInvoke.mockResolvedValueOnce(makeConfig([CONN_A], null));

      const { result } = renderHook(() => useConnections());
      await act(async () => { await result.current.setActive(null); });

      expect(useAppStore.getState().activeConnectionId).toBeNull();
    });
  });

  describe("exportConnections", () => {
    it("opens a save dialog and invokes export_connections with the chosen path", async () => {
      mockSave.mockResolvedValueOnce("/tmp/connections.busman");
      mockInvoke.mockResolvedValueOnce(undefined);

      const { result } = renderHook(() => useConnections());
      await act(async () => { await result.current.exportConnections("secret"); });

      expect(mockSave).toHaveBeenCalled();
      expect(mockInvoke).toHaveBeenCalledWith("export_connections", {
        path: "/tmp/connections.busman",
        password: "secret",
      });
    });

    it("does nothing when the user cancels the save dialog", async () => {
      mockSave.mockResolvedValueOnce(null);

      const { result } = renderHook(() => useConnections());
      await act(async () => { await result.current.exportConnections("secret"); });

      expect(mockInvoke).not.toHaveBeenCalled();
    });
  });

  describe("importConnections", () => {
    it("returns 0 and skips the invoke when user cancels the file picker", async () => {
      mockOpen.mockResolvedValueOnce(null);

      const { result } = renderHook(() => useConnections());
      let count!: number;
      await act(async () => { count = await result.current.importConnections("pw", false); });

      expect(count).toBe(0);
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("returns the total connection count when merge=false", async () => {
      mockOpen.mockResolvedValueOnce("/tmp/export.busman");
      mockInvoke.mockResolvedValueOnce(makeConfig([CONN_A, CONN_B], null));

      const { result } = renderHook(() => useConnections());
      let count!: number;
      await act(async () => { count = await result.current.importConnections("pw", false); });

      expect(count).toBe(2);
      expect(useAppStore.getState().connections).toHaveLength(2);
    });

    it("returns only the delta (new connections) when merge=true", async () => {
      useAppStore.getState().setConnections([CONN_A]);
      mockOpen.mockResolvedValueOnce("/tmp/export.busman");
      mockInvoke.mockResolvedValueOnce(makeConfig([CONN_A, CONN_B], null));

      const { result } = renderHook(() => useConnections());
      let count!: number;
      await act(async () => { count = await result.current.importConnections("pw", true); });

      // 2 total − 1 pre-existing = 1 new
      expect(count).toBe(1);
    });
  });
});
