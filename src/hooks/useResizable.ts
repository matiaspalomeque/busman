import { useCallback, useRef } from "react";

interface UseResizableOptions {
  initialWidth: number;
  minWidth: number;
  maxWidth: number;
  onDragEnd: (width: number) => void;
}

interface UseResizableResult {
  widthRef: React.MutableRefObject<number>;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
}

/**
 * Handles horizontal resize via pointer events.
 *
 * Risk mitigation: width is tracked in a ref during drag to avoid rapid
 * React re-renders on every pointermove. The sidebar reads widthRef.current
 * and applies it via a local state that only updates on pointerup (drag end).
 * The caller receives the final width via onDragEnd.
 */
export function useResizable({ initialWidth, minWidth, maxWidth, onDragEnd }: UseResizableOptions): UseResizableResult {
  const widthRef = useRef(initialWidth);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const handle = e.currentTarget;
      handle.setPointerCapture(e.pointerId);

      const startX = e.clientX;
      const startWidth = widthRef.current;

      function onPointerMove(moveEvent: PointerEvent) {
        const delta = moveEvent.clientX - startX;
        const next = Math.min(maxWidth, Math.max(minWidth, startWidth + delta));
        widthRef.current = next;
        // Apply directly to the sidebar DOM element to avoid React re-render per frame.
        const sidebar = handle.parentElement;
        if (sidebar) {
          sidebar.style.width = `${next}px`;
        }
      }

      function onPointerUp(upEvent: PointerEvent) {
        handle.releasePointerCapture(upEvent.pointerId);
        handle.removeEventListener("pointermove", onPointerMove);
        handle.removeEventListener("pointerup", onPointerUp);
        document.body.style.userSelect = "";
        onDragEnd(widthRef.current);
      }

      document.body.style.userSelect = "none";
      handle.addEventListener("pointermove", onPointerMove);
      handle.addEventListener("pointerup", onPointerUp);
    },
    [minWidth, maxWidth, onDragEnd]
  );

  return { widthRef, onPointerDown };
}
