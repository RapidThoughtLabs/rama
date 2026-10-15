import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { FONT_SCALES, Fluke, Input, Modal, SegmentedControl, Toggle, useTheme, useToast, wallpaperCss, type RamaTheme, type ThemeFamily } from "@rama/ui";
import type { ChatMode, GeneralSettingsDTO, ModelRole, ModelRoleDTO, PermissionRule, PermissionSettings, PermissionTool } from "@rama/protocol";
import {
  fetchGeneralSettings,
  fetchGlobalPermissions,
  fetchModelRoles,
  fetchProjectPermissions,
  saveGeneralSettings,
  saveGlobalPermissions,
  saveModelRole,
  saveProjectPermissions,
} from "../engine/client";
import { useProjectsData } from "./data/ProjectsProvider";
import { useProvidersData } from "./data/ProvidersProvider";
import { useThemesData } from "./data/ThemesProvider";
import { McpServersModal } from "./McpServersModal";
import { ProvidersSettingsPane } from "./ProvidersSettingsPane";

// docs/REDESIGN_PLAN.md Phase R4 — one settings modal, replacing/absorbing ProviderSettingsModal,
// Sidebar.tsx's old inline settings <Modal>, and McpServersModal's standalone mount. Docs and
// Toolbox stay out of here (they're sidebar nav rows, becoming full pages in Phase R6) — see the
// plan's own note on why.

type Pane = "general" | "appearance" | "providers" | "mcp" | "permissions" | "keyboard" | "account" | "about";

const PANES: { id: Pane; label: string }[] = [
  { id: "general", label: "general" },
  { id: "appearance", label: "appearance" },
  { id: "providers", label: "providers & models" },
  { id: "mcp", label: "mcp servers" },
  { id: "permissions", label: "permissions" },
  { id: "keyboard", label: "keyboard" },
  { id: "account", label: "account" },
  { id: "about", label: "about" },
];

export function SettingsModal({
  open,
  onClose,
  initialPane,
  focusProviderId,
}: {
  open: boolean;
  onClose: () => void;
  initialPane?: Pane;
  focusProviderId?: string;
}) {
  const [pane, setPane] = useState<Pane>("general");
  const { providers, health } = useProvidersData();

  // docs/PROVIDERS_PLAN.md Phase P1 — a deep link (the composer's model menu, the topbar) lands
  // on a specific pane every time it's used, not just the first time the modal ever opened.
  useEffect(() => {
    if (open && initialPane) setPane(initialPane);
  }, [open, initialPane]);

  if (!open) return null;

  // "a count badge on the settings nav row, which also carries Phase P4's '3 new models'" —
  // unhealthy configured providers (Phase P1) plus models discovered since the pane was last
  // opened (Phase P4, bookmarked per-provider in localStorage by ProvidersSettingsPane).
  const badProviderCount = Object.values(health).filter((h) => h.status === "bad").length;
  const newModelCount = providers.reduce((sum, p) => {
    const lastViewedAt = Number(window.localStorage.getItem(`rama.providerLastViewedAt.${p.id}`) ?? 0) || 0;
    return sum + p.models.filter((m) => m.firstSeenAt > lastViewedAt && !m.enabled).length;
  }, 0);
  const navBadgeCount = badProviderCount + newModelCount;

  return (
    <Modal open={open} title="settings" onClose={onClose} className="rama-modal-wide">
      <div className="rama-settings">
        <div className="rama-settings-nav">
          {PANES.map((p) => (
            <button
              key={p.id}
              className={`rama-settings-nav-item ${pane === p.id ? "rama-settings-nav-item-active" : ""}`}
              onClick={() => setPane(p.id)}
            >
              {p.label}
              {p.id === "providers" && navBadgeCount > 0 && <span className="rama-settings-nav-badge">{navBadgeCount}</span>}
            </button>
          ))}
        </div>
        <div className="rama-settings-content">
          {pane === "general" && <GeneralPane />}
          {pane === "appearance" && <AppearancePane />}
          {pane === "providers" && <ProvidersSettingsPane focusProviderId={open ? focusProviderId : undefined} />}
          {pane === "mcp" && <McpServersModal />}
          {pane === "permissions" && <PermissionsPane />}
          {pane === "keyboard" && <KeyboardPane />}
          {pane === "account" && <AccountPane />}
          {pane === "about" && <AboutPane />}
        </div>
      </div>
    </Modal>
  );
}

