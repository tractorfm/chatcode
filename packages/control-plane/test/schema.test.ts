import { describe, expect, it } from "vitest";
import { getGatewayByVPS, listGatewaysByVPSIds } from "../src/db/schema.js";

type PreparedResult = {
  first?: unknown;
  all?: { results: unknown[] };
  run?: unknown;
};

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function makeDB(resultsBySql: Record<string, PreparedResult>): D1Database {
  const normalizedEntries = new Map(
    Object.entries(resultsBySql).map(([sql, result]) => [normalizeSql(sql), result] as const),
  );
  return {
    prepare(sql: string) {
      const result = normalizedEntries.get(normalizeSql(sql));
      if (!result) {
        throw new Error(`unexpected SQL: ${sql}`);
      }
      return {
        bind: () => ({
          first: async () => result.first ?? null,
          all: async () => result.all ?? { results: [] },
          run: async () => result.run ?? {},
        }),
      };
    },
  } as unknown as D1Database;
}

describe("db/schema gateway selection", () => {
  it("prefers the connected gateway row for a VPS", async () => {
    const db = makeDB({
      [`SELECT * FROM gateways
       WHERE vps_id = ?
       ORDER BY connected DESC, COALESCE(last_seen_at, -1) DESC, created_at DESC, id DESC
       LIMIT 1`]: {
        first: {
          id: "gw-live",
          vps_id: "vps-1",
          auth_token_hash: "hash-live",
          version: "v0.1.8",
          host_os: "linux",
          last_seen_at: 20,
          connected: 1,
          created_at: 20,
        },
      },
    });

    await expect(getGatewayByVPS(db, "vps-1")).resolves.toMatchObject({
      id: "gw-live",
      version: "v0.1.8",
      connected: 1,
    });
  });

  it("prefers the most recent gateway row per VPS when listing", async () => {
    const db = makeDB({
      "SELECT * FROM gateways WHERE vps_id IN (?, ?)": {
        all: {
          results: [
            {
              id: "gw-1-old",
              vps_id: "vps-1",
              auth_token_hash: "hash-1-old",
              version: "v0.1.6",
              host_os: "linux",
              last_seen_at: 100,
              connected: 1,
              created_at: 100,
            },
            {
              id: "gw-1-new",
              vps_id: "vps-1",
              auth_token_hash: "hash-1-new",
              version: "v0.1.8",
              host_os: "linux",
              last_seen_at: 200,
              connected: 1,
              created_at: 200,
            },
            {
              id: "gw-2-live",
              vps_id: "vps-2",
              auth_token_hash: "hash-2-live",
              version: "v0.1.7",
              host_os: "linux",
              last_seen_at: 150,
              connected: 1,
              created_at: 150,
            },
            {
              id: "gw-2-stale",
              vps_id: "vps-2",
              auth_token_hash: "hash-2-stale",
              version: "v0.1.5",
              host_os: "linux",
              last_seen_at: 300,
              connected: 0,
              created_at: 300,
            },
          ],
        },
      },
    });

    await expect(listGatewaysByVPSIds(db, ["vps-1", "vps-2"])).resolves.toMatchObject({
      "vps-1": { id: "gw-1-new", version: "v0.1.8", connected: 1 },
      "vps-2": { id: "gw-2-live", version: "v0.1.7", connected: 1 },
    });
  });
});
