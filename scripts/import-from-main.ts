// 本体の MariaDB の amis_* / ai_* を、D1 に流し込む SQL に変換する。
// 開発中は本体と Worker のレスポンスを突き合わせるため、本番の切り替えでは移行に使う。
//
//   node scripts/import-from-main.ts <出力先.sql>
//   接続先は MAIN_DATABASE_URL (既定はローカルの compose の MariaDB)
//
// ローカルの D1 に入れるときは `npm run db:import:local` (D1 を作り直してから流す)。
// wrangler dev は先に止めておく (動いたまま D1 のファイルを作り直すと、開発サーバーが D1 を開けなくなる)
//
// - id は本体と同じ値を使う。参照をそのまま保てて、突き合わせもしやすい
// - 本体の DATETIME はタイムゾーンなしの JST なので、epoch ミリ秒に直す
// - 廃止したもの (ゲストのチャット、章、結末、コイン) は持ってこない。完結したチャットは普通のチャットに戻し、章ごとの要約は普通の要約にする
// - 通報は持ってこない (Amis で受け付けた分から始める)
// - チャットとメッセージ、AI の利用記録は多いので、id の順に区切って読み、読んだそばから書く (全件をメモリに載せない)
// - 画像は Amis から参照されているものだけを持ってくる。R2 のファイルは別にコピーする。
//   コピーするキーの一覧を <出力先>.images.txt に書くので、scripts/copy-images.ts に渡す
import { closeSync, openSync, writeFileSync, writeSync } from "node:fs";
import { createConnection } from "mysql2/promise";

type Row = Record<string, unknown>;
type Value = string | number | boolean | null | Date | undefined;

const url = process.env.MAIN_DATABASE_URL ?? "mysql://root:mdbroot@127.0.0.1:3306/amiverse_development";
const out = process.argv[2];
if (!out) throw new Error("出力先の .sql を指定してください");

const conn = await createConnection({ uri: url, timezone: "+09:00", dateStrings: false, supportBigNumbers: true, bigNumberStrings: false });
const select = async (sql: string, params: unknown[] = []) => (await conn.query(sql, params))[0] as Row[];

const fd = openSync(out, "w");
let statementCount = 0;
// テーブルごとに書いた行数 (確かめるときに D1 の count(*) と比べる)
const counts = new Map<string, number>();
// D1 は 1 文が 100KB まで。INSERT の頭の分を残しておく
const MAX_STATEMENT_BYTES = 90_000;

function literal(value: Value): string {
  if (value === null || value === undefined) return "NULL";
  if (value instanceof Date) return String(value.getTime());
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return String(value);
  return `'${value.replaceAll("'", "''")}'`;
}

function insert(table: string, rows: Record<string, Value>[]) {
  counts.set(table, (counts.get(table) ?? 0) + rows.length);
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0]);
  const head = `INSERT INTO ${table} (${columns.join(", ")}) VALUES\n`;
  // D1 は 1 文が 100KB まで。チャットの本文が長いので、行数ではなく大きさで区切る
  let values: string[] = [];
  let size = 0;
  const flush = () => {
    if (values.length === 0) return;
    writeSync(fd, `${head}${values.join(",\n")};\n\n`);
    statementCount += 1;
    values = [];
    size = 0;
  };
  for (const row of rows) {
    const value = `(${columns.map((c) => literal(row[c])).join(", ")})`;
    const bytes = Buffer.byteLength(value);
    if (bytes > MAX_STATEMENT_BYTES) throw new Error(`${table} の 1 行が ${bytes} バイトあり、D1 の 1 文の上限を超えます`);
    if (size + bytes > MAX_STATEMENT_BYTES) flush();
    values.push(value);
    size += bytes;
  }
  flush();
}

const bool = (v: unknown) => Boolean(Number(v));
// mysql2 は MariaDB の JSON カラムをパースして返す。文字列で来たときもそのまま通す
const json = (v: unknown, fallback: string) => {
  if (v === null || v === undefined || v === "") return fallback;
  return typeof v === "string" ? v : JSON.stringify(v);
};
const ratings = (r: Row) => ({ user_rating: r.user_rating as number, auto_rating: r.auto_rating as number | null, mod_rating: r.mod_rating as number | null });
const stamps = (r: Row) => ({ created_at: r.created_at as Date, updated_at: r.updated_at as Date });

