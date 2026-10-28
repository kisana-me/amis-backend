// 行形式の出力をインクリメンタルにパースし、正規化済みの scene 配列にする (本体の Amis::ScenePresenter)
import { headChars, isBlank, isPresent, rubyStrip } from "./ruby-text";
import { type SceneParserHandler, SceneStreamParser } from "./scene-stream-parser";

export type SceneEntry = { speaker: string | null; text: string; icon?: string; image?: string };
export type SceneEvent = { i: number; speaker: string | null; delta: string; done: boolean; icon?: string; image?: string };

type Line = { index: number; speaker: string | null; text: string; icon: number | null; image: number | null };

const MAX_RAW_BYTES = 200_000;
const MAX_CHOICES = 3;
const MAX_IMAGES = 1;

// 進む側の判定は取りこぼしても害が小さいほうへ倒す。cleared は明示的な真だけを見る
const TRUTHY = ["true", "yes", "1", "はい"];
const BLANK_VALUES = ["-", "null", "none", "なし", "no", "false"];
// 場面の状態。長い説明を書いてくることがあるので頭で切る
export const STATUS_KEYS = ["time", "place", "air"] as const;
// 本文の前に書かせるもの (舞台) と、後ろに書かせるもの (結果)
export const HEAD_STATUS_KEYS = ["time", "place"] as const;
export const TAIL_STATUS_KEYS = ["air"] as const;
export const STATUS_LIMIT = 60;
// 本文の前に書かせる段取り。UI には出さないが、次のターンの few-shot には戻す
const BEAT_LIMIT = 120;

// 行まるごとが物語の外側の発言なら落とし、末尾に付いているだけなら削る。\s は Ruby と同じく ASCII だけ
const META_NOTE = "[（(][ \\t\\r\\n\\f\\v]*(?:注|註|補足|訂正|お詫び|備考|Note)[ \\t\\r\\n\\f\\v]*[:：][^）)]*[）)]";
const META_NOTE_TEST = new RegExp(META_NOTE, "u");
const META_NOTE_STRIP = new RegExp(`\\*{0,2}${META_NOTE}\\*{0,2}`, "gu");
// 行まるごとが 1 つの引用になっているときだけ外す
const QUOTED_LINE = /^[「『]([^「『」』]*)[」』]$/u;
// 空白・記号・敬称を落としてから突き合わせる
const ALIAS_NOISE = /[\s「」『』（）()【】・,、.。]/gu;
const HONORIFICS = /(さん|さま|様|ちゃん|くん|君|先輩|先生|殿)$/u;
// 区切り線や記号だけの行 ([[:alnum:]] を含まない)
const ALNUM = /[\p{Alphabetic}\p{Nd}]/u;

export type ScenePresenterOptions = {
  speakerKeys?: string[];
  // LLM が返す名前 → speaker_key の対応表
  aliases?: Record<string, string>;
  // ユーザーの役の名前。これを speaker にした行は捨てる
  selfNames?: string[];
  // プロンプトに出した番号の並び順に並べた画像 aid
  iconAids?: Record<string, string[]>;
  imageAids?: string[];
};

export class ScenePresenter implements SceneParserHandler {
  raw = "";
  unknownSpeakers: string[] = [];
  unknownIcons: string[] = [];
  selfSpeakers: string[] = [];
  noiseLines = 0;
  parseError: string | null = null;
  // この場面で起こすと宣言した出来事。本文には出さず、次のターンの few-shot にだけ戻す
  beat: string | null = null;

  private readonly speakerKeys: Set<string>;
  private readonly aliases = new Map<string, string>();
  private readonly selfNames: Set<string>;
  private readonly iconAids: Record<string, string[]>;
  private readonly imageAids: string[];
  private lines: (Line | undefined)[] = [];
  private events: SceneEvent[] = [];
  private rawChoices: string[] = [];
  private chapterCleared = false;
  private endingKeyValue: string | null = null;
  private statusValues: Record<string, string> = {};
  private rawBytes = 0;
  private readonly parser = new SceneStreamParser(this);

