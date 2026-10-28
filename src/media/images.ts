// アップロードされた画像を変換して R2 に置き、images の行を作る (本体の Image#image_upload と ImageProcessable)。
// 本体と同じく、元の画像は残さず表示用の WebP だけを置く (amis/images/variants/{aid}.webp)
import { images } from "../db/schema";
import { newAid } from "../lib/aid";

export type VariantType = "amis-character" | "amis-plot";

// 縮める大きさ (長辺の上限) と、切り抜く縦横比
const VARIANTS: Record<VariantType, { width: number; height: number; ratio: [number, number] }> = {
  "amis-plot": { width: 900, height: 1200, ratio: [3, 4] },
  "amis-character": { width: 800, height: 800, ratio: [1, 1] },
};

const ALLOWED_FORMATS = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_SIZE_MB = 30;
// 長辺は縮めて保存するので、寸法の上限は緩めにしておく
const MAX_DIMENSION = 16_384;

export type ProcessedImage = { body: ReadableStream<Uint8Array> | ArrayBuffer; width: number; height: number };
export type ImageProcessor = (file: File, variant: VariantType) => Promise<ProcessedImage>;

export class ImageInvalid extends Error {}

// Images バインディングで、比率どおりに中央を切り抜いてから、上限を超えないように縮めて WebP にする
export function imagesBindingProcessor(binding: ImagesBinding): ImageProcessor {
  return async (file, variant) => {
    if (file.size / 1024 / 1024 > MAX_SIZE_MB) throw new ImageInvalid(`画像は${MAX_SIZE_MB}MBまでです`);

    let info: Awaited<ReturnType<ImagesBinding["info"]>>;
    try {
      info = await binding.info(file.stream());
    } catch {
      throw new ImageInvalid("画像が無効です");
    }
    if (!("width" in info) || !ALLOWED_FORMATS.has(info.format)) throw new ImageInvalid("画像の形式が対応していません");
    if (info.width > MAX_DIMENSION || info.height > MAX_DIMENSION) throw new ImageInvalid(`画像は${MAX_DIMENSION}px までです`);

    const { width, height, ratio: [rw, rh] } = VARIANTS[variant];
    const cropWidth = Math.min(info.width, Math.round((info.height * rw) / rh));
    const cropHeight = Math.min(info.height, Math.round((info.width * rh) / rw));
    const result = await binding.input(file.stream())
      .transform({ width: cropWidth, height: cropHeight, fit: "crop", gravity: "center" })
      .transform({ width, height, fit: "scale-down" })
      .output({ format: "image/webp", quality: 80 });

    // 縮めたあとの大きさ (縮めないなら切り抜いた大きさのまま)
    const scale = Math.min(1, width / cropWidth, height / cropHeight);
    return { body: result.image(), width: Math.round(cropWidth * scale), height: Math.round(cropHeight * scale) };
  };
}

export type StoredImage = typeof images.$inferInsert & { aid: string };

// R2 に置いて、images に入れる行を返す (行の書き込みは呼び出し側の batch に混ぜる)
export async function storeImage(
  deps: { media: R2Bucket; process: ImageProcessor },
  file: File,
  variant: VariantType,
  accountId: number,
): Promise<StoredImage> {
  const processed = await deps.process(file, variant);
  const aid = newAid();
  const body = processed.body instanceof ArrayBuffer ? processed.body : await new Response(processed.body).arrayBuffer();
  await deps.media.put(`amis/images/variants/${aid}.webp`, body, { httpMetadata: { contentType: "image/webp" } });
  return { aid, accountId, variantType: variant, width: processed.width, height: processed.height };
}
