#!/usr/bin/env bun
/**
 * skill-graph MCP server
 *
 * Spawned by Claude Code as a stdio MCP server.
 * Wraps the skill-graph HTTP API as MCP tools.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SKILL_GRAPH_URL =
  process.env.SKILL_GRAPH_URL ?? "http://127.0.0.1:7901";
const SKILL_GRAPH_TOKEN: string | null =
  process.env.SKILL_GRAPH_TOKEN ?? null;

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function sgFetch<T>(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const headers: Record<string, string> = {};
  if (SKILL_GRAPH_TOKEN) {
    headers["Authorization"] = `Bearer ${SKILL_GRAPH_TOKEN}`;
  }
  if (options.body) {
    headers["Content-Type"] = "application/json";
  }
  const resp = await fetch(`${SKILL_GRAPH_URL}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return (await resp.json()) as T;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const mcp = new Server(
  { name: "skill-graph", version: "1.0.0" },
  {
    capabilities: { tools: {} },
    instructions: `You are connected to the shared skill-graph knowledge base.
This stores technical knowledge shared between Claude Code peers.

Available tools:
- read_node: Read a knowledge node by name
- write_node: Create a new knowledge node
- update_node: Update an existing node (requires base_version for optimistic locking)
- delete_node: Delete a knowledge node
- list_nodes: List all nodes (metadata only)
- recent_nodes: Get recently updated nodes
- search_nodes: Full-text search across all nodes

Use Obsidian-compatible wikilinks [[node-name]] to connect related nodes.
Node names must be lowercase alphanumeric with hyphens/underscores (e.g. codex-sandbox-fix).`,
  }
);

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "read_node",
    description:
      "Read a knowledge node by name. Returns full content, tags, version, and metadata.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string" as const,
          description: "Node name (e.g. codex-sandbox-fix)",
        },
        format: {
          type: "string" as const,
          enum: ["json", "markdown"],
          description: "Output format. Default: json",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "write_node",
    description:
      "Create a new knowledge node. Use wikilinks [[name]] to connect related nodes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string" as const,
          description:
            "Node name (lowercase, alphanumeric, hyphens, underscores)",
        },
        content: {
          type: "string" as const,
          description: "Markdown content of the node",
        },
        type: {
          type: "string" as const,
          description:
            "Node type: knowledge, troubleshoot, workflow, config (default: knowledge)",
        },
        tags: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Tags for categorization",
        },
        contributor_name: {
          type: "string" as const,
          description: "Who is writing this node (e.g. jiro, taro)",
        },
      },
      required: ["name", "content"],
    },
  },
  {
    name: "update_node",
    description:
      "Update an existing node. Requires base_version for optimistic locking (get it from read_node).",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string" as const,
          description: "Node name to update",
        },
        content: {
          type: "string" as const,
          description: "New markdown content",
        },
        base_version: {
          type: "number" as const,
          description:
            "Current version number (from read_node). Required for conflict detection.",
        },
        type: {
          type: "string" as const,
          description: "New node type (optional)",
        },
        tags: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "New tags (optional)",
        },
        contributor_name: {
          type: "string" as const,
          description: "Who is updating (e.g. jiro, taro)",
        },
      },
      required: ["name", "content", "base_version"],
    },
  },
  {
    name: "delete_node",
    description: "Delete a knowledge node by name.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string" as const,
          description: "Node name to delete",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "list_nodes",
    description:
      "List all knowledge nodes (metadata only, no content). Supports type filter and pagination.",
    inputSchema: {
      type: "object" as const,
      properties: {
        type: {
          type: "string" as const,
          description: "Filter by node type (e.g. troubleshoot, workflow)",
        },
        limit: {
          type: "number" as const,
          description: "Max results (default 50, max 200)",
        },
        offset: {
          type: "number" as const,
          description: "Pagination offset (default 0)",
        },
      },
    },
  },
  {
    name: "recent_nodes",
    description: "Get the 20 most recently updated knowledge nodes.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "search_nodes",
    description:
      "Full-text search across all knowledge nodes. Returns matching nodes with snippets.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string" as const,
          description: "Search query (1-200 characters)",
        },
      },
      required: ["query"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  try {
    switch (name) {
      case "read_node": {
        const { name: nodeName, format } = args as {
          name: string;
          format?: string;
        };
        const qp = format === "markdown" ? "?format=markdown" : "";
        const result = await sgFetch<{
          ok: boolean;
          data: unknown;
          error?: string;
        }>(`/nodes/${encodeURIComponent(nodeName)}${qp}`);
        if (!result.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: result.error ?? "Node not found",
              },
            ],
            isError: true,
          };
        }
        const text =
          typeof result.data === "string"
            ? result.data
            : JSON.stringify(result.data, null, 2);
        return { content: [{ type: "text" as const, text }] };
      }

      case "write_node": {
        const {
          name: nodeName,
          content,
          type,
          tags,
          contributor_name,
        } = args as {
          name: string;
          content: string;
          type?: string;
          tags?: string[];
          contributor_name?: string;
        };
        const result = await sgFetch<{
          ok: boolean;
          data?: unknown;
          error?: string;
        }>("/nodes", {
          method: "POST",
          body: { name: nodeName, content, type, tags, contributor_name },
        });
        if (!result.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: result.error ?? "Failed to create node",
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Node "${nodeName}" created (version 1)`,
            },
          ],
        };
      }

      case "update_node": {
        const {
          name: nodeName,
          content,
          base_version,
          type,
          tags,
          contributor_name,
        } = args as {
          name: string;
          content: string;
          base_version: number;
          type?: string;
          tags?: string[];
          contributor_name?: string;
        };
        const result = await sgFetch<{
          ok: boolean;
          data?: { version: number };
          error?: string;
          current_version?: number;
        }>(`/nodes/${encodeURIComponent(nodeName)}`, {
          method: "PUT",
          body: { content, base_version, type, tags, contributor_name },
        });
        if (!result.ok) {
          if (result.current_version) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Version conflict. Your base: ${base_version}, current: ${result.current_version}. Re-read and retry.`,
                },
              ],
              isError: true,
            };
          }
          return {
            content: [
              {
                type: "text" as const,
                text: result.error ?? "Failed to update node",
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Node "${nodeName}" updated (version ${result.data?.version})`,
            },
          ],
        };
      }

      case "delete_node": {
        const { name: nodeName } = args as { name: string };
        const result = await sgFetch<{ ok: boolean; error?: string }>(
          `/nodes/${encodeURIComponent(nodeName)}`,
          { method: "DELETE" }
        );
        if (!result.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: result.error ?? "Failed to delete",
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Node "${nodeName}" deleted`,
            },
          ],
        };
      }

      case "list_nodes": {
        const { type, limit, offset } = args as {
          type?: string;
          limit?: number;
          offset?: number;
        };
        const params = new URLSearchParams();
        if (type) params.set("type", type);
        if (limit !== undefined) params.set("limit", String(limit));
        if (offset !== undefined) params.set("offset", String(offset));
        const qs = params.toString() ? `?${params.toString()}` : "";
        const result = await sgFetch<{
          ok: boolean;
          data: unknown[];
          total: number;
        }>(`/nodes${qs}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${result.total} node(s):\n\n${JSON.stringify(result.data, null, 2)}`,
            },
          ],
        };
      }

      case "recent_nodes": {
        const result = await sgFetch<{ ok: boolean; data: unknown[] }>(
          "/nodes/recent"
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `Recent nodes:\n\n${JSON.stringify(result.data, null, 2)}`,
            },
          ],
        };
      }

      case "search_nodes": {
        const { query } = args as { query: string };
        const result = await sgFetch<{ ok: boolean; data: unknown[] }>(
          `/search?q=${encodeURIComponent(query)}`
        );
        const count = result.data?.length ?? 0;
        if (count === 0) {
          return {
            content: [
              { type: "text" as const, text: `No results for "${query}"` },
            ],
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `${count} result(s) for "${query}":\n\n${JSON.stringify(result.data, null, 2)}`,
            },
          ],
        };
      }

      default:
        return {
          content: [
            { type: "text" as const, text: `Unknown tool: ${name}` },
          ],
          isError: true,
        };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await mcp.connect(transport);
console.error(
  `[skill-graph-mcp] connected url=${SKILL_GRAPH_URL} auth=${SKILL_GRAPH_TOKEN ? "enabled" : "disabled"}`
);
