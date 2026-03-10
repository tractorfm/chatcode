import { describe, expect, it } from "vitest";
import { handleStagingTestPage, parseChecksumEntry } from "../src/routes/staging";
import type { Env } from "../src/types";

describe("routes/staging", () => {
  it("returns 404 outside staging/dev", async () => {
    const res = handleStagingTestPage(new Request("https://cp.example.test/staging/test"), {
      APP_ENV: "prod",
    } as unknown as Env);

    expect(res.status).toBe(404);
  });

  it("renders terminal script with arrow-key fallback and reconnect handlers", async () => {
    const res = handleStagingTestPage(new Request("https://cp.example.test/staging/test"), {
      APP_ENV: "staging",
      GATEWAY_VERSION: "v0.0.11",
    } as unknown as Env);

    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain("attachCustomKeyEventHandler");
    expect(html).toContain("ArrowUp");
    expect(html).toContain("sendInputData(seq)");

    expect(html).toContain('socket.addEventListener("close"');
    expect(html).toContain('setTerminalStatus("disconnected")');
    expect(html).toContain("gateway-update-target");
    expect(html).toContain("update-gateway");
    expect(html).toContain("rename-session");
    expect(html).toContain("v0.0.11");
  });

  it("parses a checksum entry by filename", () => {
    const checksums = [
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  chatcode-gateway-linux-amd64",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  checksums.txt",
    ].join("\n");

    expect(parseChecksumEntry(checksums, "chatcode-gateway-linux-amd64")).toBe(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(parseChecksumEntry(checksums, "missing")).toBeNull();
  });
});
