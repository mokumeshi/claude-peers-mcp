#!/usr/bin/env bun
/**
 * skill-graph server
 *
 * A shared HTTP server backed by SQLite.
 * Stores skill-graph knowledge nodes with full-text search.
 */

import { Database } from "bun:sqlite";
import { isLoopback, sanitizeForDisplay } from "./shared/net.ts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.SKILL_GRAPH_PORT ?? "7901", 10);
const HOSTNAME = process.env.SKILL_GRAPH_HOST ?? "127.0.0.1";
const DB_PATH =
  process.env.SKILL_GRAPH_DB ??
  `${process.env.HOME ?? process.env.USERPROFILE ?? "."}/.skill-graph.db`;
const AUTH_TOKEN = process.env.SKILL_GRAPH_TOKEN ?? null;
const NAME_REGEX = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const MAX_CONTENT_LENGTH = 1_048_576; // 1MB

// ---------------------------------------------------------------------------
// Fail-closed startup check
// ---------------------------------------------------------------------------

if (!isLoopback(HOSTNAME) && !AUTH_TOKEN) {
  console.error(
    "[skill-graph] FATAL: SKILL_GRAPH_TOKEN is required when binding to non-loopback address.\n" +
      "Either set SKILL_GRAPH_TOKEN=<secret> or use SKILL_GRAPH_HOST=127.0.0.1 for local-only mode."
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
  console.error(`[skill-graph] ${event}${suffix}`);
}

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 5000");

db.run(`
  CREATE TABLE IF NOT EXISTS nodes (
    id INTEGER PRIMARY KEY,
    name TEXT UNIQUE NOT NULL CHECK (length(name) >= 1 AND length(name) <= 128),
    display_name TEXT,
    type TEXT NOT NULL DEFAULT 'knowledge',
    tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags) AND json_type(tags) = 'array'),
    content TEXT NOT NULL CHECK (length(content) <= 1048576),
    contributor_name TEXT NOT NULL DEFAULT 'anonymous',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

db.run(
  "CREATE INDEX IF NOT EXISTS idx_nodes_updated ON nodes(updated_at DESC)"
);

db.run(
  "CREATE INDEX IF NOT EXISTS idx_nodes_type_updated ON nodes(type, updated_at DESC)"
);

db.run(`
  CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
    name, content, tags,
    content='nodes',
    content_rowid='id',
    tokenize='unicode61'
  )
`);

db.run(`
  CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
    INSERT INTO nodes_fts(rowid, name, content, tags) VALUES (NEW.id, NEW.name, NEW.content, NEW.tags);
  END
`);

db.run(`
  CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, name, content, tags) VALUES('delete', OLD.id, OLD.name, OLD.content, OLD.tags);
  END
`);

db.run(`
  CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, name, content, tags) VALUES('delete', OLD.id, OLD.name, OLD.content, OLD.tags);
    INSERT INTO nodes_fts(rowid, name, content, tags) VALUES (NEW.id, NEW.name, NEW.content, NEW.tags);
  END
