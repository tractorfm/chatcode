import { describe, it, expect } from "vitest";
import { importKEK, encryptToken, decryptToken } from "../src/lib/do-tokens";

describe("do-tokens AES-GCM", () => {
  // Generate a test key (base64 of 32 random bytes)
  async function testKEK(): Promise<{ key: CryptoKey; b64: string }> {
    const raw = new Uint8Array(32);
    crypto.getRandomValues(raw);
    let binary = "";
    for (const b of raw) binary += String.fromCharCode(b);
    const b64 = btoa(binary);
    const key = await importKEK(b64);
    return { key, b64 };
  }

  it("encrypts and decrypts a token round-trip", async () => {
    const { key } = await testKEK();
    const plaintext = "dop_v1_abc123_test_token_value";
    const encrypted = await encryptToken(plaintext, key);
    const decrypted = await decryptToken(encrypted, key);
    expect(decrypted).toBe(plaintext);
  });

  it("produces different ciphertext for same plaintext (random IV)", async () => {
    const { key } = await testKEK();
    const plaintext = "same_token";
    const enc1 = await encryptToken(plaintext, key);
    const enc2 = await encryptToken(plaintext, key);
    expect(enc1).not.toBe(enc2);
    // But both decrypt to same value
    expect(await decryptToken(enc1, key)).toBe(plaintext);
    expect(await decryptToken(enc2, key)).toBe(plaintext);
  });

  it("fails to decrypt with wrong key", async () => {
    const { key: key1 } = await testKEK();
    const { key: key2 } = await testKEK();
    const encrypted = await encryptToken("secret", key1);
    await expect(decryptToken(encrypted, key2)).rejects.toThrow();
  });

  it("handles empty string", async () => {
    const { key } = await testKEK();
    const encrypted = await encryptToken("", key);
    const decrypted = await decryptToken(encrypted, key);
    expect(decrypted).toBe("");
  });

  it("handles unicode", async () => {
    const { key } = await testKEK();
    const plaintext = "token-with-unicode-\u{1F600}-\u{1F4BB}";
    const encrypted = await encryptToken(plaintext, key);
    const decrypted = await decryptToken(encrypted, key);
    expect(decrypted).toBe(plaintext);
  });
});
