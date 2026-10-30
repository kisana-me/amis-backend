// API キーなしでも生成〜配信まで通しで動かすための擬似上流 (本体の AiClient::MockProvider)。
// ai_models.provider が "mock" のときだけ使われる
import type { AiResult, ChatMessageParam, Hints } from "./ai-client";
import { headChars, isPresent, rubyStrip } from "./ruby-text";

const CHUNK_SIZE = 12;
const CHUNK_INTERVAL_MS = 40;

// 地の文には *…* を使わない (PromptBuilder の出力規約と揃える)
const NARRATIONS = [
  "窓の外を、湿った風が通り抜けていった。カーテンが一度だけ大きく膨らみ、力尽きたように元へ戻る。埃の粒が、斜めに差す光の中をゆっくりと横切っていった。",
  "沈黙は、思っていたよりも長く続いた。時計の秒針だけが、几帳面に空白を刻んでいく。誰も先に口を開こうとしないまま、空気だけが少しずつ重さを増していった。",
  "廊下の向こうから、足音が一つ近づいてくる。上履きが床を擦る、ためらいがちな音だった。それは扉の手前でぴたりと止まり、それきり動かなくなった。",
  "張り詰めていた空気が、わずかに緩んだ。誰かが小さく息を吐き、椅子の脚が短く鳴る。窓の外では、部活の掛け声が遠くで途切れ途切れに響いていた。",
];

const REPLIES = [
  "*指先で机の縁をなぞりながら*\n「……なるほど。それで、どうするの？」",
  "*少し目を伏せる*\n「そういうことなら、わたしは構わない」",
  "「本気で言ってる？」\n*こらえきれずに笑って*\n「面白い人だね」",
  "*視線を逸らしたまま*\n「……その言い方、ずるいと思う」",
];

// 毎ターン同じ状態を返すと、状態が動いているかの確認にならない
const PLACES = ["二年三組の教室", "旧校舎の階段", "屋上へ続く踊り場", "下校途中の商店街"];
const AIRS = ["探り合っている", "少しだけ打ち解けた", "気まずい沈黙が続いている", "こちらを試している"];
const CHOICES = ["黙って見つめ返す", "理由を尋ねる", "その場を離れる"];

// 場面の指定が無い呼び出しでは、1 通ぶんの素の返事だけを返す
const PLAIN_REPLIES = [
  "なるほど。それで、どうするの？",
  "そういうことなら、こちらは構わない。",
  "ちょっと待って。順番に整理しよう。",
  "了解。ほかに気になっていることは？",
];

export async function streamMock(
  messages: ChatMessageParam[],
  hints: Hints,
  onDelta: (text: string) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<AiResult> {
  const payload = buildPayload(messages, hints);
  const chars = Array.from(payload);
  for (let i = 0; i < chars.length; i += CHUNK_SIZE) {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    await onDelta(chars.slice(i, i + CHUNK_SIZE).join(""));
    await new Promise((resolve) => setTimeout(resolve, CHUNK_INTERVAL_MS));
  }

  const promptTokens = Math.floor(messages.reduce((sum, m) => sum + Array.from(m.content ?? "").length, 0) / 2);
  return {
    promptTokens,
    cachedTokens: messages.length > 2 ? Math.floor(promptTokens * 0.9) : 0,
    completionTokens: Math.floor(chars.length / 2),
    reasoningTokens: 0,
    finishReason: "stop",
    gatewayLogId: null,
  };
}

const firstLine = (text: string) => rubyStrip(text.split("\n")[0] ?? "");

function buildPayload(messages: ChatMessageParam[], hints: Hints): string {
  if (hints.mode === "summary") {
    const transcript = messages.at(-1)?.content ?? "";
    return `（擬似要約）${headChars(rubyStrip(transcript.replace(/[ \t\r\n\f\v]+/g, " ")), 200)}`;
  }
  const speakers = hints.speakerNames?.length ? hints.speakerNames : (hints.speakerKeys ?? []);
  if (speakers.length === 0) {
    const lastUser = firstLine([...messages].reverse().find((m) => m.role === "user")?.content ?? "");
    const head = isPresent(lastUser) ? `「${headChars(lastUser, 30)}」ね。\n` : "";
    return `${head}${PLAIN_REPLIES[messages.length % PLAIN_REPLIES.length]}`;
  }

  // やり直しでは同じターン番号のまま呼ばれる。ずらさないと前回と同じ本文になる
  const turn = (hints.turn ?? 0) + (hints.regenerate ?? 0);
  // 自動継続とやり直しでは末尾のユーザー発言が指示文なので、鸚鵡返しの対象にしない
  const quiet = hints.autoContinue || (hints.regenerate ?? 0) > 0;
  const lastUser = quiet ? "" : ([...messages].reverse().find((m) => m.role === "user")?.content ?? "");

  const lines = [`@: ${NARRATIONS[turn % NARRATIONS.length]}`];
  speakers.forEach((key, i) => {
    const text = i === 0 && isPresent(lastUser)
      ? `*相手の言葉を反芻するように*\n「${headChars(firstLine(lastUser), 30)}……ね」\n${REPLIES[turn % REPLIES.length]}`
      : REPLIES[(turn + i + 1) % REPLIES.length];
    lines.push(`@${key}: ${text}`);
  });

  lines.push(`@@time: 四月${8 + turn}日 放課後 十七時${String((turn * 7) % 60).padStart(2, "0")}分`);
  lines.push(`@@place: ${PLACES[turn % PLACES.length]}`);
  lines.push(`@@air: ${AIRS[turn % AIRS.length]}`);
  if (hints.choiceMode) {
    const offset = turn % CHOICES.length;
    for (const choice of [...CHOICES.slice(offset), ...CHOICES.slice(0, offset)]) lines.push(`@@choice: ${choice}`);
  }
  return lines.join("\n");
}
