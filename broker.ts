#!/usr/bin/env bun
/**
 * claude-peers broker daemon (v11 — cross-machine)
 *
 * A shared HTTP server backed by SQLite.
 * Tracks registered Claude Code peers and routes messages between them.
 */

import { Database } from "bun:sqlite";
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  ListPeersRequest,
  SendMessageRequest,
  PollMessagesRequest,
  PollMessagesResponse,
  Peer,
  Message,
} from "./shared/types.ts";
import { isLoopback, sanitizeForDisplay } from "./shared/net.ts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const HOSTNAME = process.env.CLAUDE_PEERS_HOST ?? "127.0.0.1";
const DB_PATH =
  process.env.CLAUDE_PEERS_DB ??
  `${process.env.HOME ?? process.env.USERPROFILE}/.claude-peers.db`;
const AUTH_TOKEN = process.env.CLAUDE_PEERS_TOKEN ?? null;
const STALE_LOCAL_MS = 90_000;
const STALE_REMOTE_MS = 300_000; // Remote peers get 5min grace (network latency)

// ---------------------------------------------------------------------------
// Fail-closed startup check
// ---------------------------------------------------------------------------

if (!isLoopback(HOSTNAME) && !AUTH_TOKEN) {
  console.error(
    "[claude-peers broker] FATAL: CLAUDE_PEERS_TOKEN is required when binding to non-loopback address.\n" +
      "Either set CLAUDE_PEERS_TOKEN=<secret> or use CLAUDE_PEERS_HOST=127.0.0.1 for local-only mode."
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(event: string, details?: Record<string, unknown>) {
  const suffix = details
    ? ` ${JSON.stringify(
        Object.fromEntries(
          Object.entries(details).map(([key, value]) => [
            key,
            typeof value === "string" ? sanitizeForDisplay(value) : value,
          ])
        )
      )}`
    : "";
  console.error(`[claude-peers broker] ${event}${suffix}`);
}

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    git_remote_url TEXT NOT NULL DEFAULT '',
    tty TEXT,
    summary TEXT NOT NULL DEFAULT '',
    machine_id TEXT NOT NULL DEFAULT '',
    machine_name TEXT NOT NULL DEFAULT '',
    remote_addr TEXT NOT NULL DEFAULT '',
    instance_key TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (to_id) REFERENCES peers(id)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL
  )
`);

// ---------------------------------------------------------------------------
// Schema migration (transactional)
// ---------------------------------------------------------------------------

function getSchemaVersion(): number {
  const row = db
    .query("SELECT version FROM schema_version WHERE id = 1")
    .get() as { version: number } | null;
  return row?.version ?? 0;
}

function setSchemaVersion(v: number): void {
  db.run("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, ?)", [
    v,
  ]);
}

function migrate(): void {
  const current = getSchemaVersion();

  if (current < 1) {
    const txn = db.transaction(() => {
      const cols = db
        .query("PRAGMA table_info(peers)")
        .all() as { name: string }[];
      const colNames = new Set(cols.map((c) => c.name));

      const additions: [string, string][] = [
        ["machine_id", "TEXT NOT NULL DEFAULT ''"],
        ["machine_name", "TEXT NOT NULL DEFAULT ''"],
        ["remote_addr", "TEXT NOT NULL DEFAULT ''"],
        ["git_remote_url", "TEXT NOT NULL DEFAULT ''"],
        ["instance_key", "TEXT NOT NULL DEFAULT ''"],
      ];

      for (const [name, type] of additions) {
        if (!colNames.has(name)) {
          db.run(`ALTER TABLE peers ADD COLUMN ${name} ${type}`);
        }
      }

      // Partial UNIQUE index: instance_key uniqueness excluding empty strings
      db.run(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_peers_instance_key ON peers(instance_key) WHERE instance_key != ''"
      );

      setSchemaVersion(1);
    });
    txn();
  }
}

migrate();

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

// instance_key excluded from SELECT (DB-internal only; not exposed in Peer responses)
const PEER_COLUMNS =
  "id, pid, cwd, git_root, git_remote_url, tty, summary, machine_id, machine_name, remote_addr, registered_at, last_seen";

const insertPeer = db.prepare(`
  INSERT INTO peers (id, pid, cwd, git_root, git_remote_url, tty, summary, machine_id, machine_name, remote_addr, instance_key, registered_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const upsertPeerByInstanceKey = db.prepare(`
  INSERT INTO peers (id, pid, cwd, git_root, git_remote_url, tty, summary, machine_id, machine_name, remote_addr, instance_key, registered_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(instance_key) WHERE instance_key != '' DO UPDATE SET
    pid = excluded.pid,
    cwd = excluded.cwd,
    git_root = excluded.git_root,
    git_remote_url = excluded.git_remote_url,
    tty = excluded.tty,
    summary = excluded.summary,
    machine_id = excluded.machine_id,
    machine_name = excluded.machine_name,
    remote_addr = excluded.remote_addr,
    last_seen = excluded.last_seen
  RETURNING id
`);

const updateLastSeen = db.prepare(
  "UPDATE peers SET last_seen = ? WHERE id = ?"
);

const updateSummary = db.prepare(
  "UPDATE peers SET summary = ? WHERE id = ?"
);

const deletePeer = db.prepare("DELETE FROM peers WHERE id = ?");
const deleteLegacyPeersByRemoteAddr = db.prepare(
  "DELETE FROM peers WHERE instance_key = '' AND remote_addr = ? RETURNING id"
);

const selectAllPeers = db.prepare(
  `SELECT ${PEER_COLUMNS} FROM peers ORDER BY last_seen DESC`
);

const selectPeerById = db.prepare(
  `SELECT ${PEER_COLUMNS} FROM peers WHERE id = ?`
);

const selectPeersByMachineId = db.prepare(
  `SELECT ${PEER_COLUMNS} FROM peers WHERE machine_id = ? ORDER BY last_seen DESC`
);

const selectPeersByMachineIdAndCwd = db.prepare(
  `SELECT ${PEER_COLUMNS} FROM peers WHERE machine_id = ? AND cwd = ? ORDER BY last_seen DESC`
);

const selectPeersByGitRemoteUrl = db.prepare(
  `SELECT ${PEER_COLUMNS} FROM peers WHERE git_remote_url = ? AND git_remote_url != '' ORDER BY last_seen DESC`
);

const selectPeersByMachineIdAndGitRoot = db.prepare(
  `SELECT ${PEER_COLUMNS} FROM peers WHERE machine_id = ? AND git_root = ? ORDER BY last_seen DESC`
);

const insertMessage = db.prepare(
  "INSERT INTO messages (from_id, to_id, text, sent_at, delivered) VALUES (?, ?, ?, ?, 0)"
);

const selectUndelivered = db.prepare(
  "SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC"
);

const markDelivered = db.prepare(
  "UPDATE messages SET delivered = 1 WHERE id = ?"
);

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function validateRegisterRequest(body: unknown): RegisterRequest | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;

  // Required fields
  if (typeof b.pid !== "number") return null;
  if (typeof b.cwd !== "string" || b.cwd.length > 4096) return null;

  // summary: required (string). Fallback to empty string if missing
  if (b.summary === undefined || b.summary === null) {
    b.summary = "";
  } else if (typeof b.summary !== "string") {
    return null;
  }

  // git_root: required (string | null). undefined → null
  if (b.git_root === undefined) {
    b.git_root = null;
  } else if (b.git_root !== null && typeof b.git_root !== "string") {
    return null;
  }

  // tty: required (string | null). undefined → null
  if (b.tty === undefined) {
    b.tty = null;
  } else if (b.tty !== null && typeof b.tty !== "string") {
    return null;
  }

  // Optional string fields: type check + length truncation
  const optionalStrings: [string, number][] = [
    ["summary", 1024],
    ["machine_name", 256],
    ["machine_id", 128],
    ["git_root", 4096],
    ["git_remote_url", 2048],
    ["tty", 256],
    ["instance_key", 128],
  ];
  for (const [field, maxLen] of optionalStrings) {
    if (b[field] !== undefined && b[field] !== null) {
      if (typeof b[field] !== "string") return null;
      if ((b[field] as string).length > maxLen) {
        b[field] = (b[field] as string).slice(0, maxLen);
      }
    }
  }

  return b as unknown as RegisterRequest;
}

function validateSendMessage(body: unknown): SendMessageRequest | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.from_id !== "string" || typeof b.to_id !== "string") return null;
  if (typeof b.text !== "string" || b.text.length > 65536) return null;
  return b as unknown as SendMessageRequest;
}

