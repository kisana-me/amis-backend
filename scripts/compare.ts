// 本体の Rails と Worker に同じリクエストを送り、JSON の違いを出す。
// 先に `npm run db:import:local` で本体と同じデータを D1 に入れ、Rails と `wrangler dev` を動かしておく。
//
//   COMPARE_TOKEN=<セッショントークン> node scripts/compare.ts [パス[:JSON本文]] ...
//   パスを省くと、決まった一式 (status、キャラの一覧と全件の詳細など) を比べる
//
// 意図して変えたところ (廃止した項目、画像の置き場所、分けたり統合したりしたエンドポイント) は、比べる前にそろえる
export {};

const RAILS = process.env.RAILS_URL ?? "http://localhost:3001";
const WORKER = process.env.WORKER_URL ?? "http://localhost:8787";
const TOKEN = process.env.COMPARE_TOKEN ?? "";
const workerHeaders: Record<string, string> = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
// 画像の公開 URL。キーは同じで、バケット (配る場所) だけが違う
const RAILS_MEDIA = process.env.RAILS_MEDIA_URL ?? "http://localhost:9000/amiverse/";
const WORKER_MEDIA = process.env.WORKER_MEDIA_URL ?? `${WORKER}/v1/amis/media/`;

type Json = unknown;

// Rails は Bearer でも CSRF トークンを求めるので、/start でトークンとセッション cookie をもらう。
// /start は呼ぶたびにその日の訪問を記録する (ログインボーナスが付く) ので、1 回だけ呼ぶ
async function railsSession(): Promise<{ headers: Record<string, string>; nameId: string | null }> {
  const cookie = TOKEN ? `amiverse=${TOKEN}` : "";
  const res = await fetch(`${RAILS}/v1/start`, { headers: cookie ? { Cookie: cookie } : {} });
  const { csrf_token, account } = (await res.json()) as { csrf_token: string; account?: { name_id?: string } };
  const session = res.headers.getSetCookie().map((c) => c.split(";")[0]).filter((c) => c.startsWith("_amiverse="));
  return {
    headers: { Cookie: [cookie, ...session].filter(Boolean).join("; "), "X-CSRF-Token": csrf_token },
    nameId: account?.name_id ?? null,
  };
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
  if (path === "/status" && isObject(json) && "quota" in json) {
    const { queue_position: _q, ...rest } = json;
    const quota = json.quota as Record<string, unknown> | undefined;
    return {
      ...rest,
      // コイン・無料枠・ボーナスは廃止。週の利用率だけを残す
      quota: quota ? { weekly_usage_percent: quota.weekly_usage_percent } : quota,
      models: (json.models as Record<string, unknown>[] | undefined)?.map(({ coin_cost: _c, ...m }) => m),
    };
  }
  // 結末 (エンディング) は廃止
  if (/^\/plots\/[^/]+$/.test(path) && isObject(json) && isObject(json.plot)) {
    const { endings: _e, collected_count: _c, ...plot } = json.plot;
    return { ...json, plot };
  }
  if (/^\/plots\/[^/]+\/edit$/.test(path) && isObject(json) && isObject(json.plot)) {
    const chapters = (json.plot.chapters as Record<string, unknown>[]).map(({ endings: _e, ...chapter }) => chapter);
    return { ...json, plot: { ...json.plot, chapters } };
  }
  // Worker のチャットはメッセージを新しい側の 30 件だけ返す (前は /chats/:aid/history で遡る)
  if (/^\/chats\/[^/]+$/.test(path) && isObject(json) && Array.isArray(json.messages)) {
    json = { ...json, messages: json.messages.slice(-30) };
  }
  // チャットの結末とコイン・無料枠も廃止
  if (path.startsWith("/chats") && isObject(json)) {
    const chat = ({ ending_key: _k, ending_title: _t, ...rest }: Record<string, unknown>) => rest;
    const quota = json.quota as Record<string, unknown> | undefined;
    return {
      ...json,
      ...(isObject(json.chat) ? { chat: chat(json.chat) } : {}),
      ...(Array.isArray(json.chats) ? { chats: json.chats.map((x) => chat(x as Record<string, unknown>)) } : {}),
      ...(quota ? { quota: { weekly_usage_percent: quota.weekly_usage_percent } } : {}),
    };
  }
  if (path.startsWith("/accounts/") && isObject(json) && "achievements" in json) {
    return { ...json, achievements: [] };
  }
  return json;
}

function normalizeWorker(json: Json): Json {
  // Amis の画像は Amis のバケットに同じキーで置く (移行時に R2 でコピーする)
  return walk(json, (v) => (typeof v === "string" ? v.replace(WORKER_MEDIA, RAILS_MEDIA) : v));
}

