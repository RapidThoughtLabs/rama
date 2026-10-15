import type { RefObject } from "react";
import { Icon } from "./Icon";
import { Popover } from "./Popover";
import type { ModelPlace } from "./modelPlace";

/* Kit model menu — HOME_REDESIGN_PLAN.md Phase HD5 (mock:L658-666, 1995-2013). Presentational: the
   caller decides which models are on offer (Home passes the user's shortlist) and what picking one
   means. Placed above the pill, right-aligned to it, flipped below when there's no room. Groups are
   "On this Mac" then "Cloud", and an empty group is left out. A model whose provider is down stays
   listed, with its `via` line reading "· unavailable" in the bad colour.

   "More models…" is not in the mockup (§6.3). It sits at the right of the first group label, not
   as a row of its own: a row makes the menu 46px taller than the mockup's, enough that it no
   longer fits above the landing composer at 900px and flips below. With no models at all it's the
   menu's only row. */

export interface ModelChoice {
  providerId: string;
  modelId: string;
  /** Display name, e.g. "Qwen3 14B". */
  name: string;
  place: ModelPlace;
  /** The provider's label, e.g. "Ollama". */
  via: string;
  unavailable?: boolean;
}

export const sameModel = (a: Pick<ModelChoice, "providerId" | "modelId"> | null | undefined, b: Pick<ModelChoice, "providerId" | "modelId"> | null | undefined) =>
  !!a && !!b && a.providerId === b.providerId && a.modelId === b.modelId;

const GROUPS: [string, ModelPlace][] = [
  ["On this Mac", "local"],
  ["Cloud", "cloud"],
];

export function ModelMenu({
  open,
  onClose,
  anchor,
  models,
  selected,
  onPick,
  onMore,
}: {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  models: ModelChoice[];
  selected: ModelChoice | null;
  onPick: (model: ModelChoice) => void;
  onMore?: () => void;
}) {
  return (
    <Popover open={open} onClose={onClose} anchor={anchor} placement="above" className="r-model-pop" role="menu" aria-label="Model">
      {GROUPS.filter(([, place]) => models.some((m) => m.place === place)).map(([label, place], i) => (
        <div key={place}>
          <div className="r-mp-label">
            {label}
            {i === 0 && onMore && (
              <button className="r-mp-manage" onClick={onMore}>
                More models…
              </button>
            )}
          </div>
          {models
            .filter((m) => m.place === place)
            .map((m) => (
              <button
                key={`${m.providerId}/${m.modelId}`}
                className="r-mp-item"
                role="menuitemradio"
                aria-checked={sameModel(m, selected)}
                onClick={() => onPick(m)}
              >
                <Icon name={place === "local" ? "lock" : "cloud"} />
                <span>
                  <b>{m.name}</b>
                  <small className={m.unavailable ? "bad" : undefined}>{m.unavailable ? `${m.via} · unavailable` : m.via}</small>
                </span>
                <Icon name="check" className="tick" />
              </button>
            ))}
        </div>
      ))}
      {models.length === 0 && onMore && (
        <button className="r-mp-item r-mp-more" role="menuitem" onClick={onMore}>
          <Icon name="sliders" />
          <span>
            <b>More models…</b>
          </span>
        </button>
      )}
    </Popover>
  );
}
