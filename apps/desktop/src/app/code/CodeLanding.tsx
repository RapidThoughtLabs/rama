import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { Fluke, Icon } from "@rama/ui";
import type { ProjectDTO, RecentChatDTO } from "@rama/protocol";
import { fetchRecentChats } from "../../engine/client";
import { useSettingsLink } from "../data/SettingsLinkContext";
import "../home/home.css";
import { relativeWhen } from "./relativeWhen";
import { useOpenChat } from "./useOpenChat";

/* The Code tab's landing — docs/CODE_REDESIGN_PLAN.md CR8 (mock:L798-809, 1881-1896). The fluke, the
   project's name, the composer, and up to three of the project's chats to pick back up. The frame
   (`.r-landing-inner`, the greeting, the resume rows, the arrival animation) is Home's: the mockup
   draws one `.landing-inner` for both tabs, so both load the same CSS (home/home.css).

   The composer arrives as a node because its state (text, mode, draft sync, submit) lives in
   CodeChat. Two states the mockup doesn't draw (plan §9.36): with no project the composer is a card
   that adds one; with no provider it is a card that opens Settings › Providers' add form. */

export function CodeLanding({
  project,
  composer,
  noProjects,
  needsProvider,
  textareaRef,
}: {
  /** The project the draft is for; undefined only while there are none. */
  project: ProjectDTO | undefined;
  composer: ReactNode;
  noProjects: boolean;
  needsProvider: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
  // Keyed on the project, so entering the landing — or pointing it at another project — replays the
  // arrival, as the mockup's goCodeLanding() does.
  return (
    <section className="r-landing r-code-landing">
      <LandingInner key={project?.id ?? "none"} project={project} composer={composer} noProjects={noProjects} needsProvider={needsProvider} textareaRef={textareaRef} />
    </section>
  );
}

function LandingInner({ project, composer, noProjects, needsProvider, textareaRef }: Parameters<typeof CodeLanding>[0]) {
  const openChat = useOpenChat();
  const { open: openSettings } = useSettingsLink();
  const [recent, setRecent] = useState<RecentChatDTO[]>([]);

  useEffect(() => {
    if (!project) return;
    let live = true;
    fetchRecentChats(project.id, 3)
      .then((rows) => live && setRecent(rows))
      // The rows are a convenience; a failed fetch is a landing without them.
      .catch((err) => console.error("[rama] failed to load recent chats", err));
    return () => {
      live = false;
    };
  }, [project?.id]);

  // mock:L1894 — focus the composer once the arrival has started, without scrolling.
  const canType = !noProjects && !needsProvider;
  useEffect(() => {
    if (!canType) return;
    const t = setTimeout(() => textareaRef.current?.focus({ preventScroll: true }), 50);
    return () => clearTimeout(t);
  }, [canType, textareaRef]);

  const now = Date.now();
  return (
    <div className="r-landing-inner arrive">
      <Fluke className="r-greet-fluke" aria-hidden="true" role={undefined} aria-label={undefined} />
      <h1 className="r-greet">{noProjects ? "Code" : (project?.name ?? "Code")}</h1>

      {noProjects ? (
        <div className="r-empty-card">
          <h2>Add a project to start</h2>
          <p>Code works inside a folder on this Mac. Pick one and it shows up here.</p>
          <button type="button" className="r-btn" onClick={() => window.dispatchEvent(new Event("rama:open-add-project"))}>
            <Icon name="plus" />
            <span>Add a project…</span>
          </button>
        </div>
      ) : needsProvider ? (
        <div className="r-empty-card">
          <h2>Connect a provider to start</h2>
          <p>Rama works with any API that speaks the OpenAI or Claude format, on this Mac like Ollama, or in the cloud.</p>
          <button type="button" className="r-btn" onClick={() => openSettings({ pane: "providers", addProvider: true })}>
            <Icon name="plus" />
            <span>Add a provider…</span>
          </button>
        </div>
      ) : (
        composer
      )}

      {!noProjects && recent.length > 0 && (
        <div className="r-resume">
          <h2>Recent in {project?.name}</h2>
          <div>
            {recent.map((c) => (
              <button key={c.id} type="button" className="r-resume-row" onClick={() => void openChat(c.id)}>
                <b>{c.title}</b>
                <time dateTime={new Date(c.updatedAt).toISOString()}>{relativeWhen(c.updatedAt, now)}</time>
                <p>{c.snippet ?? ""}</p>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
