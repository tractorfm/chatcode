/**
 * @chatcode/protocol – TypeScript types for the gateway ↔ control plane protocol.
 *
 * Hand-written to match packages/protocol/schema/commands.json and events.json.
 * Add codegen when schemas stabilize.
 */

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

export interface BaseCommand {
  type: string;
  schema_version: string;
  request_id: string;
}

export interface Ack {
  type: "ack";
  schema_version: string;
  request_id: string;
  ok: boolean;
  error?: string;
}

export interface BaseEvent {
  type: string;
  schema_version: string;
}

// ---------------------------------------------------------------------------
// Commands: control plane → gateway (JSON text frames)
// ---------------------------------------------------------------------------

export interface SessionCreate extends BaseCommand {
  type: "session.create";
  session_id: string;
  name: string;
  workdir: string;
  agent?: "claude-code" | "codex" | "gemini" | "none";
  agent_config?: {
    claude_md?: string;
    agents_md?: string;
  };
  env?: Record<string, string>;
}

export interface SessionInput extends BaseCommand {
  type: "session.input";
  session_id: string;
  /** Base64-encoded input bytes */
  data: string;
}

export interface SessionResize extends BaseCommand {
  type: "session.resize";
  session_id: string;
  cols: number;
  rows: number;
}

export interface SessionEnd extends BaseCommand {
  type: "session.end";
  session_id: string;
}

export interface SessionAck extends BaseCommand {
  type: "session.ack";
  session_id: string;
  seq: number;
}

export interface SessionSnapshot extends BaseCommand {
  type: "session.snapshot";
  session_id: string;
}

export interface SSHAuthorize extends BaseCommand {
  type: "ssh.authorize";
  public_key: string;
  label: string;
  /** RFC 3339; omit for permanent key */
  expires_at?: string;
}

export interface SSHRevoke extends BaseCommand {
  type: "ssh.revoke";
  fingerprint: string;
}

export interface SSHList extends BaseCommand {
  type: "ssh.list";
}

export interface FileUploadBegin extends BaseCommand {
  type: "file.upload.begin";
  transfer_id: string;
  dest_path: string;
  size: number;
  total_chunks: number;
}

export interface FileUploadChunk extends BaseCommand {
  type: "file.upload.chunk";
  transfer_id: string;
  seq: number;
  /** Base64-encoded chunk bytes */
  data: string;
}

export interface FileUploadEnd extends BaseCommand {
  type: "file.upload.end";
  transfer_id: string;
}

export interface FileDownload extends BaseCommand {
  type: "file.download";
  transfer_id: string;
  path: string;
}

export interface FileCancel extends BaseCommand {
  type: "file.cancel";
  transfer_id: string;
}

export interface AgentsInstall extends BaseCommand {
  type: "agents.install";
  agent: "claude-code" | "codex" | "gemini";
}

export interface GatewayUpdate extends BaseCommand {
  type: "gateway.update";
  url: string;
  sha256: string;
  version: string;
}

export type Command =
  | SessionCreate
  | SessionInput
  | SessionResize
  | SessionEnd
  | SessionAck
  | SessionSnapshot
  | SSHAuthorize
  | SSHRevoke
  | SSHList
  | FileUploadBegin
  | FileUploadChunk
  | FileUploadEnd
  | FileDownload
  | FileCancel
  | AgentsInstall
  | GatewayUpdate;

// ---------------------------------------------------------------------------
// Events: gateway → control plane (JSON text frames)
// ---------------------------------------------------------------------------

export interface GatewayHello extends BaseEvent {
  type: "gateway.hello";
  gateway_id: string;
  version: string;
  hostname: string;
  go_version?: string;
  bootstrap_token?: string;
  system_info: SystemInfo;
}

export interface SystemInfo {
  os: string;
  arch: string;
  cpus: number;
  ram_total_bytes: number;
  disk_total_bytes: number;
}

export interface ActiveSession {
  session_id: string;
  last_activity_at: string;
}

