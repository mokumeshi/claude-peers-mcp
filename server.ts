#!/usr/bin/env bun
/**
 * claude-peers MCP server (v11 — cross-machine)
 *
 * Spawned by Claude Code as a stdio MCP server (one per instance).
 * Connects to the shared broker daemon for peer discovery and messaging.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { hostname as osHostname } from "node:os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  PeerId,
  Peer,
  RegisterResponse,
  PollMessagesResponse,
} from "./shared/types.ts";
import {
  generateSummary,
  getGitBranch,
  getRecentFiles,
} from "./shared/summarize.ts";
import { isLoopback, sanitizeForDisplay } from "./shared/net.ts";
import { appendFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Debug file log (temporary — remove after diagnosis)
// ---------------------------------------------------------------------------

const DEBUG_LOG_PATH = join(import.meta.dir, "debug-poll.log");
function debugLog(msg: string) {
  try {
    appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL =
  process.env.CLAUDE_PEERS_BROKER ?? `http://127.0.0.1:${BROKER_PORT}`;
const AUTH_TOKEN: string | null = process.env.CLAUDE_PEERS_TOKEN ?? null;
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const BROKER_SCRIPT = join(import.meta.dir, "broker.ts");

// ---------------------------------------------------------------------------
// Relay configuration (VPS → LAN workaround for channel notification bug)
// When set, VPS instance forwards received messages to the LAN broker
// instead of sending mcp.notification() (which Claude Code ignores from
// secondary MCP servers). The LAN instance picks them up and sends the
// notification through its working channel.
// ---------------------------------------------------------------------------

const RELAY_BROKER: string | null = process.env.CLAUDE_PEERS_RELAY_BROKER ?? null;
const RELAY_TOKEN: string | null = process.env.CLAUDE_PEERS_RELAY_TOKEN ?? null;
const RELAY_PREFIX = "__RELAY__";

// ---------------------------------------------------------------------------
// Loopback detection (URL-based)
// ---------------------------------------------------------------------------

function isBrokerLocal(): boolean {
  try {
    const url = new URL(BROKER_URL);
    return isLoopback(url.hostname);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Timeouts: local 5s, remote 10s
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = isBrokerLocal() ? 5_000 : 10_000;

// ---------------------------------------------------------------------------
// Idempotent paths (retry-safe)
// ---------------------------------------------------------------------------

const IDEMPOTENT_PATHS = new Set([
  "/list-peers",
  "/poll-messages",
  "/health",
  "/heartbeat",
]);

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg: string, meta?: Record<string, unknown>) {
  const suffix = meta
    ? ` ${JSON.stringify(
        Object.fromEntries(
          Object.entries(meta).map(([key, value]) => [
            key,
            typeof value === "string" ? sanitizeForDisplay(value) : value,
          ])
        )
      )}`
    : "";
  console.error(`[claude-peers] ${msg}${suffix}`);
}

// ---------------------------------------------------------------------------
// brokerFetch: auth header, timeout, idempotent-only retry, statusCode prop
// ---------------------------------------------------------------------------

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
  };
  if (AUTH_TOKEN) {
    headers["Authorization"] = `Bearer ${AUTH_TOKEN}`;
  }

  const maxRetries =
    !isBrokerLocal() && IDEMPOTENT_PATHS.has(path) ? 2 : 0;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(`${BROKER_URL}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status === 401) {
        throw new Error(
          "Broker authentication failed. Check CLAUDE_PEERS_TOKEN."
        );
      }
      if (!res.ok) {
        const text = await res.text();
        const brokerErr = new Error(
          `Broker error (${path}): ${res.status} ${text}`
        );
        (brokerErr as any).statusCode = res.status;
        throw brokerErr;
      }
      return (await res.json()) as T;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt < maxRetries) {
        const delay = 1000 * (attempt + 1); // 1s, 2s
        log(
          `Broker request failed (${path}), retrying in ${delay}ms... (${attempt + 1}/${maxRetries})`,
          { error: lastError.message }
        );
        await Bun.sleep(delay);
      }
    }
  }
  throw lastError!;
}

// ---------------------------------------------------------------------------
// Relay fetch (for VPS → LAN forwarding)
// ---------------------------------------------------------------------------

async function relayFetch<T>(path: string, body: unknown): Promise<T> {
  if (!RELAY_BROKER) throw new Error("Relay not configured");
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
  };
  if (RELAY_TOKEN) {
    headers["Authorization"] = `Bearer ${RELAY_TOKEN}`;
  }
  const res = await fetch(`${RELAY_BROKER}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Relay error (${path}): ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

let relayTargetId: string | null = null;
let relayTargetLookupAt = 0;

// ---------------------------------------------------------------------------
// Broker health check
// ---------------------------------------------------------------------------

async function isBrokerAlive(): Promise<boolean> {
  try {
    const headers: Record<string, string> = {};
    if (AUTH_TOKEN) {
      headers["Authorization"] = `Bearer ${AUTH_TOKEN}`;
    }
    const res = await fetch(`${BROKER_URL}/health`, {
      headers,
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// ensureBroker: only auto-start for loopback
// ---------------------------------------------------------------------------

async function ensureBroker(): Promise<void> {
  if (await isBrokerAlive()) {
    log("broker_available", { broker_url: BROKER_URL });
    return;
  }

  if (!isBrokerLocal()) {
    throw new Error(
      `Remote broker at ${sanitizeForDisplay(BROKER_URL)} is not reachable. ` +
        `Ensure the broker is running on the remote machine and firewall allows the port.`
    );
  }

  log("starting_local_broker", { broker_url: BROKER_URL });
  const url = new URL(BROKER_URL);
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    stdio: ["ignore", "ignore", "inherit"],
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: url.port || String(BROKER_PORT),
      CLAUDE_PEERS_HOST: url.hostname,
    },
  });
  proc.unref();

  for (let i = 0; i < 30; i++) {
    await Bun.sleep(200);
    if (await isBrokerAlive()) {
      log("broker_started", { broker_url: BROKER_URL });
      return;
    }
  }

  throw new Error(
    `Failed to start broker daemon at ${sanitizeForDisplay(BROKER_URL)} after 6 seconds`
  );
}

// ---------------------------------------------------------------------------
// Shell command helper
// ---------------------------------------------------------------------------

async function runCommand(
  args: string[],
  cwd = process.cwd()
): Promise<string> {
  try {
    const proc = Bun.spawn(args, {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return code === 0 ? text.trim() : "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

async function getGitRoot(cwd: string): Promise<string | null> {
  const text = await runCommand(
    ["git", "rev-parse", "--show-toplevel"],
    cwd
  );
  return text || null;
}

/**
 * Normalize a git remote URL to a canonical form for cross-machine matching.
 *
 * - host lowercase, path case-sensitive
 * - credentials removed
 * - trailing .git / .git/ removed
 * - trailing slash removed
 * - URL-decoded path
 * - file:// -> empty string (local-only, not useful for cross-machine)
 * - SSH scp-like (git@host:path) supported
 */
