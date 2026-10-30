// プロンプトを組み立てる (本体の Amis::PromptBuilder)。
// プロンプトはプレフィックスキャッシュが効くよう、変化しにくい区画から順に並べる。
// 現在時刻の埋め込みや出演キャラの並び順のブレは、プレフィックスを全損させる。
// ここは DB を引かない。必要なものは prompt-input.ts がまとめて読み込んで渡す。
// 文面は prompts/*.txt にある (本体から抜き出し、廃止した章・結末 (@@cleared / @@ending) の部分を外した)
import { REPLY_STYLES } from "../db/schema";
import type { ChatMessage } from "../views/context";
import { choices, scene, type SceneLine } from "../views/chat";
import type { ChatMessageParam, Hints } from "./ai-client";
import absoluteRules from "./prompts/absolute-rules.txt";
import choiceOffRule from "./prompts/choice-off-rule.txt";
import choiceRule from "./prompts/choice-rule.txt";
import closingRules from "./prompts/closing-rules.txt";
import continueInstruction from "./prompts/continue-instruction.txt";
import direction from "./prompts/direction.txt";
import iconRule from "./prompts/icon-rule.txt";
import imageRule from "./prompts/image-rule.txt";
import loreRule from "./prompts/lore-rule.txt";
import outputRules from "./prompts/output-rules.txt";
import regenerateInstruction from "./prompts/regenerate-instruction.txt";
import settingsHeader from "./prompts/settings-header.txt";
import settingsNotice from "./prompts/settings-notice.txt";
import userInputRule from "./prompts/user-input-rule.txt";
import { isBlank, isPresent, rubyStrip } from "./ruby-text";
import { HEAD_STATUS_KEYS, TAIL_STATUS_KEYS } from "./scene-presenter";

const DELIMITER_OPEN = "<<<CHARACTER";
const DELIMITER_CLOSE = "CHARACTER>>>";

// どれを選んでも地の文が消えないよう、下限を各文言に持たせる
const REPLY_STYLE_RULES: Record<number, string> = {
  [REPLY_STYLES.balanced]: "地の文とセリフの分量は 5:5 を目安にしてください。",
  [REPLY_STYLES.dialogue]: "セリフを多めにしてください。ただし場面の冒頭には必ず地の文を置き、地の文を 1 行以上入れます。",
  [REPLY_STYLES.narration]: "地の文を厚めにしてください。分量は 7:3 を目安にし、情景と心情を丁寧に書きます。",
};

// 説明 (situation) の付いた画像だけが候補になる。並びは position, id 順
export type LabeledImage = { aid: string; situation: string };

export type PromptCast = {
  speakerKey: string;
  roleName: string;
  roleDescription: string;
  name: string;
  persona: string;
  images: LabeledImage[];
};

export type PromptInput = {
  chat: {
    aid: string;
    choiceMode: boolean;
    replyStyle: number;
    summaries: unknown[];
  };
  plot: { situation: string };
  // position, id 順
  casts: PromptCast[];
  plotImages: LabeledImage[];
  hasLores: boolean;
  persona: { name: string; description: string } | null;
  // ペルソナが無いときのユーザーの役の名前 (アカウントの名前)
  ownerName: string;
  // プロンプトに載せる会話 (要約に畳んでいない normal のメッセージ)
  messages: ChatMessage[];
  // やり直しで不採用になった返答。新しい順
  rejected?: ChatMessage[];
  instruction?: string | null;
  autoContinue?: boolean;
  loreBlock?: string | null;
};

export class PromptBuilder {
  private readonly rejected: ChatMessage[];

  constructor(private readonly input: PromptInput) {
    this.rejected = input.rejected ?? [];
  }

  build(): ChatMessageParam[] {
    return [{ role: "system", content: this.systemPrompt() }, ...this.conversation()];
  }

  systemPrompt(): string {
    return [
      section("絶対ルール", absoluteRules),
      section("演出方針", direction),
      section("出力規約", outputRules),
      section("チャットの設定", settingsNotice),
      section("設定集(ロアブック/キーワードRAG)", this.input.hasLores ? loreRule : ""),
      section("出演キャラ", this.charactersSection()),
      section("状況設定", rubyStrip(this.input.plot.situation)),
      section("画像", this.imagesSection()),
      section("ユーザーの役", this.personaSection()),
      section("これまでのあらすじ", this.summariesSection()),
      section("出力の締めくくり", closingRules),
    ].filter((s): s is string => s !== null).join("\n\n");
  }

