import { useRef } from "react";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useDialogFocus } from "./useDialogFocus";

function DialogFixture() {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref);
  return (
    <div ref={ref} role="dialog">
      <button data-dialog-initial-focus>First</button>
      <button>Last</button>
    </div>
  );
}

describe("useDialogFocus", () => {
  it("focuses the requested initial control and wraps Tab focus", () => {
    const { getByRole } = render(<DialogFixture />);
    const first = getByRole("button", { name: "First" });
    const last = getByRole("button", { name: "Last" });

    expect(document.activeElement).toBe(first);
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});
