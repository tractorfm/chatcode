import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveOrCreateUserByIdentity,
  IdentityConflictError,
} from "../src/lib/identity";

type Provider = "email" | "google" | "github" | "digitalocean";

interface User {
  id: string;
  created_at: number;
}

interface EmailIdentity {
  user_id: string;
  email: string;
  verified_at: number | null;
}

interface AuthIdentity {
  provider: Provider;
  provider_user_id: string;
  user_id: string;
  email_verified: number;
  created_at: number;
  updated_at: number;
  last_login_at: number;
}

const state = vi.hoisted(() => ({
  users: new Map<string, User>(),
  emails: new Map<string, EmailIdentity>(),
  providers: new Map<string, AuthIdentity>(),
  seq: 1,
}));

function providerKey(provider: Provider, providerUserId: string): string {
  return `${provider}:${providerUserId}`;
}

vi.mock("../src/db/schema.js", () => ({
  createUser: vi.fn(async (_db: D1Database, id: string) => {
    state.users.set(id, { id, created_at: 1 });
  }),
  getUser: vi.fn(async (_db: D1Database, id: string) => state.users.get(id) ?? null),
  getEmailIdentityByEmail: vi.fn(async (_db: D1Database, email: string) => state.emails.get(email) ?? null),
  getAuthIdentity: vi.fn(async (_db: D1Database, provider: Provider, providerUserId: string) => {
    return state.providers.get(providerKey(provider, providerUserId)) ?? null;
  }),
  upsertEmailIdentity: vi.fn(async (_db: D1Database, row: EmailIdentity) => {
    const existing = state.emails.get(row.email);
    if (existing && existing.user_id !== row.user_id) {
      throw new Error("UNIQUE constraint failed: email_identities.email");
    }
    if (existing) {
      state.emails.set(row.email, {
        ...existing,
        verified_at: existing.verified_at ?? row.verified_at,
      });
      return;
    }
    state.emails.set(row.email, row);
  }),
  upsertAuthIdentity: vi.fn(async (_db: D1Database, row: AuthIdentity) => {
    state.providers.set(providerKey(row.provider, row.provider_user_id), row);
  }),
}));

vi.mock("../src/lib/ids.js", () => ({
  newUserId: vi.fn(() => `usr-test-${state.seq++}`),
}));

describe("identity linking", () => {
  beforeEach(() => {
    state.users.clear();
    state.emails.clear();
    state.providers.clear();
    state.seq = 1;
  });

  it("creates a new user for first email sign-in", async () => {
    const result = await resolveOrCreateUserByIdentity({} as D1Database, {
      provider: "email",
      providerUserId: "user@example.test",
      email: "User@Example.test",
      emailVerified: true,
    });

    expect(result.userId).toBe("usr-test-1");
    expect(result.email).toBe("user@example.test");
    expect(result.created).toBe(true);
  });

  it("links different providers to same user when emails match", async () => {
    const first = await resolveOrCreateUserByIdentity({} as D1Database, {
      provider: "email",
      providerUserId: "user@example.test",
      email: "user@example.test",
      emailVerified: true,
    });

    const second = await resolveOrCreateUserByIdentity({} as D1Database, {
      provider: "google",
      providerUserId: "google-sub-1",
      email: "USER@example.test",
      emailVerified: true,
    });

    expect(first.userId).toBe(second.userId);
    expect(second.created).toBe(false);
  });

  it("fails with identity conflict when provider and email resolve to different users", async () => {
    state.users.set("usr-a", { id: "usr-a", created_at: 1 });
    state.users.set("usr-b", { id: "usr-b", created_at: 1 });
    state.emails.set("user@example.test", {
      user_id: "usr-a",
      email: "user@example.test",
      verified_at: 1,
    });
    state.providers.set(providerKey("google", "sub-1"), {
      provider: "google",
      provider_user_id: "sub-1",
      user_id: "usr-b",
      email_verified: 1,
      created_at: 1,
      updated_at: 1,
      last_login_at: 1,
    });

    await expect(
      resolveOrCreateUserByIdentity({} as D1Database, {
        provider: "google",
        providerUserId: "sub-1",
        email: "user@example.test",
        emailVerified: true,
      }),
    ).rejects.toBeInstanceOf(IdentityConflictError);
  });

  it("fails with identity conflict when expected user does not own email", async () => {
    state.users.set("usr-a", { id: "usr-a", created_at: 1 });
    state.users.set("usr-b", { id: "usr-b", created_at: 1 });
    state.emails.set("user@example.test", {
      user_id: "usr-a",
      email: "user@example.test",
      verified_at: 1,
    });

    await expect(
      resolveOrCreateUserByIdentity({} as D1Database, {
        provider: "digitalocean",
        providerUserId: "do-1",
        email: "user@example.test",
        emailVerified: true,
        expectedUserId: "usr-b",
      }),
    ).rejects.toBeInstanceOf(IdentityConflictError);
  });
});