`);

db.run("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')");
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type NodeRow = {
  id: number;
  name: string;
  display_name: string | null;
  type: string;
  tags: string;
  content: string;
  contributor_name: string;
  version: number;
  created_at: string;
  updated_at: string;
};

type NodeSummaryRow = Omit<NodeRow, "content">;

type SearchRow = NodeSummaryRow & {
  snippet: string;
};

type CreateNodeRequest = {
  name: string;
  display_name?: string;
  type?: string;
  tags?: string[];
  content: string;
  contributor_name?: string;
};

type UpdateNodeRequest = {
  display_name?: string;
  type?: string;
  tags?: string[];
  content: string;
  base_version: number;
  contributor_name?: string;
};

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

const NODE_COLUMNS =
  "id, name, display_name, type, tags, content, contributor_name, version, created_at, updated_at";
const NODE_SUMMARY_COLUMNS =
  "id, name, display_name, type, tags, contributor_name, version, created_at, updated_at";

const selectNodeByName = db.prepare(
  `SELECT ${NODE_COLUMNS} FROM nodes WHERE name = ?`
);

const insertNode = db.prepare(`
  INSERT INTO nodes (name, display_name, type, tags, content, contributor_name, version, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateNodeById = db.prepare(`
  UPDATE nodes
  SET display_name = ?, type = ?, tags = ?, content = ?, contributor_name = ?, version = ?, updated_at = ?
  WHERE id = ?
`);

const deleteNodeById = db.prepare("DELETE FROM nodes WHERE id = ?");

const selectNodeCount = db.prepare("SELECT COUNT(*) AS count FROM nodes");

const selectNodeCountByType = db.prepare(
  "SELECT COUNT(*) AS count FROM nodes WHERE type = ?"
);

const selectNodesPage = db.prepare(`
  SELECT ${NODE_SUMMARY_COLUMNS}
  FROM nodes
  ORDER BY updated_at DESC, name ASC
  LIMIT ? OFFSET ?
`);

const selectNodesPageByType = db.prepare(`
  SELECT ${NODE_SUMMARY_COLUMNS}
  FROM nodes
  WHERE type = ?
  ORDER BY updated_at DESC, name ASC
  LIMIT ? OFFSET ?
`);

const selectRecentNodes = db.prepare(`
  SELECT ${NODE_SUMMARY_COLUMNS}
  FROM nodes
  ORDER BY updated_at DESC, name ASC
  LIMIT 20
`);

const searchNodes = db.prepare(`
  SELECT
    nodes.id,
    nodes.name,
    nodes.display_name,
    nodes.type,
    nodes.tags,
    nodes.contributor_name,
    nodes.version,
    nodes.created_at,
    nodes.updated_at,
    snippet(nodes_fts, 1, '', '', '...', 30) AS snippet
  FROM nodes_fts
  JOIN nodes ON nodes.id = nodes_fts.rowid
  WHERE nodes_fts MATCH ?
  ORDER BY bm25(nodes_fts), nodes.updated_at DESC, nodes.name ASC
  LIMIT 50
`);
// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.every((v) => typeof v === "string")
    ) {
      return parsed;
    }
  } catch {
    // Ignore malformed legacy data; return a safe empty array.
  }
  return [];
}

function toNodeData(row: NodeRow) {
  return {
    id: row.id,
    name: row.name,
    display_name: row.display_name,
    type: row.type,
    tags: parseTags(row.tags),
    content: row.content,
    contributor_name: row.contributor_name,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toNodeSummary(row: NodeSummaryRow) {
  return {
    id: row.id,
    name: row.name,
    display_name: row.display_name,
    type: row.type,
    tags: parseTags(row.tags),
    contributor_name: row.contributor_name,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function yamlQuote(value: string | number | null): string {
  return JSON.stringify(value === null ? "" : String(value));
}

function toFrontmatterMarkdown(row: NodeRow): string {
  const tags = parseTags(row.tags);
  const tagLines =
    tags.length === 0
      ? "tags: []"
      : ["tags:", ...tags.map((tag) => `  - ${yamlQuote(tag)}`)].join("\n");

  return [
    "---",
    `id: ${yamlQuote(row.id)}`,
    `name: ${yamlQuote(row.name)}`,
    `display_name: ${yamlQuote(row.display_name)}`,
    `type: ${yamlQuote(row.type)}`,
    tagLines,
    `contributor_name: ${yamlQuote(row.contributor_name)}`,
    `version: ${yamlQuote(row.version)}`,
    `created_at: ${yamlQuote(row.created_at)}`,
    `updated_at: ${yamlQuote(row.updated_at)}`,
    "---",
    row.content,
  ].join("\n");
}

function decodeNodeName(encodedName: string): string | null {
  try {
    return decodeURIComponent(encodedName);
  } catch {
    return null;
  }
}
// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function validateName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  if (!NAME_REGEX.test(name)) return null;
  if (name === "recent") return null;
  return name;
}

function validateType(type: unknown): string | null {
  if (typeof type !== "string") return null;
  if (type.length < 1 || type.length > 128) return null;
  return type;
}

function validateContributorName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length < 1 || value.length > 256) return null;
  return value;
}

function validateDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length < 1 || value.length > 256) return null;
  return value;
}

