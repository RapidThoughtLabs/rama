import { useState } from "react";
import { Button, Input, Modal, useToast } from "@rama/ui";
import { useWindowTabsData } from "./data/WindowTabsProvider";

// Mirrors McpServersModal.tsx's stdio fields for UI consistency — a cli-backed chat's launch
// command is configured the same way an MCP stdio server's is (docs/IMPLEMENTATION_PLAN.md
// Phase 8's "generic launch command" v1 scope).
export function NewTerminalChatModal({
  open,
  onClose,
  projectId,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string | null;
}) {
  const { openNewTerminalTab } = useWindowTabsData();
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [creating, setCreating] = useState(false);
  const { push } = useToast();

  async function handleCreate() {
    const trimmedCommand = command.trim();
    if (!projectId || !trimmedCommand) return;
    setCreating(true);
    try {
      await openNewTerminalTab(projectId, trimmedCommand, args.trim() ? args.trim().split(/\s+/) : []);
      setCommand("");
      setArgs("");
      onClose();
    } catch (err) {
      push(err instanceof Error ? err.message : String(err), "bad");
    } finally {
      setCreating(false);
    }
  }

  return (
    <Modal open={open} title="new terminal chat" onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ fontSize: "var(--fs-sm)", color: "rgba(var(--ink),0.5)" }}>
          Launches an interactive CLI (e.g. <code>claude</code>) inside a themed terminal instead of this app's own
          agent loop.
        </div>
        <Input
          placeholder="command (e.g. claude)"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          autoFocus
        />
        <Input placeholder="args (space separated)" value={args} onChange={(e) => setArgs(e.target.value)} />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="ghost" size="sm" onClick={onClose}>
            cancel
          </Button>
          <Button size="sm" onClick={handleCreate} disabled={creating || !command.trim() || !projectId}>
            {creating ? "starting…" : "start"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
