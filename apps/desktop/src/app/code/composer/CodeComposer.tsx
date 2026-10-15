import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import type { ChatMode, FileEntryDTO, ProjectDTO, SearchResultDTO } from "@rama/protocol";
import { Composer, Icon, Popover } from "@rama/ui";
import { fetchProjectFiles, ramaSearch } from "../../../engine/client";
import { useSettingsLink } from "../../data/SettingsLinkContext";
import { useModelChoices, type ModelRef } from "../../home/HomeComposer";
import { ContextChips } from "./ContextChips";
import { ModePill } from "./ModeMenu";
import type { ComposerContext } from "./useComposerContext";
import "./composer.css";

/* The Code composer — docs/CODE_REDESIGN_PLAN.md CR5 (mock:L232-279, 398-404, 1543-1572). Home's
   kit `Composer` with the Code slots filled: the chip row above the text, the mode pill where the
   web toggle would be, and the context ring after the privacy note. The text, what Send means and
   the chat state stay with the caller (CodeChat); this owns the chrome around
   them, the `/` menu and the attach popover.

   Keys: a capture-phase handler on the wrapper sees the textarea's keys before the kit does, so
   the `/` menu can take ↑ ↓ ⏎ and Esc, and Esc can stop a run, without the kit knowing either
   exists. */

const SLASH_RE = /^\/(\S*)$/;

function k(n: number): string {
  return `${Math.round(n / 1000)}k`;
}

function Ring({ pct }: { pct: number }) {
  const c = 2 * Math.PI * 5;
  return (
    <svg className="r-ring" viewBox="0 0 14 14" aria-hidden="true">
      <circle className="bg" cx="7" cy="7" r="5" />
      <circle className="fg" cx="7" cy="7" r="5" strokeDasharray={`${(c * Math.max(pct, 0.03)).toFixed(1)} ${c.toFixed(1)}`} />
    </svg>
  );
}

/** A bare slash command being typed, no space yet — "/" or "/re". A space ends the match: rama search
 *  only drives this picker, never the turn text. */
function useSlashSearch(value: string, projectId: string | undefined) {
  const term = value.match(SLASH_RE)?.[1] ?? null;
  const [results, setResults] = useState<SearchResultDTO[]>([]);
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);

  // docs/IMPLEMENTATION_PLAN.md Phase 6 — a native harness search seam, not heku (heku is its own
  // MCP server scoped to config search). Only the "tools" domain is registered today.
  useEffect(() => {
    if (term === null) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      ramaSearch(term, projectId)
        .then((list) => {
          setResults(list);
          setIndex(0);
        })
        .catch(() => setResults([]));
    }, 150);
    return () => clearTimeout(timer);
  }, [term, projectId]);

  const groups = useMemo(() => {
    const by = new Map<string, SearchResultDTO[]>();
    for (const r of results) by.set(r.domain, [...(by.get(r.domain) ?? []), r]);
    return [...by.entries()];
  }, [results]);

  return {
    open: term !== null && dismissed !== term,
    term,
    results,
    groups,
    index,
    setIndex,
    dismiss: () => setDismissed(term),
  };
}