// --- 本体側の行を読む -------------------------------------------------------

const characters = await select("SELECT * FROM amis_characters ORDER BY id");
const plots = await select("SELECT * FROM amis_plots ORDER BY id");
const plotCharacters = await select("SELECT * FROM amis_plot_characters ORDER BY id");
const characterImages = await select("SELECT * FROM amis_character_images ORDER BY id");
const plotImages = await select("SELECT * FROM amis_plot_images ORDER BY id");
const lores = await select("SELECT * FROM amis_lores ORDER BY id");
const loreEntries = await select("SELECT * FROM amis_lore_entries ORDER BY id");
const plotLores = await select("SELECT * FROM amis_plot_lores ORDER BY id");
const personas = await select("SELECT * FROM amis_personas ORDER BY id");
const characterLikes = await select("SELECT * FROM amis_character_likes ORDER BY id");
const plotLikes = await select("SELECT * FROM amis_plot_likes ORDER BY id");
const aiModels = await select("SELECT * FROM ai_models ORDER BY id");

// 大きいテーブルを id の順に BATCH 行ずつ読む。sql は WHERE まで書き、読む表の別名を t にする
const BATCH = 2000;
async function eachBatch(sql: string, write: (rows: Row[]) => void) {
  for (let after = 0; ;) {
    const rows = await select(`${sql} AND t.id > ? ORDER BY t.id LIMIT ${BATCH}`, [after]);
    if (rows.length === 0) return;
    write(rows);
    after = rows.at(-1)!.id as number;
  }
}

const imageIds = new Set<unknown>([
  ...characters.map((r) => r.icon_id), ...plots.map((r) => r.icon_id), ...personas.map((r) => r.icon_id),
  ...characterImages.map((r) => r.image_id), ...plotImages.map((r) => r.image_id),
].filter((id) => id !== null));
const images = imageIds.size === 0 ? [] : await select("SELECT * FROM images WHERE id IN (?) ORDER BY id", [[...imageIds]]);
const existingImages = new Set(images.map((i) => i.id));
// 消えた画像を指していたら参照を外す (D1 は外部キーを確かめる)
const imageRef = (id: unknown) => (existingImages.has(id) ? (id as number) : null);

// --- D1 の形に直して書く (外部キーの向きに合わせた順番) ----------------------

insert("images", images.map((r) => ({
  id: r.id as number, aid: r.aid as string, account_id: r.account_id as number | null,
  name: r.name as string, description: r.description as string,
  // 元の画像は持ってこない (Amis は表示用の WebP しか置かない)
  original_key: null,
  original_ext: null,
  variant_type: r.variant_type as string | null,
  status: r.status as number, visibility: r.visibility as number, ...ratings(r),
  meta: json(r.meta, "{}"), ...stamps(r),
})));

insert("ai_models", aiModels.map((r) => ({
  id: r.id as number, aid: r.aid as string, name: r.name as string, description: r.description as string,
  provider: r.provider as string, upstream_model: r.upstream_model as string,
  api: r.api as number, route: r.route as number, tier: r.tier as number, status: r.status as number,
  max_rating: r.max_rating as number, context_window: r.context_window as number, max_output_tokens: r.max_output_tokens as number,
  input_price_micro: Number(r.input_price_micro), cached_input_price_micro: Number(r.cached_input_price_micro),
  output_price_micro: Number(r.output_price_micro), position: r.position as number,
  request_params: json(r.request_params, "{}"), meta: json(r.meta, "{}"), ...stamps(r),
})));

insert("characters", characters.map((r) => ({
  id: r.id as number, aid: r.aid as string, author_id: r.author_id as number | null, icon_id: imageRef(r.icon_id),
  name: r.name as string, tagline: r.tagline as string, description: r.description as string, persona: r.persona as string,
  persona_public: bool(r.persona_public), allow_casting: bool(r.allow_casting), allow_fork: bool(r.allow_fork),
  status: r.status as number, visibility: r.visibility as number, ...ratings(r), derived_rating: r.derived_rating as number | null,
  chats_count: Number(r.chats_count), leads_count: Number(r.leads_count), likes_count: r.likes_count as number,
  messages_count: Number(r.messages_count), meta: json(r.meta, "{}"), ...stamps(r),
})));

