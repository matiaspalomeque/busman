import { useEffect, useRef } from "react";

export function useEscapeKey(onEscape: () => void) {
  const ref = useRef(onEscape);
  useEffect(() => { ref.current = onEscape; });
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") ref.current();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);
}