function validateTags(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((tag) => typeof tag === "string" && tag.length <= 256)) {
    return null;
  }
  return value as string[];
}

function validateCreateNodeRequest(body: unknown): CreateNodeRequest | null {
  if (!isRecord(body)) return null;

  const name = validateName(body.name);
  if (!name) return null;

  if (
    typeof body.content !== "string" ||
    body.content.length > MAX_CONTENT_LENGTH
  ) {
    return null;
  }

  const result: CreateNodeRequest = { name, content: body.content };

  if (body.display_name !== undefined) {
    const displayName = validateDisplayName(body.display_name);
    if (!displayName) return null;
    result.display_name = displayName;
  }

  if (body.type !== undefined) {
    const type = validateType(body.type);
    if (!type) return null;
    result.type = type;
  }

  if (body.tags !== undefined) {
    const tags = validateTags(body.tags);
    if (!tags) return null;
    result.tags = tags;
  }

  if (body.contributor_name !== undefined) {
    const contributorName = validateContributorName(body.contributor_name);
    if (!contributorName) return null;
    result.contributor_name = contributorName;
  }

  return result;
}

function validateUpdateNodeRequest(body: unknown): UpdateNodeRequest | null {
  if (!isRecord(body)) return null;

  if (
    typeof body.content !== "string" ||
    body.content.length > MAX_CONTENT_LENGTH
  ) {
    return null;
  }

  if (
    typeof body.base_version !== "number" ||
    !Number.isInteger(body.base_version) ||
    body.base_version < 1
  ) {
    return null;
  }

  const result: UpdateNodeRequest = {
    content: body.content,
    base_version: body.base_version,
  };

  if (body.display_name !== undefined) {
    const displayName = validateDisplayName(body.display_name);
    if (!displayName) return null;
    result.display_name = displayName;
  }

  if (body.type !== undefined) {
    const type = validateType(body.type);
    if (!type) return null;
    result.type = type;
  }

  if (body.tags !== undefined) {
    const tags = validateTags(body.tags);
    if (!tags) return null;
    result.tags = tags;
  }

  if (body.contributor_name !== undefined) {
    const contributorName = validateContributorName(body.contributor_name);
    if (!contributorName) return null;
    result.contributor_name = contributorName;
  }

  return result;
}

function parseLimit(value: string | null): number | null {
  if (value === null) return 50;
  if (!/^\d+$/.test(value)) return null;
  const limit = parseInt(value, 10);
  if (limit < 1 || limit > 200) return null;
  return limit;
}