insert("plots", plots.map((r) => ({
  id: r.id as number, aid: r.aid as string, author_id: r.author_id as number | null, icon_id: imageRef(r.icon_id),
  forked_from_id: r.forked_from_id as number | null,
  title: r.title as string, tagline: r.tagline as string, description: r.description as string,
  situation: r.situation as string, situation_public: bool(r.situation_public),
  opening_scene: json(r.opening_scene, "[]"), allow_fork: bool(r.allow_fork),
  status: r.status as number, visibility: r.visibility as number, ...ratings(r), derived_rating: r.derived_rating as number | null,
  chats_count: Number(r.chats_count), likes_count: r.likes_count as number,
  meta: json(r.meta, "{}"), ...stamps(r),
})));

insert("lores", lores.map((r) => ({
  id: r.id as number, aid: r.aid as string, author_id: r.author_id as number | null,
  title: r.title as string, description: r.description as string, allow_attach: bool(r.allow_attach),
  status: r.status as number, visibility: r.visibility as number,
  entries_count: r.entries_count as number, plots_count: r.plots_count as number, meta: json(r.meta, "{}"), ...stamps(r),
})));

insert("lore_entries", loreEntries.map((r) => ({
  id: r.id as number, lore_id: r.lore_id as number, title: r.title as string,
  keywords: r.keywords as string, body: r.body as string, ...stamps(r),
})));

insert("personas", personas.map((r) => ({
  id: r.id as number, aid: r.aid as string, account_id: r.account_id as number | null, plot_id: r.plot_id as number | null,
  icon_id: imageRef(r.icon_id), name: r.name as string, description: r.description as string,
  is_default: bool(r.is_default), position: r.position as number, status: r.status as number, ...stamps(r),
})));

// 章は廃止したので、章ごとの要約もローリング要約と同じ「畳んだ要約」として持ってくる (並びは古い順のまま)
const plainSummaries = (summaries: unknown) => {
  const list = JSON.parse(json(summaries, "[]")) as unknown[];
  return JSON.stringify(list.flatMap((s) => {
    if (typeof s !== "object" || s === null || Array.isArray(s)) return [];
    const { text } = s as Record<string, unknown>;
    return typeof text === "string" && text.trim() !== "" ? [{ text }] : [];
  }));
};
// 本体では、章が閉じたときにその章の会話を要約し、プロンプトには今の章の会話だけを載せていた。
// 閉じた章の会話 (今の章ではないもの) は要約済みなので、その最後の 1 通までを畳んだ位置にする。
// ローリング要約で畳んだ位置を持っていれば、進んでいるほうを使う
const withSummarizedUpto = (r: Row) => {
  const meta = JSON.parse(json(r.meta, "{}")) as Record<string, unknown>;
  const upto = Math.max(Math.trunc(Number(meta.summarized_upto_id) || 0), Number(r.closed_upto_id) || 0);
  return JSON.stringify(upto > 0 ? { ...meta, summarized_upto_id: upto } : meta);
};
// 本体の chats.status の finished (1)。D1 では欠番
const FINISHED = 1;

// ゲストのチャットは持ってこない
await eachBatch(`
  SELECT t.*,
    (SELECT MAX(m.id) FROM amis_chat_messages m WHERE m.chat_id = t.id AND m.chapter_key <> t.current_chapter_key) AS closed_upto_id
  FROM amis_chats t WHERE t.account_id IS NOT NULL`, (rows) => insert("chats", rows.map((r) => ({
  id: r.id as number, aid: r.aid as string, account_id: r.account_id as number, plot_id: r.plot_id as number,
  persona_id: r.persona_id as number | null, ai_model_id: r.ai_model_id as number | null,
  title: r.title as string, status: r.status === FINISHED ? 0 : r.status as number,
  reply_style: r.reply_style as number, choice_mode: bool(r.choice_mode), summaries: plainSummaries(r.summaries),
  messages_count: r.messages_count as number, last_message_at: r.last_message_at as Date | null,
  meta: withSummarizedUpto(r), ...stamps(r),
}))));