export interface GatewayHealth extends BaseEvent {
  type: "gateway.health";
  gateway_id: string;
  timestamp: string;
  cpu_percent?: number;
  ram_used_bytes?: number;
  ram_total_bytes?: number;
  disk_used_bytes?: number;
  disk_total_bytes?: number;
  uptime_seconds?: number;
  active_sessions: ActiveSession[];
}

export interface SessionStarted extends BaseEvent {
  type: "session.started";
  request_id: string;
  session_id: string;
  pid?: number;
}

export interface SessionEnded extends BaseEvent {
  type: "session.ended";
  session_id: string;
  exit_code?: number;
}

export interface SessionError extends BaseEvent {
  type: "session.error";
  session_id: string;
  error: string;
}

export interface SessionSnapshotEvent extends BaseEvent {
  type: "session.snapshot";
  request_id?: string;
  session_id: string;
  content: string;
  cols?: number;
  rows?: number;
}

export interface SSHKey {
  fingerprint: string;
  label: string;
  algorithm: string;
  added_at?: string;
  expires_at?: string;
}

export interface SSHKeyList extends BaseEvent {
  type: "ssh.keys";
  request_id: string;
  keys: SSHKey[];
}

export interface FileContentBegin extends BaseEvent {
  type: "file.content.begin";
  transfer_id: string;
  path: string;
  size: number;
  total_chunks: number;
}

export interface FileContentChunk extends BaseEvent {
  type: "file.content.chunk";
  transfer_id: string;
  seq: number;
  /** Base64-encoded chunk bytes */
  data: string;
}

export interface FileContentEnd extends BaseEvent {
  type: "file.content.end";
  transfer_id: string;
}

export interface AgentInstalled extends BaseEvent {
  type: "agent.installed";
  request_id: string;
  agent: string;
  version?: string;
}

export interface GatewayUpdated extends BaseEvent {
  type: "gateway.updated";
  request_id: string;
  version: string;
}

export type Event =
  | Ack
  | GatewayHello
  | GatewayHealth
  | SessionStarted
  | SessionEnded
  | SessionError
  | SessionSnapshotEvent
  | SSHKeyList
  | FileContentBegin
  | FileContentChunk
  | FileContentEnd
  | AgentInstalled
  | GatewayUpdated;

// ---------------------------------------------------------------------------
// Binary frames (terminal output)
// ---------------------------------------------------------------------------

/**
 * Encodes a terminal output binary frame.
 * Layout: [kind:1][session_id_len:1][session_id:N][seq:8][payload:M]
 */
export function encodeTerminalFrame(
  sessionId: string,
  seq: bigint,
  payload: Uint8Array
): Uint8Array {
  const sessionIdBytes = new TextEncoder().encode(sessionId);
  const buf = new Uint8Array(1 + 1 + sessionIdBytes.length + 8 + payload.length);
  const view = new DataView(buf.buffer);
  let offset = 0;
  buf[offset++] = 0x01; // kind: terminal_output
  buf[offset++] = sessionIdBytes.length;
  buf.set(sessionIdBytes, offset);
  offset += sessionIdBytes.length;
  view.setBigUint64(offset, seq, false); // big-endian
  offset += 8;
  buf.set(payload, offset);
  return buf;
}

/**
 * Decodes a terminal output binary frame.
 */
export function decodeTerminalFrame(buf: Uint8Array): {
  kind: number;
  sessionId: string;
  seq: bigint;
  payload: Uint8Array;
} | null {
  if (buf.length < 2) return null;
  const kind = buf[0];
  const sessionIdLen = buf[1];
  if (buf.length < 2 + sessionIdLen + 8) return null;
  const sessionId = new TextDecoder().decode(buf.slice(2, 2 + sessionIdLen));
  const view = new DataView(buf.buffer, buf.byteOffset);
  const seq = view.getBigUint64(2 + sessionIdLen, false);
  const payload = buf.slice(2 + sessionIdLen + 8);
  return { kind, sessionId, seq, payload };
}
