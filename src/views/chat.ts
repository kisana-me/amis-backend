// チャットとメッセージの JSON (本体の _chat / _message / chats/show.json.jbuilder)
import { CHAT_STATUSES, MESSAGE_ROLES, MESSAGE_STATUSES } from "../db/schema";
import { ratingLabel } from "../lib/ratings";
import type { AiModel, Chat, ChatMessage, Persona, Plot, ViewContext } from "./context";
import { chapterDefinitions, imageUrl, plotJson } from "./json";

const CHAT_STATUS_LABELS = ["normal", "finished", "archived", "deleted"] as const;
const REPLY_STYLE_LABELS = ["balanced", "dialogue", "narration"] as const;
const ROLE_LABELS = ["user", "assistant", "system"] as const;
const MESSAGE_STATUS_LABELS = ["normal", "pending", "streaming", "replaced", "hidden", "failed", "canceled", "deleted"] as const;

// 場面の状態 (時間・場所・空気) のキー (本体の ScenePresenter::STATUS_KEYS)
export const SCENE_STATUS_KEYS = ["time", "place", "air"] as const;

// 一覧や画面に出さないメッセージ (本体の ChatMessage.visible の逆)
export const HIDDEN_MESSAGE_STATUSES = [MESSAGE_STATUSES.replaced, MESSAGE_STATUSES.hidden, MESSAGE_STATUSES.deleted];

type Hash = Record<string, unknown>;
const isHash = (v: unknown): v is Hash => typeof v === "object" && v !== null && !Array.isArray(v);
const present = (v: unknown) => v !== null && v !== undefined && String(v).trim() !== "";
const seconds = (date: Date | null) => (date ? Math.floor(date.getTime() / 1000) : null);

export type SceneLine = { speaker: unknown; text: string; icon?: unknown; image?: unknown };

// 正規化した本文。icon / image は持っている行にだけ入る (本体の ChatMessage#scene)
export function scene(message: ChatMessage): SceneLine[] {
  return message.content.filter(isHash).map((line) => ({
    speaker: present(line.speaker) ? line.speaker : null,
    text: line.text === null || line.text === undefined ? "" : String(line.text),
    ...(present(line.icon) ? { icon: line.icon } : {}),
    ...(present(line.image) ? { image: line.image } : {}),
  }));
}

export function sceneStatus(message: ChatMessage): Hash {
  return isHash(message.meta.scene_status) ? message.meta.scene_status : {};
}

// 選択肢で応答したときの選択肢。本文ではないので meta に置いてある
export function choices(message: ChatMessage): string[] {
  const list = Array.isArray(message.meta.choices) ? message.meta.choices : [];
  return list.map((c) => (c === null || c === undefined ? "" : String(c))).filter((c) => c.trim() !== "");
}

// この返答が使っている絵の aid
export function imageAids(message: ChatMessage): Set<string> {
  return new Set(scene(message).flatMap((line) => [line.icon, line.image]).filter(present).map(String));
}

// 一覧のプレビュー。* は動作を囲む記号なので落とし、1 行に畳んで 60 文字で切る (本体の ChatMessage#excerpt)
const EXCERPT_LIMIT = 60;
export function excerpt(message: ChatMessage): string {
  // Ruby の \s と strip は ASCII の空白だけを見る (全角スペースは残る)
  const text = scene(message).map((line) => line.text).join("\n").replaceAll("*", "").replace(/[ \t\r\n\f\v]+/g, " ").replace(/^[ \t\r\n\f\v\0]+|[ \t\r\n\f\v\0]+$/g, "");
  const chars = Array.from(text);
  // String#truncate と同じく、はみ出すときは末尾を "..." にして 60 文字に収める
  return chars.length > EXCERPT_LIMIT ? `${chars.slice(0, EXCERPT_LIMIT - 3).join("")}...` : text;
}