const MODES: { id: ChatMode; label: string }[] = [
  { id: "agent", label: "agent" },
  { id: "plan", label: "plan" },
  { id: "ask", label: "ask" },
];

function GeneralPane() {
  const [settings, setSettings] = useState<GeneralSettingsDTO | null>(null);
  const { push } = useToast();

  useEffect(() => {
    fetchGeneralSettings()
      .then(setSettings)
      .catch((err) => console.error("[rama] failed to load general settings", err));
  }, []);

  async function save(patch: Partial<GeneralSettingsDTO>) {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
    try {
      await saveGeneralSettings(patch);
    } catch (err) {
      push(err instanceof Error ? err.message : String(err), "bad");
    }
  }

  if (!settings) return <div className="rama-settings-hint">loading…</div>;

  return (
    <div className="rama-settings-pane">
      <div className="rama-settings-field">
        <label className="rama-settings-label">default project directory</label>
        <Input
          placeholder="~/dev"
          value={settings.defaultProjectDir}
          onChange={(e) => setSettings({ ...settings, defaultProjectDir: e.target.value })}
          onBlur={() => save({ defaultProjectDir: settings.defaultProjectDir })}
        />
        <div className="rama-settings-hint">pre-fills the path field when adding a new project.</div>
      </div>
      <div className="rama-settings-field">
        <label className="rama-settings-label">default chat mode</label>
        <SegmentedControl options={MODES} value={settings.defaultMode} onChange={(mode) => save({ defaultMode: mode })} />
        <div className="rama-settings-hint">the mode a brand new chat starts in.</div>
      </div>
      <ModelRolesField />
      <div className="rama-settings-field">
        <label className="rama-settings-label">auto-name chats</label>
        <Toggle checked={settings.autoNameChats} onChange={(v) => save({ autoNameChats: v })} label={settings.autoNameChats ? "on" : "off"} />
        <div className="rama-settings-hint">
          asks the utility model above for a short title once your first message gets a reply. off means no chat
          content is ever sent anywhere for this — the chat just keeps its first-line title.
        </div>
      </div>
      <div className="rama-settings-field">
        <label className="rama-settings-label">enrich pricing from OpenRouter</label>
        <Toggle
          checked={settings.enrichFromOpenRouter}
          onChange={(v) => save({ enrichFromOpenRouter: v })}
          label={settings.enrichFromOpenRouter ? "on" : "off"}
        />
        <div className="rama-settings-hint">
          fills in pricing and capability flags for models the bundled catalog doesn't know about yet, using
          OpenRouter's public model list (no key needed). checked at most once a week, and only ever fills gaps on
          models a configured provider already offers — never adds a model your key can't reach. off by default
          since it's an outbound request.
        </div>
      </div>
      <div className="rama-settings-field">
        <label className="rama-settings-label">prune old tool output</label>
        <Toggle
          checked={settings.pruneOldToolOutputs}
          onChange={(v) => save({ pruneOldToolOutputs: v })}
          label={settings.pruneOldToolOutputs ? "on" : "off"}
        />
        <div className="rama-settings-hint">
          during a long turn, replaces old tool output (old file reads, command output) with a placeholder once it
          falls outside a recent budget — frees context space, but the agent can no longer see what it already read.
          off by default: most tasks never need it, and it can force the agent to re-read files that were still
          relevant.
        </div>
      </div>
      <div className="rama-settings-field">
        <label className="rama-settings-label">telemetry</label>
        <div className="rama-settings-hint">
          rama runs entirely on your machine — chats, projects, and settings all live in ~/.rama. no usage data is
          collected or sent anywhere.
        </div>
      </div>
    </div>
  );
}

