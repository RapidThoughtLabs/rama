import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "@rama/ui";
import { useProvidersData } from "../data/ProvidersProvider";
import type { SettingsPaneId, SettingsTarget } from "../data/SettingsLinkContext";
import { AboutPane, AccountPane, KeyboardPane } from "./InfoPanes";
import { AppearancePane } from "./AppearancePane";
import { GeneralPane } from "./GeneralPane";
import { McpPane } from "./McpPane";
import { ModelsPane } from "./ModelsPane";
import { PermissionsPane } from "./PermissionsPane";
import { ProvidersPane } from "./ProvidersPane";
import { newModelCount } from "./newModels";
import "./settings.css";

/* Settings — one modal (docs/REDESIGN_PLAN.md R4), rebuilt on the Home/Code kit. The left nav
   follows the app sidebar (nav rows, sentence-case group labels, account pinned at the bottom);
   each pane is a title, a line saying what it's for, and raised cards of rows. Providers and
   Models are separate panes: Providers is where an API endpoint is added (OpenAI- or
   Claude-compatible, any base URL), Models is where the models of every provider are mixed into
   the one menu. Portalled into `.r-app` so the kit's fonts and button reset apply. */

export type Navigate = (pane: SettingsPaneId, opts?: Omit<SettingsTarget, "pane">) => void;

const GROUPS: { label?: string; items: { id: SettingsPaneId; label: string; icon: IconName }[] }[] = [
  {
    items: [
      { id: "general", label: "General", icon: "sliders" },
      { id: "appearance", label: "Appearance", icon: "palette" },
      { id: "keyboard", label: "Keyboard", icon: "keyboard" },
    ],
  },
  {
    label: "AI",
    items: [
      { id: "providers", label: "Providers", icon: "plug" },
      { id: "models", label: "Models", icon: "chip" },
    ],
  },
  {
    label: "Agent",
    items: [
      { id: "mcp", label: "MCP servers", icon: "tool" },
      { id: "permissions", label: "Permissions", icon: "shield" },
    ],
  },
];
const FOOT: { id: SettingsPaneId; label: string; icon: IconName }[] = [
  { id: "account", label: "Account", icon: "user" },
  { id: "about", label: "About", icon: "info" },
];

export function SettingsModal({ open, onClose, target }: { open: boolean; onClose: () => void; target: SettingsTarget | null }) {
  const [pane, setPane] = useState<SettingsPaneId>("general");
  // What a pane was opened *for* (a provider to focus, the add form). Cleared on manual nav so a
  // later visit doesn't replay it.
  const [intent, setIntent] = useState<Omit<SettingsTarget, "pane">>({});
  const [visit, setVisit] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const { providers, health } = useProvidersData();

  // A deep link (the composer's model menu, the top bar) lands on its pane every time it's used.
  useEffect(() => {
    if (!open) return;
    if (target?.pane) setPane(target.pane);
    setIntent({ providerId: target?.providerId, addProvider: target?.addProvider });
    setVisit((v) => v + 1);
  }, [open, target]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus({ preventScroll: true });
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.({ preventScroll: true });
    };
  }, [open, onClose]);

  if (!open) return null;

  const navigate: Navigate = (next, opts = {}) => {
    setPane(next);
    setIntent(opts);
    setVisit((v) => v + 1);
  };

  const badProviders = Object.values(health).filter((h) => h.status === "bad" || h.status === "no-key").length;
  const newModels = newModelCount(providers);
  const badge = (id: SettingsPaneId) =>
    id === "providers" && badProviders > 0 ? (
      <span className="r-set-badge bad" aria-label={`${badProviders} need attention`}>
        {badProviders}
      </span>
    ) : id === "models" && newModels > 0 ? (
      <span className="r-set-badge" aria-label={`${newModels} new models`}>
        {newModels}
      </span>
    ) : null;

  const navRow = (item: { id: SettingsPaneId; label: string; icon: IconName }) => (
    <button
      key={item.id}
      type="button"
      className="r-set-nav-row"
      aria-current={pane === item.id ? "page" : undefined}
      title={item.label}
      onClick={() => navigate(item.id)}
    >
      <Icon name={item.icon} />
      <span>{item.label}</span>
      {badge(item.id)}
    </button>
  );

  const body = (
    <div className="r-set-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panelRef} className="r-set" role="dialog" aria-modal="true" aria-label="Settings" tabIndex={-1}>
        <nav className="r-set-nav" aria-label="Settings sections">
          <h2>Settings</h2>
          {GROUPS.map((g, i) => (
            <div key={i}>
              {g.label && <div className="r-group-label">{g.label}</div>}
              {g.items.map(navRow)}
            </div>
          ))}
          <div className="r-set-nav-foot">{FOOT.map(navRow)}</div>
        </nav>
        <div className="r-set-main" key={`${pane}:${visit}`}>
          {pane === "general" && <GeneralPane />}
          {pane === "appearance" && <AppearancePane />}
          {pane === "keyboard" && <KeyboardPane />}
          {pane === "providers" && <ProvidersPane focusProviderId={intent.providerId} startAdding={intent.addProvider} navigate={navigate} />}
          {pane === "models" && <ModelsPane initialProviderId={intent.providerId} navigate={navigate} />}
          {pane === "mcp" && <McpPane />}
          {pane === "permissions" && <PermissionsPane />}
          {pane === "account" && <AccountPane />}
          {pane === "about" && <AboutPane />}
        </div>
        <button type="button" className="r-icon-btn r-set-close" onClick={onClose} aria-label="Close settings" title="Close (Esc)">
          <Icon name="x" />
        </button>
      </div>
    </div>
  );
  return createPortal(body, document.querySelector(".r-app") ?? document.body);
}
