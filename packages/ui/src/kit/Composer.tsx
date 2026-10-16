import { useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode, Ref } from "react";
import { useTheme } from "../theme";
import { Icon } from "./Icon";
import { ModelMenu, sameModel, type ModelChoice } from "./ModelMenu";

/* Kit composer — HOME_REDESIGN_PLAN.md Phase HD5 (mock:L232-279, 1543-1590). The card, the
   autosizing textarea, the tool row (attach, web search, model pill, send) and the privacy line
   under it. Controlled: the caller owns the text, what sending means, and which models are on
   offer.

   Slots for the Code plan (§3 rule 3): `above` (its chip row), `tools` (its mode pill, which
   replaces the web toggle) and `corner` (its context ring, pinned inside the card's top right).
   There is no where-does-this-model-run line: models and providers are dynamic, so the pill's
   own icon says local or cloud and nothing is printed under the card. `trailing` is the line
   under the card for notes that need saying (a file that couldn't be added), and is left out when
   there are none.

   Not in the mockup (§6.3): while a run is going the send button turns into a stop button, and
   with no model the pill reads "Choose a model", and it and Send open the menu, or call
   `onChooseModel` (Home: the provider setup wizard) when there are no models to offer.

   HD7: files dropped on the card or pasted into it go to `onDropFiles`, and the card lights up
   while files are dragged over it. With `canSendEmpty` (files waiting), Send works without text. */

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  running?: boolean;
  onStop?: () => void;
  webSearch?: boolean;
  onWebSearchChange?: (on: boolean) => void;
  onAttach?: () => void;
  onDropFiles?: (files: File[]) => void;
  canSendEmpty?: boolean;
  models: ModelChoice[];
  model: ModelChoice | null;
  onPickModel: (model: ModelChoice) => void;
  onMoreModels?: () => void;
  onChooseModel?: () => void;
  above?: ReactNode;
  tools?: ReactNode;
  trailing?: ReactNode;
  corner?: ReactNode;
  textareaRef?: Ref<HTMLTextAreaElement>;
}

const MAX_HEIGHT = 220;

export function Composer({
  value,
  onChange,
  onSubmit,
  placeholder,
  running = false,
  onStop,
  webSearch = false,
  onWebSearchChange,
  onAttach,
  onDropFiles,
  canSendEmpty = false,
  models,
  model,
  onPickModel,
  onMoreModels,
  onChooseModel,
  above,
  tools,
  trailing,
  corner,
  textareaRef,
}: ComposerProps) {
  const { fontScale } = useTheme();
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dropping, setDropping] = useState(false);
  const empty = !value.trim() && !canSendEmpty;
  const hasFiles = (dt: DataTransfer | null) => !!dt && Array.from(dt.types).includes("Files");

  // mock:L1580-1584 — grow with the text up to 220px, then scroll. Re-measured when the text size
  // changes, since that changes the line height under the same text.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, MAX_HEIGHT)}px`;
  }, [value, fontScale]);

  function setRefs(el: HTMLTextAreaElement | null) {
    taRef.current = el;
    if (typeof textareaRef === "function") textareaRef(el);
    else if (textareaRef) (textareaRef as { current: HTMLTextAreaElement | null }).current = el;
  }

  function send() {
    if (empty || running) return;
    if (!model) return chooseModel();
    onSubmit();
  }

  // No model yet: offer the menu when there's anything in it, otherwise the caller's setup flow.
  function chooseModel() {
    if (models.length === 0 && onChooseModel) onChooseModel();
    else setMenuOpen(true);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // mock:L2121 — Enter sends, Shift+Enter is a newline. Never mid-IME composition.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  }

  return (
    <>
      <form
        className={dropping ? "r-composer drop" : "r-composer"}
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        onDragOver={(e) => {
          if (!onDropFiles || !hasFiles(e.dataTransfer)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDropping(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
        }}
        onDrop={(e) => {
          if (!onDropFiles || !hasFiles(e.dataTransfer)) return;
          e.preventDefault();
          setDropping(false);
          onDropFiles(Array.from(e.dataTransfer.files));
        }}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData.files);
          if (!onDropFiles || files.length === 0) return;
          e.preventDefault();
          onDropFiles(files);
        }}
      >
        {corner && <div className="r-composer-corner">{corner}</div>}
        {above}
        <textarea ref={setRefs} rows={1} aria-label="Message" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} />
        <div className="r-composer-row">
          <button type="button" className="r-tool-btn" title="Attach a file" aria-label="Attach a file" onClick={onAttach}>
            <Icon name="clip" />
          </button>
          {tools ?? (
            <button type="button" className="r-tool-btn" aria-pressed={webSearch} title="Search the web" onClick={() => onWebSearchChange?.(!webSearch)}>
              <Icon name="globe" />
              <span className="lbl">Web search</span>
            </button>
          )}
          <button
            ref={pillRef}
            type="button"
            className="r-model-pill"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => (menuOpen ? setMenuOpen(false) : chooseModel())}
          >
            {model && <Icon name={model.place === "local" ? "lock" : "cloud"} />}
            <span>{model ? model.name : "Choose a model"}</span>
            <Icon name="down" className="chev" />
          </button>
          {running ? (
            <button type="button" className="r-send r-stop" aria-label="Stop" title="Stop" onClick={onStop}>
              <span className="sq" />
            </button>
          ) : (
            <button type="submit" className="r-send" aria-label="Send" disabled={empty}>
              <Icon name="up" />
            </button>
          )}
        </div>
      </form>
      {trailing && <p className="r-privacy">{trailing}</p>}
      <ModelMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        anchor={pillRef}
        models={models}
        selected={model}
        onPick={(m) => {
          setMenuOpen(false);
          if (!sameModel(m, model)) onPickModel(m);
        }}
        onMore={
          onMoreModels &&
          (() => {
            setMenuOpen(false);
            onMoreModels();
          })
        }
      />
    </>
  );
}
