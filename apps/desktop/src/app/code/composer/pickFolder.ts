import { open } from "@tauri-apps/plugin-dialog";

/** The OS folder picker. Resolves to the chosen path, `null` when the person cancels, and rejects
 *  where there is no native dialog (the browser fixture), so callers can fall back to a typed path. */
export async function pickFolder(title: string, defaultPath?: string): Promise<string | null> {
  const picked = await open({ directory: true, multiple: false, title, defaultPath });
  return typeof picked === "string" ? picked : null;
}
