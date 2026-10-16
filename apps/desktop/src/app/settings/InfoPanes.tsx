import { Fluke } from "@rama/ui";
import { Card, PaneHead, Row, Section } from "./parts";

/* The read-only panes. Every shortcut listed here is wired in CommandPalette.tsx's one keydown
   listener (or the composer, for ⇧⏎). */

const SHORTCUTS: { section: string; items: { keys: string[]; label: string }[] }[] = [
  {
    section: "Everywhere",
    items: [
      { keys: ["⌘", "K"], label: "Command palette" },
      { keys: ["⌘", "N"], label: "New chat" },
      { keys: ["⌘", ","], label: "Settings" },
      { keys: ["esc"], label: "Close a menu or dialog, or stop a running reply" },
    ],
  },
  {
    section: "Chats and windows",
    items: [
      { keys: ["⌃", "⇥"], label: "Next chat in this window (⇧ for previous)" },
      { keys: ["⌘", "1–9"], label: "Jump to a chat in this window" },
      { keys: ["⌘", "⇧", "O"], label: "Move the chat to its own window" },
      { keys: ["⇧", "⏎"], label: "New line in the message box" },
    ],
  },
  {
    section: "Code workspace",
    items: [
      { keys: ["⌥", "1–4"], label: "Changes, Terminal, Web, Files" },
      { keys: ["⌥", "`"], label: "Fold or unfold the list beside the workspace" },
      { keys: ["⌘", "⇧", "`"], label: "New terminal" },
    ],
  },
];

export function KeyboardPane() {
  return (
    <>
      <PaneHead title="Keyboard" sub="Shortcuts that work across Rama. They can't be changed yet." />
      <div className="r-set-body">
        {SHORTCUTS.map((s) => (
          <Section key={s.section} title={s.section}>
            <Card>
              {s.items.map((item) => (
                <Row key={item.label} title={item.label}>
                  {item.keys.map((k) => (
                    <kbd key={k} className="r-kbd">
                      {k}
                    </kbd>
                  ))}
                </Row>
              ))}
            </Card>
          </Section>
        ))}
      </div>
    </>
  );
}

export function AccountPane() {
  return (
    <>
      <PaneHead title="Account" sub="There's nothing to sign in to." />
      <div className="r-set-body">
        <Section>
          <Card>
            <Row
              title="Local only"
              hint="Rama has no accounts. Your chats, projects, provider keys and settings stay on this Mac, in ~/.rama and your Keychain, and nothing syncs between machines."
            >
              <span className="r-tag accent">This Mac</span>
            </Row>
          </Card>
        </Section>
      </div>
    </>
  );
}

export function AboutPane() {
  return (
    <>
      <PaneHead title="About" />
      <div className="r-set-body">
        <div className="r-about">
          <Fluke aria-hidden="true" role={undefined} aria-label={undefined} />
          <div>
            <b>Rama</b>
            <span>An open-source home for local and cloud models, built for coding.</span>
          </div>
        </div>
        <Section>
          <Card>
            <Row title="Version">
              <span className="val mono">0.1.0</span>
            </Row>
            <Row title="License">
              <span className="val">MIT</span>
            </Row>
            <Row title="Source">
              <span className="val mono">rtl-labs/rama</span>
            </Row>
          </Card>
        </Section>
      </div>
    </>
  );
}
