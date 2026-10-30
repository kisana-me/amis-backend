import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { ctx } from "./helpers";

const get = (path: string, serve?: string) =>
  createApp().request(`/v1/amis/media/${path}`, {}, { ...env, SERVE_LOCAL_MEDIA: serve }, ctx);

describe("GET /media/*", () => {
  it("SERVE_LOCAL_MEDIA が true のときだけ、ローカルの R2 から配る", async () => {
    await env.MEDIA.put("images/variants/abc.webp", "webp", { httpMetadata: { contentType: "image/webp" } });

    const res = await get("images/variants/abc.webp", "true");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    expect(await res.text()).toBe("webp");

    expect((await get("images/variants/none.webp", "true")).status).toBe(404);
    expect((await get("images/variants/abc.webp")).status).toBe(404);
  });
});
