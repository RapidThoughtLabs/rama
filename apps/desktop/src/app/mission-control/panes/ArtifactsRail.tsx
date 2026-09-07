import type { ArtifactDTO, ArtifactKind } from "@rama/protocol";
import { useArtifactsPane } from "./ArtifactsPaneContext";

// Lifted unchanged from the old ArtifactsPanel.tsx (docs/MISSION_CONTROL_PLAN.md M1). The fake
// "all · files · tools" filter chips that used to sit in that panel's header did not come along —
// they were decorative, see M1's own note; real ones with real counts come back in M3.
const KIND_GLYPH: Record<ArtifactKind, string> = { diff: "±", code: "◇", terminal: "▸", doc: "▤", file: "⬚" };

function formatMetaLine(a: ArtifactDTO): string {
  if (a.kind === "code" && typeof a.meta.lines === "number") return `${a.kind} · ${a.meta.lines} lines`;
  if (a.kind === "terminal" && typeof a.meta.matches === "number") return `${a.kind} · ${a.meta.matches} matches`;
  if (a.kind === "terminal" && typeof a.meta.entries === "number") return `${a.kind} · ${a.meta.entries} entries`;
  if (a.kind === "diff" && typeof a.meta.added === "number" && typeof a.meta.removed === "number") {
    return `${a.kind} · +${a.meta.added} −${a.meta.removed}`;
  }
  return a.kind;
}

function formatBadge(a: ArtifactDTO): string {
  if (a.status === "streaming") return "streaming";
  if (a.kind === "terminal" && typeof a.meta.exitCode === "number") {
    return a.meta.exitCode === 0 ? "ok" : `exit ${a.meta.exitCode}`;
  }
  return "";
}

// docs/MISSION_CONTROL_PLAN.md §7.2 — the artifact ↔ terminal bridge: a background `bash` call's
// artifact carries `meta.terminalId` (bash.ts), and clicking it jumps to the Terminal pane. Best-
// effort on "with that shell selected": TerminalPaneProvider only exists while the Terminal pane
// is active, so there's no prop-drilled path to force a specific selection from here — this relies
// on TerminalPaneContext.tsx defaulting a fresh mount's selection to the newest terminal, which is
// this one in the common case (the row was just clicked shortly after the shell was started).
// Decoupled via a window CustomEvent, the same bridge pattern CommandPalette.tsx already uses for
// `rama:toggle-palette` etc., rather than prop-drilling `geometry` down through Rail → pane.Rail.
function jumpToTerminalPane() {
  window.dispatchEvent(new CustomEvent("rama:mc-select-pane", { detail: "terminal" }));
}

export function ArtifactsRail({ collapsed }: { collapsed: boolean }) {
  const { artifacts, activeId, setActiveId } = useArtifactsPane();

  function selectArtifact(a: ArtifactDTO) {
    setActiveId(a.id);
    if (a.kind === "terminal" && typeof a.meta.terminalId === "string") jumpToTerminalPane();
  }

  // §4.5 — wide/collapsed is a 44px icon strip, not a hidden list: rows become their glyph with
  // a tooltip, the active row keeps its accent border.
  if (collapsed) {
    return (
      <>
        {artifacts.map((a) => (
          <button
            key={a.id}
            type="button"
            className={`rama-mc-rail-icon-row${a.id === activeId ? " rama-mc-rail-icon-row-active" : ""}`}
            title={a.name}
            onClick={() => selectArtifact(a)}
          >
            {KIND_GLYPH[a.kind]}
          </button>
        ))}
      </>
    );
  }

  if (artifacts.length === 0) {
    return (
      <div style={{ padding: "8px 12px", fontSize: "var(--fs-sm)", color: "rgba(var(--ink),0.4)" }}>no artifacts yet.</div>
    );
  }

  return (
    <>
      {artifacts.map((a) => (
        <div
          key={a.id}
          role="option"
          aria-selected={a.id === activeId}
          className="rama-artifact-row"
          onClick={() => selectArtifact(a)}
        >
          <span className="rama-artifact-glyph">{KIND_GLYPH[a.kind]}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="rama-artifact-name">{a.name}</div>
            <div className="rama-artifact-meta">{formatMetaLine(a)}</div>
          </div>
          {formatBadge(a) && <span className="rama-artifact-badge">{formatBadge(a)}</span>}
        </div>
      ))}
    </>
  );
}
