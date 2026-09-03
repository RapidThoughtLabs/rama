import { useEffect, useState } from "react";
import { Button, Input, SegmentedControl, useToast } from "@rama/ui";
import type { McpHealthStatus, McpServerDTO, McpTransportDTO } from "@rama/protocol";
import { addMcpServer, fetchMcpServerHealth, fetchMcpServers, removeMcpServer } from "../engine/client";

const TRANSPORT_KINDS: { id: "stdio" | "http" | "sse"; label: string }[] = [
  { id: "stdio", label: "stdio" },
  { id: "http", label: "http" },
  { id: "sse", label: "sse" },
];

const STATUS_COLOR: Record<McpHealthStatus, string> = {
  ok: "var(--good)",
  bad: "var(--bad)",
  disabled: "rgba(var(--ink),0.35)",
};

export function McpServersModal() {
  const [servers, setServers] = useState<McpServerDTO[]>([]);
  const [status, setStatus] = useState<Record<string, McpHealthStatus>>({});
  const [kind, setKind] = useState<"stdio" | "http" | "sse">("stdio");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const { push } = useToast();

  function reload() {
    fetchMcpServers().then((rows) => {
      setServers(rows);
      for (const row of rows) {
        fetchMcpServerHealth(row.id)
          .then((h) => setStatus((prev) => ({ ...prev, [row.id]: h.status })))
          .catch(() => {});
      }
    });
  }

  useEffect(reload, []);

  async function handleAdd() {
    const trimmedName = name.trim();
    if (!trimmedName) return;

    let transport: McpTransportDTO;
    if (kind === "stdio") {
      if (!command.trim()) return;
      transport = { kind: "stdio", command: command.trim(), args: args.trim() ? args.trim().split(/\s+/) : undefined };
    } else {
      if (!url.trim()) return;
      transport = { kind, url: url.trim() };
    }

    setAdding(true);
    try {
      await addMcpServer(trimmedName, transport);
      setName("");
      setCommand("");
      setArgs("");
      setUrl("");
      reload();
      push("mcp server connected", "good");
    } catch (err) {
      push(err instanceof Error ? err.message : String(err), "bad");
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(id: string) {
    try {
      await removeMcpServer(id);
      reload();
    } catch (err) {
      push(err instanceof Error ? err.message : String(err), "bad");
    }
  }

  return (
    <div className="rama-provider-settings">
      <div className="rama-provider-settings-input-row">
        <Input placeholder="server name" value={name} onChange={(e) => setName(e.target.value)} />
        <SegmentedControl options={TRANSPORT_KINDS} value={kind} onChange={setKind} />
      </div>
      {kind === "stdio" ? (
        <div className="rama-provider-settings-input-row">
          <Input placeholder="command (e.g. npx some-mcp-server)" value={command} onChange={(e) => setCommand(e.target.value)} />
          <Input placeholder="args (space separated)" value={args} onChange={(e) => setArgs(e.target.value)} />
        </div>
      ) : (
        <div className="rama-provider-settings-input-row">
          <Input placeholder="server URL" value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button size="sm" onClick={handleAdd} disabled={adding || !name.trim()}>
          {adding ? "connecting…" : "add server"}
        </Button>
      </div>

      {servers.length === 0 && <div className="rama-provider-settings-hint">no MCP servers connected yet.</div>}

      {servers.map((s) => (
        <div key={s.id} className="rama-provider-settings-row">
          <div className="rama-provider-settings-head">
            <span className="rama-statusbar-dot" style={{ background: STATUS_COLOR[status[s.id] ?? "disabled"] }} />
            <span className="rama-provider-settings-label">{s.name}</span>
            <span style={{ flex: 1 }} />
            <Button size="sm" variant="ghost" onClick={() => handleRemove(s.id)}>
              remove
            </Button>
          </div>
          <div className="rama-provider-settings-hint">
            {s.transport.kind === "stdio" ? s.transport.command : s.transport.url}
          </div>
        </div>
      ))}
    </div>
  );
}
