// 本体の v1/amis/shared/*.json.jbuilder と同じ形の JSON を作る
import { authorJson } from "../accounts/accounts";
import { CONTENT_STATUSES, RATINGS } from "../db/schema";
import { ratingLabel } from "../lib/ratings";
import { amisObjectUrl, staticImageUrl } from "../lib/urls";
import type { Cast, Character, Image, Lore, LoreEntry, Persona, Plot, ViewContext } from "./context";

// 本体の Image#image_url。変換が済んでいて、正常で、rejected でなければ実体を指す
export function imageUrl(image: Image, ctx: ViewContext): string {
  const usable = image.status === CONTENT_STATUSES.normal && !!image.variantType?.trim() && image.rating !== RATINGS.rejected;
  return usable ? amisObjectUrl(ctx.env, `images/variants/${image.aid}.webp`) : staticImageUrl(ctx.env, "amiverse-1.webp");
}

// 本体の Image#display_url。見ている人に見せられないレーティングなら代わりの画像
export function imageDisplayUrl(image: Image, ctx: ViewContext): string {
  if ((image.rating ?? 0) > ctx.maxRating) return staticImageUrl(ctx.env, "amiverse-1.webp");
  return imageUrl(image, ctx);
}

function iconDisplayUrl(iconId: number | null, ctx: ViewContext, fallback: "amiverse-logo.webp" | "amiverse-1.webp"): string {
  const icon = iconId === null ? undefined : ctx.images.get(iconId);
  return icon ? imageDisplayUrl(icon, ctx) : staticImageUrl(ctx.env, fallback);
}

// _image.json.jbuilder
export function imageJson(image: Image, ctx: ViewContext) {
  return {
    type: "image",
    aid: image.aid,
    name: image.name,
    description: image.description,
    url: imageDisplayUrl(image, ctx),
    rating: ratingLabel(image.rating),
  };
}

// _character.json.jbuilder
export function characterJson(character: Character, ctx: ViewContext) {
  return {
    aid: character.aid,
    name: character.name,
    tagline: character.tagline,
    description: character.description,
    icon_url: iconDisplayUrl(character.iconId, ctx, "amiverse-logo.webp"),
    rating: ratingLabel(character.rating),
    official: character.authorId === null,
    author: character.authorId === null ? null : authorJson(ctx.authors.get(character.authorId)),
    leads_count: character.leadsCount,
    chats_count: character.chatsCount,
    likes_count: character.likesCount,
    allow_fork: character.allowFork,
    ...(character.personaPublic ? { persona: character.persona } : {}),
  };
}

// _cast.json.jbuilder
export function castJson({ plotCharacter, character }: Cast, ctx: ViewContext) {
  return {
    speaker_key: plotCharacter.speakerKey,
    role_name: plotCharacter.roleName,
    is_lead: plotCharacter.isLead,
    character: characterJson(character, ctx),
  };
}

type Hash = Record<string, unknown>;
const isHash = (v: unknown): v is Hash => typeof v === "object" && v !== null && !Array.isArray(v);
const present = (v: unknown) => v !== null && v !== undefined && String(v).trim() !== "";

// 導入の行。本文が空の行は落とす。icon が吹き出しの顔、image が地の文に添える挿絵 (本体の Plot#opening_lines)
export function openingLines(plot: Plot) {
  return plot.openingScene.filter(isHash).filter((line) => present(line.text)).map((line) => ({
    speaker: present(line.speaker) ? line.speaker : null,
    text: String(line.text ?? ""),
    ...(present(line.icon) ? { icon: line.icon } : {}),
    ...(present(line.image) ? { image: line.image } : {}),
  }));
}

// 導入で名指しされている画像の aid
export function openingImageAids(plot: Plot): string[] {
  return [...new Set(openingLines(plot).flatMap((line) => [line.icon, line.image]).filter(present).map(String))];
}

// 主役。is_lead がいなければ先頭 (本体の Plot#lead_plot_character)
export function leadCast(plot: Plot, ctx: ViewContext): Cast | undefined {
  const casts = ctx.casts.get(plot.id) ?? [];
  return casts.find((c) => c.plotCharacter.isLead) ?? casts[0];
}

// _plot.json.jbuilder
export function plotJson(plot: Plot, ctx: ViewContext) {
  const lead = leadCast(plot, ctx);
  return {
    aid: plot.aid,
    title: plot.title,
    tagline: plot.tagline,
    description: plot.description,
    icon_url: iconDisplayUrl(plot.iconId, ctx, "amiverse-1.webp"),
    rating: ratingLabel(plot.rating),
    official: plot.authorId === null,
    author: plot.authorId === null ? null : authorJson(ctx.authors.get(plot.authorId)),
    allow_fork: plot.allowFork,
    chats_count: plot.chatsCount,
    likes_count: plot.likesCount,
    cast: (ctx.casts.get(plot.id) ?? []).map((c) => castJson(c, ctx)),
    lead_character: lead ? characterJson(lead.character, ctx) : null,
  };
}

