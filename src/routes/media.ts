import { Hono } from "hono";
import type { AppEnv } from "../env";
import { notFound } from "../lib/http";

export const mediaRoutes = new Hono<AppEnv>();

// wrangler dev のローカルの R2 には公開の URL がないので、開発中だけ Worker から画像を配る。
// .dev.vars で SERVE_LOCAL_MEDIA=true と AMIS_MEDIA_URL=http://localhost:8787/v1/amis/media を指定する。
// 本番は公開バケットのドメインから直接配るので、ここは 404 を返すだけ
mediaRoutes.get("/media/:key{.+}", async (c) => {
  if (c.env.SERVE_LOCAL_MEDIA !== "true") return notFound(c, "見つかりませんでした");
  const object = await c.env.MEDIA.get(c.req.param("key"));
  if (!object) return notFound(c, "画像が見つかりませんでした");
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  return new Response(object.body, { headers });
});
