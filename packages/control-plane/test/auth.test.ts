import { describe, it, expect } from "vitest";
import {
  signSessionCookie,
  verifySessionCookie,
  hashGatewayToken,
  verifyGatewayToken,
  authenticateRequest,
} from "../src/lib/auth";

describe("session cookie", () => {
  const secret = "test-jwt-secret-for-unit-tests";

  it("signs and verifies a session cookie", async () => {
    const userId = "usr-test123";
    const token = await signSessionCookie(userId, secret);
    const result = await verifySessionCookie(token, secret);
    expect(result).toBe(userId);
  });

  it("rejects tampered cookie", async () => {
    const token = await signSessionCookie("usr-test123", secret);
    const tampered = token.slice(0, -4) + "XXXX";
    const result = await verifySessionCookie(tampered, secret);
    expect(result).toBeNull();
  });

  it("rejects cookie with wrong secret", async () => {
    const token = await signSessionCookie("usr-test123", secret);
    const result = await verifySessionCookie(token, "wrong-secret");
    expect(result).toBeNull();
  });

  it("rejects malformed cookie (no dot)", async () => {
    const result = await verifySessionCookie("nodothere", secret);
    expect(result).toBeNull();
  });
});

describe("gateway token HMAC", () => {
  const salt = "test-gateway-salt";

  it("hashes and verifies a gateway token", async () => {
    const token = "abc123def456";
    const hash = await hashGatewayToken(token, salt);
    const valid = await verifyGatewayToken(token, hash, salt);
    expect(valid).toBe(true);
  });

  it("rejects wrong token", async () => {
    const hash = await hashGatewayToken("correct-token", salt);
    const valid = await verifyGatewayToken("wrong-token", hash, salt);
    expect(valid).toBe(false);
  });

  it("produces deterministic hashes", async () => {
    const token = "deterministic-test";
    const hash1 = await hashGatewayToken(token, salt);
    const hash2 = await hashGatewayToken(token, salt);
    expect(hash1).toBe(hash2);
  });

  it("produces different hashes for different salts", async () => {
    const token = "same-token";
    const hash1 = await hashGatewayToken(token, "salt1");
    const hash2 = await hashGatewayToken(token, "salt2");
    expect(hash1).not.toBe(hash2);
  });
});

describe("dev header auth", () => {
  const baseEnv = {
    AUTH_MODE: "dev",
    JWT_SECRET: "jwt",
    DEV_AUTH_SECRET: undefined,
  } as const;

  it("accepts X-Dev-User when no dev secret is configured", async () => {
    const req = new Request("https://example.com", {
      headers: { "X-Dev-User": "usr-dev-1" },
    });
    const result = await authenticateRequest(req, baseEnv as unknown as any);
    expect(result).toEqual({ userId: "usr-dev-1" });
  });

  it("rejects X-Dev-User when dev secret is configured but missing", async () => {
    const req = new Request("https://example.com", {
      headers: { "X-Dev-User": "usr-dev-1" },
    });
    const result = await authenticateRequest(
      req,
      { ...baseEnv, DEV_AUTH_SECRET: "secret-1" } as unknown as any,
    );
    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      expect(result.status).toBe(401);
    }
  });

  it("accepts X-Dev-User when X-Dev-Secret matches", async () => {
    const req = new Request("https://example.com", {
      headers: {
        "X-Dev-User": "usr-dev-1",
        "X-Dev-Secret": "secret-1",
      },
    });
    const result = await authenticateRequest(
      req,
      { ...baseEnv, DEV_AUTH_SECRET: "secret-1" } as unknown as any,
    );
    expect(result).toEqual({ userId: "usr-dev-1" });
  });
});
