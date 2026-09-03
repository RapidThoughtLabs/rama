import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Button, FONT_SCALES, Fluke, Input, Modal, SegmentedControl, useTheme, useToast, type RamaTheme, type ThemeFamily } from "@rama/ui";
import type {
  ChatMode,
  GeneralSettingsDTO,
  PermissionRule,
  PermissionSettings,
  PermissionTool,
  ProviderHealthStatus,
} from "@rama/protocol";
import {
  fetchGeneralSettings,
  fetchGlobalPermissions,
  fetchProjectPermissions,
  saveGeneralSettings,
  saveGlobalPermissions,
  saveProjectPermissions,
} from "../engine/client";
import { useProjectsData } from "./data/ProjectsProvider";
import { useProvidersData } from "./data/ProvidersProvider";
import { useThemesData } from "./data/ThemesProvider";
import { McpServersModal } from "./McpServersModal";

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

export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [pane, setPane] = useState<Pane>("general");
  if (!open) return null;
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
            </button>
          ))}
        </div>
        <div className="rama-settings-content">
          {pane === "general" && <GeneralPane />}
          {pane === "appearance" && <AppearancePane />}
          {pane === "providers" && <ProvidersPane />}
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
    backgroundImage: wp.css ?? `url('${wp.image}')`,
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
          value={FONT_SCALE_LABEL.get(fontScale) ?? "default"}
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

const PROVIDER_STATUS_LABEL: Record<ProviderHealthStatus, string> = {
  ok: "connected",
  bad: "error",
  "no-key": "no key",
  checking: "checking…",
};
const PROVIDER_STATUS_COLOR: Record<ProviderHealthStatus, string> = {
  ok: "var(--good)",
  bad: "var(--bad)",
  "no-key": "var(--warn)",
  checking: "var(--warn)",
};

function ProvidersPane() {
  const { providers, health, saveProviderKey } = useProvidersData();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const { push } = useToast();

  async function handleSave(providerId: string, label: string) {
    const key = drafts[providerId]?.trim();
    if (!key) return;
    setSavingId(providerId);
    try {
      await saveProviderKey(providerId, key);
      setDrafts((prev) => ({ ...prev, [providerId]: "" }));
      push(`saved ${label} key`, "good");
    } catch (err) {
      push(err instanceof Error ? err.message : String(err), "bad");
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="rama-provider-settings">
      {providers.map((p) => {
        const status = health[p.id]?.status ?? "checking";
        return (
          <div key={p.id} className="rama-provider-settings-row">
            <div className="rama-provider-settings-head">
              <span className="rama-statusbar-dot" style={{ background: PROVIDER_STATUS_COLOR[status] }} />
              <span className="rama-provider-settings-label">{p.label}</span>
              <span className="rama-provider-settings-status">{PROVIDER_STATUS_LABEL[status]}</span>
            </div>
            {p.requiresKey ? (
              <div className="rama-provider-settings-input-row">
                <Input
                  type="password"
                  placeholder={status === "ok" ? "•••••••• (key saved)" : "paste API key…"}
                  value={drafts[p.id] ?? ""}
                  onChange={(e) => setDrafts((prev) => ({ ...prev, [p.id]: e.target.value }))}
                />
                <Button size="sm" onClick={() => handleSave(p.id, p.label)} disabled={!drafts[p.id]?.trim() || savingId === p.id}>
                  {savingId === p.id ? "saving…" : "save"}
                </Button>
              </div>
            ) : (
              <div className="rama-provider-settings-hint">local endpoint, no key needed — {p.baseUrl}</div>
            )}
          </div>
        );
      })}
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
