import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, HTMLAttributes, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";

/* Kit popover — HOME_REDESIGN_PLAN.md §3 (mock:L622-629, 1989-2003). A `.r-pop` box, position
   fixed, that closes on outside click and Escape. Only one is open at a time across the window,
   like the mockup's closePops(): opening one broadcasts its id and every other open popover
   closes itself.

   Placement: `placement="fixed"` leaves position to `style`/CSS (the theme popover's top 62 /
   right 18) and uses `anchor` only so a click on the trigger doesn't count as "outside". Otherwise
   `anchor` plus `placement` measures the trigger once the box has a size. "above" is the mockup's
   placeAbove (right-aligned to the trigger, clamped 12px from the viewport, flipped below when it
   doesn't fit); "below" is its mirror, left-aligned, for menus hanging off the top bar.

   The box is portalled to the `.r-app` root (body outside the app). A fixed box is only fixed to
   the viewport while no ancestor has a transform, and the landing's arrival animation leaves one
   filled on the composer (HD5), which put the model menu off screen. `.r-app` itself is never
   transformed and still carries the kit's base styles (font, button reset). React events still
   bubble to the component that rendered the popover; outside-click checks are DOM-based and see
   the portalled box through `ref`. */

export type PopoverPlacement = "above" | "below" | "fixed";

const OPEN_EVENT = "r-pop:open";
/** `{ id, open }` — every popover announces itself here so a native webview can step aside. */
export const OVERLAY_EVENT = "rama:overlay-visibility";

export function placeAbove(trigger: DOMRect, w: number, h: number): { left: number; top: number } {
  const left = Math.max(12, Math.min(trigger.right - w, window.innerWidth - w - 12));
  const top = trigger.top - h - 8 > 8 ? trigger.top - h - 8 : trigger.bottom + 8;
  return { left, top };
}

export function placeBelow(trigger: DOMRect, w: number, h: number): { left: number; top: number } {
  const left = Math.max(12, Math.min(trigger.left, window.innerWidth - w - 12));
  const top = trigger.bottom + 6 + h < window.innerHeight - 8 ? trigger.bottom + 6 : Math.max(8, trigger.top - h - 6);
  return { left, top };
}

export function Popover({
  open,
  onClose,
  anchor,
  placement = "below",
  className,
  style,
  children,
  ...rest
}: {
  open: boolean;
  onClose: () => void;
  anchor?: RefObject<HTMLElement | null>;
  placement?: PopoverPlacement;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, "style" | "className" | "children">) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    if (!open || placement === "fixed" || !anchor?.current || !ref.current) {
      setPos(null);
      return;
    }
    const r = anchor.current.getBoundingClientRect();
    const { offsetWidth: w, offsetHeight: h } = ref.current;
    setPos(placement === "above" ? placeAbove(r, w, h) : placeBelow(r, w, h));
  }, [open, anchor, placement]);

  // Tells the native-webview hook (app/mission-control/useWebviewVisibility.ts) that something is
  // open over the page: a child webview paints above the DOM, so the Web pane hides it meanwhile.
  useEffect(() => {
    if (!open) return;
    window.dispatchEvent(new CustomEvent(OVERLAY_EVENT, { detail: { id, open: true } }));
    return () => {
      window.dispatchEvent(new CustomEvent(OVERLAY_EVENT, { detail: { id, open: false } }));
    };
  }, [open, id]);

  useEffect(() => {
    if (!open) return;
    window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: id }));
    function onOther(e: Event) {
      if ((e as CustomEvent<string>).detail !== id) onCloseRef.current();
    }
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor?.current?.contains(t)) return;
      onCloseRef.current();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // Focus goes back to the trigger when it was inside the box (or nowhere), not when the user
      // is typing elsewhere — Esc then just closes the menu.
      const a = document.activeElement;
      if (!a || a === document.body || ref.current?.contains(a)) anchor?.current?.focus();
      onCloseRef.current();
    }
    window.addEventListener(OPEN_EVENT, onOther);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener(OPEN_EVENT, onOther);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, id, anchor]);

  if (!open) return null;
  // Anchored popovers render hidden for the one layout pass it takes to measure them.
  const placed: CSSProperties | undefined =
    anchor && placement !== "fixed"
      ? pos
        ? { left: pos.left, top: pos.top }
        : { left: 0, top: 0, visibility: "hidden" }
      : undefined;
  return createPortal(
    <div ref={ref} className={className ? `r-pop ${className}` : "r-pop"} style={{ ...placed, ...style }} {...rest}>
      {children}
    </div>,
    document.querySelector(".r-app") ?? document.body,
  );
}