  get speakerKeys(): string[] {
    return this.input.casts.map((c) => c.speakerKey);
  }

  get speakerNames(): string[] {
    return this.input.casts.map((c) => rubyStrip(c.name));
  }

  get userName(): string {
    return isPresent(this.input.persona?.name) ? this.input.persona!.name : this.input.ownerName;
  }

  // ユーザーの役の名前。これを speaker にした行は受け取り側で捨てる
  get selfNames(): string[] {
    const name = this.userName;
    const names = unique([name, ...name.split(/\s+/u)].map(rubyStrip).filter((v) => isPresent(v)));
    return names.filter((n) => !this.speakerNames.includes(n));
  }

  // モデルには speaker_key ではなく名前を書かせる。受け取った名前を speaker_key に戻すための対応表で、
  // どちらの人物か決まらない別名は捨てる
  get speakerAliases(): Record<string, string> {
    const map = new Map<string, string>();
    const ambiguous = new Set<string>();
    for (const cast of this.input.casts) {
      // 姓と名の片方だけで呼ばれることが多いので、分割したものも別名に入れる
      const aliases = unique([cast.speakerKey, cast.name, ...cast.name.split(/\s+/u), cast.roleName].map(rubyStrip).filter((v) => isPresent(v)));
      for (const name of aliases) {
        if (map.has(name) && map.get(name) !== cast.speakerKey) ambiguous.add(name);
        else map.set(name, cast.speakerKey);
      }
    }
    return Object.fromEntries([...map].filter(([name]) => !ambiguous.has(name)));
  }

  // プロンプトに出すのは 1 始まりの連番だけ
  get iconAids(): Record<string, string[]> {
    return Object.fromEntries(this.input.casts.filter((c) => c.images.length > 0).map((c) => [c.speakerKey, c.images.map((i) => i.aid)]));
  }

  get imageAids(): string[] {
    return this.input.plotImages.map((i) => i.aid);
  }

  hints(): Hints {
    return {
      // 同じチャットのリクエストをプレフィックスキャッシュに寄せるためのヒント
      cacheKey: this.input.chat.aid,
      speakerKeys: this.speakerKeys,
      speakerNames: this.speakerNames,
      turn: this.input.messages.filter((m) => m.role !== 0).length,
      choiceMode: this.input.chat.choiceMode,
      autoContinue: this.input.autoContinue ?? false,
      regenerate: this.rejected.length,
    };
  }

  // --- system プロンプトの区画 ---

  // 名前を列挙しておかないと、モデルが名前を揺らしたときに同じ人物が別人として並ぶ
  private charactersSection(): string {
    const known = `この物語の登場人物です。speaker にはこの名前をそのまま書いてください: ${this.speakerNames.join(" / ")}\n`
      + "新しい人物を出す場合だけ、別の名前を speaker に書いて構いません。";
    return [known, this.characterBlocks()].join("\n\n");
  }

  private characterBlocks(): string {
    return this.input.casts.map((cast) => {
      const lines = [`## ${cast.name}`];
      if (isPresent(cast.roleName)) lines.push(`役: ${cast.roleName}`);
      lines.push(`${DELIMITER_OPEN}\n${rubyStrip(cast.persona)}\n${DELIMITER_CLOSE}`);
      if (isPresent(cast.roleDescription)) {
        lines.push(`この物語での補足:\n${DELIMITER_OPEN}\n${rubyStrip(cast.roleDescription)}\n${DELIMITER_CLOSE}`);
      }
      if (cast.images.length > 0) lines.push(`表情: ${numbered(cast.images)}`);
      return lines.join("\n");
    }).join("\n\n");
  }

  private imagesSection(): string {
    const parts: string[] = [];
    if (Object.keys(this.iconAids).length > 0) parts.push(rubyStrip(iconRule));
    if (this.imageAids.length > 0) parts.push(`${rubyStrip(imageRule)}\n\n${numbered(this.input.plotImages)}`);
    return parts.join("\n\n");
  }

  private personaSection(): string {
    const persona = this.input.persona;
    const lines = persona
      ? [`名前: ${persona.name}`, ...(isPresent(persona.description) ? [persona.description] : [])]
      : [`名前: ${this.userName}`];
    return [rubyStrip(userInputRule), ...lines].join("\n\n");
  }

