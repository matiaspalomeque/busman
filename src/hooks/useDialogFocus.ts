import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = "button, [href], input:not([type='hidden']), select, textarea, [tabindex]";

export function useDialogFocus(dialogRef: RefObject<HTMLElement | null>, onEscape?: () => void) {
  const escapeHandler = useRef(onEscape);
  useEffect(() => { escapeHandler.current = onEscape; }, [onEscape]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.hasAttribute("tabindex")) dialog.tabIndex = -1;

    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const tabStops = () => Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) =>
      element.tabIndex >= 0 && !element.matches(":disabled") && !element.closest("[hidden], [inert]") &&
      element.closest('[role="dialog"]') === dialog && element.checkVisibility?.({ visibilityProperty: true }) !== false
    );
    const initialFocus = dialog.querySelector<HTMLElement>("[data-dialog-initial-focus]")
      ?? tabStops()[0];
    (initialFocus ?? dialog).focus();

    const focusAfterDisable = (event: FocusEvent) => {
      if (!event.relatedTarget && event.target instanceof HTMLElement && event.target.matches(":disabled")
        && event.target.closest('[role="dialog"]') === dialog) dialog.focus();
    };

    const trapFocus = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest('[role="dialog"]') !== dialog) return;
      if (event.key === "Escape" && escapeHandler.current) {
        event.stopPropagation();
        escapeHandler.current();
        return;
      }
      if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      const stops = tabStops();
      if (event.shiftKey) stops.reverse();
      const current = stops.findIndex((element) => element === document.activeElement);
      (stops[current + 1] ?? stops[0] ?? dialog).focus();
    };

    dialog.addEventListener("focusout", focusAfterDisable);
    dialog.addEventListener("keydown", trapFocus);
    return () => {
      dialog.removeEventListener("focusout", focusAfterDisable);
      dialog.removeEventListener("keydown", trapFocus);
      previousFocus?.focus();
    };
  }, [dialogRef]);
}