// docs/PROVIDERS_PLAN.md Phase P2 — 'chat' replaces the old DEFAULT_PROVIDER_ID/DEFAULT_MODEL
// consts; 'utility' backs auto-titling and future background calls. 'summarize' has no row here
// (rule 3 — no settings UI for a subsystem that doesn't exist yet).
const ROLE_LABEL: Record<"chat" | "utility", string> = { chat: "chat model", utility: "utility model" };

function ModelRolesField() {
  const { providers } = useProvidersData();
  const [roles, setRoles] = useState<Record<ModelRole, ModelRoleDTO | null> | null>(null);
  const { push } = useToast();

  useEffect(() => {
    fetchModelRoles()
      .then(setRoles)
      .catch((err) => console.error("[rama] failed to load model roles", err));
  }, []);

  async function assign(role: ModelRole, providerId: string, modelId: string) {
    setRoles((prev) => (prev ? { ...prev, [role]: { role, providerId, modelId, updatedAt: Date.now() } } : prev));
    try {
      const updated = await saveModelRole(role, providerId, modelId);
      setRoles((prev) => (prev ? { ...prev, [role]: updated } : prev));
    } catch (err) {
      push(err instanceof Error ? err.message : String(err), "bad");
    }
  }

  if (!roles || providers.length === 0) return null;

  return (
    <>
      {(["chat", "utility"] as const).map((role) => {
        const current = roles[role];
        const providerId = current?.providerId ?? providers[0].id;
        const provider = providers.find((p) => p.id === providerId) ?? providers[0];
        const modelId = current?.modelId ?? provider.models[0]?.id ?? "";
        return (
          <div key={role} className="rama-settings-field">
            <label className="rama-settings-label">{ROLE_LABEL[role]}</label>
            <div className="rama-role-row">
              <select
                className="rama-input rama-select"
                value={provider.id}
                onChange={(e) => {
                  const next = providers.find((p) => p.id === e.target.value);
                  const nextModel = next?.models[0]?.id;
                  if (next && nextModel) assign(role, next.id, nextModel);
                }}
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
              <select className="rama-input rama-select" value={modelId} onChange={(e) => assign(role, provider.id, e.target.value)}>
                {provider.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="rama-settings-hint">
              {role === "chat"
                ? "the provider + model every new chat starts on."
                : `background calls (auto-naming chats today; tagging and compaction later) go to ${provider.label} — that's a data-egress choice, not just a cost one.`}
              {role === "utility" && provider.id === "ollama" && " ollama unloads after ~5m idle, so a cold title call can take ~10s."}
            </div>
          </div>
        );
      })}
    </>
  );
}

const FAMILY_LABEL: Record<ThemeFamily, string> = { blue: "blue", red: "red", green: "green" };

function groupByFamily(themes: RamaTheme[]): [ThemeFamily, RamaTheme[]][] {
  const order: ThemeFamily[] = ["blue", "red", "green"];
  return order.map((family) => [family, themes.filter((t) => t.family === family)]);
}

// SETTINGS_PLAN.md Phase S2 — a swatch previews the theme's wallpaper (image or gradient) under
// its veil, not just a flat ground fill, since the wallpaper is part of the theme now (Phase S0).
function themeSwatchStyle(t: RamaTheme): CSSProperties {
  const wp = t.wallpaper;
  if (!wp || (!wp.image && !wp.css)) return { background: t.preview.bg };
  return {
    background: t.preview.bg,
    backgroundImage: wallpaperCss(t),
    backgroundSize: wp.fit ?? "cover",
    backgroundPosition: wp.position ?? "center",
  };
}

const FONT_SCALE_OPTIONS = FONT_SCALES.map((s) => ({ id: s.label, label: s.label }));
const FONT_SCALE_BY_LABEL = new Map(FONT_SCALES.map((s) => [s.label, s.value]));
const FONT_SCALE_LABEL = new Map(FONT_SCALES.map((s) => [s.value, s.label]));

function AppearancePane() {
  const { themeId, themes, fontScale, setThemeId, setFontScale } = useTheme();
  const { errors: themeErrors } = useThemesData();

  return (
    <div className="rama-settings-pane">
      <div className="rama-settings-field">
        <label className="rama-settings-label">theme</label>
        {groupByFamily(themes).map(([family, members]) =>
          members.length === 0 ? null : (
            <div key={family} className="rama-theme-family-row">
              <div className="rama-theme-family-label">{FAMILY_LABEL[family]}</div>
              <div className="rama-theme-gallery">
                {members.map((t) => (
                  <button
                    key={t.id}
                    className={`rama-theme-swatch ${themeId === t.id ? "rama-theme-swatch-active" : ""}`}
                    style={themeSwatchStyle(t)}
                    onClick={() => setThemeId(t.id)}
                    title={t.shadowsBuiltin ? `${t.label} — overridden by ~/.rama/themes/${t.id}.json` : t.label}
                  >
                    <span className="rama-theme-swatch-dot" style={{ background: t.preview.accent }} />
                    <span className="rama-theme-swatch-label" style={{ color: t.preview.ink }}>
                      {t.label}
                      {t.shadowsBuiltin && " *"}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ),
        )}
        <div className="rama-settings-hint">applies to the active chat — every other chat keeps its own theme.</div>
        {themeErrors.length > 0 && (
          <div className="rama-settings-hint" style={{ color: "var(--bad)", marginTop: 6 }}>
            {themeErrors.map((e) => (
              <div key={e.file}>
                {e.file} — {e.message}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="rama-settings-field">
        <label className="rama-settings-label">font size — {FONT_SCALE_LABEL.get(fontScale)}</label>
        <SegmentedControl
          options={FONT_SCALE_OPTIONS}
          value={FONT_SCALE_LABEL.get(fontScale) ?? "Default"}
          onChange={(label) => {
            const scale = FONT_SCALE_BY_LABEL.get(label);
            if (scale !== undefined) setFontScale(scale);
          }}
        />
        <div className="rama-settings-hint">
          applies to every window and the terminal — this is a reading preference, not part of a chat's theme.
        </div>
      </div>
    </div>
  );
}

const PERMISSION_TOOLS: { id: PermissionTool; label: string; hint: string }[] = [
  { id: "bash", label: "bash", hint: "run shell commands" },
  { id: "write", label: "write", hint: "create new files" },
  { id: "edit", label: "edit", hint: "modify existing files" },
  { id: "web", label: "web", hint: "fetch URLs" },
];
const GLOBAL_RULE_OPTIONS: { id: PermissionRule; label: string }[] = [
  { id: "allow", label: "allow" },
  { id: "ask", label: "ask" },
  { id: "deny", label: "deny" },
];
type ProjectRuleOption = "inherit" | PermissionRule;
const PROJECT_RULE_OPTIONS: { id: ProjectRuleOption; label: string }[] = [
  { id: "inherit", label: "inherit" },
  ...GLOBAL_RULE_OPTIONS,
];

function PermissionsPane() {
  const { activeProjectId, projects } = useProjectsData();
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const [global, setGlobal] = useState<PermissionSettings | null>(null);
  const [override, setOverride] = useState<PermissionSettings | null>(null);
  const { push } = useToast();

  useEffect(() => {
    fetchGlobalPermissions()
      .then(setGlobal)
      .catch((err) => console.error("[rama] failed to load global permissions", err));
  }, []);

  useEffect(() => {
    if (!activeProjectId) {
      setOverride(null);
      return;
    }
    fetchProjectPermissions(activeProjectId)
      .then(setOverride)
      .catch((err) => console.error("[rama] failed to load project permissions", err));
  }, [activeProjectId]);

  async function setGlobalRule(tool: PermissionTool, rule: PermissionRule) {
    setGlobal((prev) => (prev ? { ...prev, [tool]: rule } : prev));
    try {
      await saveGlobalPermissions({ [tool]: rule });
    } catch (err) {
      push(err instanceof Error ? err.message : String(err), "bad");
    }
  }

  async function setProjectRule(tool: PermissionTool, choice: ProjectRuleOption) {
    if (!activeProjectId) return;
    const rule = choice === "inherit" ? null : choice;
    setOverride((prev) => {
      const next = { ...(prev ?? {}) };
      if (rule === null) delete next[tool];
      else next[tool] = rule;
      return next;
    });
    try {
      await saveProjectPermissions(activeProjectId, { [tool]: rule });
    } catch (err) {
      push(err instanceof Error ? err.message : String(err), "bad");
    }
  }

  return (
    <div className="rama-settings-pane">
      <div className="rama-settings-hint" style={{ marginBottom: 4 }}>
        rules are saved and shown to the agent's permission prompts, but the agent loop's automatic allow/deny
        enforcement per rule is a follow-up — today `ask` mode still confirms every high-risk call individually.
      </div>

      <div className="rama-settings-field">
        <label className="rama-settings-label">global defaults</label>
        <div className="rama-permission-grid">
          {PERMISSION_TOOLS.map((t) => (
            <div key={t.id} className="rama-permission-row">
              <div>
                <div className="rama-permission-tool">{t.label}</div>
                <div className="rama-settings-hint">{t.hint}</div>
              </div>
              <SegmentedControl
                options={GLOBAL_RULE_OPTIONS}
                value={global?.[t.id] ?? "ask"}
                onChange={(rule) => setGlobalRule(t.id, rule)}
              />
            </div>
          ))}
        </div>
      </div>

      {activeProject && (
        <div className="rama-settings-field">
          <label className="rama-settings-label">override for {activeProject.name}</label>
          <div className="rama-permission-grid">
            {PERMISSION_TOOLS.map((t) => (
              <div key={t.id} className="rama-permission-row">
                <div className="rama-permission-tool">{t.label}</div>
                <SegmentedControl
                  options={PROJECT_RULE_OPTIONS}
                  value={override?.[t.id] ?? "inherit"}
                  onChange={(choice) => setProjectRule(t.id, choice)}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const SHORTCUTS: { keys: string; label: string }[] = [
  { keys: "⌘K", label: "command palette" },
  { keys: "⌘N", label: "new chat in the active project" },
  { keys: "⌘,", label: "open settings" },
  { keys: "⌃⇥ / ⌃⇧⇥", label: "cycle this window's tabs" },
  { keys: "⌘1 – ⌘9", label: "jump to tab N in this window" },
  { keys: "⌘⇧O", label: "pop the active chat out into a new window" },
  { keys: "esc", label: "close a modal or the palette · interrupt a running turn" },
  { keys: "⇧⏎", label: "newline in the composer" },
];

function KeyboardPane() {
  return (
    <div className="rama-settings-pane">
      <div className="rama-settings-hint" style={{ marginBottom: 4 }}>
        read-only for now.
      </div>
      <div className="rama-keyboard-list">
        {SHORTCUTS.map((s) => (
          <div key={s.keys} className="rama-keyboard-row">
            <span className="rama-keyboard-keys">{s.keys}</span>
            <span>{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AccountPane() {
  return (
    <div className="rama-settings-pane">
      <div className="rama-settings-field">
        <span className="rama-badge rama-badge-accent">local only</span>
        <div className="rama-settings-hint" style={{ marginTop: 10 }}>
          rama has no account system yet — everything (chats, projects, provider keys, settings) lives on this
          machine in ~/.rama. there's no sync between machines and nothing to sign in to.
        </div>
      </div>
    </div>
  );
}

function AboutPane() {
  return (
    <div className="rama-settings-pane">
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
        <Fluke style={{ width: 34, height: "auto", color: "var(--accent)" }} />
        <div>
          <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "var(--fs-xl)" }}>rama</div>
          <div className="rama-settings-hint">the terminal that grew a UI · open-source agentic harness</div>
        </div>
      </div>
      <div className="rama-keyboard-list">
        <div className="rama-keyboard-row">
          <span className="rama-keyboard-keys">version</span>
          <span>v0.1.0</span>
        </div>
        <div className="rama-keyboard-row">
          <span className="rama-keyboard-keys">license</span>
          <span>MIT</span>
        </div>
        <div className="rama-keyboard-row">
          <span className="rama-keyboard-keys">repository</span>
          <span>rtl-labs/rama</span>
        </div>
      </div>
    </div>
  );
}
