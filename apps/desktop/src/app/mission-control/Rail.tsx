import type { MissionControlPane } from "./panes";

// docs/MISSION_CONTROL_PLAN.md §4.1 — the generic rail chrome: a 36px header (pane label, count,
// right-aligned actions) over a scrollable body, or — when collapsed in wide mode — a 44px icon
// strip with no header at all (§4.5). The pane-specific list content is `pane.Rail`.
export function Rail({
  pane,
  wide,
  collapsed,
  size,
}: {
  pane: MissionControlPane;
  wide: boolean;
  collapsed: boolean;
  size?: number;
}) {
  const badge = pane.useBadge();
  const RailBody = pane.Rail;
  const RailActions = pane.RailActions;

  if (wide && collapsed) {
    return (
      <div className="rama-mc-rail rama-mc-rail-icons" style={{ width: 44 }}>
        <RailBody collapsed />
      </div>
    );
  }

  return (
    <div className="rama-mc-rail" style={wide ? { width: size } : undefined}>
      <div className="rama-mc-rail-header">
        <span className="t-label">{pane.label}</span>
        {badge && badge.count > 0 && <span className="rama-badge rama-badge-accent">{badge.count}</span>}
        <span style={{ flex: 1 }} />
        {RailActions && <RailActions />}
      </div>
      <div className="rama-mc-rail-body">
        <RailBody collapsed={false} />
      </div>
    </div>
  );
}
