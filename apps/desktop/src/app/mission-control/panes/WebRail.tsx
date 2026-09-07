import { useProjectsData } from "../../data/ProjectsProvider";
import { useWebPane } from "./WebPaneContext";
import type { WebPageState } from "./WebPaneContext";

// docs/MISSION_CONTROL_PLAN.md §8 Phase M5 — replaces M1's "coming in M5" stub. Row anatomy
// mirrors TerminalRail: glyph · title · `⌁` iff agent-opened, with a tooltip naming the chat.
function pageGlyph(p: WebPageState): string {
  return p.loading ? "○" : "◆";
}

export function WebRail({ collapsed }: { collapsed: boolean }) {
  const { allChats } = useProjectsData();
  const { pages, activeId, setActiveId, closePage } = useWebPane();

  if (collapsed) {
    return (
      <>
        {pages.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`rama-mc-rail-icon-row${p.id === activeId ? " rama-mc-rail-icon-row-active" : ""}`}
            title={p.title}
            onClick={() => setActiveId(p.id)}
          >
            {pageGlyph(p)}
          </button>
        ))}
      </>
    );
  }

  if (pages.length === 0) {
    return <div style={{ padding: "8px 12px", fontSize: "var(--fs-sm)", color: "rgba(var(--ink),0.4)" }}>no pages open yet.</div>;
  }

  return (
    <>
      {pages.map((p) => {
        const originChat = p.originChatId ? allChats.find((c) => c.id === p.originChatId) : undefined;
        return (
          <div
            key={p.id}
            role="option"
            aria-selected={p.id === activeId}
            className="rama-artifact-row"
            onClick={() => setActiveId(p.id)}
          >
            <span className="rama-artifact-glyph">{pageGlyph(p)}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="rama-artifact-name">
                {p.title}
                {p.owner === "agent" && (
                  <span title={originChat ? `opened by ${originChat.title}` : "opened by an agent"}> ⌁</span>
                )}
              </div>
              <div className="rama-artifact-meta">{p.url}</div>
            </div>
            <button
              type="button"
              className="rama-btn rama-btn-icon"
              title="Close"
              onClick={(e) => {
                e.stopPropagation();
                void closePage(p.id);
              }}
            >
              ✕
            </button>
          </div>
        );
      })}
    </>
  );
}

// §4.6 — the rail header's `+`, rendered via the registry's `RailActions` slot.
export function WebRailActions() {
  const { activeProjectId } = useProjectsData();
  const { openPage } = useWebPane();
  return (
    <button
      type="button"
      className="rama-mc-rail-action-btn"
      title="New page"
      disabled={!activeProjectId}
      onClick={() => void openPage("about:blank")}
    >
      +
    </button>
  );
}