  private summariesSection(): string {
    return this.input.chat.summaries.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
      const text = rubyStrip(str((entry as Record<string, unknown>).text));
      return isBlank(text) ? [] : [text];
    }).join("\n\n");
  }

  // --- 会話 ---

  // やり直しの対象は会話から外し、代わりに末尾のブロックへ「不採用の出力」として置く。
  // 前段はやり直す前と完全に同じ並びになるので、プレフィックスキャッシュがそのまま効く。
  // 設定集と現在の設定も同じ理由で末尾に置く
  private conversation(): ChatMessageParam[] {
    const rejectedIds = new Set(this.rejected.map((m) => m.id));
    const messages: ChatMessageParam[] = this.input.messages.filter((m) => !rejectedIds.has(m.id)).map((message) =>
      message.role === 0
        ? { role: "user", content: scene(message).map((line) => line.text).join("\n") }
        : { role: "assistant", content: this.assistantContent(message) });

    // 設定集は指示より前。参考情報を先に置き、生成の直前は必ず「何をしてほしいか」で終わらせる
    if (isPresent(this.input.loreBlock)) messages.push({ role: "user", content: this.input.loreBlock! });
    messages.push({ role: "user", content: this.settingsBlock() });

    if (this.rejected.length > 0) messages.push({ role: "user", content: this.regenerateBlock() });
    else if (this.input.autoContinue) messages.push({ role: "user", content: rubyStrip(continueInstruction) });
    return messages;
  }

  // 設定の実際の値はここにだけ書く。切り替えても system プロンプトが変わらず、履歴のプレフィックスが生き残る
  private settingsBlock(): string {
    const style = REPLY_STYLE_RULES[this.input.chat.replyStyle] ?? REPLY_STYLE_RULES[REPLY_STYLES.balanced];
    return [
      rubyStrip(settingsHeader),
      `## 地の文とセリフの分量\n${style}`,
      `## 選択肢\n${rubyStrip(this.input.chat.choiceMode ? choiceRule : choiceOffRule)}`,
    ].join("\n\n");
  }

  // 兄弟を全部並べる。1 本だけだと 2 回目以降のやり直しで同じ場面に収束する
  private regenerateBlock(): string {
    const parts = [rubyStrip(regenerateInstruction), ...this.rejected.map((m) => `# 不採用の出力\n${this.assistantContent(m)}`)];
    if (isPresent(this.input.instruction)) parts.push(`# ユーザーからのやり直しの指示\n${this.input.instruction}`);
    return parts.join("\n\n");
  }

  // 直前までの自分の出力が few-shot になる。choices や状態を落とすと 2 回目から書かなくなる。
  // 並び順も出力規約と揃える (舞台と段取りは本文の前、空気は後ろ)
  private assistantContent(message: ChatMessage): string {
    const status = (typeof message.meta.scene_status === "object" && message.meta.scene_status !== null
      ? message.meta.scene_status : {}) as Record<string, unknown>;
    const lines = HEAD_STATUS_KEYS.filter((key) => isPresent(status[key])).map((key) => `@@${key}: ${status[key]}`);
    const beat = str(message.meta.scene_beat);
    if (isPresent(beat)) lines.push(`@@beat: ${beat}`);
    lines.push(...scene(message).map((line) => this.replayLine(line)));
    for (const key of TAIL_STATUS_KEYS) if (isPresent(status[key])) lines.push(`@@${key}: ${status[key]}`);
    lines.push(...choices(message).map((choice) => `@@choice: ${choice}`));
    return lines.join("\n");
  }

  // 保存してあるのは aid なので、few-shot に戻すときは番号へ引き直す。speaker_key ではなく表示名に戻す
  private replayLine(line: SceneLine): string {
    const speaker = str(line.speaker);
    const cast = this.input.casts.find((c) => c.speakerKey === speaker);
    const name = cast ? rubyStrip(cast.name) : speaker;
    const icon = this.iconAids[speaker]?.indexOf(String(line.icon));
    const image = this.imageAids.indexOf(String(line.image));
    const number = isPresent(name) && icon !== undefined && icon >= 0 ? `[${icon + 1}]`
      : isBlank(name) && image >= 0 ? `[${image + 1}]` : "";
    return `@${name}${number}: ${line.text}`;
  }
}

function section(title: string, body: string): string | null {
  return isBlank(body) ? null : `# ${title}\n${rubyStrip(body)}`;
}

function numbered(rows: LabeledImage[]): string {
  return rows.map((row, i) => `${i + 1}=${rubyStrip(row.situation)}`).join(" / ");
}

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const unique = <T,>(values: T[]) => [...new Set(values)];
