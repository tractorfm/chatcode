/**
 * AES-256-GCM encryption/decryption for DigitalOcean OAuth tokens.
 *
 * Tokens are stored in D1 as base64(iv || ciphertext).
 * The KEK (key encryption key) is a 256-bit key stored as a Wrangler secret.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Import a base64-encoded AES-256-GCM key. */
export async function importKEK(base64Key: string): Promise<CryptoKey> {
  const raw = base64ToBytes(base64Key);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Encrypt a plaintext token → base64(iv || ciphertext). */
export async function encryptToken(
  plaintext: string,
  kek: CryptoKey,
): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    kek,
    encoder.encode(plaintext),
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return bytesToBase64(combined);
}

/** Decrypt base64(iv || ciphertext) → plaintext token. */
export async function decryptToken(
  stored: string,
  kek: CryptoKey,
): Promise<string> {
  const buf = base64ToBytes(stored);
  const iv = buf.slice(0, 12);
  const ct = buf.slice(12);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    kek,
    ct,
  );
  return decoder.decode(plaintext);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
