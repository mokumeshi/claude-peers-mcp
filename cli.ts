#!/usr/bin/env bun
/**
 * claude-peers CLI
 *
 * Utility commands for managing the broker and inspecting peers.
 * PLAN_cross_machine.md v11 compliant.
 */

import type { Peer } from "./shared/types.ts";
import { isLoopback, sanitizeForDisplay } from "./shared/net.ts";

// --- Configuration ---

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL =
  process.env.CLAUDE_PEERS_BROKER ?? `http://127.0.0.1:${BROKER_PORT}`;
const AUTH_TOKEN = process.env.CLAUDE_PEERS_TOKEN ?? null;

// --- Broker communication ---

async function brokerFetch<T>(path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (AUTH_TOKEN) {
    headers["Authorization"] = `Bearer ${AUTH_TOKEN}`;
  }
  const opts: RequestInit = body
    ? {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    : { headers };
  const res = await fetch(`${BROKER_URL}${path}`, {
    ...opts,
    signal: AbortSignal.timeout(5000),
  });
  if (res.status === 401) {
    throw new Error("Authentication failed. Check CLAUDE_PEERS_TOKEN.");
  }
  if (!res.ok) {
    throw new Error(`${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

// --- Peer display ---

function renderPeer(p: Peer): void {
  const machine = sanitizeForDisplay(p.machine_name || "?");
  console.log(
    `  ${p.id}  Machine:${machine}  PID:${p.pid}  ${sanitizeForDisplay(p.cwd)}`
  );
  if (p.summary)
    console.log(`         ${sanitizeForDisplay(p.summary)}`);
  if (p.git_remote_url)
    console.log(`         Repo: ${sanitizeForDisplay(p.git_remote_url)}`);
  console.log(`         Last seen: ${p.last_seen}`);
}

// --- Auth guard ---

try {
  const url = new URL(BROKER_URL);
  if (!isLoopback(url.hostname) && !AUTH_TOKEN) {
    console.error(
      `Remote broker requires CLAUDE_PEERS_TOKEN: ${sanitizeForDisplay(BROKER_URL)}`
    );
    process.exit(1);
  }
} catch {
  // URL parse failure — let individual commands fail with a better message
}

// --- Command dispatch ---

const cmd = process.argv[2];

switch (cmd) {
  case "status": {
    try {
      const health = await brokerFetch<{
        status: string;
        peers: number;
        schema_version?: number;
      }>("/health");
      console.log(
        `Broker: ${sanitizeForDisplay(health.status)} (${health.peers} peer(s) registered)`
      );
      console.log(`URL: ${sanitizeForDisplay(BROKER_URL)}`);
      if (health.schema_version !== undefined) {
        console.log(`Schema: v${health.schema_version}`);
      }

      if (health.peers > 0) {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope: "machine",
          cwd: process.cwd(),
          git_root: null,
        });
        console.log("\nPeers:");
        for (const p of peers) {
          renderPeer(p);
          console.log("");
        }
      }
    } catch (error) {
      console.log(
        `Broker is not running or unreachable: ${
          error instanceof Error
            ? sanitizeForDisplay(error.message)
            : String(error)
        }`
      );
    }
    break;
  }

  case "peers": {
    try {
      const peers = await brokerFetch<Peer[]>("/list-peers", {
        scope: "machine",
        cwd: process.cwd(),
        git_root: null,
      });
      if (peers.length === 0) {
        console.log("No peers registered.");
      } else {
        for (const p of peers) {
          renderPeer(p);
          console.log("");
        }
      }
    } catch (error) {
      console.log(
        `Broker is not running or unreachable: ${
          error instanceof Error
            ? sanitizeForDisplay(error.message)
            : String(error)
        }`
      );
    }
    break;
  }

  case "network": {
    try {
      const peers = await brokerFetch<Peer[]>("/list-peers", {
        scope: "network",
        cwd: "/",
        git_root: null,
      });
      if (peers.length === 0) {
        console.log("No peers on the network.");
      } else {
        const byMachine = new Map<string, Peer[]>();
        for (const p of peers) {
          const key = sanitizeForDisplay(
            p.machine_name || p.machine_id?.slice(0, 8) || "unknown"
          );
          if (!byMachine.has(key)) byMachine.set(key, []);
          byMachine.get(key)!.push(p);
        }
        for (const [machine, machinePeers] of byMachine) {
          console.log(`\n[${machine}]`);
          for (const p of machinePeers) {
            console.log(`  ${p.id}  ${sanitizeForDisplay(p.cwd)}`);
            if (p.summary)
              console.log(`         ${sanitizeForDisplay(p.summary)}`);
          }
        }
      }
    } catch (e) {
      console.error(
        `Error: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    break;
  }

  case "send": {
    const toId = process.argv[3];
    const msg = process.argv.slice(4).join(" ");
    if (!toId || !msg) {
      console.error("Usage: bun cli.ts send <peer-id> <message>");
      process.exit(1);
    }
    try {
      const result = await brokerFetch<{ ok: boolean; error?: string }>(
        "/send-message",
        {
          from_id: "cli",
          to_id: toId,
          text: msg,
        }
      );
      if (result.ok) {
        console.log(`Message sent to ${sanitizeForDisplay(toId)}`);
      } else {
        console.error(
          `Failed: ${sanitizeForDisplay(result.error ?? "unknown error")}`
        );
      }
    } catch (error) {
      console.error(
        `Error: ${
          error instanceof Error
            ? sanitizeForDisplay(error.message)
            : String(error)
        }`
      );
    }
    break;
  }

  case "kill-broker": {
    // Refuse to kill remote brokers
    try {
      const url = new URL(BROKER_URL);
      if (!isLoopback(url.hostname)) {
        console.error(
          "ERROR: Cannot kill a remote broker. Run this command on the broker machine."
        );
        process.exit(1);
      }
    } catch {
      // URL parse failure — proceed and let the fetch fail
    }

    try {
      const health = await brokerFetch<{ status: string; peers: number }>(
        "/health"
      );
      console.log(`Broker has ${health.peers} peer(s). Shutting down...`);

      // Cross-platform: find PIDs listening on the broker port and kill them
      const isWindows = process.platform === "win32";
      if (isWindows) {
        // Windows: netstat to find listening PIDs, then taskkill
        const proc = Bun.spawnSync([
          "cmd",
          "/c",
          `for /f "tokens=5" %a in ('netstat -ano ^| findstr :${BROKER_PORT} ^| findstr LISTENING') do @echo %a`,
        ]);
        const pids = new TextDecoder()
          .decode(proc.stdout)
          .trim()
          .split("\n")
          .filter((p) => p && p.trim() !== "0");
        for (const pid of pids) {
          Bun.spawnSync(["taskkill", "/PID", pid.trim(), "/F"]);
        }
      } else {
        // macOS/Linux: lsof
        const proc = Bun.spawnSync(["lsof", "-ti", `:${BROKER_PORT}`]);
        const pids = new TextDecoder()
          .decode(proc.stdout)
          .trim()
          .split("\n")
          .filter((p) => p);
        for (const pid of pids) {
          process.kill(parseInt(pid), "SIGTERM");
        }
      }
      console.log("Broker stopped.");
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  default:
    console.log(`claude-peers CLI

Usage:
  bun cli.ts status          Show broker status and local peers
  bun cli.ts peers           List local machine peers
  bun cli.ts network         List all peers across all machines
  bun cli.ts send <id> <msg> Send a message to a peer
  bun cli.ts kill-broker     Stop the local broker daemon`);
}