  constructor(options: ScenePresenterOptions = {}) {
    this.speakerKeys = new Set((options.speakerKeys ?? []).map(String));
    for (const [name, key] of Object.entries(options.aliases ?? {})) {
      const normalized = normalizeAlias(name);
      if (!this.aliases.has(normalized)) this.aliases.set(normalized, String(key));
    }
    this.selfNames = new Set((options.selfNames ?? []).map(normalizeAlias).filter((n) => isPresent(n)));
    this.iconAids = options.iconAids ?? {};
    this.imageAids = options.imageAids ?? [];
  }

  push(chunk: string): this {
    if (!chunk) return this;
    if (this.rawBytes < MAX_RAW_BYTES) {
      this.raw += chunk;
      this.rawBytes += new TextEncoder().encode(chunk).length;
    }
    this.parser.push(chunk);
    return this;
  }

  isEmpty(): boolean {
    return !this.presentLines().some((line) => isPresent(line.text));
  }

  isChapterCleared(): boolean {
    return this.chapterCleared;
  }

  get endingKey(): string | null {
    return isPresent(this.endingKeyValue) ? this.endingKeyValue : null;
  }

  // 壊れていれば空配列に倒し、UI は自由入力のままにする
  get choices(): string[] {
    return this.rawChoices.map(rubyStrip).filter((c) => isPresent(c)).slice(0, MAX_CHOICES);
  }

  // 書かれた項目だけを返す。欠けた項目は前のターンのものが生き続ける
  get status(): Record<string, string> {
    return Object.fromEntries(STATUS_KEYS.filter((key) => isPresent(this.statusValues[key])).map((key) => [key, this.statusValues[key]]));
  }

  normalized(): SceneEntry[] {
    let noise = 0;
    let images = 0;
    const result: SceneEntry[] = [];
    for (const line of this.presentLines()) {
      if (this.isSelfSpeaker(line.speaker)) continue;

      const text = stripMetaNote(line.text);
      if (isBlank(text)) continue;
      if (!ALNUM.test(text)) {
        noise += 1;
        continue;
      }

      const speaker = this.resolveSpeaker(line.speaker);
      const entry: SceneEntry = { speaker, text: speaker ? stripQuotes(text) : text };
      const icon = this.resolveIcon(speaker, line.icon);
      if (icon) entry.icon = icon;
      // 挿絵は地の文の行にだけ、1 出力 1 枚まで
      if (speaker === null && images < MAX_IMAGES) {
        const image = this.resolveImage(line.image);
        if (image) {
          entry.image = image;
          images += 1;
        }
      }
      result.push(entry);
    }
    this.noiseLines = noise;
    return result;
  }

  takeEvents(): SceneEvent[] {
    const events = this.events;
    this.events = [];
    return events;
  }

  // 上流の完了後に一度だけ呼ぶ。1 行も取れなければ全体を地の文として拾う
  finalize(): boolean {
    this.parser.finish();
    if (this.presentLines().some((line) => isPresent(line.text))) return true;

    const text = rubyStrip(this.raw);
    if (isBlank(text)) return false;

    this.parseError = "no scene line";
    this.lines = [{ index: 0, speaker: null, text, icon: null, image: null }];
    this.chapterCleared = false;
    this.endingKeyValue = null;
    return true;
  }

  // --- SceneStreamParser のハンドラ ---

  onLineStart(index: number, speaker: string | null, icon: number | null, image: number | null): void {
    const line = this.lineFor(index);
    line.speaker = speaker;
    line.icon = icon;
    line.image = image;
  }

  onLineDelta(index: number, chunk: string): void {
    const line = this.lineFor(index);
    line.text += chunk;
    // 捨てる行は流さない。出してから消すと画面がちらつく
    if (this.isSelfSpeaker(line.speaker)) return;
    this.events.push(this.eventFor(line, chunk, false));
  }

  onLineEnd(index: number): void {
    const line = this.lines[index];
    if (!line || this.isSelfSpeaker(line.speaker)) return;
    this.events.push(this.eventFor(line, "", true));
  }