const VISIBILITY_LABELS = ["opened", "limited", "closed"] as const;

export function visibilityLabel(visibility: number): string {
  return VISIBILITY_LABELS[visibility] ?? "opened";
}

// 本体の Character#icon_url / Plot#icon_url。見る人のレーティングでは伏せない (編集画面とカード用)
export function characterIconUrl(character: Character, ctx: ViewContext): string {
  const icon = character.iconId === null ? undefined : ctx.images.get(character.iconId);
  return icon ? imageUrl(icon, ctx) : staticImageUrl(ctx.env, "amiverse-logo.webp");
}

export function plotIconUrl(plot: Plot, ctx: ViewContext): string {
  const icon = plot.iconId === null ? undefined : ctx.images.get(plot.iconId);
  return icon ? imageUrl(icon, ctx) : staticImageUrl(ctx.env, "amiverse-1.webp");
}

export type OwnedImage = { imageId: number; situation: string; secret: boolean };

// _owned_image.json.jbuilder
export function ownedImageJson(owned: OwnedImage, ctx: ViewContext) {
  const image = ctx.images.get(owned.imageId);
  return image ? [{ ...imageJson(image, ctx), situation: owned.situation, secret: owned.secret }] : [];
}

// _editable_character.json.jbuilder。表情差分は作者にだけ全部返し、他人にはシークレットを伏せる
export function editableCharacterJson(character: Character, ctx: ViewContext, viewerId: number | null, ownedImages: OwnedImage[]) {
  const mine = character.authorId !== null && character.authorId === viewerId;
  return {
    aid: character.aid,
    name: character.name,
    tagline: character.tagline,
    description: character.description,
    persona_public: character.personaPublic,
    allow_casting: character.allowCasting,
    allow_fork: character.allowFork,
    visibility: visibilityLabel(character.visibility),
    icon_url: characterIconUrl(character, ctx),
    user_rating: ratingLabel(character.userRating),
    rating: ratingLabel(character.rating),
    official: character.authorId === null,
    leads_count: character.leadsCount,
    chats_count: character.chatsCount,
    mine,
    has_icon: character.iconId !== null && ctx.images.has(character.iconId),
    ...(mine || character.personaPublic ? { persona: character.persona } : {}),
    images: (mine ? ownedImages : ownedImages.filter((o) => !o.secret)).flatMap((o) => ownedImageJson(o, ctx)),
  };
}

// _lore.json.jbuilder。本文はここには載せない。body_length は一覧とピッカーでだけ付ける
export function loreJson(lore: Lore, ctx: ViewContext, viewerId: number | null, bodyLength?: number) {
  return {
    aid: lore.aid,
    title: lore.title,
    description: lore.description,
    allow_attach: lore.allowAttach,
    visibility: visibilityLabel(lore.visibility),
    entries_count: lore.entriesCount,
    plots_count: lore.plotsCount,
    mine: lore.authorId !== null && lore.authorId === viewerId,
    official: lore.authorId === null,
    author: lore.authorId === null ? null : authorJson(ctx.authors.get(lore.authorId)),
    ...(bodyLength === undefined ? {} : { body_length: bodyLength }),
  };
}

// _editable_lore.json.jbuilder。項目まで込み
export function editableLoreJson(lore: Lore, entries: LoreEntry[], ctx: ViewContext, viewerId: number | null) {
  return {
    ...loreJson(lore, ctx, viewerId),
    entries: entries.map((e) => ({ id: e.id, title: e.title, keywords: e.keywords, body: e.body })),
  };
}

// _persona.json.jbuilder。アイコンは見る人で伏せない (本体の Persona#icon_url)
export function personaJson(persona: Persona, ctx: ViewContext) {
  const icon = persona.iconId === null ? undefined : ctx.images.get(persona.iconId);
  return {
    aid: persona.aid,
    name: persona.name,
    description: persona.description,
    is_default: persona.isDefault,
    position: persona.position,
    icon_url: icon ? imageUrl(icon, ctx) : null,
    recommended: persona.plotId !== null,
  };
}

// _link_card.json.jbuilder。SNS のタイムラインに素で並ぶので、全年齢以外の絵は伏せる
export function linkCardJson(card: { kind: "plot"; row: Plot } | { kind: "character"; row: Character }, ctx: ViewContext) {
  const { row } = card;
  const general = row.rating === RATINGS.general;
  const icon = card.kind === "plot" ? plotIconUrl(card.row, ctx) : characterIconUrl(card.row, ctx);
  return {
    type: card.kind,
    aid: row.aid,
    title: card.kind === "plot" ? card.row.title : card.row.name,
    tagline: row.tagline,
    icon_url: general ? icon : staticImageUrl(ctx.env, "amiverse-1.webp"),
    rating: ratingLabel(row.rating),
    official: row.authorId === null,
    author_name: row.authorId === null ? null : (ctx.authors.get(row.authorId)?.name ?? null),
    chats_count: row.chatsCount,
  };
}
