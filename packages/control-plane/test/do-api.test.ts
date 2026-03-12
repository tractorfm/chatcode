import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createDroplet } from "../src/lib/do-api";

describe("do-api createDroplet", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("retries transient failures and eventually succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("temporary", { status: 502 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            droplet: {
              id: 123,
              name: "chatcode-test",
              status: "new",
              networks: { v4: [] },
              region: { slug: "ams3" },
              size_slug: "s-2vcpu-2gb",
            },
          }),
          { status: 202, headers: { "Content-Type": "application/json" } },
        ),
      );
    global.fetch = fetchMock as typeof fetch;

    const droplet = await createDroplet("token", {
      name: "chatcode-test",
      region: "ams3",
      size: "s-2vcpu-2gb",
      image: "ubuntu-24-04-x64",
      user_data: "#!/bin/bash",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(droplet.id).toBe(123);
  });

  it("does not retry non-transient failures", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));
    global.fetch = fetchMock as typeof fetch;

    await expect(
      createDroplet("token", {
        name: "chatcode-test",
        region: "ams3",
        size: "s-2vcpu-2gb",
        image: "ubuntu-24-04-x64",
        user_data: "#!/bin/bash",
      }),
    ).rejects.toThrow("DO create droplet failed: 400 bad request");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