  onMeta(key: string, value: string): void {
    const lower = value.toLowerCase();
    switch (key) {
      case "cleared":
      case "chapter_cleared":
        this.chapterCleared = TRUTHY.includes(lower);
        break;
      case "ending":
      case "ending_key":
        if (isPresent(value) && !BLANK_VALUES.includes(lower)) this.endingKeyValue = value;
        break;
      case "choice":
        if (isPresent(value)) this.rawChoices.push(value);
        break;
      case "choices":
        this.rawChoices.push(...value.split("|").map(rubyStrip).filter((c) => isPresent(c)));
        break;
      case "time":
      case "place":
      case "air":
        if (isPresent(value) && !BLANK_VALUES.includes(lower)) this.statusValues[key] = headChars(value, STATUS_LIMIT);
        break;
      case "beat":
        if (isPresent(value) && !BLANK_VALUES.includes(lower)) this.beat = headChars(value, BEAT_LIMIT);
        break;
    }
  }

  // icon は text より前に来るので、本文が流れ始める時点で確定している
  private eventFor(line: Line, delta: string, done: boolean): SceneEvent {
    const speaker = this.resolveSpeaker(line.speaker);
    const event: SceneEvent = { i: line.index, speaker, delta, done };
    const icon = this.resolveIcon(speaker, line.icon);
    if (icon) event.icon = icon;
    const image = speaker === null ? this.resolveImage(line.image) : undefined;
    if (image) event.image = image;
    return event;
  }

  // 番号 → aid。範囲外・画像を持たない speaker はすべて null に倒す
  private resolveIcon(speakerKey: string | null, value: number | null): string | undefined {
    const index = toIndex(value);
    if (index === null) return undefined;

    const aid = speakerKey && isPresent(speakerKey) ? this.iconAids[speakerKey]?.[index - 1] : undefined;
    const label = `${speakerKey ?? ""}:${value}`;
    if (aid === undefined && !this.unknownIcons.includes(label)) this.unknownIcons.push(label);
    return aid;
  }

  private resolveImage(value: number | null): string | undefined {
    const index = toIndex(value);
    return index === null ? undefined : this.imageAids[index - 1];
  }

  // ユーザーの役として書かれた行。出演キャラや別名で解決できるならそちらが優先される
  private isSelfSpeaker(key: string | null): boolean {
    if (isBlank(key) || this.selfNames.size === 0) return false;
    if (this.speakerKeys.has(key!) || this.aliases.has(normalizeAlias(key!))) return false;
    if (!this.selfNames.has(normalizeAlias(key!))) return false;

    if (!this.selfSpeakers.includes(key!)) this.selfSpeakers.push(key!);
    return true;
  }

  // 出演に紐づかない speaker は、その場で登場した人物として名前のまま通す
  private resolveSpeaker(key: string | null): string | null {
    if (isBlank(key)) return null;
    if (this.speakerKeys.has(key!)) return key;

    const resolved = this.aliases.get(normalizeAlias(key!));
    if (resolved) return resolved;

    if (!this.unknownSpeakers.includes(key!)) this.unknownSpeakers.push(key!);
    return key;
  }

  private lineFor(index: number): Line {
    this.lines[index] ??= { index, speaker: null, text: "", icon: null, image: null };
    return this.lines[index]!;
  }

  private presentLines(): Line[] {
    return this.lines.filter((line): line is Line => line !== undefined);
  }
}

function toIndex(value: number | null): number | null {
  return value !== null && Number.isInteger(value) && value > 0 ? value : null;
}

export function normalizeAlias(value: string): string {
  const base = String(value ?? "").toLowerCase().replace(ALIAS_NOISE, "");
  const trimmed = base.replace(HONORIFICS, "");
  return isPresent(trimmed) ? trimmed : base;
}

// 本文中の *…* は動作描写なので、注釈にくっついているものだけを落とす
function stripMetaNote(text: string): string {
  if (isBlank(text) || !META_NOTE_TEST.test(text)) return text;
  return rubyStrip(text.replace(META_NOTE_STRIP, ""));
}

// 複数のセリフが入っている行は他人のセリフが混ざっている可能性があるのでそのまま残す
function stripQuotes(text: string): string {
  if (!text.includes("「") && !text.includes("『")) return text;
  return text.split("\n").map((line) => {
    const match = QUOTED_LINE.exec(rubyStrip(line));
    return match ? match[1] : line;
  }).join("\n");
}
