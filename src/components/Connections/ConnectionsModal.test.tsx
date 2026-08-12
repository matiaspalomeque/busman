import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import { ExportConnectionsModal } from "./ExportConnectionsModal";
import { ImportConnectionsModal } from "./ImportConnectionsModal";

const connectionMocks = vi.hoisted(() => ({
  importConnections: vi.fn(),
  exportConnections: vi.fn(),
}));

vi.mock("../../hooks/useConnections", () => ({
  useConnections: () => connectionMocks,
}));

describe("connection transfer dialogs", () => {
  beforeEach(() => {
    connectionMocks.importConnections.mockReset();
    connectionMocks.exportConnections.mockReset();
  });

  it("keeps the import dialog shell stable after success", async () => {
    connectionMocks.importConnections.mockResolvedValue(3);
    render(<ImportConnectionsModal onClose={() => {}} />);

    const dialog = screen.getByRole("dialog");
    const shellClass = dialog.className;
    expect(shellClass).toContain("min-h-[19rem]");

    fireEvent.change(screen.getByLabelText("Decryption Password"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(dialog.className).toBe(shellClass);
  });

  it("keeps the export dialog shell stable after success", async () => {
    connectionMocks.exportConnections.mockResolvedValue(undefined);
    render(<ExportConnectionsModal onClose={() => {}} />);

    const dialog = screen.getByRole("dialog");
    const shellClass = dialog.className;
    expect(shellClass).toContain("min-h-[22rem]");

    fireEvent.change(screen.getByLabelText("Encryption Password"), { target: { value: "secret" } });
    fireEvent.change(screen.getByLabelText("Confirm Password"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(dialog.className).toBe(shellClass);
  });
});