function normalizeGitRemoteUrl(url: string): string {
  let normalized = url.trim();

  // file:// is local-only; return empty to disable repo scope
  if (normalized.startsWith("file://")) {
    return "";
  }

  // SSH scp-like format: [user@]host:path (only when no :// present)
  const scpMatch = normalized.match(/^(?:[\w.-]+@)?([\w.-]+):(.+)/);
  if (scpMatch && !normalized.includes("://")) {
    const host = scpMatch[1].toLowerCase();
    let path = scpMatch[2];
    path = path.replace(/\.git\/?$/, "");
    path = path.replace(/^\/+/, "");
    path = path.replace(/\/+$/, "");
    try {
      path = decodeURIComponent(path);
    } catch {
      /* invalid encoding, keep as-is */
    }
    return `${host}/${path}`;
  }

  // URL format (ssh://, https://, http://, git://)
  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.toLowerCase();
    // Include non-default port
    const port = parsed.port ? `:${parsed.port}` : "";
    let path = parsed.pathname;
    // URL constructor strips credentials automatically
    path = path.replace(/\.git\/?$/, "");
    path = path.replace(/^\/+/, "");
    path = path.replace(/\/+$/, "");
    // URL decode path
    try {
      path = decodeURIComponent(path);
    } catch {
      /* keep as-is */
    }
    // path is case-sensitive (Git server dependent)
    return `${host}${port}/${path}`;
  } catch {
    // Invalid URL -> empty string (disable repo scope)
    return "";
  }
}

