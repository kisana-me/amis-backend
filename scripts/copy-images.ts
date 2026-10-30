// import-from-main.ts が書いた <出力先>.images.txt (1 行に 1 つのキー) の画像を、
// 本体のバケットから Amis のバケットへ同じキーでコピーする。
//
//   ローカル:  node --env-file=../amiverse/.env scripts/copy-images.ts --local <一覧.txt>
//   本番:      AMIS_BUCKET=amis-media node --env-file=<本体の本番の設定> scripts/copy-images.ts <一覧.txt>
//
// コピー元は本体と同じ環境変数で決める (S3_API_ENDPOINT / S3_USERNAME / S3_PASSWORD / S3_REGION / S3_BUCKET)。
// R2 では S3_API_ENDPOINT に https://<アカウント ID>.r2.cloudflarestorage.com、S3_REGION に auto を使う。
// コピー先は、--local なら wrangler dev のローカルの R2 (.wrangler/state)、そうでなければ同じ接続先の AMIS_BUCKET。
// --local のときは wrangler dev を止めておく (ローカルの R2 を同時に開かないように)
//
// 同じキーへの上書きになるだけなので、何度流してもよい。コピー元がないものは最後にまとめて出す
import { readFileSync } from "node:fs";
import { AwsClient } from "aws4fetch";
import { getPlatformProxy } from "wrangler";

const local = process.argv.includes("--local");
const list = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
if (!list) throw new Error("コピーする一覧 (.images.txt) を指定してください");

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} を指定してください`);
  return value;
};
const endpoint = env("S3_API_ENDPOINT").replace(/\/+$/, "");
const sourceBucket = env("S3_BUCKET");
const client = new AwsClient({
  accessKeyId: env("S3_USERNAME"),
  secretAccessKey: env("S3_PASSWORD"),
  region: process.env.S3_REGION || "auto",
  service: "s3",
});
// キーは "/" を残してパーツごとにエンコードする (パス形式でバケットを指す)
const objectUrl = (bucket: string, key: string) => `${endpoint}/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;

type Put = (key: string, body: ArrayBuffer, contentType: string) => Promise<void>;

async function localTarget(): Promise<{ put: Put; label: string; close: () => Promise<void> }> {
  const proxy = await getPlatformProxy<{ MEDIA: R2Bucket }>();
  return {
    put: async (key, body, contentType) => void (await proxy.env.MEDIA.put(key, body, { httpMetadata: { contentType } })),
    label: "ローカルの R2",
    close: () => proxy.dispose(),
  };
}

function remoteTarget(): { put: Put; label: string; close: () => Promise<void> } {
  const bucket = env("AMIS_BUCKET");
  if (bucket === sourceBucket) throw new Error("AMIS_BUCKET が本体のバケットと同じです");
  return {
    put: async (key, body, contentType) => {
      const res = await client.fetch(objectUrl(bucket, key), { method: "PUT", body, headers: { "Content-Type": contentType } });
      if (!res.ok) throw new Error(`${key} を ${bucket} に置けませんでした: ${res.status} ${await res.text()}`);
    },
    label: bucket,
    close: async () => undefined,
  };
}

const keys = readFileSync(list, "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
const target = local ? await localTarget() : remoteTarget();

async function copy(key: string): Promise<"copied" | "missing"> {
  const res = await client.fetch(objectUrl(sourceBucket, key));
  if (res.status === 404) return "missing";
  if (!res.ok) throw new Error(`${key} を ${sourceBucket} から読めませんでした: ${res.status} ${await res.text()}`);
  await target.put(key, await res.arrayBuffer(), res.headers.get("Content-Type") ?? "image/webp");
  return "copied";
}

// 同時に投げる数。R2 のレート制限に当たらない程度にしておく
const CONCURRENCY = 8;
const missing: string[] = [];
let copied = 0;
let next = 0;
try {
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < keys.length) {
      const key = keys[next++];
      if ((await copy(key)) === "copied") copied += 1;
      else missing.push(key);
    }
  }));
} finally {
  await target.close();
}

console.log(`${sourceBucket} → ${target.label}: ${copied} copied, ${missing.length} missing`);
for (const key of missing) console.log(`  missing: ${key}`);