// Rails のリクエストを、Worker で同じ結果になる呼び方にする。分けたり統合したりしたエンドポイントは組み立て直す
async function postWorker(path: string, body: Json): Promise<{ status: number; json: Json }> {
  const call = (p: string, b: Json = {}) => post(WORKER, p, b, workerHeaders);
  const params = isObject(body) ? body : {};
  // 自分のもの (非公開も) と、ほかの人の選べるもの。Worker は 2 回に分けて引き、自分のものを除く
  const selectable = async (p: string, key: string, filter: Record<string, unknown>) => {
    const [mine, others] = await Promise.all([call(p, { ...params, ...filter, author: "me", sort: "new", limit: 100 }), call(p, { ...params, ...filter, limit: 100 })]);
    if (mine.status !== 200) return mine;
    const rows = (r: typeof mine) => (isObject(r.json) ? (r.json[key] as { mine?: boolean }[]) : []);
    return { status: others.status, json: { status: "success", mine: rows(mine), others: rows(others).filter((x) => !x.mine) } };
  };
  switch (path) {
    case "/status": {
      const [quota, models] = await Promise.all([call("/quota"), call("/models", params)]);
      if (quota.status !== 200) return quota;
      return { status: models.status, json: { status: "success", ...(quota.json as object), ...(models.json as object) } };
    }
    case "/home":
      return call("/plots", { sort: params.tab ?? "popular", limit: 20 });
    case "/lores":
      return call("/lores", { author: "me", sort: "new" });
    case "/characters/selectable":
      return selectable("/characters", "characters", { castable: true, include: ["images"] });
    case "/lores/selectable":
      return selectable("/lores", "lores", { attachable: true });
    default: {
      const res = await call(path, body);
      // 遡るためのカーソルは Worker にだけある
      if (/^\/chats\/[^/]+$/.test(path) && isObject(res.json)) {
        const { older_messages_cursor: _c, ...rest } = res.json;
        return { ...res, json: rest };
      }
      return res;
    }
  }
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

const { headers: railsHeaders, nameId: myNameId } = await railsSession();

const aidsOf = (json: Json, key: string) =>
  isObject(json) && Array.isArray(json[key]) ? (json[key] as { aid: string }[]).map((x) => x.aid) : [];

async function defaultTargets(): Promise<[string, Json][]> {
  const get = async (path: string, body: Json = {}) => (await post(RAILS, path, body, railsHeaders)).json;
  const characterAids = aidsOf(await get("/characters"), "characters");
  const plotAids = aidsOf(await get("/plots"), "plots");

  // キャラの詳細に出てくるプロットで、/status のモデルの選び方も比べる
  const castPlotAids = new Set<string>();
  const authorNameIds = new Set<string>();
  for (const aid of characterAids) {
    const detail = (await get(`/characters/${aid}`)) as Record<string, any>;
    for (const plot of [...(detail.lead_plots ?? []), ...(detail.cast_plots ?? [])]) castPlotAids.add(plot.aid);
    if (detail.character?.author?.name_id) authorNameIds.add(detail.character.author.name_id);
  }

  // 自分のアカウントのページには非公開のものも出るので、編集画面の対象をここから集める
  const mine = myNameId ? await get(`/accounts/@${myNameId}`) : null;
  const myLores = TOKEN ? aidsOf(await get("/lores"), "lores") : [];
  const selectableLores = TOKEN ? (await get("/lores/selectable")) as Record<string, { aid: string }[]> : {};

  const chatAids = TOKEN
    ? [...aidsOf(await get("/chats"), "chats"), ...aidsOf(await get("/chats", { tab: "archived" }), "chats")]
    : [];

  const signedIn: [string, Json][] = TOKEN
    ? [
      ["/chats", {}],
      ["/chats", { tab: "archived" }],
      ...chatAids.map((aid): [string, Json] => [`/chats/${aid}`, {}]),
      ...chatAids.map((aid): [string, Json] => [`/chats/${aid}/palette`, {}]),
      ["/personas", {}],
      ["/my/likes/plots", {}],
      ["/my/likes/characters", {}],
      ["/characters/selectable", {}],
      ["/lores", {}],
      ["/lores/selectable", {}],
      ...aidsOf(mine, "plots").map((aid): [string, Json] => [`/plots/${aid}/edit`, {}]),
      ...aidsOf(mine, "characters").map((aid): [string, Json] => [`/characters/${aid}/edit`, {}]),
    ]
    : [];

  return [
    ["/status", {}],
    ...[...castPlotAids].map((aid): [string, Json] => ["/status", { plot_aid: aid }]),
    ["/home", {}],
    ["/home", { tab: "new" }],
    ["/home", { tab: "trending" }],
    ["/characters", {}],
    ...characterAids.map((aid): [string, Json] => [`/characters/${aid}`, {}]),
    ...characterAids.map((aid): [string, Json] => ["/cards", { type: "character", aid }]),
    ["/plots", {}],
    ...plotAids.map((aid): [string, Json] => [`/plots/${aid}`, {}]),
    ...plotAids.map((aid): [string, Json] => ["/cards", { type: "plot", aid }]),
    ...[myNameId, ...authorNameIds].filter(Boolean).map((nameId): [string, Json] => [`/accounts/@${nameId}`, {}]),
    ...[...new Set([...myLores, ...(selectableLores.others ?? []).map((l) => l.aid)])].map((aid): [string, Json] => [`/lores/${aid}`, {}]),
    ...signedIn,
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
  const [rails, worker] = await Promise.all([post(RAILS, path, body, railsHeaders), postWorker(path, body)]);
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
