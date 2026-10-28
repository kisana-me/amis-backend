// プロット・キャラの追加画像 (中間テーブル) を 1 回の保存で同期する (本体の Amis::ImageSync)。
// 既存の行は image_aid、新しく上げる行は upload (images_files の添字) で指す
import { charLength, isPresent, rubyStrip } from "../generation/ruby-text";
import type { ValidationErrors } from "../lib/errors";
import { castBoolean } from "../lib/http";
import type { OwnedImage } from "../views/json";

const MAX_IMAGES = 12;

export type ImagePlan =
  | { kind: "existing"; imageId: number; aid: string; situation: string; secret: boolean }
  | { kind: "upload"; file: File; situation: string; secret: boolean };

// 送られた行を、既存の画像か新しいアップロードかに振り分ける。position は並び順そのもの
export function planImages(
  errors: ValidationErrors,
  rows: Record<string, unknown>[],
  existing: (OwnedImage & { aid: string })[],
  files: File[],
): ImagePlan[] {
  if (rows.length > MAX_IMAGES) {
    errors.add(`画像は${MAX_IMAGES}枚までです`);
    return [];
  }
  const byAid = new Map(existing.map((row) => [row.aid, row]));
  const plans: ImagePlan[] = [];
  for (const row of rows) {
    const situation = rubyStrip(String(row.situation ?? ""));
    const secret = castBoolean(row.secret) === true;
    if (charLength(situation) > 50) {
      errors.add("画像: 説明は50文字以内で入力してください");
      return [];
    }
    const aid = String(row.image_aid ?? "");
    if (isPresent(aid)) {
      const found = byAid.get(aid);
      if (!found) {
        errors.add("画像が見つかりませんでした");
        return [];
      }
      plans.push({ kind: "existing", imageId: found.imageId, aid, situation, secret });
      continue;
    }
    const index = typeof row.upload === "number" || /^\d+$/.test(String(row.upload ?? "")) ? Number(row.upload) : -1;
    const file = files[index];
    if (!file) {
      errors.add("画像のアップロードに失敗しました");
      return [];
    }
    plans.push({ kind: "upload", file, situation, secret });
  }
  return plans;
}
