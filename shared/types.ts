// Unique ID for each Claude Code instance (generated on registration)
export type PeerId = string;

export interface Peer {
  id: PeerId;
  pid: number;
  cwd: string;
  git_root: string | null;
  git_remote_url: string;
  tty: string | null;
  summary: string;
  machine_id: string;
  machine_name: string;
  remote_addr: string;
  // instance_key is DB-internal only; NOT included in Peer responses
  registered_at: string; // ISO timestamp
  last_seen: string; // ISO timestamp
}

export interface Message {
  id: number;
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  sent_at: string; // ISO timestamp
  delivered: boolean;
}

// --- Broker API types ---

export interface RegisterRequest {
  pid: number;
  cwd: string;
  git_root: string | null;
  git_remote_url?: string;
  tty: string | null;
  summary: string;
  machine_id?: string;
  machine_name?: string;
  instance_key?: string; // Client session key for upsert
}

export interface RegisterResponse {
  id: PeerId;
}

export interface HeartbeatRequest {
  id: PeerId;
}

export interface SetSummaryRequest {
  id: PeerId;
  summary: string;
}

export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo" | "network";
  cwd: string;
  git_root: string | null;
  git_remote_url?: string;
  machine_id?: string;
  exclude_id?: PeerId;
}

export interface SendMessageRequest {
  from_id: PeerId;
  to_id: PeerId;
  text: string;
}

export interface PollMessagesRequest {
  id: PeerId;
}

export interface PollMessagesResponse {
  messages: Message[];
}
