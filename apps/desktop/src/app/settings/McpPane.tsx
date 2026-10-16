import { useEffect, useState } from "react";
import { ConfirmDialog, Icon, useToast } from "@rama/ui";
import type { McpHealthStatus, McpServerDTO, McpTransportDTO } from "@rama/protocol";
import { addMcpServer, fetchMcpServerHealth, fetchMcpServers, removeMcpServer } from "../../engine/client";
import { Card, MiniSeg, PaneHead, Section, errorText } from "./parts";

/* MCP servers — the settings half of what McpServersModal.tsx still renders for the (legacy)
   Toolbox page: a list of servers with health, and an inline add form. */

type Transport = "stdio" | "http" | "sse";
const TRANSPORTS: { id: Transport; label: string }[] = [
  { id: "stdio", label: "Command" },
  { id: "http", label: "HTTP" },
  { id: "sse", label: "SSE" },
];
const DOT: Record<McpHealthStatus, string> = { ok: "ok", bad: "bad", disabled: "" };

export function McpPane() {
  const [servers, setServers] = useState<McpServerDTO[] | null>(null);
  const [status, setStatus] = useState<Record<string, McpHealthStatus>>({});
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<McpServerDTO | null>(null);
  const { push } = useToast();

  function reload() {
    fetchMcpServers()
      .then((rows) => {
        setServers(rows);
        for (const row of rows) {
          fetchMcpServerHealth(row.id)
            .then((h) => setStatus((prev) => ({ ...prev, [row.id]: h.status })))
            .catch(() => {});
        }
      })
      .catch((err) => {
        setServers([]);
        console.error("[rama] failed to load MCP servers", err);
      });
  }
  useEffect(reload, []);

  async function remove(server: McpServerDTO) {
    setRemoving(null);
    try {
      await removeMcpServer(server.id);
      reload();
    } catch (err) {
      push(errorText(err), "bad");
    }
  }

  return (
    <>
      <PaneHead
        title="MCP servers"
        sub="Extra tools for the agent, like a database, an issue tracker or a design file, over the Model Context Protocol."
        action={
          !adding && (
            <button type="button" className="r-btn" onClick={() => setAdding(true)}>
              <Icon name="plus" />
              Add server
            </button>
          )
        }
      />
      <div className="r-set-body">
        {adding && (
          <Section>
            <Card>
              <AddServerForm
                onCancel={() => setAdding(false)}
                onAdded={() => {
                  setAdding(false);
                  reload();
                }}
              />
            </Card>
          </Section>
        )}
        <Section title={servers && servers.length > 0 ? "Connected" : undefined}>
          {servers === null ? (
            <div className="r-set-loading">Loading…</div>
          ) : servers.length === 0 ? (
            !adding && (
              <Card>
                <div className="r-set-empty">
                  <b>No MCP servers yet</b>
                  <p>Add one by the command that starts it, or by its URL if it's already running.</p>
                  <button type="button" className="r-btn r-btn-ghost" onClick={() => setAdding(true)}>
                    <Icon name="plus" />
                    Add server
                  </button>
                </div>
              </Card>
            )
          ) : (
            <Card>
              {servers.map((s) => (
                <div key={s.id} className="r-set-row">
                  <span className={`r-dot ${DOT[status[s.id] ?? "disabled"]}`} aria-hidden="true" />
                  <div className="r-set-row-text">
                    <b>{s.name}</b>
                    <p className="r-prov-url">{s.transport.kind === "stdio" ? [s.transport.command, ...(s.transport.args ?? [])].join(" ") : s.transport.url}</p>
                  </div>
                  <div className="r-set-row-ctl">
                    <span className="r-tag">{s.transport.kind === "stdio" ? "Command" : s.transport.kind.toUpperCase()}</span>
                    <button type="button" className="r-mini danger" onClick={() => setRemoving(s)}>
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </Card>
          )}
        </Section>
      </div>
      <ConfirmDialog
        open={!!removing}
        title={`Remove ${removing?.name ?? "server"}?`}
        confirmLabel="Remove"
        danger
        onConfirm={() => removing && void remove(removing)}
        onCancel={() => setRemoving(null)}
      >
        The agent loses its tools right away. You can add it again later.
      </ConfirmDialog>
    </>
  );
}

function AddServerForm({ onCancel, onAdded }: { onCancel: () => void; onAdded: () => void }) {
  const [kind, setKind] = useState<Transport>("stdio");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { push } = useToast();

  const ready = name.trim() && (kind === "stdio" ? command.trim() : url.trim());

  async function submit() {
    if (!ready) return;
    let transport: McpTransportDTO;
    if (kind === "stdio") {
      const [cmd, ...args] = command.trim().split(/\s+/);
      transport = { kind: "stdio", command: cmd!, args: args.length ? args : undefined };
    } else {
      transport = { kind, url: url.trim() };
    }
    setBusy(true);
    setError(null);
    try {
      await addMcpServer(name.trim(), transport);
      push(`${name.trim()} connected`, "good");
      onAdded();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="r-add"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3>Add an MCP server</h3>
      <div className="r-set-fields two">
        <div className="r-set-field">
          <label htmlFor="mcp-name">Name</label>
          <input id="mcp-name" className="r-input" placeholder="e.g. GitHub" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        <div className="r-set-field">
          <span className="lbl">Connects by</span>
          <MiniSeg label="Transport" options={TRANSPORTS} value={kind} onChange={setKind} />
        </div>
      </div>
      {kind === "stdio" ? (
        <div className="r-set-field">
          <label htmlFor="mcp-cmd">Command</label>
          <input id="mcp-cmd" className="r-input mono" spellCheck={false} placeholder="npx -y @modelcontextprotocol/server-github" value={command} onChange={(e) => setCommand(e.target.value)} />
          <p>Rama starts it for you and talks to it over stdin and stdout.</p>
        </div>
      ) : (
        <div className="r-set-field">
          <label htmlFor="mcp-url">Server URL</label>
          <input id="mcp-url" className="r-input mono" spellCheck={false} placeholder="http://localhost:3333/mcp" value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
      )}
      {error && <div className="r-set-error">{error}</div>}
      <div className="r-set-actions">
        <span className="grow" />
        <button type="button" className="r-btn r-btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="r-btn" disabled={!ready || busy}>
          {busy ? "Connecting…" : "Add server"}
        </button>
      </div>
    </form>
  );
}
