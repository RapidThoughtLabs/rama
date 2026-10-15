import { Icon } from "@rama/ui";
import { Empty, PressRow } from "../../code/workspace/parts";
import { useProjectsData } from "../../data/ProjectsProvider";
import { useWebPane } from "./WebPaneContext";

// docs/CODE_REDESIGN_PLAN.md CR4 (mock:L1788-1796) — the Web rail head and rail. A page is a globe,
// its title, and its address with who opened it. `+` isn't in the mockup; it stays for symmetry
// with Terminal (plan §9).

/** `https://youtube.com/` → `youtube.com`: what people read an address as. */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

export function WebRailHead() {
  const { activeProjectId } = useProjectsData();
  const { openPage } = useWebPane();
  return (
    <>
      <b className="grow">Pages</b>
      <button className="r-icon-btn" title="New page" aria-label="New page" disabled={!activeProjectId} onClick={() => void openPage("about:blank")}>
        <Icon name="plus" />
      </button>
    </>
  );
}

export function WebRail({ collapsed }: { collapsed: boolean }) {
  const { pages, activeId, setActiveId, closePage } = useWebPane();

  if (pages.length === 0) return collapsed ? null : <Empty compact title="No pages open" />;

  return (
    <>
      {pages.map((p) => (
        <PressRow key={p.id} className="r-rrow" aria-current={p.id === activeId} title={p.url} onPress={() => setActiveId(p.id)}>
          <Icon name="globe" />
          <span className="t">{p.title}</span>
          <span className="end" />
          <span className="sub">
            {displayUrl(p.url)}, opened by {p.owner === "agent" ? "Rama" : "you"}
          </span>
          <button
            className="row-x"
            title="Close page"
            aria-label={`Close ${p.title}`}
            onClick={(e) => {
              e.stopPropagation();
              void closePage(p.id);
            }}
          >
            <Icon name="x" />
          </button>
        </PressRow>
      ))}
    </>
  );
}
