import { useEffect, useRef, useState } from "react";
import { Fluke } from "@rama/ui";
import { useHomeChats } from "../data/HomeChatsProvider";
import { useNavigation } from "../data/NavigationProvider";
import { greeting, relativeTime } from "./dates";
import { HomeComposer } from "./HomeComposer";

/* Home's landing — HOME_REDESIGN_PLAN.md Phase HD5 (mock:L202-229, 779-789, 1593-1603, 1859-1869).
   The fluke, a greeting for the hour, the composer, and up to three chats to pick back up. The
   inner block is keyed on the navigation's landingKey, so every visit (including "New chat" while
   already here) remounts it: the arrival animation replays and the greeting is recomputed. */
export function HomeLanding() {
  const { landingKey } = useNavigation();
  return (
    <section className="r-view r-landing">
      <LandingInner key={landingKey} />
    </section>
  );
}

function LandingInner() {
  const nav = useNavigation();
  const { homeChats, draft, updateDraft, createFromDraft } = useHomeChats();
  const [greet] = useState(() => greeting(new Date().getHours()));
  const [notice, setNotice] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // mock:L1867 — focus the composer once the arrival has started, without scrolling.
  useEffect(() => {
    const t = setTimeout(() => taRef.current?.focus({ preventScroll: true }), 50);
    return () => clearTimeout(t);
  }, []);

  const now = Date.now();
  const resume = [...homeChats].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3);

  return (
    <div className="r-landing-inner arrive">
      <Fluke className="r-greet-fluke" aria-hidden="true" role={undefined} aria-label={undefined} />
      <h1 className="r-greet">{greet}</h1>
      <div className="r-composer-wrap">
        <HomeComposer
          placeholder="Ask anything, or drop in a file"
          value={draft.text}
          onChange={(text) => updateDraft({ text })}
          onSubmit={() => {
            setNotice(null);
            createFromDraft().catch((err) => {
              console.error("[rama] failed to start a Home chat", err);
              setNotice(err instanceof Error ? err.message : String(err));
            });
          }}
          files={draft.files}
          onFilesChange={(files) => {
            setNotice(null);
            updateDraft({ files });
          }}
          notice={notice}
          webSearch={draft.webSearch}
          onWebSearchChange={(webSearch) => updateDraft({ webSearch })}
          selected={{ providerId: draft.providerId, modelId: draft.model }}
          onPickModel={(providerId, model) => updateDraft({ providerId, model })}
          textareaRef={taRef}
        />
      </div>
      {resume.length > 0 && (
        <div className="r-resume">
          <h2>Pick up where you left off</h2>
          <div>
            {resume.map((c) => (
              <button key={c.id} className="r-resume-row" onClick={() => nav.openHomeChat(c.id)}>
                <b>{c.title}</b>
                <time dateTime={new Date(c.updatedAt).toISOString()}>{relativeTime(c.updatedAt, now)}</time>
                <p>{c.snippet ?? ""}</p>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
