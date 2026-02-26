import type { AuthIdentityRow } from "../db/schema.js";
import {
  createUser,
  getAuthIdentity,
  getEmailIdentityByEmail,
  getUser,
  upsertAuthIdentity,
  upsertEmailIdentity,
} from "../db/schema.js";
import { newUserId } from "./ids.js";
import { normalizeEmail } from "./auth.js";

export class IdentityConflictError extends Error {
  constructor(message = "identity_conflict") {
    super(message);
    this.name = "IdentityConflictError";
  }
}

export class InvalidEmailError extends Error {
  constructor(message = "invalid_email") {
    super(message);
    this.name = "InvalidEmailError";
  }
}

interface ResolveIdentityInput {
  provider: AuthIdentityRow["provider"];
  providerUserId: string;
  email: string;
  emailVerified: boolean;
  expectedUserId?: string;
}

interface ResolveIdentityResult {
  userId: string;
  email: string;
  created: boolean;
}

export async function resolveOrCreateUserByIdentity(
  db: D1Database,
  input: ResolveIdentityInput,
): Promise<ResolveIdentityResult> {
  const email = normalizeEmail(input.email);
  if (!email || !looksLikeEmail(email)) {
    throw new InvalidEmailError();
  }

  const providerUserId = input.providerUserId.trim();
  if (!providerUserId) {
    throw new IdentityConflictError("invalid_provider_user_id");
  }

  const providerIdentity = await getAuthIdentity(db, input.provider, providerUserId);
  const emailIdentity = await getEmailIdentityByEmail(db, email);

  let userId: string;
  let created = false;

  if (input.expectedUserId) {
    const expected = input.expectedUserId;
    const user = await getUser(db, expected);
    if (!user) {
      throw new IdentityConflictError("expected_user_not_found");
    }
    if (providerIdentity && providerIdentity.user_id !== expected) {
      throw new IdentityConflictError();
    }
    if (emailIdentity && emailIdentity.user_id !== expected) {
      throw new IdentityConflictError();
    }
    userId = expected;
  } else {
    if (providerIdentity && emailIdentity && providerIdentity.user_id !== emailIdentity.user_id) {
      throw new IdentityConflictError();
    }

    if (providerIdentity) {
      userId = providerIdentity.user_id;
    } else if (emailIdentity) {
      userId = emailIdentity.user_id;
    } else {
      userId = newUserId();
      await createUser(db, userId);
      created = true;
    }
  }

  const now = nowSec();
  await upsertEmailIdentity(db, {
    user_id: userId,
    email,
    verified_at: input.emailVerified ? now : null,
  });

  await upsertAuthIdentity(db, {
    provider: input.provider,
    provider_user_id: providerUserId,
    user_id: userId,
    email_verified: input.emailVerified ? 1 : 0,
    created_at: now,
    updated_at: now,
    last_login_at: now,
  });

  return { userId, email, created };
}

function looksLikeEmail(value: string): boolean {
  if (value.length < 3 || value.length > 320) return false;
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return false;
  const domain = value.slice(at + 1);
  return domain.includes(".");
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
