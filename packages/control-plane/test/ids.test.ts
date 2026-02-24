import { describe, it, expect } from "vitest";
import { newUserId, newVPSId, newGatewayId, newSessionId, newKeyId, randomHex } from "../src/lib/ids";

describe("id generation", () => {
  it("generates prefixed IDs", () => {
    expect(newUserId()).toMatch(/^usr-/);
    expect(newVPSId()).toMatch(/^vps-/);
    expect(newGatewayId()).toMatch(/^gw-/);
    expect(newSessionId()).toMatch(/^ses-/);
    expect(newKeyId()).toMatch(/^key-/);
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => newUserId()));
    expect(ids.size).toBe(100);
  });

  it("generates hex strings of correct length", () => {
    const hex16 = randomHex(16);
    expect(hex16).toMatch(/^[0-9a-f]{32}$/);

    const hex32 = randomHex(32);
    expect(hex32).toMatch(/^[0-9a-f]{64}$/);
  });
});
