import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TreeSection } from "./SidebarTree";

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
