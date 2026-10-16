import type { ReactNode, SelectHTMLAttributes } from "react";
import { Icon } from "@rama/ui";
import type { ProviderHealthStatus } from "@rama/protocol";

/* Small building blocks every settings pane shares. Styles live in settings.css. */

export function PaneHead({ title, sub, action }: { title: string; sub?: ReactNode; action?: ReactNode }) {
  return (
    <header className="r-set-head">
      <div>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {action}
    </header>
  );
}

export function Section({ title, count, action, children, note }: { title?: string; count?: number; action?: ReactNode; children: ReactNode; note?: ReactNode }) {
  return (
    <section className="r-set-sec">
      {(title || action) && (
        <div className="r-set-sec-head">
          <h2>
            {title}
            {count != null && <span> · {count}</span>}
          </h2>
          {action}
        </div>
      )}
      {children}
      {note && <p className="r-set-note">{note}</p>}
    </section>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return <div className="r-set-card">{children}</div>;
}

/** A label and hint on the left, the control on the right. */
export function Row({ title, hint, children }: { title: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="r-set-row">
      <div className="r-set-row-text">
        <b>{title}</b>
        {hint && <p>{hint}</p>}
      </div>
      {children && <div className="r-set-row-ctl">{children}</div>}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" className="r-switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} />;
}

export function Select({ children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  return (
    <span className="r-select-wrap">
      <select className="r-select" {...props}>
        {children}
      </select>
      <Icon name="down" />
    </span>
  );
}

/** The kit's mini segmented control (kit.css .r-mini-seg). */
export function MiniSeg<T extends string>({ options, value, onChange, label }: { options: { id: T; label: string }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div className="r-mini-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" aria-pressed={value === o.id} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function StatusDot({ status }: { status: ProviderHealthStatus }) {
  return <span className={`r-dot ${status}`} aria-hidden="true" />;
}

export const STATUS_TEXT: Record<ProviderHealthStatus, string> = {
  ok: "Connected",
  bad: "Can't connect",
  "no-key": "Needs an API key",
  checking: "Checking…",
};

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
