/**
 * Typed D1 query helpers for every table.
 * All timestamps are Unix seconds (integer).
 */

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface UserRow {
  id: string;
  created_at: number;
}

export interface EmailIdentityRow {
  user_id: string;
  email: string;
  verified_at: number | null;
}

export interface AuthIdentityRow {
  provider: "email" | "google" | "github" | "digitalocean";
  provider_user_id: string;
  user_id: string;
  email_verified: number;
  created_at: number;
  updated_at: number;
  last_login_at: number;
}

export interface DOConnectionRow {
  user_id: string;
  access_token_enc: string;
  refresh_token_enc: string;
  token_key_version: number;
  team_uuid: string | null;
  expires_at: number;
  created_at: number;
  updated_at: number;
}

export interface VPSRow {
  id: string;
  user_id: string;
  droplet_id: number;
  region: string;
  size: string;
  ipv4: string | null;
  status: string;
  provisioning_deadline_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface GatewayRow {
  id: string;
  vps_id: string;
  auth_token_hash: string;
  version: string | null;
  last_seen_at: number | null;
  connected: number;
  created_at: number;
}

export interface SessionRow {
  id: string;
  user_id: string;
  vps_id: string;
  title: string;
  agent_type: string;
  workdir: string;
  status: string;
  created_at: number;
  last_activity_at: number | null;
}

export interface AuthorizedKeyRow {
  id: string;
  vps_id: string;
  fingerprint: string;
  public_key: string;
  label: string;
  key_type: string;
  expires_at: number | null;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export async function createUser(db: D1Database, id: string): Promise<void> {
  await db
    .prepare("INSERT INTO users (id, created_at) VALUES (?, ?)")
    .bind(id, nowSec())
    .run();
}

export async function getUser(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
}

export async function getEmailIdentityByEmail(
  db: D1Database,
  email: string,
): Promise<EmailIdentityRow | null> {
  return db
    .prepare("SELECT * FROM email_identities WHERE email = ?")
    .bind(email)
    .first<EmailIdentityRow>();
}

export async function upsertEmailIdentity(
  db: D1Database,
  row: EmailIdentityRow,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO email_identities (user_id, email, verified_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, email) DO UPDATE SET
         verified_at = COALESCE(email_identities.verified_at, excluded.verified_at)`,
    )
    .bind(row.user_id, row.email, row.verified_at)
    .run();
}

export async function getPrimaryEmailForUser(
  db: D1Database,
  userId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT email
       FROM email_identities
       WHERE user_id = ?
       ORDER BY verified_at DESC, email ASC
       LIMIT 1`,
    )
    .bind(userId)
    .first<{ email: string }>();
  return row?.email ?? null;
}

export async function getAuthIdentity(
  db: D1Database,
  provider: AuthIdentityRow["provider"],
  providerUserId: string,
): Promise<AuthIdentityRow | null> {
  return db
    .prepare("SELECT * FROM auth_identities WHERE provider = ? AND provider_user_id = ?")
    .bind(provider, providerUserId)
    .first<AuthIdentityRow>();
}

export async function upsertAuthIdentity(
  db: D1Database,
  row: AuthIdentityRow,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO auth_identities (provider, provider_user_id, user_id, email_verified, created_at, updated_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, provider_user_id) DO UPDATE SET
         email_verified = CASE
           WHEN auth_identities.email_verified = 1 THEN 1
           ELSE excluded.email_verified
         END,
         updated_at = excluded.updated_at,
         last_login_at = excluded.last_login_at`,
    )
    .bind(
      row.provider,
      row.provider_user_id,
      row.user_id,
      row.email_verified,
      row.created_at,
      row.updated_at,
      row.last_login_at,
    )
    .run();
}

export async function listAuthIdentitiesByUser(
  db: D1Database,
  userId: string,
): Promise<AuthIdentityRow[]> {
  const result = await db
    .prepare(
      "SELECT * FROM auth_identities WHERE user_id = ? ORDER BY provider ASC, created_at ASC",
    )
    .bind(userId)
    .all<AuthIdentityRow>();
  return result.results;
}

// ---------------------------------------------------------------------------
// DO Connections
// ---------------------------------------------------------------------------

export async function upsertDOConnection(
  db: D1Database,
  row: Omit<DOConnectionRow, "created_at" | "updated_at"> & { created_at?: number; updated_at?: number },
): Promise<void> {
  const now = nowSec();
  await db
    .prepare(
      `INSERT INTO do_connections (user_id, access_token_enc, refresh_token_enc, token_key_version, team_uuid, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         access_token_enc = excluded.access_token_enc,
         refresh_token_enc = excluded.refresh_token_enc,
         token_key_version = excluded.token_key_version,
         team_uuid = excluded.team_uuid,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`,
    )
    .bind(
      row.user_id,
      row.access_token_enc,
      row.refresh_token_enc,
      row.token_key_version,
      row.team_uuid ?? null,
      row.expires_at,
      row.created_at ?? now,
      row.updated_at ?? now,
    )
    .run();
}

export async function getDOConnection(
  db: D1Database,
  userId: string,
): Promise<DOConnectionRow | null> {
  return db
    .prepare("SELECT * FROM do_connections WHERE user_id = ?")
    .bind(userId)
    .first<DOConnectionRow>();
}

export async function deleteDOConnection(db: D1Database, userId: string): Promise<void> {
  await db.prepare("DELETE FROM do_connections WHERE user_id = ?").bind(userId).run();
}

// ---------------------------------------------------------------------------
// VPS
// ---------------------------------------------------------------------------

export async function createVPS(db: D1Database, row: VPSRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO vps (id, user_id, droplet_id, region, size, ipv4, status, provisioning_deadline_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.user_id,
      row.droplet_id,
      row.region,
      row.size,
      row.ipv4,
      row.status,
      row.provisioning_deadline_at,
      row.created_at,
      row.updated_at,
    )
    .run();
}

export async function getVPS(db: D1Database, id: string): Promise<VPSRow | null> {
  return db.prepare("SELECT * FROM vps WHERE id = ?").bind(id).first<VPSRow>();
}

export async function listVPSByUser(db: D1Database, userId: string): Promise<VPSRow[]> {
  const result = await db
    .prepare("SELECT * FROM vps WHERE user_id = ? ORDER BY created_at DESC")
    .bind(userId)
    .all<VPSRow>();
  return result.results;
}

export async function updateVPSStatus(
  db: D1Database,
  id: string,
  status: string,
): Promise<void> {
  await db
    .prepare("UPDATE vps SET status = ?, updated_at = ? WHERE id = ?")
    .bind(status, nowSec(), id)
    .run();
}

export async function updateVPSIpv4(
  db: D1Database,
  id: string,
  ipv4: string,
): Promise<void> {
  await db
    .prepare("UPDATE vps SET ipv4 = ?, updated_at = ? WHERE id = ?")
    .bind(ipv4, nowSec(), id)
    .run();
}

export async function deleteVPSCascade(db: D1Database, vpsId: string): Promise<void> {
  const batch = [
    db.prepare("DELETE FROM authorized_keys WHERE vps_id = ?").bind(vpsId),
    db.prepare("DELETE FROM sessions WHERE vps_id = ?").bind(vpsId),
    db.prepare("DELETE FROM gateways WHERE vps_id = ?").bind(vpsId),
    db.prepare("DELETE FROM vps WHERE id = ?").bind(vpsId),
  ];
  await db.batch(batch);
}

export async function listProvisioningTimedOut(db: D1Database): Promise<VPSRow[]> {
  const result = await db
    .prepare(
      `SELECT v.* FROM vps v
       WHERE v.status = 'provisioning'
         AND v.provisioning_deadline_at < ?`,
    )
    .bind(nowSec())
    .all<VPSRow>();
  return result.results;
}

export async function listDeletingVPS(db: D1Database): Promise<VPSRow[]> {
  const result = await db
    .prepare("SELECT * FROM vps WHERE status = 'deleting'")
    .all<VPSRow>();
  return result.results;
}

export async function listVPSMissingIPv4(db: D1Database): Promise<VPSRow[]> {
  const result = await db
    .prepare(
      `SELECT * FROM vps
       WHERE droplet_id > 0
         AND ipv4 IS NULL
         AND status IN ('provisioning', 'active', 'off', 'deleting')`,
    )
    .all<VPSRow>();
  return result.results;
}

// ---------------------------------------------------------------------------
// Gateways
// ---------------------------------------------------------------------------

export async function createGateway(db: D1Database, row: GatewayRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO gateways (id, vps_id, auth_token_hash, version, last_seen_at, connected, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.vps_id,
      row.auth_token_hash,
      row.version,
      row.last_seen_at,
      row.connected,
      row.created_at,
    )
    .run();
}

export async function getGateway(db: D1Database, id: string): Promise<GatewayRow | null> {
  return db.prepare("SELECT * FROM gateways WHERE id = ?").bind(id).first<GatewayRow>();
}

export async function getGatewayByVPS(
  db: D1Database,
  vpsId: string,
): Promise<GatewayRow | null> {
  return db
    .prepare("SELECT * FROM gateways WHERE vps_id = ?")
    .bind(vpsId)
    .first<GatewayRow>();
}

export async function updateGatewayConnected(
  db: D1Database,
  id: string,
  connected: boolean,
): Promise<void> {
  await db
    .prepare("UPDATE gateways SET connected = ?, last_seen_at = ? WHERE id = ?")
    .bind(connected ? 1 : 0, nowSec(), id)
    .run();
}

export async function updateGatewayVersion(
  db: D1Database,
  id: string,
  version: string,
): Promise<void> {
  await db
    .prepare("UPDATE gateways SET version = ? WHERE id = ?")
    .bind(version, id)
    .run();
}

export async function updateGatewayLastSeen(db: D1Database, id: string): Promise<void> {
  await db
    .prepare("UPDATE gateways SET last_seen_at = ? WHERE id = ?")
    .bind(nowSec(), id)
    .run();
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function createSession(db: D1Database, row: SessionRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sessions (id, user_id, vps_id, title, agent_type, workdir, status, created_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.user_id,
      row.vps_id,
      row.title,
      row.agent_type,
      row.workdir,
      row.status,
      row.created_at,
      row.last_activity_at,
    )
    .run();
}

export async function getSession(db: D1Database, id: string): Promise<SessionRow | null> {
  return db.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
}

export async function listSessionsByVPS(
  db: D1Database,
  vpsId: string,
): Promise<SessionRow[]> {
  const result = await db
    .prepare("SELECT * FROM sessions WHERE vps_id = ? ORDER BY created_at DESC")
    .bind(vpsId)
    .all<SessionRow>();
  return result.results;
}

export async function updateSessionStatus(
  db: D1Database,
  id: string,
  status: string,
): Promise<void> {
  await db
    .prepare("UPDATE sessions SET status = ?, last_activity_at = ? WHERE id = ?")
    .bind(status, nowSec(), id)
    .run();
}

export async function deleteSession(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
}

// ---------------------------------------------------------------------------
// Authorized Keys
// ---------------------------------------------------------------------------

export async function createAuthorizedKey(
  db: D1Database,
  row: AuthorizedKeyRow,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO authorized_keys (id, vps_id, fingerprint, public_key, label, key_type, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.vps_id,
      row.fingerprint,
      row.public_key,
      row.label,
      row.key_type,
      row.expires_at,
      row.created_at,
    )
    .run();
}

export async function listAuthorizedKeys(
  db: D1Database,
  vpsId: string,
): Promise<AuthorizedKeyRow[]> {
  const result = await db
    .prepare("SELECT * FROM authorized_keys WHERE vps_id = ? ORDER BY created_at DESC")
    .bind(vpsId)
    .all<AuthorizedKeyRow>();
  return result.results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