// _message.json.jbuilder
export function messageJson(message: ChatMessage) {
  return {
    aid: message.aid,
    role: ROLE_LABELS[message.role] ?? "user",
    status: MESSAGE_STATUS_LABELS[message.status] ?? "normal",
    chapter_key: message.chapterKey,
    scene: scene(message),
    choices: choices(message),
    scene_status: sceneStatus(message),
    rating: ratingLabel(message.rating),
    created_at: seconds(message.createdAt),
  };
}

export function chatStatusLabel(status: number): string {
  return CHAT_STATUS_LABELS[status] ?? "normal";
}

// _chat.json.jbuilder。結末 (ending_key / ending_title) は廃止した
export function chatJson(chat: Chat, plot: Plot, ctx: ViewContext, extra: { model: AiModel | null; persona: Persona | null }) {
  const chapters = chapterDefinitions(plot);
  const index = chapters.findIndex((c) => c.key === chat.currentChapterKey);
  const current = index < 0 ? null : chapters[index];
  const personaIcon = extra.persona?.iconId == null ? undefined : ctx.images.get(extra.persona.iconId);

  return {
    aid: chat.aid,
    title: chat.title,
    current_chapter_key: chat.currentChapterKey,
    turns_in_chapter: chat.turnsInChapter,
    status: chatStatusLabel(chat.status),
    choice_mode: chat.choiceMode,
    reply_style: REPLY_STYLE_LABELS[chat.replyStyle] ?? "balanced",
    // 未設定は「明示的に選んでいない」= 既定モデル。フロントは status の default 印を見る
    model_aid: extra.model?.aid ?? null,
    model_name: extra.model?.name ?? null,
    display_title: chat.title.trim() !== "" ? chat.title : plot.title,
    archived: chat.status === CHAT_STATUSES.archived,
    // アーカイブすると status が移ってしまうので、完結したかどうかは時刻で見る
    finished: chat.finishedAt !== null,
    messages_count: chat.messagesCount,
    last_message_at: seconds(chat.lastMessageAt),
    finished_at: seconds(chat.finishedAt),
    // 章の切れ目の暗転演出でタイトルを出すために、章の一覧も付ける
    plot: { ...plotJson(plot, ctx), chapters },
    chapter: current
      ? {
        key: current.key,
        title: current.title,
        index,
        total: chapters.length,
        final: present(current.key) && current.key === (chapters.at(-1)?.key ?? ""),
      }
      : null,
    persona: extra.persona
      ? {
        aid: extra.persona.aid,
        name: extra.persona.name,
        description: extra.persona.description,
        icon_url: personaIcon ? imageUrl(personaIcon, ctx) : null,
      }
      : null,
  };
}

// いまの場面の状態。書かれなかった項目は前のターンのものが生きるので、新しい返答から遡って埋める
// (本体の Chat#current_scene_status。time / place / air 以外のキーが入っていれば、それも残る)
export function currentSceneStatus(assistantMessagesNewestFirst: ChatMessage[]): Hash {
  const status = new Map<string, unknown>(SCENE_STATUS_KEYS.map((key) => [key, undefined]));
  for (const message of assistantMessagesNewestFirst) {
    for (const [key, value] of Object.entries(sceneStatus(message))) {
      // 空の値でもキーは入る (本体の ||= と同じ)。入ったキーが埋まるまで遡り続ける
      if (status.get(key) === undefined) status.set(key, presentValue(value) ? value : undefined);
    }
    if ([...status.values()].every((v) => v !== undefined)) break;
  }
  return Object.fromEntries([...status].filter(([, v]) => v !== undefined));
}

// Ruby の present? と同じ。空文字・空白だけ・空の配列とハッシュ・false は「ない」
function presentValue(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (isHash(value)) return Object.keys(value).length > 0;
  return true;
}

export const isVisibleAssistant = (m: ChatMessage) => m.role === MESSAGE_ROLES.assistant && m.status === MESSAGE_STATUSES.normal;