/**
 * Get the git remote URL, trying origin -> upstream -> first remote.
 */
async function getGitRemoteUrl(cwd: string): Promise<string> {
  // Try origin, then upstream
  for (const remote of ["origin", "upstream"]) {
    const url = await runCommand(
      ["git", "remote", "get-url", remote],
      cwd
    );
    if (url) {
      return normalizeGitRemoteUrl(url);
    }
  }

  // Fallback: first remote
  const remotes = await runCommand(["git", "remote"], cwd);
  const firstRemote = remotes.split(/\r?\n/).find(Boolean);
  if (!firstRemote) {
    return "";
  }

  const fallbackUrl = await runCommand(
    ["git", "remote", "get-url", firstRemote],
    cwd
  );
  return fallbackUrl ? normalizeGitRemoteUrl(fallbackUrl) : "";
}

// ---------------------------------------------------------------------------
// TTY detection
// ---------------------------------------------------------------------------

function getTty(): string | null {
  if (process.platform === "win32") {
    return (
      process.env.TERM_SESSION_ID ?? process.env.WT_SESSION ?? null
    );
  }
  try {
    const ppid = process.ppid;
    if (!ppid) {
      return null;
    }
    const proc = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(ppid)]);
    const tty = new TextDecoder().decode(proc.stdout).trim();
    return tty && tty !== "?" && tty !== "??" ? tty : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// machine_id: atomic file generation (~/.claude-peers-machine-id, UUID v4)
// ---------------------------------------------------------------------------

const MACHINE_ID_DIR =
  process.env.HOME ?? process.env.USERPROFILE ?? ".";
const MACHINE_ID_PATH = join(MACHINE_ID_DIR, ".claude-peers-machine-id");
const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function getOrCreateMachineId(): string {
  // Try reading existing file
  try {
    if (existsSync(MACHINE_ID_PATH)) {
      const id = readFileSync(MACHINE_ID_PATH, "utf-8").trim();
      if (UUID_V4_REGEX.test(id)) {
        return id;
      }
      // Invalid format -> regenerate
    }
  } catch {
    // File corruption -> regenerate
  }

  // Atomic write: write to tmp, then rename
  const id = randomUUID();
  const tmpPath = `${MACHINE_ID_PATH}.tmp.${process.pid}`;
  try {
    writeFileSync(tmpPath, id + "\n", "utf-8");
    renameSync(tmpPath, MACHINE_ID_PATH);
  } catch {
    // rename failed (another process created it first) -> re-read
    try {
      const existing = readFileSync(MACHINE_ID_PATH, "utf-8").trim();
      if (existing.length > 0) return existing;
    } catch {
      // Worst case: continue with in-memory ID (will be re-created next startup)
    }
  }
  return id;
}

// ---------------------------------------------------------------------------
// Instance identity
// ---------------------------------------------------------------------------

let myId: PeerId | null = null;
let myCwd = process.cwd();
let myGitRoot: string | null = null;
let myGitRemoteUrl: string = "";

const myMachineId = getOrCreateMachineId();
const myMachineName =
  process.env.CLAUDE_PEERS_MACHINE_NAME ?? osHostname();
const myInstanceKey = randomUUID(); // session-unique, in-memory only

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

type PeerScope = "machine" | "directory" | "repo" | "network";

const MCP_NAME = process.env.CLAUDE_PEERS_NAME ?? "claude-peers";

