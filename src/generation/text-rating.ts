// テキストの簡易レーティング判定 (本体の TextRating)。語を含むかで nsfw / r18 を判定する。
// 語のリストは本体の config/moderation/wordlist.yml と同じ。部分一致 (NFKC 正規化 + 小文字化後)
import { RATINGS } from "../db/schema";
import { isBlank } from "./ruby-text";

const WORDLIST: { nsfw: string[]; r18: string[] } = {
  nsfw: ["死ね", "殺す", "殺せ", "殺して", "殺し", "殺人", "殺害", "死体", "死刑", "自殺", "自決", "自害", "自傷", "自爆テロ"],
  r18: [],
};

const normalize = (text: string) => text.normalize("NFKC").toLowerCase();
const NSFW = WORDLIST.nsfw.map(normalize);
const R18 = WORDLIST.r18.map(normalize);

export function rateText(content: string): number {
  if (isBlank(content)) return RATINGS.general;
  const text = normalize(content);
  if (R18.some((word) => text.includes(word))) return RATINGS.r18;
  if (NSFW.some((word) => text.includes(word))) return RATINGS.nsfw;
  return RATINGS.general;
}
