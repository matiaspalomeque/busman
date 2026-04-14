import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useResizable } from "./useResizable";
import type React from "react";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Creates a mock handle element with a parent, and stubs pointer capture APIs. */
function makeHandle() {
  const parent = document.createElement("div");
  const handle = document.createElement("div");
  parent.appendChild(handle);
  handle.setPointerCapture = vi.fn();
  handle.releasePointerCapture = vi.fn();
  return { handle, parent };
}

function fakePointerDown(
  handle: HTMLDivElement,
  clientX: number,
  pointerId = 1,
): React.PointerEvent<HTMLDivElement> {
  return {
    preventDefault: vi.fn(),
    currentTarget: handle,
    pointerId,
    clientX,
  } as unknown as React.PointerEvent<HTMLDivElement>;
}

beforeEach(() => {
  document.body.style.userSelect = "";
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("useResizable", () => {
  it("initialises widthRef to initialWidth", () => {
    const { result } = renderHook(() =>
      useResizable({ initialWidth: 200, minWidth: 100, maxWidth: 400, onDragEnd: vi.fn() }),
    );
    expect(result.current.widthRef.current).toBe(200);
  });

  it("grows rightward on pointermove when direction='right' (default)", () => {
    const onDragEnd = vi.fn();
    const { handle, parent } = makeHandle();

    const { result } = renderHook(() =>
      useResizable({ initialWidth: 200, minWidth: 100, maxWidth: 400, onDragEnd }),
    );

    act(() => { result.current.onPointerDown(fakePointerDown(handle, 100)); });

    handle.dispatchEvent(new PointerEvent("pointermove", { clientX: 150, bubbles: true }));

    expect(result.current.widthRef.current).toBe(250); // 200 + 50
    expect(parent.style.width).toBe("250px");
  });

  it("grows leftward on pointermove when direction='left'", () => {
    const onDragEnd = vi.fn();
    const { handle } = makeHandle();

    const { result } = renderHook(() =>
      useResizable({ initialWidth: 300, minWidth: 100, maxWidth: 500, onDragEnd, direction: "left" }),
    );

    act(() => { result.current.onPointerDown(fakePointerDown(handle, 300)); });

    // Moving the mouse 50px to the left → clientX decreases → rawDelta negative → delta positive
    handle.dispatchEvent(new PointerEvent("pointermove", { clientX: 250, bubbles: true }));

    expect(result.current.widthRef.current).toBe(350); // 300 + -(-50)
  });

  it("clamps width at minWidth", () => {
    const onDragEnd = vi.fn();
    const { handle } = makeHandle();

    const { result } = renderHook(() =>
      useResizable({ initialWidth: 200, minWidth: 180, maxWidth: 400, onDragEnd }),
    );

    act(() => { result.current.onPointerDown(fakePointerDown(handle, 200)); });

    // Drag far to the left — would yield a negative width without clamping
    handle.dispatchEvent(new PointerEvent("pointermove", { clientX: 0, bubbles: true }));

    expect(result.current.widthRef.current).toBe(180);
  });

  it("clamps width at maxWidth", () => {
    const onDragEnd = vi.fn();
    const { handle } = makeHandle();

    const { result } = renderHook(() =>
      useResizable({ initialWidth: 200, minWidth: 100, maxWidth: 300, onDragEnd }),
    );

    act(() => { result.current.onPointerDown(fakePointerDown(handle, 100)); });

    // Drag far to the right — would exceed maxWidth without clamping
    handle.dispatchEvent(new PointerEvent("pointermove", { clientX: 999, bubbles: true }));

    expect(result.current.widthRef.current).toBe(300);
  });

  it("calls onDragEnd with the final clamped width on pointerup", () => {
    const onDragEnd = vi.fn();
    const { handle } = makeHandle();

    const { result } = renderHook(() =>
      useResizable({ initialWidth: 200, minWidth: 100, maxWidth: 400, onDragEnd }),
    );

    act(() => { result.current.onPointerDown(fakePointerDown(handle, 100)); });

    handle.dispatchEvent(new PointerEvent("pointermove", { clientX: 150, bubbles: true }));
    handle.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true }));

    expect(onDragEnd).toHaveBeenCalledOnce();
    expect(onDragEnd).toHaveBeenCalledWith(250);
  });

  it("removes pointermove/pointerup listeners and restores user-select on pointerup", () => {
    const onDragEnd = vi.fn();
    const { handle } = makeHandle();
    const removeEventListenerSpy = vi.spyOn(handle, "removeEventListener");

    const { result } = renderHook(() =>
      useResizable({ initialWidth: 200, minWidth: 100, maxWidth: 400, onDragEnd }),
    );

    act(() => { result.current.onPointerDown(fakePointerDown(handle, 100)); });

    expect(document.body.style.userSelect).toBe("none");

    handle.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true }));

    expect(removeEventListenerSpy).toHaveBeenCalledWith("pointermove", expect.any(Function));
    expect(removeEventListenerSpy).toHaveBeenCalledWith("pointerup", expect.any(Function));
    expect(document.body.style.userSelect).toBe("");
  });
});
