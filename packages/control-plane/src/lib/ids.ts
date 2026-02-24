import { nanoid } from "nanoid";

/** Generate a prefixed nano ID. */
export function newId(prefix: string, size = 21): string {
  return `${prefix}-${nanoid(size)}`;
}

export const newUserId = () => newId("usr");
export const newVPSId = () => newId("vps");
export const newGatewayId = () => newId("gw");
export const newSessionId = () => newId("ses");
export const newKeyId = () => newId("key");

/** Generate a random hex string (for auth tokens, nonces). */
export function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
