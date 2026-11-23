import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, expect, it, vi } from "vitest";
import "../../i18n";
import { useAppStore } from "../../store/appStore";
import { ConnectionsPanel } from "./ConnectionsPanel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const listed = { id: "demo", name: "Demo", environment: "qa", connectionString: "Endpoint=sb://example.invalid/", env: {} };
const full = { ...listed, connectionString: listed.connectionString + ";SharedAccessKey=fixture", env: { MAX_WAIT_TIME_IN_MS: "5000" } };

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  useAppStore.getState().setConnections([listed]);
  useAppStore.getState().setActiveConnectionId(listed.id);
  useAppStore.getState().setExplorerQueue("orders");
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke)
    .mockResolvedValueOnce({ ...full, connectionString: ` ${full.connectionString} ` })
    .mockResolvedValueOnce({ connections: [listed], activeConnectionId: listed.id });
});

it.each([false, true])("preserves private profile settings and clears the active selection only on a key change (rotate = %s)", async (rotate) => {
  render(<ConnectionsPanel />);
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  const credential = await screen.findByDisplayValue(full.connectionString);
  const connectionString = rotate ? full.connectionString + "2" : full.connectionString;
  if (rotate) fireEvent.change(credential, { target: { value: connectionString } });
  fireEvent.change(screen.getByDisplayValue("Demo"), { target: { value: "Renamed" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByDisplayValue("Renamed")).toBeNull());
  expect(invoke).toHaveBeenCalledWith("save_connection", {
    connection: expect.objectContaining({ ...full, name: "Renamed", connectionString }),
  });
  expect(useAppStore.getState().explorerSelection.kind).toBe(rotate ? "none" : "queue");
});
