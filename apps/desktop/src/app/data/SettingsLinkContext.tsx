import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

// docs/PROVIDERS_PLAN.md Phase P1 — lets anything (the composer's model menu, the topbar) open
// Settings straight onto a pane, optionally focused on one provider, without prop-drilling that
// state down through the views. AppShell is the sole renderer of SettingsModal and reads `target`
// from here instead of owning its own open/close bool.

export type SettingsPaneId = "general" | "appearance" | "keyboard" | "providers" | "models" | "mcp" | "permissions" | "account" | "about";

export interface SettingsTarget {
  pane?: SettingsPaneId;
  /** Providers: open this provider's details. Models: show this provider's models to add. */
  providerId?: string;
  /** Providers: open the add-provider form. */
  addProvider?: boolean;
}

interface SettingsLinkValue {
  isOpen: boolean;
  target: SettingsTarget | null;
  open: (target?: SettingsTarget) => void;
  close: () => void;
}

const SettingsLinkContext = createContext<SettingsLinkValue | null>(null);

export function SettingsLinkProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [target, setTarget] = useState<SettingsTarget | null>(null);

  const value = useMemo<SettingsLinkValue>(
    () => ({
      isOpen,
      target,
      open: (t) => {
        setTarget(t ?? null);
        setIsOpen(true);
      },
      close: () => setIsOpen(false),
    }),
    [isOpen, target],
  );

  return <SettingsLinkContext.Provider value={value}>{children}</SettingsLinkContext.Provider>;
}

export function useSettingsLink(): SettingsLinkValue {
  const ctx = useContext(SettingsLinkContext);
  if (!ctx) throw new Error("useSettingsLink must be used within a SettingsLinkProvider");
  return ctx;
}
