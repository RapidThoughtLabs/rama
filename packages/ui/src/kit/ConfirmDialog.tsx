import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

/* Kit confirm dialog — HOME_REDESIGN_PLAN.md Phase HD4. Not in the mockup (§6.3); designed from kit
   tokens: a raised card on a light scrim with a ghost Cancel and a solid confirm. It exists
   because Tauri's WKWebView has no JS-dialog delegate, so window.confirm() silently returns false
   (see code/CodeChatList.tsx). It may render outside `.r-app`, so it styles its own buttons rather
   than leaning on the app root's reset. Escape cancels; the confirm button takes focus, so Enter
   confirms. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancelRef.current();
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);

  if (!open) return null;
  return (
    <div className="r-dialog-scrim" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="r-dialog" role="alertdialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        {children && <p>{children}</p>}
        <div className="r-dialog-actions">
          <button className="r-btn r-btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button ref={confirmRef} className={danger ? "r-btn r-btn-danger" : "r-btn"} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