export function CodeComposer({
  value,
  onChange,
  onSubmit,
  running,
  onStop,
  textareaRef,
  placeholder,
  project,
  projects,
  locked,
  context,
  onSwitchProject,
  onNewChatIn,
  mode,
  onMode,
  agentId,
  onAgent,
  model,
  onPickModel,
  usage,
  onSlashPick,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  running: boolean;
  onStop: () => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  placeholder: string;
  project: ProjectDTO | undefined;
  projects: ProjectDTO[];
  locked: boolean;
  context: ComposerContext;
  onSwitchProject: (projectId: string) => void;
  onNewChatIn: (projectId: string) => void;
  mode: ChatMode;
  onMode: (mode: ChatMode) => void;
  agentId: string | undefined;
  onAgent: (agentId: string) => void;
  model: ModelRef;
  onPickModel: (providerId: string, modelId: string) => void;
  /** Tokens in the chat's context window; null on a draft, which has none yet. */
  usage: { used: number; max: number } | null;
  onSlashPick: (result: SearchResultDTO) => void;
}) {
  const { models, resolve } = useModelChoices();
  const { open: openSettings } = useSettingsLink();
  const slash = useSlashSearch(value, project?.id);
  const wrapRef = useRef<HTMLDivElement>(null);
  const attachAnchor = useRef<HTMLElement | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);

  function onKeyDownCapture(e: KeyboardEvent<HTMLDivElement>) {
    // Popovers are portalled out of the wrapper but their events still bubble through it.
    if (!(e.target instanceof HTMLTextAreaElement)) return;
    if (slash.open && slash.results.length > 0) {
      const last = slash.results.length - 1;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        slash.setIndex(e.key === "ArrowDown" ? (slash.index >= last ? 0 : slash.index + 1) : slash.index <= 0 ? last : slash.index - 1);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        slash.dismiss();
        onSlashPick(slash.results[slash.index]!);
        return;
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (slash.open) slash.dismiss();
      else if (running) onStop();
    }
  }

  function insertMention(path: string) {
    const ta = textareaRef.current;
    const at = ta ? ta.selectionStart : value.length;
    const end = ta ? ta.selectionEnd : value.length;
    const before = value.slice(0, at);
    const mention = `${before && !/\s$/.test(before) ? " " : ""}@${path} `;
    onChange(before + mention + value.slice(end));
    requestAnimationFrame(() => {
      ta?.focus();
      const caret = before.length + mention.length;
      ta?.setSelectionRange(caret, caret);
    });
  }

  const selected = resolve(model);
  const pct = usage && usage.max > 0 ? Math.min(1, usage.used / usage.max) : 0;

  return (
    <div className="r-composer-wrap r-code-composer" ref={wrapRef} onKeyDownCapture={onKeyDownCapture}>
      {slash.open && (
        <div className="r-pop r-slash" role="listbox" aria-label="Search tools and commands">
          {slash.results.length === 0 ? (
            <div className="r-slash-empty">{slash.term ? "No matches" : "Type to search tools…"}</div>
          ) : (
            (() => {
              let flat = -1;
              return slash.groups.map(([domain, items]) => (
                <div key={domain}>
                  <div className="r-mp-label">{domain.charAt(0).toUpperCase() + domain.slice(1)}</div>
                  {items.map((r) => {
                    const i = ++flat;
                    return (
                      <button
                        key={r.id}
                        type="button"
                        role="option"
                        aria-selected={i === slash.index}
                        className="r-mp-item r-slash-item"
                        // mousedown would blur the textarea before the click lands.
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseEnter={() => slash.setIndex(i)}
                        onClick={() => {
                          slash.dismiss();
                          onSlashPick(r);
                        }}
                      >
                        <span>
                          <b>{r.title}</b>
                          {r.subtitle && <small>{r.subtitle}</small>}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ));
            })()
          )}
        </div>
      )}
      <Composer
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        running={running}
        onStop={onStop}
        models={models}
        model={selected}
        onPickModel={(m) => onPickModel(m.providerId, m.modelId)}
        onMoreModels={() => openSettings({ pane: "providers" })}
        onChooseModel={() => openSettings({ pane: "providers" })}
        onAttach={() => {
          if (!project) return;
          attachAnchor.current = wrapRef.current?.querySelector<HTMLElement>(".r-tool-btn") ?? null;
          setAttachOpen((v) => !v);
        }}
        textareaRef={textareaRef}
        above={
          <ContextChips
            project={project}
            projects={projects}
            locked={locked}
            context={context}
            onSwitchProject={onSwitchProject}
            onNewChatIn={onNewChatIn}
            onAddProject={() => window.dispatchEvent(new CustomEvent("rama:open-add-project"))}
          />
        }
        tools={<ModePill mode={mode} onMode={onMode} projectId={project?.id} agentId={agentId} onAgent={onAgent} disabled={running} />}
        trailing={
          usage && usage.max > 0 ? (
            <span className="ctx">
              <Ring pct={pct} />
              {k(usage.used)} of {k(usage.max)} context used
            </span>
          ) : null
        }
      />
      {project && (
        <FileMention
          open={attachOpen}
          anchor={attachAnchor}
          projectId={project.id}
          onClose={() => setAttachOpen(false)}
          onPick={(path) => {
            setAttachOpen(false);
            insertMention(path);
          }}
        />
      )}
    </div>
  );
}

/* Attach, in Code: there are no binary attachments, so the clip mentions a project file instead —
   it types `@relative/path` into the message, which is how the agent is pointed at a file. The
   popover completes a path one directory at a time from the project's own file listing. */
function FileMention({
  open,
  anchor,
  projectId,
  onClose,
  onPick,
}: {
  open: boolean;
  anchor: RefObject<HTMLElement | null>;
  projectId: string;
  onClose: () => void;
  onPick: (path: string) => void;
}) {
  const [text, setText] = useState("");
  const [listing, setListing] = useState<Record<string, FileEntryDTO[]>>({});
  const [index, setIndex] = useState(0);
  const slash = text.lastIndexOf("/");
  const dir = slash >= 0 ? text.slice(0, slash) : "";
  const stem = text.slice(slash + 1).toLowerCase();

  useEffect(() => {
    if (!open) {
      setText("");
      setIndex(0);
    }
  }, [open]);

  useEffect(() => {
    if (!open || listing[dir]) return;
    let cancelled = false;
    fetchProjectFiles(projectId, dir)
      .then((r) => {
        if (!cancelled) setListing((prev) => ({ ...prev, [dir]: r.entries }));
      })
      .catch(() => {
        if (!cancelled) setListing((prev) => ({ ...prev, [dir]: [] }));
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId, dir, listing]);

  const rows = (listing[dir] ?? [])
    .filter((e) => !e.ignored && e.name.toLowerCase().includes(stem))
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1))
    .slice(0, 8);

  function choose(entry: FileEntryDTO) {
    if (entry.kind === "dir") {
      setText(`${entry.path}/`);
      setIndex(0);
    } else onPick(entry.path);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (rows.length) setIndex((i) => (e.key === "ArrowDown" ? (i + 1) % rows.length : (i - 1 + rows.length) % rows.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[index];
      if (row) choose(row);
      else if (text.trim()) onPick(text.trim());
    }
  }

  return (
    <Popover open={open} onClose={onClose} anchor={anchor} placement="above" className="r-model-pop r-mention-pop" role="dialog" aria-label="Mention a file">
      <input
        autoFocus
        className="r-add-pop-input"
        placeholder="Find a file in the project"
        aria-label="File path"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setIndex(0);
        }}
        onKeyDown={onKeyDown}
      />
      {rows.map((e, i) => (
        <button key={e.path} type="button" className="r-mp-item r-mention-row" aria-selected={i === index} onMouseEnter={() => setIndex(i)} onClick={() => choose(e)}>
          <Icon name={e.kind === "dir" ? "folder" : "doc"} />
          <span>
            <b>{e.name}</b>
          </span>
        </button>
      ))}
      {listing[dir] && rows.length === 0 && <div className="r-slash-empty">{text.trim() ? "No match. Enter adds it as typed." : "This folder is empty."}</div>}
    </Popover>
  );
}