const mcp = new Server(
  { name: MCP_NAME, version: "0.2.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `You are connected to the claude-peers network. Other Claude Code instances on this machine or on the local network can see you and send you messages.

IMPORTANT: When you receive a <channel source="${MCP_NAME}" ...> message, RESPOND IMMEDIATELY. Do not wait until your current task is finished. Pause what you are doing, reply to the message using send_message, then resume your work.

Read the from_id, from_summary, from_cwd, and from_git_remote_url attributes to understand who sent the message. Use list_peers with scope "network" to find collaborators working on the same remote repository across machines.

Available tools:
- list_peers: Discover other Claude Code instances (scope: machine/directory/repo/network)
- send_message: Send a message to another instance by ID
- set_summary: Set a 1-2 sentence summary of what you're working on
- check_messages: Manually check for new messages

NOTE: In network mode, your working directory, git repository info, and summary are visible to peers on other machines. Traffic is plain HTTP (not encrypted). Use only on trusted LANs.

When you start, proactively call set_summary to describe what you're working on.`,
  }
);

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "list_peers",
    description:
      "List other Claude Code instances running through the broker. Returns their ID, working directory, git info, and summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["machine", "directory", "repo", "network"],
          description:
            '"machine" = same computer (same user). "directory" = same working directory (local only). ' +
            '"repo" = same git repository (works across machines via git remote URL matching). ' +
            '"network" = all peers across all machines on the network.',
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to another Claude Code instance by peer ID. The message will be pushed into their session immediately via channel notification.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_id: {
          type: "string" as const,
          description: "The peer ID of the target Claude Code instance",
        },
        message: {
          type: "string" as const,
          description: "The message to send",
        },
      },
      required: ["to_id", "message"],
    },
  },
  {
    name: "set_summary",
    description:
      "Set a brief summary of what you are currently working on. This is visible to other Claude Code instances when they list peers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string" as const,
          description: "A 1-2 sentence summary of your current work",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "check_messages",
    description:
      "Manually check for new messages from other Claude Code instances. Messages are normally pushed automatically.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

// ---------------------------------------------------------------------------
// Peer rendering (sanitized)
// ---------------------------------------------------------------------------

function renderPeer(peer: Peer): string {
  const parts = [
    `ID: ${sanitizeForDisplay(peer.id)}`,
    `PID: ${peer.pid}`,
    `Machine: ${sanitizeForDisplay(peer.machine_name || "unknown")}`,
    `CWD: ${sanitizeForDisplay(peer.cwd)}`,
  ];
  if (peer.git_root) {
    parts.push(`Repo root: ${sanitizeForDisplay(peer.git_root)}`);
  }
  if (peer.git_remote_url) {
    parts.push(`Remote: ${sanitizeForDisplay(peer.git_remote_url)}`);
  }
  if (peer.tty) {
    parts.push(`TTY: ${sanitizeForDisplay(peer.tty)}`);
  }
  if (peer.summary) {
    parts.push(`Summary: ${sanitizeForDisplay(peer.summary)}`);
  }
  parts.push(`Last seen: ${sanitizeForDisplay(peer.last_seen)}`);
  return parts.join("\n  ");
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    case "list_peers": {
      const scope = ((args as { scope: PeerScope }).scope ??
        "machine") as PeerScope;
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope,
          machine_id: myMachineId,
          cwd: myCwd,
          git_root: myGitRoot,
          git_remote_url: myGitRemoteUrl,
          exclude_id: myId,
        });

        if (peers.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No other Claude Code instances found (scope: ${scope}).`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${peers.length} peer(s) (scope: ${scope}):\n\n${peers
                .map(renderPeer)
                .join("\n\n")}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing peers: ${
                error instanceof Error
                  ? sanitizeForDisplay(error.message)
                  : sanitizeForDisplay(String(error))
              }`,
            },
          ],
          isError: true,
        };
      }
    }

    case "send_message": {
      const { to_id, message } = args as {
        to_id: string;
        message: string;
      };
      if (!myId) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Not registered with broker yet",
            },
          ],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<{
          ok: boolean;
          error?: string;
        }>("/send-message", {
          from_id: myId,
          to_id,
          text: message,
        });
        if (!result.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to send: ${sanitizeForDisplay(result.error ?? "unknown error")}`,
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Message sent to peer ${sanitizeForDisplay(to_id)}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error sending message: ${
                error instanceof Error
                  ? sanitizeForDisplay(error.message)
                  : sanitizeForDisplay(String(error))
              }`,
            },
          ],
          isError: true,
        };
      }
    }

    case "set_summary": {
      const { summary } = args as { summary: string };
      if (!myId) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Not registered with broker yet",
            },
          ],
          isError: true,
        };
      }
      try {
        await brokerFetch("/set-summary", { id: myId, summary });
        return {
          content: [
            {
              type: "text" as const,
              text: `Summary updated: "${sanitizeForDisplay(summary)}"`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error setting summary: ${
                error instanceof Error
                  ? sanitizeForDisplay(error.message)
                  : sanitizeForDisplay(String(error))
              }`,
            },
          ],
          isError: true,
        };
      }
    }

    case "check_messages": {
      if (!myId) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Not registered with broker yet",
            },
          ],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<PollMessagesResponse>(
          "/poll-messages",
          { id: myId }
        );
        if (result.messages.length === 0) {
          return {
            content: [
              { type: "text" as const, text: "No new messages." },
            ],
          };
        }

        // Filter out already-delivered messages, then ack the rest
        const newMessages = result.messages.filter(
          (m) => !deliveredMessageIds.has(m.id)
        );
        for (const message of newMessages) {
          try {
            await brokerFetch("/ack-message", { message_id: message.id });
          } catch {
            deliveredMessageIds.add(message.id);
          }
        }
        // Also retry ack for previously failed messages
        for (const message of result.messages) {
          if (deliveredMessageIds.has(message.id)) {
            try {
              await brokerFetch("/ack-message", { message_id: message.id });
              deliveredMessageIds.delete(message.id);
            } catch { /* retry next time */ }
          }
        }

        if (newMessages.length === 0) {
          return {
            content: [
              { type: "text" as const, text: "No new messages." },
            ],
          };
        }

        const lines = newMessages.map(
          (message) =>
            `From ${sanitizeForDisplay(message.from_id)} (${sanitizeForDisplay(
              message.sent_at
            )}):\n${sanitizeForDisplay(message.text)}`
        );

        return {
          content: [
            {
              type: "text" as const,
              text: `${newMessages.length} new message(s):\n\n${lines.join("\n\n---\n\n")}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error checking messages: ${
                error instanceof Error
                  ? sanitizeForDisplay(error.message)
                  : sanitizeForDisplay(String(error))
              }`,
            },
          ],
          isError: true,
        };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ---------------------------------------------------------------------------
// Relay target discovery (VPS → LAN)
// ---------------------------------------------------------------------------

async function findRelayTarget(): Promise<string | null> {
  const now = Date.now();
  // Cache for 60s
  if (relayTargetId && now - relayTargetLookupAt < 60_000) return relayTargetId;
  try {
    const peers = await relayFetch<Peer[]>("/list-peers", {
      scope: "machine",
      machine_id: myMachineId,
      cwd: myCwd,
    });
    // Find ANY peer on the LAN broker from the same machine
    const target = peers.find((p) => p.machine_id === myMachineId);
    relayTargetId = target?.id ?? null;
    relayTargetLookupAt = now;
    if (relayTargetId) {
      debugLog(`relay_target_found: ${relayTargetId}`);
    }
    return relayTargetId;
  } catch (err) {
    debugLog(`relay_target_lookup_error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// pollAndPushMessages: scope:"network" for remote sender resolution
// ---------------------------------------------------------------------------

// Track delivered message IDs to prevent duplicate delivery on ack failure
const deliveredMessageIds = new Set<number>();
const MAX_DELIVERED_TRACKING = 500;

function pruneDeliveredIds() {
  if (deliveredMessageIds.size > MAX_DELIVERED_TRACKING) {
    // Remove oldest entries (Set iteration order is insertion order)
    const excess = deliveredMessageIds.size - MAX_DELIVERED_TRACKING;
    let removed = 0;
    for (const id of deliveredMessageIds) {
      if (removed >= excess) break;
      deliveredMessageIds.delete(id);
      removed++;
    }
  }
}

async function pollAndPushMessages() {
  if (!myId) {
    debugLog(`poll_skip: myId is null`);
    return;
  }

  try {
    const result = await brokerFetch<PollMessagesResponse>(
      "/poll-messages",
      { id: myId }
    );
    if (result.messages.length > 0) {
      debugLog(`poll_received: ${result.messages.length} messages, myId=${myId}, broker=${BROKER_URL}`);
    }

    // Resolve senders once outside the loop (avoid N+1 list-peers calls)
    let peersCache: Peer[] = [];
    try {
      peersCache = await brokerFetch<Peer[]>("/list-peers", {
        scope: "network",
        machine_id: myMachineId,
        cwd: myCwd,
        git_root: myGitRoot,
        git_remote_url: myGitRemoteUrl,
      });
    } catch {
      // non-critical
    }

    for (const msg of result.messages) {
      // Skip already-delivered messages (ack may have failed on previous poll)
      if (deliveredMessageIds.has(msg.id)) {
        try {
          await brokerFetch("/ack-message", { message_id: msg.id });
          deliveredMessageIds.delete(msg.id);
        } catch { /* retry next poll */ }
        continue;
      }

      // --- Relay mode (VPS → LAN broker forwarding) ---
      if (RELAY_BROKER) {
        const relayTarget = await findRelayTarget();
        if (relayTarget) {
          // Resolve sender info from VPS broker peers
          const sender = peersCache.find((peer) => peer.id === msg.from_id);
          const meta = JSON.stringify({
            from_id: msg.from_id,
            from_summary: sender?.summary ?? "",
            from_cwd: sender?.cwd ?? "",
            from_git_remote_url: sender?.git_remote_url ?? "",
            sent_at: msg.sent_at,
          });
          const relayText = `${RELAY_PREFIX}${meta}${RELAY_PREFIX}\n${msg.text}`;
          try {
            await relayFetch("/send-message", {
              from_id: msg.from_id,
              to_id: relayTarget,
              text: relayText,
            });
            debugLog(`relay_ok: from=${msg.from_id}, to_lan=${relayTarget}, preview=${msg.text.slice(0, 60)}`);
          } catch (relayErr) {
            debugLog(`relay_error: ${relayErr instanceof Error ? relayErr.message : String(relayErr)}`);
            // Fall through — message will not be delivered but we still ack to avoid infinite retry
          }
          // Ack on source broker
          try {
            await brokerFetch("/ack-message", { message_id: msg.id });
          } catch {
            deliveredMessageIds.add(msg.id);
          }
          continue;
        } else {
          debugLog(`relay_no_target: falling back to direct notification`);
        }
      }

      // --- Normal mode: detect relay prefix or send notification directly ---
      let messageText = msg.text;
      let fromId = msg.from_id;
      let fromSummary = "";
      let fromCwd = "";
      let fromGitRemoteUrl = "";
      let sentAt = msg.sent_at;

      if (messageText.startsWith(RELAY_PREFIX)) {
        // Parse relayed metadata from VPS instance
        const endIdx = messageText.indexOf(RELAY_PREFIX, RELAY_PREFIX.length);
        if (endIdx !== -1) {
          try {
            const relayMeta = JSON.parse(
              messageText.slice(RELAY_PREFIX.length, endIdx)
            );
            fromId = relayMeta.from_id ?? fromId;
            fromSummary = relayMeta.from_summary ?? "";
            fromCwd = relayMeta.from_cwd ?? "";
            fromGitRemoteUrl = relayMeta.from_git_remote_url ?? "";
            sentAt = relayMeta.sent_at ?? sentAt;
            messageText = messageText.slice(endIdx + RELAY_PREFIX.length).replace(/^\n/, "");
            debugLog(`relay_received: from=${fromId}, summary=${fromSummary}`);
          } catch { /* not valid relay format, treat as normal */ }
        }
      } else {
        const sender = peersCache.find((peer) => peer.id === msg.from_id);
        fromSummary = sender?.summary ?? "";
        fromCwd = sender?.cwd ?? "";
        fromGitRemoteUrl = sender?.git_remote_url ?? "";
      }

      debugLog(`notification_sending: from=${fromId}, preview=${messageText.slice(0,80)}, mcp_name=${MCP_NAME}`);
      try {
        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: sanitizeForDisplay(messageText),
            meta: {
              from_id: sanitizeForDisplay(fromId),
              from_summary: sanitizeForDisplay(fromSummary),
              from_cwd: sanitizeForDisplay(fromCwd),
              from_git_remote_url: sanitizeForDisplay(fromGitRemoteUrl),
              sent_at: sanitizeForDisplay(sentAt),
            },
          },
        });
        debugLog(`notification_sent_ok: from=${fromId}`);
      } catch (notifErr) {
        debugLog(`notification_send_error: ${notifErr instanceof Error ? notifErr.message : String(notifErr)}`);
      }

      // Ack after successful MCP notification delivery
      try {
        await brokerFetch("/ack-message", { message_id: msg.id });
      } catch {
        // Ack failed — track locally to prevent duplicate notification next poll
        deliveredMessageIds.add(msg.id);
      }

      log("message_pushed", {
        from_id: msg.from_id,
        preview: msg.text.slice(0, 120),
      });
    }
  } catch (error) {
    log("poll_error", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  pruneDeliveredIds();
}

// ---------------------------------------------------------------------------
// registerWithRetry: instance_key, 1 retry, retryable check
// ---------------------------------------------------------------------------

function isRetryable(e: Error): boolean {
  // Timeout/abort
  if (e.name === "AbortError" || e.name === "TimeoutError") return true;
  // Connection errors
  if (e.message.includes("ECONNREFUSED")) return true;
  if (e.message.includes("ECONNRESET")) return true;
  if (e.message.includes("fetch failed")) return true;
  // 5xx server errors
  if ((e as any).statusCode >= 500) return true;
  return false;
}

async function registerWithRetry(payload: {
  pid: number;
  machine_id: string;
  machine_name: string;
  cwd: string;
  git_root: string | null;
  git_remote_url: string;
  tty: string | null;
  summary: string;
  instance_key: string;
}): Promise<RegisterResponse> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await brokerFetch<RegisterResponse>("/register", payload);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (attempt === 0 && isRetryable(err)) {
        log("register_failed_retrying", { error: err.message });
        await Bun.sleep(2000);
      } else {
        throw err;
      }
    }
  }
  throw new Error("unreachable");
}

