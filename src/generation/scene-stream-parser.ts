// 行形式のインクリメンタルパーサ (本体の Amis::SceneStreamParser)。
//
//   @: 地の文
//   @白峰 琴葉: *封筒を差し出す*
//   断ってもいいの                  ← ヘッダに一致しない行は直前の行の続き
//   @白峰 琴葉[2]: セリフ            ← [2] は表情
//   @[1]: 挿絵つきの地の文           ← 名前が無ければ [1] は挿絵
//   @@cleared: true                 ← メタ行
//
// JSON と違い「壊れる」状態が無く、ヘッダを取り損ねても本文として残る。
// 上流のバイト列は呼び出し側が TextDecoder (stream: true) で文字列にしてから渡すので、
// 本体にあったマルチバイト文字の持ち越しはここでは要らない
import { BLANK, charLength, isPresent, rubyStrip } from "./ruby-text";

export type SceneParserHandler = {
  onLineStart(index: number, speaker: string | null, icon: number | null, image: number | null): void;
  onLineDelta(index: number, chunk: string): void;
  onLineEnd(index: number): void;
  onMeta(key: string, value: string): void;
};

// 名前に : [ ] @ は使えない。ヘッダ直後の空白ひとつは区切りとして食う
const HEADER = new RegExp(`^@(?<name>[^:：\\[\\]\\n@]{0,50})(?:\\[(?<number>\\d{1,3})\\])?[:：]${BLANK}?`, "u");
const META = new RegExp(`^@@(?<key>[A-Za-z_]{1,20})[:：]${BLANK}*(?<value>[\\s\\S]*)$`, "u");
const BLANK_CHAR = new RegExp(`^${BLANK}$`, "u");
// ヘッダなら必ずこの長さまでに区切りが来る。超えたら本文として流す
const MAX_HEADER = 64;

export class SceneStreamParser {
  private pending = "";
  private deltaBuf = "";
  private inBody = false;
  private open = false;
  private index = -1;
  // 物理行が終わっただけでは改行を流さない。次が続きの行だと分かってから足す
  private oweNewline = false;
  private skipBlank = false;
  private finished = false;

  constructor(private readonly handler: SceneParserHandler) {}

  push(text: string): this {
    if (!text || this.finished) return this;
    for (const ch of text) this.step(ch);
    this.flushDelta();
    return this;
  }

  // 上流の完了後に一度だけ呼ぶ。ヘッダを書きかけたまま切れた末尾は捨てる
  finish(): void {
    if (this.finished) return;

    if (this.pending.startsWith("@@")) {
      this.emitMeta(this.pending);
    } else if (isPresent(this.pending) && !this.pending.startsWith("@")) {
      this.startContinuation(this.pending);
    }
    this.flushDelta();
    this.closeLine();
    this.finished = true;
  }

  private step(ch: string): void {
    if (this.inBody) return this.bodyChar(ch);
    if (ch === "\n") return this.lineStartBreak();

    this.pending += ch;
    if (this.pending.startsWith("@@")) return; // メタ行は改行まで溜める
    if (!this.pending.startsWith("@")) return this.startContinuation(this.pending);

    const header = HEADER.exec(this.pending);
    if (header) return this.openLine(header);
    if (charLength(this.pending) > MAX_HEADER) this.startContinuation(this.pending);
  }

  private bodyChar(ch: string): void {
    // ヘッダ直後の空白ひとつは区切り。1 文字ずつ届くと正規表現側で食えないのでここで落とす
    if (this.skipBlank) {
      this.skipBlank = false;
      if (BLANK_CHAR.test(ch)) return;
    }
    if (ch !== "\n") {
      this.deltaBuf += ch;
      return;
    }

    // 物理行の終わり。続きの行が来たときだけ改行として復元する
    this.inBody = false;
    this.pending = "";
    this.oweNewline = true;
  }

  // 行頭のまま改行が来た。空行か、ヘッダにならないまま終わった短い行
  private lineStartBreak(): void {
    if (this.pending.startsWith("@@")) {
      this.emitMeta(this.pending);
    } else if (isPresent(this.pending)) {
      this.startContinuation(this.pending);
      this.inBody = false;
      this.oweNewline = true;
    }
    this.pending = "";
  }

  private openLine(match: RegExpExecArray): void {
    this.closeLine();
    this.index += 1;
    this.open = true;
    this.oweNewline = false;
    this.inBody = true;
    const name = rubyStrip(match.groups?.name ?? "") || null;
    const number = match.groups?.number === undefined ? null : Number(match.groups.number);
    // 名前があれば表情、無ければ挿絵の番号
    this.handler.onLineStart(this.index, name, name ? number : null, name ? null : number);

    const rest = this.pending.slice(match[0].length);
    this.pending = "";
    // 区切りの空白がまだ届いていなければ、本文の 1 文字目で落とす
    this.skipBlank = rest === "";
    if (isPresent(rest)) this.deltaBuf += rest;
  }

  // ヘッダにならなかった行。直前の行の続きとして流す
  private startContinuation(text: string): void {
    if (!this.open) this.openLineWithoutHeader();
    if (this.oweNewline) this.deltaBuf += "\n";
    this.oweNewline = false;
    this.deltaBuf += text;
    this.pending = "";
    this.inBody = true;
  }

  // 出力がいきなり本文から始まったときの受け皿。地の文として開く
  private openLineWithoutHeader(): void {
    this.index += 1;
    this.open = true;
    this.handler.onLineStart(this.index, null, null, null);
  }

  private closeLine(): void {
    if (!this.open) return;
    this.flushDelta();
    this.handler.onLineEnd(this.index);
    this.open = false;
  }

  private flushDelta(): void {
    if (this.deltaBuf === "" || !this.open) return;
    const chunk = this.deltaBuf;
    this.deltaBuf = "";
    this.handler.onLineDelta(this.index, chunk);
  }

  private emitMeta(line: string): void {
    const match = META.exec(line);
    if (match?.groups) this.handler.onMeta(match.groups.key.toLowerCase(), rubyStrip(match.groups.value ?? ""));
  }
}