function validateSetSummary(body: unknown): SetSummaryRequest | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.id !== "string") return null;
  if (typeof b.summary !== "string" || b.summary.length > 1024) return null;
  return b as unknown as SetSummaryRequest;
}

function validateListPeers(body: unknown): ListPeersRequest | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const validScopes = new Set(["machine", "directory", "repo", "network"]);
  if (typeof b.scope !== "string" || !validScopes.has(b.scope)) return null;
  if (typeof b.cwd !== "string") return null;
  // Optional fields: type validation
  if (
    b.git_root !== undefined &&
    b.git_root !== null &&
    typeof b.git_root !== "string"
  )
    return null;
  if (
    b.git_remote_url !== undefined &&
    b.git_remote_url !== null &&
    typeof b.git_remote_url !== "string"
  )
    return null;
  if (
    b.machine_id !== undefined &&
    b.machine_id !== null &&
    typeof b.machine_id !== "string"
  )
    return null;
  if (
    b.exclude_id !== undefined &&
    b.exclude_id !== null &&
    typeof b.exclude_id !== "string"
  )
    return null;
  return b as unknown as ListPeersRequest;
}

function validateIdOnly(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  return typeof (body as Record<string, unknown>).id === "string";
}

// ---------------------------------------------------------------------------
// JSON response helper (explicit charset=utf-8)
// ---------------------------------------------------------------------------

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

