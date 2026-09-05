import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TreeItem, TreeSection } from "./SidebarTree";

describe("TreeItem selection", () => {
  it("selects from the counts, empty row space, and name exactly once per click", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <TreeItem label="orders" icon="queue" isSelected={false} onClick={onSelect} counts={{ active: 260, dlq: 3 }} />
    );

    fireEvent.click(screen.getByText("260"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    fireEvent.click(container.firstElementChild!);
    expect(onSelect).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "orders" }));
    expect(onSelect).toHaveBeenCalledTimes(3);
  });

  it("keeps row actions and the threshold editor independent of selection", () => {
    const onSelect = vi.fn();
    const onDelete = vi.fn();
    const onTogglePin = vi.fn();
    const onSetThreshold = vi.fn();
    render(
      <TreeItem label="orders" icon="queue" isSelected={false} onClick={onSelect}
        pinKey="queue:orders" onDelete={onDelete} onTogglePin={onTogglePin} onSetThreshold={onSetThreshold} />
    );

    fireEvent.click(screen.getByRole("button", { name: "explorer.sidebar.deleteTitle" }));
    fireEvent.click(screen.getByRole("button", { name: "explorer.sidebar.pin" }));
    fireEvent.click(screen.getByRole("button", { name: "explorer.sidebar.dlqThresholdSet" }));
    fireEvent.click(screen.getByRole("spinbutton"));
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "explorer.sidebar.dlqThresholdSave" }));

    expect(onDelete).toHaveBeenCalledOnce();
    expect(onTogglePin).toHaveBeenCalledOnce();
    expect(onSetThreshold).toHaveBeenCalledWith(10);
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("TreeSection", () => {
  it("exposes expanded state on the section toggle", () => {
    const { rerender } = render(
      <TreeSection label="Queues" collapsed={false} onToggle={() => {}}>
        <div>queue-a</div>
      </TreeSection>
    );

    expect(screen.getByRole("button", { name: "Queues" }).getAttribute("aria-expanded")).toBe("true");

    rerender(
      <TreeSection label="Queues" collapsed={true} onToggle={() => {}}>
        <div>queue-a</div>
      </TreeSection>
    );

    expect(screen.getByRole("button", { name: "Queues" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the section toggle clickable", () => {
    let toggled = false;
    render(
      <TreeSection label="Topics" collapsed={false} onToggle={() => { toggled = true; }}>
        <div>topic-a</div>
      </TreeSection>
    );

    fireEvent.click(screen.getByRole("button", { name: "Topics" }));

    expect(toggled).toBe(true);
  });
});
