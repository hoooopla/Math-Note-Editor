import { useEffect, useRef, type RefObject } from 'react';

/** Keeps keyboard focus in an open dialog and returns it to its trigger. */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, open: boolean, onEscape: () => void, initialSelector?: string) {
  const closeRef = useRef(onEscape);
  closeRef.current = onEscape;

  useEffect(() => {
    if (!open || !ref.current) return;
    const dialog = ref.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusableSelector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    (initialSelector ? dialog.querySelector<HTMLElement>(initialSelector) : null)?.focus();
    if (!dialog.contains(document.activeElement)) dialog.querySelector<HTMLElement>(focusableSelector)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (!dialog.contains(document.activeElement)) return;
      if (event.target instanceof HTMLElement && event.target.closest('[role="dialog"]') !== dialog) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = (Array.from(dialog.querySelectorAll(focusableSelector)) as HTMLElement[]).filter(item => item.getClientRects().length > 0);
      if (!items.length) { event.preventDefault(); dialog.focus(); return; }
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    dialog.addEventListener('keydown', onKeyDown);
    return () => {
      dialog.removeEventListener('keydown', onKeyDown);
      if (previous?.isConnected) previous.focus();
    };
  }, [ref, open, initialSelector]);
}
