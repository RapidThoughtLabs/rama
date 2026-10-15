import { useMemo, useRef, useState } from "react";
import type { Ref } from "react";
import { createPortal } from "react-dom";
import { Attachment, Composer, Modal, placeOf, type ModelChoice } from "@rama/ui";
import { acceptFiles, chipForFile, isImage } from "./attachments";
import { fetchModelRoles } from "../../engine/client";
import { ProviderSetupWizard } from "../ProviderSetupWizard";
import { useProvidersData } from "../data/ProvidersProvider";
import { useSettingsLink } from "../data/SettingsLinkContext";

/* Home's composer — HOME_REDESIGN_PLAN.md Phase HD5. The kit composer fed from the provider roster:
   the menu offers the user's shortlist (PROVIDERS_PLAN P3/P4: enabled models that aren't missing
   or erroring) across enabled providers, never the full catalog. A provider whose health is bad
   or keyless keeps its models listed and marked unavailable, which replaces the old title-bar
   alert dot. With no model at all, Send and the pill open the setup wizard in place, instead of
   swapping the whole landing out the way the old Code chat column did.

   HD7: the paperclip opens the system file picker; files can also be dropped on the card or
   pasted. They wait as chips above the textarea (each with a ✕) until Send, when the caller
   uploads them. Notes after the privacy line: a model that can't see an attached photo, a file
   that couldn't be added, and, while the globe is on, that web search isn't set up yet (it
   doesn't exist until WEB_SEARCH_PLAN WS0–WS2). */

export interface ModelRef {
  providerId: string | null;
  modelId: string | null;
}

/** The shortlist as menu rows, plus a resolver for the current pick (which may sit outside it). */
export function useModelChoices(): { models: ModelChoice[]; resolve: (ref: ModelRef) => ModelChoice | null } {
  const { providers, health } = useProvidersData();
  return useMemo(() => {
    const unavailable = (providerId: string) => {
      const status = health[providerId]?.status;
      return status === "bad" || status === "no-key";
    };
    const models: ModelChoice[] = [];
    for (const p of providers) {
      if (!p.enabled) continue;
      for (const m of p.models) {
        if (!m.enabled || m.status === "missing" || m.status === "erroring") continue;
        models.push({ providerId: p.id, modelId: m.id, name: m.label, place: placeOf(p), via: p.label, unavailable: unavailable(p.id) });
      }
    }
    const resolve = ({ providerId, modelId }: ModelRef): ModelChoice | null => {
      if (!providerId || !modelId) return null;
      const p = providers.find((x) => x.id === providerId);
      if (!p) return null;
      const m = p.models.find((x) => x.id === modelId);
      return { providerId, modelId, name: m?.label ?? modelId, place: placeOf(p), via: p.label, unavailable: unavailable(p.id) };
    };
    return { models, resolve };
  }, [providers, health]);
}

export function HomeComposer({
  placeholder,
  value,
  onChange,
  onSubmit,
  running,
  onStop,
  webSearch,
  onWebSearchChange,
  selected,
  onPickModel,
  textareaRef,
  files,
  onFilesChange,
  notice,
}: {
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  running?: boolean;
  onStop?: () => void;
  webSearch: boolean;
  onWebSearchChange: (on: boolean) => void;
  selected: ModelRef;
  onPickModel: (providerId: string, modelId: string) => void;
  textareaRef?: Ref<HTMLTextAreaElement>;
  /** Files waiting to go with the next message. */
  files: File[];
  onFilesChange: (files: File[]) => void;
  /** The caller's own problem to show, e.g. an upload that failed. */
  notice?: string | null;
}) {
  const { models, resolve } = useModelChoices();
  const { providers } = useProvidersData();
  const { open: openSettings } = useSettingsLink();
  const [setupOpen, setSetupOpen] = useState(false);
  const [addNotice, setAddNotice] = useState<string | null>(null);
  const pickerRef = useRef<HTMLInputElement>(null);
  const model = resolve(selected);

  function addFiles(incoming: File[]) {
    const next = acceptFiles(files, incoming);
    setAddNotice(next.notice);
    if (next.files.length !== files.length) onFilesChange(next.files);
  }

  const seesImages = !!model && !!providers.find((p) => p.id === model.providerId)?.models.find((m) => m.id === model.modelId)?.supportsVision;
  const blindTo = model && !seesImages && files.some(isImage) ? model.name : null;
  const problem = notice ?? addNotice;

  async function afterSetup(providerId: string) {
    setSetupOpen(false);
    try {
      const chat = (await fetchModelRoles()).chat;
      if (chat) return onPickModel(chat.providerId, chat.modelId);
    } catch (err) {
      console.error("[rama] failed to read the default model after setup", err);
    }
    const first = providers.find((p) => p.id === providerId)?.models.find((m) => m.enabled);
    if (first) onPickModel(providerId, first.id);
  }

  return (
    <>
      <Composer
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        running={running}
        onStop={onStop}
        webSearch={webSearch}
        onWebSearchChange={onWebSearchChange}
        onAttach={() => pickerRef.current?.click()}
        onDropFiles={addFiles}
        canSendEmpty={files.length > 0}
        above={
          files.length > 0 && (
            <div className="r-composer-files">
              {files.map((f, i) => (
                <Attachment
                  key={`${f.name}:${f.size}:${f.lastModified}`}
                  chip={chipForFile(f)}
                  onRemove={() => {
                    setAddNotice(null);
                    onFilesChange(files.filter((_, j) => j !== i));
                  }}
                />
              ))}
            </div>
          )
        }
        trailing={
          <>
            {blindTo && <span className="pv-warn">· {blindTo} can't see images. Pick a model that can.</span>}
            {problem && <span className="pv-bad">· {problem}</span>}
            {webSearch && (
              <span>
                ·{" "}
                <button type="button" className="pv-link" onClick={() => openSettings()}>
                  Web search isn't set up yet
                </button>
              </span>
            )}
          </>
        }
        models={models}
        model={model}
        onPickModel={(m) => onPickModel(m.providerId, m.modelId)}
        onMoreModels={() => openSettings({ pane: "providers" })}
        onChooseModel={() => setSetupOpen(true)}
        textareaRef={textareaRef}
      />
      <input
        ref={pickerRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          addFiles(Array.from(e.currentTarget.files ?? []));
          e.currentTarget.value = "";
        }}
      />
      {/* Portalled: the view is its own stacking context, and the overlay must cover the sidebar. */}
      {setupOpen &&
        createPortal(
          <Modal open title="Set up a model" onClose={() => setSetupOpen(false)}>
            <ProviderSetupWizard onDone={afterSetup} onCancel={() => setSetupOpen(false)} />
          </Modal>,
          document.body,
        )}
    </>
  );
}
