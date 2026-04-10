import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useEscapeKey } from "./useEscapeKey";

function pressKey(key: string) {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

afterEach(() => {
  // Ensure no listeners leak between tests
  vi.restoreAllMocks();
});

describe("useEscapeKey", () => {
  it("calls the callback when Escape is pressed", () => {
    const onEscape = vi.fn();
    renderHook(() => useEscapeKey(onEscape));

    pressKey("Escape");

    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("does not call the callback for other keys", () => {
    const onEscape = vi.fn();
    renderHook(() => useEscapeKey(onEscape));

    pressKey("Enter");
    pressKey("ArrowDown");
    pressKey(" ");

    expect(onEscape).not.toHaveBeenCalled();
  });

  it("removes the listener on unmount", () => {
    const onEscape = vi.fn();
    const { unmount } = renderHook(() => useEscapeKey(onEscape));

    unmount();
    pressKey("Escape");

    expect(onEscape).not.toHaveBeenCalled();
  });

  it("calls the latest callback without re-registering the listener", () => {
    const first = vi.fn();
    const second = vi.fn();
    const spy = vi.spyOn(document, "addEventListener");

    const { rerender } = renderHook(({ cb }) => useEscapeKey(cb), {
      initialProps: { cb: first },
    });

    const registrations = spy.mock.calls.filter(([event]) => event === "keydown").length;

    rerender({ cb: second });

    // No new keydown registration after callback swap
    const registrationsAfter = spy.mock.calls.filter(([event]) => event === "keydown").length;
    expect(registrationsAfter).toBe(registrations);

    // But Escape now calls the new callback
    pressKey("Escape");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