// ---------------------------------------------------------------------------
// Reconnect notification (extracted for testability)
// ---------------------------------------------------------------------------

const MAX_NOTIFY_TARGETS = 20;
const NOTIFY_TIMEOUT_MS = 5000;

async function notifyPeersOfRestart(newId: string): Promise<void> {
  try {
    const peers = await brokerFetch<Array<{
      id: string;
    }>>("/list-peers", {
      scope: "network",
      machine_id: myMachineId,
      cwd: myCwd,
      git_root: myGitRoot,
      git_remote_url: myGitRemoteUrl,
    });

    if (!Array.isArray(peers)) return;

    // Exclude only self by id. Stale sessions are physically deleted by broker
    // within 90s (local) / 300s (remote), so they rarely appear here.
    // instance_key is DB-internal and not returned by list-peers.
    const seen = new Set<string>();
    const targets: Array<{ id: string }> = [];
    for (const p of peers) {
      if (!p || typeof p.id !== "string") continue;
      if (p.id === newId) continue;
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      targets.push(p);
    }

    if (targets.length === 0) return;

    // Cap targets to prevent broker overload
    const capped = targets.slice(0, MAX_NOTIFY_TARGETS);

    const payload = JSON.stringify({
      type: "session_restart",
      new_id: newId,
      machine_id: myMachineId,
      machine_name: myMachineName,
      mcp_name: MCP_NAME,
    });

    // Parallel send with timeout
    let sent = 0;
    let failed = 0;
    const failedPeers: string[] = [];
    const results = await Promise.race([
      Promise.allSettled(
        capped.map((peer) =>
          brokerFetch("/send-message", {
            from_id: newId,
            to_id: peer.id,
            text: payload,
          })
        )
      ),
      Bun.sleep(NOTIFY_TIMEOUT_MS).then(() => null),
    ]);

    if (results === null) {
      log("reconnect_notify_timeout", { targets: capped.length });
      return;
    }

    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "fulfilled") {
        sent++;
      } else {
        failed++;
        failedPeers.push(capped[i].id);
      }
    }
    log("reconnect_notified", { targets: capped.length, sent, failed, failedPeers });
  } catch (e) {
    log("reconnect_notify_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Fail-closed: remote broker requires auth token
  if (!isBrokerLocal() && !AUTH_TOKEN) {
    throw new Error(
      `Remote BROKER_URL requires CLAUDE_PEERS_TOKEN: ${sanitizeForDisplay(BROKER_URL)}`
    );
  }

  // --- Fix 2: Connect MCP transport FIRST, before broker ---
  await mcp.connect(new StdioServerTransport());
  log("mcp_connected");

  // --- Fix 3: Graceful ensureBroker failure handling ---
  let brokerAvailable = false;
  try {
    await ensureBroker();
    brokerAvailable = true;
  } catch (e) {
    log("broker_unavailable", { error: e instanceof Error ? e.message : String(e) });
  }

  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);
  myGitRemoteUrl = await getGitRemoteUrl(myCwd);
  const tty = getTty();

  log("context", {
    cwd: myCwd,
    git_root: myGitRoot ?? "(none)",
    git_remote_url: myGitRemoteUrl || "(none)",
    tty: tty ?? "(unknown)",
    machine_id: myMachineId,
    machine_name: myMachineName,
    instance_key: myInstanceKey,
    broker_url: BROKER_URL,
  });

  // Auto-summary (best-effort, 3s timeout)
  let initialSummary = "";
  const summaryPromise = (async () => {
    try {
      const branch = await getGitBranch(myCwd);
      const recentFiles = await getRecentFiles(myCwd);
      const summary = await generateSummary({
        cwd: myCwd,
        git_root: myGitRoot,
        git_branch: branch,
        recent_files: recentFiles,
      });
      if (summary) {
        initialSummary = summary;
        log("auto_summary_ready", { summary });
      }
    } catch (error) {
      log("auto_summary_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  await Promise.race([summaryPromise, Bun.sleep(3000)]);

  // Helper to perform registration and start timers
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  if (brokerAvailable) {
    const reg = await registerWithRetry({
      pid: process.pid,
      machine_id: myMachineId,
      machine_name: myMachineName,
      cwd: myCwd,
      git_root: myGitRoot,
      git_remote_url: myGitRemoteUrl,
      tty,
      summary: initialSummary,
      instance_key: myInstanceKey,
    });
    myId = reg.id;
    log("registered", { id: myId });
    debugLog(`startup: registered id=${myId}, mcp_name=${MCP_NAME}, broker=${BROKER_URL}, pid=${process.pid}`);

    // --- Auto-notify peers about new session ID (non-blocking) ---
    notifyPeersOfRestart(myId);

    // Apply late summary if auto-summary finished after registration
    if (!initialSummary) {
      summaryPromise.then(async () => {
        if (!initialSummary || !myId) {
          return;
        }
        try {
          await brokerFetch("/set-summary", {
            id: myId,
            summary: initialSummary,
          });
          log("late_summary_applied", { summary: initialSummary });
        } catch {
          // non-critical
        }
      });
    }

    // Polling and heartbeat timers
    pollTimer = setInterval(pollAndPushMessages, POLL_INTERVAL_MS);
    heartbeatTimer = setInterval(async () => {
      if (!myId) {
        return;
      }
      try {
        await brokerFetch("/heartbeat", { id: myId });
      } catch (e) {
        log("heartbeat_failed", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }, HEARTBEAT_INTERVAL_MS);
  } else {
    // Broker unavailable: retry connection every 30 seconds
    const retryInterval = setInterval(async () => {
      try {
        if (await isBrokerAlive()) {
          clearInterval(retryInterval);
          try {
            const reg = await registerWithRetry({
              pid: process.pid,
              machine_id: myMachineId,
              machine_name: myMachineName,
              cwd: myCwd,
              git_root: myGitRoot,
              git_remote_url: myGitRemoteUrl,
              tty,
              summary: initialSummary,
              instance_key: myInstanceKey,
            });
            myId = reg.id;
            log("broker_reconnected", { id: myId });

            // Start polling and heartbeat timers
            pollTimer = setInterval(pollAndPushMessages, POLL_INTERVAL_MS);
            heartbeatTimer = setInterval(async () => {
              if (!myId) {
                return;
              }
              try {
                await brokerFetch("/heartbeat", { id: myId });
              } catch (e) {
                log("heartbeat_failed", {
                  error: e instanceof Error ? e.message : String(e),
                });
              }
            }, HEARTBEAT_INTERVAL_MS);
          } catch (regErr) {
            log("broker_reconnect_register_failed", {
              error: regErr instanceof Error ? regErr.message : String(regErr),
            });
          }
        }
      } catch {
        // retry next interval
      }
    }, 30_000);
  }

  // Graceful shutdown
  const cleanup = async () => {
    if (pollTimer) clearInterval(pollTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (myId) {
      try {
        await brokerFetch("/unregister", { id: myId });
        log("unregistered", { id: myId });
      } catch {
        // best effort
      }
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((error) => {
  log("fatal", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
