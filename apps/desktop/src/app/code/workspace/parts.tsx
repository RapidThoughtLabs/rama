import { useEffect, useState } from "react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";

/* Small pieces every workspace pane draws the same way (mock:L410-411, 587-588, 1761-1810). */

/** `+14 −1` — the minus only when something was removed, as the mockup's `delta()` does. */
export function Delta({ added, removed }: { added: number | null; removed: number | null }) {
  if (added === null && removed === null) return null;
  return (
    <>
      {added !== null && <span className="r-plus">+{added}</span>}
      {removed ? (
        <>
          {" "}
          <span className="r-minus">−{removed}</span>
        </>
      ) : null}
    </>
  );
}

/** `.empty` — a centred sentence with a bold lead. `compact` is the rail's inline variant. */
export function Empty({ title, children, compact }: { title: string; children?: ReactNode; compact?: boolean }) {
  const style: CSSProperties | undefined = compact ? { height: "auto", padding: "28px 12px" } : undefined;
  return (
    <div className="r-empty" style={style}>
      <div>
        <b>{title}</b>
        {children}
      </div>
    </div>
  );
}

/** Home-relative cwd: `/Users/me/code/rama` → `~/code/rama`. */
export function tildePath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

export function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

export function dirName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** A rail row that holds its own hover `x`. A real `<button>` can't contain another button, so
 *  this is a `div role="button"` with the keys a button gets for free. */
export function PressRow({
  onPress,
  className,
  children,
  ...rest
}: {
  onPress: () => void;
  className?: string;
  children: ReactNode;
  title?: string;
  "aria-current"?: boolean;
}) {
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onPress();
    }
  }
  return (
    <div role="button" tabIndex={0} className={className} onClick={onPress} onKeyDown={onKeyDown} {...rest}>
      {children}
    </div>
  );
}

/** Re-renders on an interval, for labels that age ("idle" after a minute of quiet). */
export function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}
