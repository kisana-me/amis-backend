// 本体の Rails と Worker に同じリクエストを送り、JSON の違いを出す。
// 先に `npm run db:import:local` で本体と同じデータを D1 に入れ、Rails と `wrangler dev` を動かしておく。
//
//   COMPARE_TOKEN=<セッショントークン> node scripts/compare.ts [パス[:JSON本文]] ...
//   パスを省くと、決まった一式 (status、キャラの一覧と全件の詳細など) を比べる
//
// 意図して変えたところ (廃止した項目、画像の置き場所) は、比べる前にそろえる
export {};

const RAILS = process.env.RAILS_URL ?? "http://localhost:3001";
const WORKER = process.env.WORKER_URL ?? "http://localhost:8787";
const TOKEN = process.env.COMPARE_TOKEN ?? "";

type Json = unknown;

// Rails は Bearer でも CSRF トークンを求めるので、/start でトークンとセッション cookie をもらう。
// /start は呼ぶたびにその日の訪問を記録する (ログインボーナスが付く) ので、1 回だけ呼ぶ
async function railsSession(): Promise<Record<string, string>> {
  const cookie = TOKEN ? `amiverse=${TOKEN}` : "";
  const res = await fetch(`${RAILS}/v1/start`, { headers: cookie ? { Cookie: cookie } : {} });
  const { csrf_token } = (await res.json()) as { csrf_token: string };
  const session = res.headers.getSetCookie().map((c) => c.split(";")[0]).filter((c) => c.startsWith("_amiverse="));
  return { Cookie: [cookie, ...session].filter(Boolean).join("; "), "X-CSRF-Token": csrf_token };
}

async function post(base: string, path: string, body: Json, headers: Record<string, string>) {
  const res = await fetch(`${base}/v1/amis${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) as Json };
  } catch {
    return { status: res.status, json: text as Json };
  }
}

// --- 意図した違いをそろえる ---------------------------------------------------

function normalizeRails(path: string, json: Json): Json {
  if (path === "/status" && isObject(json)) {
    const quota = json.quota as Record<string, unknown> | undefined;
    return {
      ...json,
      // コイン・無料枠・ボーナスは廃止。週の利用率だけを残す
      quota: quota ? { weekly_usage_percent: quota.weekly_usage_percent } : quota,
      models: (json.models as Record<string, unknown>[] | undefined)?.map(({ coin_cost: _c, ...m }) => m),
    };
  }
  return json;
}

function normalizeWorker(json: Json): Json {
  // Amis の画像は amis/ の下に置く (移行時に R2 でコピーする)
  return walk(json, (v) => (typeof v === "string" ? v.replace("/amis/images/variants/", "/images/variants/") : v));
}

// --- 比べる -------------------------------------------------------------------

function isObject(v: Json): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function walk(v: Json, f: (v: Json) => Json): Json {
  if (Array.isArray(v)) return v.map((x) => walk(x, f));
  if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, f)]));
  return f(v);
}

function diff(a: Json, b: Json, path = "", out: string[] = []): string[] {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path} の件数: rails=${a.length} worker=${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${path}[${i}]`, out);
  } else if (isObject(a) && isObject(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(key in b)) out.push(`${path}.${key}: worker にない`);
      else if (!(key in a)) out.push(`${path}.${key}: rails にない`);
      else diff(a[key], b[key], `${path}.${key}`, out);
    }
  } else if (JSON.stringify(a) !== JSON.stringify(b)) {
    out.push(`${path}: rails=${JSON.stringify(a)?.slice(0, 120)} worker=${JSON.stringify(b)?.slice(0, 120)}`);
  }
  return out;
}

// --- 比べるリクエスト ---------------------------------------------------------

const railsHeaders = await railsSession();
const workerHeaders: Record<string, string> = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

async function defaultTargets(): Promise<[string, Json][]> {
  const characters = await post(RAILS, "/characters", {}, railsHeaders);
  const aids = isObject(characters.json) ? (characters.json.characters as { aid: string }[]).map((c) => c.aid) : [];
  // キャラの詳細に出てくるプロットで、/status のモデルの選び方も比べる
  const plotAids = new Set<string>();
  for (const aid of aids) {
    const detail = (await post(RAILS, `/characters/${aid}`, {}, railsHeaders)).json as Record<string, { aid: string }[]>;
    for (const plot of [...(detail.lead_plots ?? []), ...(detail.cast_plots ?? [])]) plotAids.add(plot.aid);
  }
  return [
    ["/status", {}],
    ...[...plotAids].map((aid): [string, Json] => ["/status", { plot_aid: aid }]),
    ["/characters", {}],
    ...aids.map((aid): [string, Json] => [`/characters/${aid}`, {}]),
  ];
}

const targets: [string, Json][] = process.argv.length > 2
  ? process.argv.slice(2).map((arg) => {
    const i = arg.indexOf(":");
    return i < 0 ? [arg, {}] : [arg.slice(0, i), JSON.parse(arg.slice(i + 1))];
  })
  : await defaultTargets();

let failed = 0;
for (const [path, body] of targets) {
  const [rails, worker] = await Promise.all([post(RAILS, path, body, railsHeaders), post(WORKER, path, body, workerHeaders)]);
  const differences = rails.status !== worker.status
    ? [`status: rails=${rails.status} worker=${worker.status}`]
    : diff(normalizeRails(path, rails.json), normalizeWorker(worker.json));
  const label = body && isObject(body) && Object.keys(body).length > 0 ? `${path} ${JSON.stringify(body)}` : path;
  if (differences.length === 0) {
    console.log(`✓ ${label}`);
    continue;
  }
  failed++;
  console.log(`✗ ${label}`);
  for (const d of differences.slice(0, 20)) console.log(`    ${d}`);
  if (differences.length > 20) console.log(`    ...ほか ${differences.length - 20} 件`);
}
console.log(`\n${targets.length - failed} / ${targets.length} 件が一致`);
process.exitCode = failed > 0 ? 1 : 0;
