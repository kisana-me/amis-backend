// 生成済みメッセージの本文をユーザーが直接書き換えるときの正規化と検証 (本体の Amis::SceneWriter)。
// クライアントから来た JSON は信用せず、そのチャットで実際に使えるものだけを通す。
// 顔はキャラの行だけ、挿絵は地の文だけ ── 出力規約 (ScenePresenter) と同じ規則を敷く
import type { Palette } from "../views/palette";
import { charLength, isBlank, isPresent, rubyStrip } from "./ruby-text";
import type { SceneEntry } from "./scene-presenter";

const MAX_LINES = 30;
// AI の出力には上限が無いので、触っていない行が保存で弾かれないよう緩めに取る
export const MAX_TEXT = 1000;
// 1 メッセージに挿絵は 1 枚まで (ScenePresenter と揃える)
const MAX_IMAGES = 1;
// 出演していない話者の名前の長さ。AI がその場で出した人物の名前も、編集で同じものを書けるようにする
export const MAX_SPEAKER = 30;

export type WriteResult = { scene: SceneEntry[]; errors: string[] };

// keep: すでにこの返答が使っている絵の aid。作者が伏せた絵を AI が選ぶことがあるので、
// 候補に出ないぶんも「そのまま残す」だけは通す
export function writeScene(rows: unknown, palette: Palette, keep: Set<string>): WriteResult {
  if (!Array.isArray(rows)) return { scene: [], errors: ["本文の形式が不正です"] };
  if (rows.length === 0) return { scene: [], errors: ["本文を1行以上入力してください"] };
  if (rows.length > MAX_LINES) return { scene: [], errors: [`本文は${MAX_LINES}行までです`] };

  const speakerKeys = new Set(Object.keys(palette.characters));
  const characterAids = (speaker: string) => new Set((palette.characters[speaker] ?? []).map((row) => row.aid));
  const plotAids = new Set(palette.plot_images.map((row) => row.aid));
  // 候補に出ている絵か、この返答がもともと使っていた絵なら通す
  const selectable = (aid: string, aids: Set<string>) => aids.has(aid) || keep.has(aid);

  const errors: string[] = [];
  const scene: SceneEntry[] = [];
  let images = 0;

  rows.forEach((raw, index) => {
    const n = index + 1;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      errors.push(`${n}行目の形式が不正です`);
      return;
    }
    const row = raw as Record<string, unknown>;

    const text = rubyStrip(str(row.text));
    if (isBlank(text)) return void errors.push(`${n}行目の本文を入力してください`);
    if (charLength(text) > MAX_TEXT) return void errors.push(`${n}行目は${MAX_TEXT}文字までです`);

    const speakerText = rubyStrip(str(row.speaker));
    const speaker = isPresent(speakerText) ? speakerText : null;
    if (speaker && charLength(speaker) > MAX_SPEAKER) return void errors.push(`${n}行目の話者名は${MAX_SPEAKER}文字までです`);

    const line: SceneEntry = { speaker, text };
    // 顔はキャラの行にだけ、挿絵は地の文にだけ付く。反対側に来たものは黙って落とす。
    // 出演していない話者には顔が無いので、指定が来ても同じように落とす
    if (speaker) {
      const icon = speakerKeys.has(speaker) && isPresent(row.icon) ? str(row.icon) : null;
      if (icon) {
        if (!selectable(icon, characterAids(speaker))) return void errors.push(`${n}行目の表情が選べません`);
        line.icon = icon;
      }
    } else {
      const image = isPresent(row.image) ? str(row.image) : null;
      if (image) {
        if (!selectable(image, plotAids)) return void errors.push(`${n}行目の挿絵が選べません`);
        images += 1;
        if (images <= MAX_IMAGES) line.image = image;
      }
    }
    scene.push(line);
  });

  if (scene.length === 0 && errors.length === 0) errors.push("本文を1行以上入力してください");
  return { scene, errors };
}

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
