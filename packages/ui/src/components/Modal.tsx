import type { ReactNode } from "react";

export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Extra class on `.rama-modal` — e.g. `rama-modal-wide` for a multi-pane layout. */
  className?: string;
}

export function Modal({ open, title, onClose, children, className }: ModalProps) {
  if (!open) return null;
  return (
    <div className="rama-modal-overlay" onClick={onClose}>
      <div className={`rama-modal${className ? ` ${className}` : ""}`} onClick={(e) => e.stopPropagation()}>
        <div className="rama-modal-header">
          <span>{title}</span>
          <button className="rama-modal-close" onClick={onClose}>
            esc ✕
          </button>
        </div>
        <div className="rama-modal-body">{children}</div>
      </div>
    </div>
  );
}
