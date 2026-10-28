// 書き込みで共通の小物
import { charLength, isBlank, rubyStrip } from "../generation/ruby-text";
import type { ValidationErrors } from "../lib/errors";
import { castBoolean } from "../lib/http";

export const VISIBILITY_KEYS: Record<string, number> = { opened: 0, limited: 1, closed: 2 };
export const USER_RATING_KEYS: Record<string, number> = { general: 0, nsfw: 1, r18: 2 };

// multipart で送られた textarea の改行は FormData 側で CRLF に直されるので、LF に戻してから数える
export const normalizeNewlines = (value: string) => value.replace(/\r\n?/g, "\n");

export const bool = (value: string | null) => castBoolean(value) === true;

// 列挙値。知らない値は本体の enum と同じく弾く
export function enumValue(errors: ValidationErrors, attribute: string, keys: Record<string, number>, value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!(value in keys)) {
    errors.add(`${attribute}は一覧にありません`);
    return undefined;
  }
  return keys[value];
}

// 必須で、1〜max 文字
export function requiredText(errors: ValidationErrors, attribute: string, value: string, max: number) {
  if (isBlank(value)) errors.blank(attribute);
  else if (charLength(value) > max) errors.tooLong(attribute, max);
}

export function optionalText(errors: ValidationErrors, attribute: string, value: string, max: number) {
  if (charLength(value) > max) errors.tooLong(attribute, max);
}

// JSON の配列。壊れていたらエラーにして空を返す。Hash でない要素は捨てる
export function parseJsonRows(errors: ValidationErrors, attribute: string, raw: string | null): Record<string, unknown>[] | null {
  if (raw === null) return null;
  if (rubyStrip(raw) === "") return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) throw new Error("配列ではありません");
    return value.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null && !Array.isArray(row));
  } catch (error) {
    errors.add(`${attribute}が JSON として不正です (${error instanceof Error ? error.message : String(error)})`);
    return [];
  }
}