function jsonResponse(data: unknown, init?: { status?: number }): Response {
  return new Response(JSON.stringify(data), {
    status: init?.status ?? 200,
    headers: JSON_HEADERS,
  });
}

// ---------------------------------------------------------------------------
// Authentication middleware
// ---------------------------------------------------------------------------

function checkAuth(req: Request): Response | null {
  if (!AUTH_TOKEN) return null; // Local mode: no auth
  const header = req.headers.get("Authorization") ?? "";
  const expected = `Bearer ${AUTH_TOKEN}`;
  // Timing-safe comparison to prevent side-channel token guessing
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  const valid =
    a.byteLength === b.byteLength &&
    require("crypto").timingSafeEqual(a, b);
  if (!valid) {
    return jsonResponse({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Request IP helper
// ---------------------------------------------------------------------------

function requestIP(req: Request, server: { requestIP(req: Request): { address: string } | null }): string {
  let addr = server.requestIP(req)?.address ?? "unknown";
  // Normalize IPv4-mapped IPv6 (::ffff:127.0.0.1 → 127.0.0.1)
  if (addr.startsWith("::ffff:")) {
    addr = addr.slice(7);
  }
  return addr;
}

// ---------------------------------------------------------------------------
// Stale peer cleanup
// ---------------------------------------------------------------------------

function cleanStalePeers() {
  const now = Date.now();
  const allPeers = db
    .query("SELECT id, remote_addr, last_seen FROM peers")
    .all() as Array<{ id: string; remote_addr: string; last_seen: string }>;

  const staleIds: string[] = [];
  for (const peer of allPeers) {
    const elapsed = now - new Date(peer.last_seen).getTime();
    const threshold = isLoopback(peer.remote_addr) ? STALE_LOCAL_MS : STALE_REMOTE_MS;
    if (elapsed > threshold) {
      staleIds.push(peer.id);
    }
  }

  for (const id of staleIds) {
    db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [id]);
    deletePeer.run(id);
  }

  if (staleIds.length > 0) {
    log("cleaned_stale_peers", { count: staleIds.length });
  }
}

cleanStalePeers();
setInterval(cleanStalePeers, 30_000);

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleRegister(
  body: RegisterRequest,
  remoteAddr: string
): RegisterResponse {
  const now = new Date().toISOString();
  const machineId =
    body.machine_id && body.machine_id.length > 0
      ? body.machine_id
      : `legacy-${generateId()}-${generateId()}`;
  const instanceKey = body.instance_key ?? "";

  if (instanceKey) {
    // instance_key provided: atomic upsert (concurrency-safe)
    const result = upsertPeerByInstanceKey.get(
      generateId(), // id (used only for new inserts; on conflict existing id is preserved)
      body.pid,
      body.cwd,
      body.git_root,
      body.git_remote_url ?? "",
      body.tty ?? null,
      body.summary ?? "",
      machineId,
      body.machine_name ?? "",
      remoteAddr,
      instanceKey,
      now,
      now
    ) as { id: string };

    // Clean up legacy entries (empty instance_key) from same remote_addr
    const deleted = deleteLegacyPeersByRemoteAddr.all(remoteAddr) as Array<{ id: string }>;
    for (const d of deleted) {
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [d.id]);
    }
    if (deleted.length > 0) {
      log("cleaned_legacy_peers", {
        count: deleted.length,
        remote_addr: remoteAddr,
        deleted_ids: deleted.map(d => d.id),
      });
    }

    log("register_upsert", {
      id: result.id,
      machine_id: machineId,
      pid: body.pid,
      cwd: body.cwd,
      git_remote_url: body.git_remote_url ?? "",
      instance_key: instanceKey,
    });
    return { id: result.id };
  }

  // No instance_key (legacy client): plain INSERT
  // Column order: id, pid, cwd, git_root, git_remote_url, tty, summary,
  //               machine_id, machine_name, remote_addr, instance_key,
  //               registered_at, last_seen
  const id = generateId();
  insertPeer.run(
    id,
    body.pid,
    body.cwd,
    body.git_root,
    body.git_remote_url ?? "",
    body.tty ?? null,
    body.summary ?? "",
    machineId,
    body.machine_name ?? "",
    remoteAddr,
    "", // instance_key (empty for legacy clients)
    now,
    now
  );

  log("register_insert", {
    id,
    machine_id: machineId,
    pid: body.pid,
    cwd: body.cwd,
    git_remote_url: body.git_remote_url ?? "",
  });
  return { id };
}

function handleHeartbeat(body: HeartbeatRequest): void {
  updateLastSeen.run(new Date().toISOString(), body.id);
}

function handleSetSummary(body: SetSummaryRequest): void {
  updateSummary.run(body.summary, body.id);
}

function handleListPeers(body: ListPeersRequest): Peer[] {
  let peers: Peer[];
  const machineId = body.machine_id ?? "";

  switch (body.scope) {
    case "machine":
      if (!machineId) {
        // Legacy client backward compat: no machine_id → return all peers (v0 behavior)
        peers = selectAllPeers.all() as Peer[];
      } else {
        peers = selectPeersByMachineId.all(machineId) as Peer[];
      }
      break;
    case "directory":
      if (!machineId) {
        // Legacy client backward compat: no machine_id → filter by cwd only
        peers = db
          .query(
            `SELECT ${PEER_COLUMNS} FROM peers WHERE cwd = ? ORDER BY last_seen DESC`
          )
          .all(body.cwd) as Peer[];
      } else {
        peers = selectPeersByMachineIdAndCwd.all(machineId, body.cwd) as Peer[];
      }
      break;
    case "repo": {
      const remoteUrl = body.git_remote_url ?? "";
      if (remoteUrl) {
        // Cross-machine: match by git remote URL
        peers = selectPeersByGitRemoteUrl.all(remoteUrl) as Peer[];
      } else if (body.git_root && machineId) {
        // Local fallback: same machine_id + same git_root
        peers = selectPeersByMachineIdAndGitRoot.all(
          machineId,
          body.git_root
        ) as Peer[];
      } else {
        peers = [];
      }
      break;
    }
    case "network":
      peers = selectAllPeers.all() as Peer[];
      break;
    default:
      // validateListPeers should prevent reaching here, but return empty for safety
      peers = [];
  }

  if (body.exclude_id) {
    peers = peers.filter((p) => p.id !== body.exclude_id);
  }

  // Filter stale peers (actual cleanup is handled by cleanStalePeers interval)
  const now = Date.now();
  return peers.filter((p) => {
    const lastSeen = new Date(p.last_seen).getTime();
    const threshold = isLoopback(p.remote_addr) ? STALE_LOCAL_MS : STALE_REMOTE_MS;
    return now - lastSeen <= threshold;
  });
}

function handleSendMessage(
  body: SendMessageRequest
): { ok: boolean; error?: string } {
  const target = selectPeerById.get(body.to_id) as Peer | null;
  if (!target) {
    return { ok: false, error: `Peer ${body.to_id} not found` };
  }

  insertMessage.run(
    body.from_id,
    body.to_id,
    body.text,
    new Date().toISOString()
  );
  log("message_enqueued", {
    from_id: body.from_id,
    to_id: body.to_id,
    preview: body.text.slice(0, 120),
  });
  return { ok: true };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const messages = selectUndelivered.all(body.id) as Message[];
  // Don't mark delivered here — wait for ack-message from client
  return { messages };
}

function handleAckMessage(body: { message_id: number }): void {
  markDelivered.run(body.message_id);
}

function handleUnregister(body: { id: string }): void {
  db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [body.id]);
  deletePeer.run(body.id);
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

Bun.serve({
  port: PORT,
  hostname: HOSTNAME,
  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;

    // remoteAddr extraction + IPv4-mapped IPv6 normalization
    const remoteAddr = requestIP(req, server);

    // GET /health — no auth required, but hide peer count in network mode
    if (req.method === "GET" && path === "/health") {
      const resp: Record<string, unknown> = { status: "ok" };
      if (isLoopback(HOSTNAME) || checkAuth(req) === null) {
        resp.peers = (selectAllPeers.all() as Peer[]).length;
      }
      return jsonResponse(resp);
    }

    // Non-POST passthrough
    if (req.method !== "POST") {
      return new Response("claude-peers broker", { status: 200 });
    }

    // POST endpoints: auth check
    const authErr = checkAuth(req);
    if (authErr) {
      log("auth_failed", { path });
      return authErr;
    }

    try {
      const body = await req.json();

      switch (path) {
        case "/register": {
          const validated = validateRegisterRequest(body);
          if (!validated)
            return jsonResponse(
              { error: "invalid register request" },
              { status: 400 }
            );
          return jsonResponse(handleRegister(validated, remoteAddr));
        }
        case "/heartbeat": {
          if (!validateIdOnly(body))
            return jsonResponse(
              { error: "invalid request: id required" },
              { status: 400 }
            );
          handleHeartbeat(body as HeartbeatRequest);
          return jsonResponse({ ok: true });
        }
        case "/set-summary": {
          const validated = validateSetSummary(body);
          if (!validated)
            return jsonResponse(
              { error: "invalid set-summary request" },
              { status: 400 }
            );
          handleSetSummary(validated);
          return jsonResponse({ ok: true });
        }
        case "/list-peers": {
          const validated = validateListPeers(body);
          if (!validated)
            return jsonResponse(
              { error: "invalid list-peers request" },
              { status: 400 }
            );
          return jsonResponse(handleListPeers(validated));
        }
        case "/send-message": {
          const validated = validateSendMessage(body);
          if (!validated)
            return jsonResponse(
              { error: "invalid send-message request" },
              { status: 400 }
            );
          return jsonResponse(handleSendMessage(validated));
        }
        case "/poll-messages": {
          if (!validateIdOnly(body))
            return jsonResponse(
              { error: "invalid request: id required" },
              { status: 400 }
            );
          return jsonResponse(
            handlePollMessages(body as PollMessagesRequest)
          );
        }
        case "/ack-message": {
          if (
            !body ||
            typeof (body as Record<string, unknown>).message_id !== "number"
          )
            return jsonResponse(
              { error: "invalid request: message_id required" },
              { status: 400 }
            );
          handleAckMessage(body as { message_id: number });
          return jsonResponse({ ok: true });
        }
        case "/unregister": {
          if (!validateIdOnly(body))
            return jsonResponse(
              { error: "invalid request: id required" },
              { status: 400 }
            );
          handleUnregister(body as { id: string });
          return jsonResponse({ ok: true });
        }
        default:
          return jsonResponse({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      // JSON parse error → 400 (not 500)
      if (e instanceof SyntaxError) {
        return jsonResponse({ error: "invalid JSON" }, { status: 400 });
      }
      const message = e instanceof Error ? e.message : String(e);
      log("request_failed", { path, error: message });
      return jsonResponse({ error: message }, { status: 500 });
    }
  },
});

// ---------------------------------------------------------------------------
// Startup log
// ---------------------------------------------------------------------------

const mode = isLoopback(HOSTNAME)
  ? "local-only"
  : "network (auth required)";
log("listening", {
  host: HOSTNAME,
  port: PORT,
  db: DB_PATH,
  mode,
  auth: AUTH_TOKEN ? "enabled" : "disabled",
});
if (!isLoopback(HOSTNAME)) {
  console.error(
    "[claude-peers broker] WARNING: Network mode active. Traffic is NOT encrypted (plain HTTP)."
  );
  console.error(
    "[claude-peers broker] WARNING: Use only on trusted LANs. Do not expose to the internet."
  );
}