function parseOffset(value: string | null): number | null {
  if (value === null) return 0;
  if (!/^\d+$/.test(value)) return null;
  return parseInt(value, 10);
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

function requireJsonContentType(req: Request): Response | null {
  const contentType = (req.headers.get("Content-Type") ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    return jsonResponse(
      { ok: false, error: "invalid content-type" },
      { status: 400 }
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleCreateNode(body: CreateNodeRequest): Response {
  const now = new Date().toISOString();
  const type = body.type ?? "knowledge";
  const tags = JSON.stringify(body.tags ?? []);
  const contributorName = body.contributor_name ?? "anonymous";
  const displayName = body.display_name ?? null;

  try {
    insertNode.run(
      body.name,
      displayName,
      type,
      tags,
      body.content,
      contributorName,
      1,
      now,
      now
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes("UNIQUE constraint failed") ||
      message.includes("constraint")
    ) {
      return jsonResponse(
        { ok: false, error: "Node already exists" },
        { status: 409 }
      );
    }
    throw error;
  }

  log("node_created", { name: body.name, type, version: 1 });

  return jsonResponse(
    { ok: true, data: { name: body.name, version: 1 } },
    { status: 201 }
  );
}

const updateNodeTransaction = db.transaction(
  (
    name: string,
    body: UpdateNodeRequest
  ):
    | { kind: "ok"; version: number }
    | { kind: "not_found" }
    | { kind: "conflict"; currentVersion: number } => {
    const current = selectNodeByName.get(name) as NodeRow | null;

    if (!current) {
      return { kind: "not_found" };
    }

    if (current.version !== body.base_version) {
      return { kind: "conflict", currentVersion: current.version };
    }

    const nextVersion = current.version + 1;
    const nextDisplayName =
      body.display_name !== undefined ? body.display_name : current.display_name;
    const nextType = body.type ?? current.type;
    const nextTags =
      body.tags !== undefined ? JSON.stringify(body.tags) : current.tags;
    const nextContributorName =
      body.contributor_name ?? current.contributor_name;

    updateNodeById.run(
      nextDisplayName,
      nextType,
      nextTags,
      body.content,
      nextContributorName,
      nextVersion,
      new Date().toISOString(),
      current.id
    );

    return { kind: "ok", version: nextVersion };
  }
);

function handleUpdateNode(name: string, body: UpdateNodeRequest): Response {
  const result = updateNodeTransaction(name, body);

  if (result.kind === "not_found") {
    return jsonResponse(
      { ok: false, error: "Node not found" },
      { status: 404 }
    );
  }

  if (result.kind === "conflict") {
    return jsonResponse(
      {
        ok: false,
        error: "Version conflict",
        current_version: result.currentVersion,
      },
      { status: 409 }
    );
  }

  log("node_updated", { name, version: result.version });

  return jsonResponse({
    ok: true,
    data: { name, version: result.version },
  });
}

function handleGetNode(row: NodeRow, format: string | null): Response {
  if (format === null) {
    return jsonResponse({ ok: true, data: toNodeData(row) });
  }

  if (format !== "markdown") {
    return jsonResponse(
      { ok: false, error: "invalid format" },
      { status: 422 }
    );
  }

  return jsonResponse({ ok: true, data: toFrontmatterMarkdown(row) });
}
function handleListNodes(url: URL): Response {
  const typeParam = url.searchParams.get("type");
  const limit = parseLimit(url.searchParams.get("limit"));
  const offset = parseOffset(url.searchParams.get("offset"));

  if (limit === null) {
    return jsonResponse(
      { ok: false, error: "invalid limit" },
      { status: 422 }
    );
  }

  if (offset === null) {
    return jsonResponse(
      { ok: false, error: "invalid offset" },
      { status: 422 }
    );
  }

  if (typeParam !== null) {
    const type = validateType(typeParam);
    if (!type) {
      return jsonResponse(
        { ok: false, error: "invalid type" },
        { status: 422 }
      );
    }

    const rows = selectNodesPageByType.all(
      type,
      limit,
      offset
    ) as NodeSummaryRow[];
    const total = (selectNodeCountByType.get(type) as { count: number }).count;

    return jsonResponse({
      ok: true,
      data: rows.map(toNodeSummary),
      total,
    });
  }

  const rows = selectNodesPage.all(limit, offset) as NodeSummaryRow[];
  const total = (selectNodeCount.get() as { count: number }).count;

  return jsonResponse({
    ok: true,
    data: rows.map(toNodeSummary),
    total,
  });
}

function handleRecentNodes(): Response {
  const rows = selectRecentNodes.all() as NodeSummaryRow[];
  return jsonResponse({ ok: true, data: rows.map(toNodeSummary) });
}

function handleSearch(url: URL): Response {
  const rawQuery = (url.searchParams.get("q") ?? "").trim();
  if (rawQuery.length < 1 || rawQuery.length > 200) {
    return jsonResponse({ ok: false, error: "invalid q" }, { status: 422 });
  }

  // FTS5 phrase search with escaped double-quotes
  const match = '"' + rawQuery.replace(/"/g, '""') + '"';
  const rows = searchNodes.all(match) as SearchRow[];

  return jsonResponse({
    ok: true,
    data: rows.map((row) => ({
      id: row.id,
      name: row.name,
      display_name: row.display_name,
      type: row.type,
      tags: parseTags(row.tags),
      contributor_name: row.contributor_name,
      version: row.version,
      created_at: row.created_at,
      updated_at: row.updated_at,
      snippet: row.snippet,
    })),
  });
}

function handleDeleteNode(name: string): Response {
  const row = selectNodeByName.get(name) as NodeRow | null;
  if (!row) {
    return jsonResponse(
      { ok: false, error: "Node not found" },
      { status: 404 }
    );
  }

  deleteNodeById.run(row.id);
  log("node_deleted", { name });
  return jsonResponse({ ok: true });
}
// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

Bun.serve({
  port: PORT,
  hostname: HOSTNAME,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // GET /health — no auth required
    if (req.method === "GET" && path === "/health") {
      const nodes = (selectNodeCount.get() as { count: number }).count;
      return jsonResponse({ status: "ok", nodes });
    }

    const authErr = checkAuth(req);
    if (authErr) {
      log("auth_failed", { path });
      return authErr;
    }

    try {
      // GET /search
      if (req.method === "GET" && path === "/search") {
        return handleSearch(url);
      }

      // GET /nodes/recent — must be checked before /nodes/:name
      if (req.method === "GET" && path === "/nodes/recent") {
        return handleRecentNodes();
      }

      // /nodes/:name routes
      const nodeMatch = path.match(/^\/nodes\/([^/]+)$/);
      if (nodeMatch) {
        const name = decodeNodeName(nodeMatch[1]);
        if (!name || !validateName(name)) {
          return jsonResponse(
            { ok: false, error: "invalid node name" },
            { status: 422 }
          );
        }

        if (req.method === "GET") {
          const row = selectNodeByName.get(name) as NodeRow | null;
          if (!row) {
            return jsonResponse(
              { ok: false, error: "Node not found" },
              { status: 404 }
            );
          }
          return handleGetNode(row, url.searchParams.get("format"));
        }

        if (req.method === "PUT") {
          const contentTypeErr = requireJsonContentType(req);
          if (contentTypeErr) return contentTypeErr;

          const body = await req.json();
          const validated = validateUpdateNodeRequest(body);
          if (!validated) {
            return jsonResponse(
              { ok: false, error: "invalid update request" },
              { status: 422 }
            );
          }
          return handleUpdateNode(name, validated);
        }

        if (req.method === "DELETE") {
          return handleDeleteNode(name);
        }

        return jsonResponse(
          { ok: false, error: "not found" },
          { status: 404 }
        );
      }

      // /nodes routes (collection)
      if (path === "/nodes") {
        if (req.method === "GET") {
          return handleListNodes(url);
        }

        if (req.method === "POST") {
          const contentTypeErr = requireJsonContentType(req);
          if (contentTypeErr) return contentTypeErr;

          const body = await req.json();
          const validated = validateCreateNodeRequest(body);
          if (!validated) {
            return jsonResponse(
              { ok: false, error: "invalid create request" },
              { status: 422 }
            );
          }
          return handleCreateNode(validated);
        }

        return jsonResponse(
          { ok: false, error: "not found" },
          { status: 404 }
        );
      }

      return jsonResponse(
        { ok: false, error: "not found" },
        { status: 404 }
      );
    } catch (error) {
      if (error instanceof SyntaxError) {
        return jsonResponse(
          { ok: false, error: "invalid JSON" },
          { status: 400 }
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      log("request_failed", { path, error: message });
      return jsonResponse({ ok: false, error: "internal error" }, { status: 500 });
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
    "[skill-graph] WARNING: Network mode active. Traffic is NOT encrypted (plain HTTP)."
  );
  console.error(
    "[skill-graph] WARNING: Use only on trusted LANs. Do not expose to the internet."
  );
}
