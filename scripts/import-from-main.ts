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
// - 廃止したもの (ゲストのチャット、結末、コイン) は持ってこない
// - 画像は Amis から参照されているものだけを持ってくる
import { writeFileSync } from "node:fs";
import { createConnection } from "mysql2/promise";

type Row = Record<string, unknown>;
type Value = string | number | boolean | null | Date | undefined;

const url = process.env.MAIN_DATABASE_URL ?? "mysql://root:mdbroot@127.0.0.1:3306/amiverse_development";
const out = process.argv[2];
if (!out) throw new Error("出力先の .sql を指定してください");

const conn = await createConnection({ uri: url, timezone: "+09:00", dateStrings: false, supportBigNumbers: true, bigNumberStrings: false });
const select = async (sql: string, params: unknown[] = []) => (await conn.query(sql, params))[0] as Row[];

const statements: string[] = [];
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
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0]);
  const head = `INSERT INTO ${table} (${columns.join(", ")}) VALUES\n`;
  // D1 は 1 文が 100KB まで。チャットの本文が長いので、行数ではなく大きさで区切る
  let values: string[] = [];
  let size = 0;
  const flush = () => {
    if (values.length > 0) statements.push(`${head}${values.join(",\n")};`);
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
// ゲストのチャットは持ってこない
const chats = await select("SELECT * FROM amis_chats WHERE account_id IS NOT NULL ORDER BY id");
const chatIds = new Set(chats.map((c) => c.id));
const messages = (await select("SELECT * FROM amis_chat_messages ORDER BY id")).filter((m) => chatIds.has(m.chat_id));
const messageById = new Map(messages.map((m) => [m.id, m]));
const characterLikes = await select("SELECT * FROM amis_character_likes ORDER BY id");
const plotLikes = await select("SELECT * FROM amis_plot_likes ORDER BY id");
const aiModels = await select("SELECT * FROM ai_models ORDER BY id");
// DM の AI は廃止したので、Amis の分だけ
const aiUsages = await select("SELECT * FROM ai_usages WHERE amis_chat_id IS NOT NULL ORDER BY id");

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
  original_key: r.original_ext ? `amis/images/originals/${r.aid}.${r.original_ext}` : null,
  original_ext: r.original_ext as string | null,
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

// 結末 (endings) は廃止したので、章の定義から外す
const withoutEndings = (chapters: unknown) => {
  const list = JSON.parse(json(chapters, "[]")) as unknown[];
  return JSON.stringify(list.map((c) => {
    if (typeof c !== "object" || c === null || Array.isArray(c)) return c;
    const { endings: _endings, ...rest } = c as Record<string, unknown>;
    return rest;
  }));
};

insert("plots", plots.map((r) => ({
  id: r.id as number, aid: r.aid as string, author_id: r.author_id as number | null, icon_id: imageRef(r.icon_id),
  forked_from_id: r.forked_from_id as number | null,
  title: r.title as string, tagline: r.tagline as string, description: r.description as string,
  situation: r.situation as string, situation_public: bool(r.situation_public),
  chapters: withoutEndings(r.chapters), opening_scene: json(r.opening_scene, "[]"), allow_fork: bool(r.allow_fork),
  status: r.status as number, visibility: r.visibility as number, ...ratings(r), derived_rating: r.derived_rating as number | null,
  chats_count: Number(r.chats_count), clears_count: Number(r.clears_count), likes_count: r.likes_count as number,
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

insert("chats", chats.map((r) => ({
  id: r.id as number, aid: r.aid as string, account_id: r.account_id as number, plot_id: r.plot_id as number,
  persona_id: r.persona_id as number | null, ai_model_id: r.ai_model_id as number | null,
  title: r.title as string, status: r.status as number, reply_style: r.reply_style as number, choice_mode: bool(r.choice_mode),
  current_chapter_key: r.current_chapter_key as string, turns_in_chapter: r.turns_in_chapter as number,
  finished_at: r.finished_at as Date | null, summaries: json(r.summaries, "[]"),
  messages_count: r.messages_count as number, last_message_at: r.last_message_at as Date | null,
  meta: json(r.meta, "{}"), ...stamps(r),
})));

insert("chat_messages", messages.map((r) => ({
  id: r.id as number, aid: r.aid as string, chat_id: r.chat_id as number, role: r.role as number, status: r.status as number,
  content: json(r.content, "[]"), chapter_key: r.chapter_key as string,
  speaker_character_id: r.speaker_character_id as number | null, replaced_by_id: r.replaced_by_id as number | null,
  ai_model_id: r.ai_model_id as number | null, ...ratings(r),
  streamed_at: r.streamed_at as Date | null, meta: json(r.meta, "{}"), ...stamps(r),
})));

// 応答時間と終わり方は、本体ではメッセージに持っていた。D1 では ai_usages に置く
insert("ai_usages", aiUsages.map((r) => {
  const message = messageById.get(r.amis_chat_message_id);
  return {
    id: r.id as number, account_id: r.account_id as number | null, ai_model_id: r.ai_model_id as number | null,
    chat_id: chatIds.has(r.amis_chat_id) ? (r.amis_chat_id as number) : null,
    chat_message_id: message ? (r.amis_chat_message_id as number) : null,
    purpose: r.purpose as number, prompt_tokens: r.prompt_tokens as number | null, cached_tokens: r.cached_tokens as number | null,
    completion_tokens: r.completion_tokens as number | null, reasoning_tokens: r.reasoning_tokens as number | null,
    cost_micro: r.cost_micro === null ? null : Number(r.cost_micro), gateway_log_id: r.gateway_log_id as string | null,
    finish_reason: (message?.finish_reason as string | null) ?? null,
    ttft_ms: (message?.ttft_ms as number | null) ?? null, latency_ms: (message?.latency_ms as number | null) ?? null,
    created_at: r.created_at as Date,
  };
}));

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

writeFileSync(out, `${statements.join("\n\n")}\n`);
console.log(`${out}: ${statements.length} statements`);
for (const [name, rows] of Object.entries({
  images, ai_models: aiModels, characters, plots, lores, lore_entries: loreEntries, personas, chats,
  chat_messages: messages, ai_usages: aiUsages, plot_characters: plotCharacters, character_images: characterImages,
  plot_images: plotImages, plot_lores: plotLores, character_likes: characterLikes, plot_likes: plotLikes,
})) console.log(`  ${name}: ${rows.length}`);
