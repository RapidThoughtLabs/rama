import type { ReactNode } from "react";

export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}

export function Modal({ open, title, onClose, children }: ModalProps) {
  if (!open) return null;
  return (
    <div className="rama-modal-overlay" onClick={onClose}>
      <div className="rama-modal" onClick={(e) => e.stopPropagation()}>
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
