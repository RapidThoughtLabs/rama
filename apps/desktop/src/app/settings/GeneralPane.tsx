import { useEffect, useState } from "react";
import { useToast } from "@rama/ui";
import type { ChatMode, GeneralSettingsDTO } from "@rama/protocol";
import { fetchGeneralSettings, saveGeneralSettings } from "../../engine/client";
import { Card, MiniSeg, PaneHead, Row, Section, Switch, errorText } from "./parts";

const MODES: { id: ChatMode; label: string }[] = [
  { id: "agent", label: "Agent" },
  { id: "plan", label: "Plan" },
  { id: "ask", label: "Ask" },
];

export function GeneralPane() {
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
      push(errorText(err), "bad");
    }
  }

  return (
    <>
      <PaneHead title="General" sub="How new projects and chats start, and what Rama does in the background." />
      <div className="r-set-body">
        {!settings ? (
          <div className="r-set-loading">Loading…</div>
        ) : (
          <>
            <Section title="Projects and chats">
              <Card>
                <div className="r-set-row stack">
                  <div className="r-set-row-text">
                    <b>Default project folder</b>
                    <p>Filled in for you when you add a project.</p>
                  </div>
                  <input
                    className="r-input mono"
                    placeholder="~/dev"
                    spellCheck={false}
                    value={settings.defaultProjectDir}
                    onChange={(e) => setSettings({ ...settings, defaultProjectDir: e.target.value })}
                    onBlur={() => save({ defaultProjectDir: settings.defaultProjectDir })}
                  />
                </div>
                <Row title="New Code chats start in" hint="Agent edits and runs things, Plan proposes first, Ask only answers.">
                  <MiniSeg label="Default mode" options={MODES} value={settings.defaultMode} onChange={(mode) => save({ defaultMode: mode })} />
                </Row>
                <Row title="Name chats automatically" hint="After the first reply, your background model writes a short title. Off means nothing is sent for this.">
                  <Switch label="Name chats automatically" checked={settings.autoNameChats} onChange={(v) => save({ autoNameChats: v })} />
                </Row>
              </Card>
            </Section>

            <Section title="Advanced">
              <Card>
                <Row
                  title="Look up model details on OpenRouter"
                  hint="Fills in prices, context size and capabilities for models Rama doesn't know, from OpenRouter's public list. At most once a week, no key needed."
                >
                  <Switch label="Look up model details on OpenRouter" checked={settings.enrichFromOpenRouter} onChange={(v) => save({ enrichFromOpenRouter: v })} />
                </Row>
                <Row
                  title="Trim old tool output in long turns"
                  hint="Swaps old file reads and command output for a placeholder to free up context. The agent may need to read files again."
                >
                  <Switch label="Trim old tool output" checked={settings.pruneOldToolOutputs} onChange={(v) => save({ pruneOldToolOutputs: v })} />
                </Row>
              </Card>
            </Section>

            <Section title="Privacy">
              <Card>
                <Row title="Your data stays on this Mac" hint="Chats, projects and settings live in ~/.rama, keys in your Keychain. Rama collects no usage data." />
              </Card>
            </Section>
          </>
        )}
      </div>
    </>
  );
}
