import type { Bindings } from "../env";

export type UrlEnv = Pick<Bindings, "S3_PUBLIC_ENDPOINT" | "BACK_URL">;

// 本体の full_url と同じく、本体のホストにある静的な画像を指す
export function staticImageUrl(env: UrlEnv, file: "amiverse-logo.webp" | "amiverse-1.webp"): string {
  return new URL(`/static_assets/images/${file}`, env.BACK_URL).toString();
}

// 本体の object_url と同じく、公開バケットのオブジェクトを指す
export function objectUrl(env: UrlEnv, key: string): string {
  return joinUrl(env.S3_PUBLIC_ENDPOINT, key);
}

// Ruby の File.join と同じく、間の "/" を 1 つにそろえる
function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
