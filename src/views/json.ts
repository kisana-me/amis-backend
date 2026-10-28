// 本体の v1/amis/shared/*.json.jbuilder と同じ形の JSON を作る
import { authorJson } from "../accounts/accounts";
import { CONTENT_STATUSES, RATINGS } from "../db/schema";
import { ratingLabel } from "../lib/ratings";
import { objectUrl, staticImageUrl } from "../lib/urls";
import type { Cast, Character, Image, Plot, ViewContext } from "./context";

// 本体の Image#image_url。変換が済んでいて、正常で、rejected でなければ実体を指す
export function imageUrl(image: Image, ctx: ViewContext): string {
  const usable = image.status === CONTENT_STATUSES.normal && !!image.variantType?.trim() && image.rating !== RATINGS.rejected;
  return usable ? objectUrl(ctx.env, `amis/images/variants/${image.aid}.webp`) : staticImageUrl(ctx.env, "amiverse-1.webp");
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

// 章の定義。Hash のものだけを使う (本体の Plot#chapter_definitions)
export function chapterDefinitions(plot: Plot): { key: string | null; title: string | null }[] {
  return plot.chapters.filter(isHash).map((c) => ({
    key: c.key === undefined || c.key === null ? null : String(c.key),
    // ActiveModel の既定値と同じく、項目がなければ ""、null が入っていれば null
    title: c.title === undefined ? "" : c.title === null ? null : String(c.title),
  }));
}

export function chapterCount(plot: Plot): number {
  return plot.chapters.filter(isHash).length;
}

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
  const chapters = chapterCount(plot);
  const lead = leadCast(plot, ctx);
  return {
    aid: plot.aid,
    title: plot.title,
    tagline: plot.tagline,
    description: plot.description,
    icon_url: iconDisplayUrl(plot.iconId, ctx, "amiverse-1.webp"),
    free_form: chapters === 0,
    rating: ratingLabel(plot.rating),
    official: plot.authorId === null,
    author: plot.authorId === null ? null : authorJson(ctx.authors.get(plot.authorId)),
    allow_fork: plot.allowFork,
    chats_count: plot.chatsCount,
    likes_count: plot.likesCount,
    clears_count: plot.clearsCount,
    chapters_count: chapters,
    cast: (ctx.casts.get(plot.id) ?? []).map((c) => castJson(c, ctx)),
    lead_character: lead ? characterJson(lead.character, ctx) : null,
  };
}