await eachBatch(
  "SELECT t.* FROM amis_chat_messages t JOIN amis_chats c ON c.id = t.chat_id WHERE c.account_id IS NOT NULL",
  (rows) => insert("chat_messages", rows.map((r) => ({
  id: r.id as number, aid: r.aid as string, chat_id: r.chat_id as number, role: r.role as number, status: r.status as number,
  content: json(r.content, "[]"),
  speaker_character_id: r.speaker_character_id as number | null, replaced_by_id: r.replaced_by_id as number | null,
  ai_model_id: r.ai_model_id as number | null, ...ratings(r),
  streamed_at: r.streamed_at as Date | null, meta: json(r.meta, "{}"), ...stamps(r),
  }))),
);

// DM の AI は廃止したので、Amis の分だけ。持ってこなかったチャット (ゲスト) を指すものは参照を外す。
// 応答時間と終わり方は、本体ではメッセージに持っていた。D1 では ai_usages に置く
await eachBatch(`
  SELECT t.*, c.id AS kept_chat_id, m.id AS kept_message_id,
    m.finish_reason AS message_finish_reason, m.ttft_ms AS message_ttft_ms, m.latency_ms AS message_latency_ms
  FROM ai_usages t
  LEFT JOIN amis_chats c ON c.id = t.amis_chat_id AND c.account_id IS NOT NULL
  LEFT JOIN amis_chat_messages m ON m.id = t.amis_chat_message_id AND c.id IS NOT NULL
  WHERE t.amis_chat_id IS NOT NULL`, (rows) => insert("ai_usages", rows.map((r) => {
  const message = r.kept_message_id !== null;
  return {
    id: r.id as number, account_id: r.account_id as number | null, ai_model_id: r.ai_model_id as number | null,
    chat_id: r.kept_chat_id as number | null,
    chat_message_id: message ? (r.kept_message_id as number) : null,
    purpose: r.purpose as number, prompt_tokens: r.prompt_tokens as number | null, cached_tokens: r.cached_tokens as number | null,
    completion_tokens: r.completion_tokens as number | null, reasoning_tokens: r.reasoning_tokens as number | null,
    cost_micro: r.cost_micro === null ? null : Number(r.cost_micro), gateway_log_id: r.gateway_log_id as string | null,
    finish_reason: message ? (r.message_finish_reason as string | null) : null,
    ttft_ms: message ? (r.message_ttft_ms as number | null) : null, latency_ms: message ? (r.message_latency_ms as number | null) : null,
    created_at: r.created_at as Date,
  };
})));

insert("plot_characters", plotCharacters.map((r) => ({
  id: r.id as number, plot_id: r.plot_id as number, character_id: r.character_id as number,
  speaker_key: r.speaker_key as string, role_name: r.role_name as string, role_description: r.role_description as string,
  is_lead: bool(r.is_lead), position: r.position as number, created_at: r.created_at as Date,
})));

for (const [table, rows, owner] of [
  ["character_images", characterImages, "character_id"],
  ["plot_images", plotImages, "plot_id"],
] as const) {
  insert(table, rows.filter((r) => existingImages.has(r.image_id)).map((r) => ({
    id: r.id as number, [owner]: r[owner] as number, image_id: r.image_id as number,
    situation: r.situation as string, secret: bool(r.secret), position: r.position as number, created_at: r.created_at as Date,
  })));
}

insert("plot_lores", plotLores.map((r) => ({ plot_id: r.plot_id as number, lore_id: r.lore_id as number, created_at: r.created_at as Date })));
insert("character_likes", characterLikes.map((r) => ({ account_id: r.account_id as number, character_id: r.character_id as number, created_at: r.created_at as Date })));
insert("plot_likes", plotLikes.map((r) => ({ account_id: r.account_id as number, plot_id: r.plot_id as number, created_at: r.created_at as Date })));

await conn.end();

// 表示用の WebP を、本体のバケットから Amis のバケットへ同じキーでコピーする。
// 削除済みの画像は本体が private/ へ移して隠しているので持ってこない (Amis でも代わりの画像になる)
const copies = images
  .filter((r) => r.variant_type && r.status !== 2)
  .map((r) => `images/variants/${r.aid}.webp`);
const copyList = `${out.replace(/\.sql$/, "")}.images.txt`;
closeSync(fd);
writeFileSync(copyList, copies.length === 0 ? "" : `${copies.join("\n")}\n`);
console.log(`${out}: ${statementCount} statements`);
console.log(`${copyList}: ${copies.length} images to copy`);
for (const [name, n] of counts) console.log(`  ${name}: ${n}`);
