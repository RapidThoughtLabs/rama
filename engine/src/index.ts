// Bun sidecar daemon (docs/IMPLEMENTATION_PLAN.md Phase 1). Rust core spawns this process and
// reads the first stdout line as JSON `{ engineUrl, token }` to hand the webview a connection.

import { ENGINE_TOKEN } from "./auth";
import { createServer } from "./server";

const server = createServer();
const engineUrl = `http://127.0.0.1:${server.port}`;

console.log(JSON.stringify({ engineUrl, token: ENGINE_TOKEN }));
console.log(`[rama/engine] listening on ${engineUrl}`);
