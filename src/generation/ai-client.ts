// 上流の AI を呼ぶ (本体の AiClient / AiClient::Format::*)。
// ここが持つのは経路 (どこへ行くか) と HTTP だけで、線の上を流れる形は Format が持つ。
// Cloudflare AI Gateway を挟むかどうかはモデルごとに ai_models.route が決める
import { AI_MODEL_APIS, AI_MODEL_ROUTES } from "../db/schema";
import type { AiModel } from "../views/context";
import { streamMock } from "./mock-provider";
import { isPresent } from "./ruby-text";

export class AiClientError extends Error {}
export class UpstreamError extends AiClientError {}

export type ChatMessageParam = { role: string; content: string };

export type AiResult = {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  finishReason: string | null;
  gatewayLogId: string | null;
};

// PromptBuilder がモデルに合わせて渡す付随情報。MockProvider は台本作りに、Responses はキャッシュの寄せ先に使う
export type Hints = {
  cacheKey?: string;
  mode?: "summary";
  speakerKeys?: string[];
  speakerNames?: string[];
  turnsInChapter?: number;
  regenerate?: number;
  autoContinue?: boolean;
  objective?: string;
  choiceMode?: boolean;
};

// API キーと AI Gateway の設定は Worker の secret に置く
export type AiEnv = Partial<Record<
  | "CF_AI_GATEWAY_ACCOUNT_ID" | "CF_AI_GATEWAY_NAME" | "CF_AI_GATEWAY_TOKEN"
  | "DEEPSEEK_API_KEY" | "OPENROUTER_API_KEY" | "OPENAI_API_KEY" | "GOOGLE_AI_STUDIO_API_KEY"
  | "CLOUDFLARE_API_TOKEN" | "CLOUDFLARE_ACCOUNT_ID",
  string
>>;

type ApiName = "chat_completions" | "responses";
type Provider = {
  base: string;
  keyEnv: keyof AiEnv;
  accountEnv?: keyof AiEnv;
  // gatewayPath があるものは gateway.ai.cloudflare.com に URL ごと差し替える。
  // Workers AI だけは URL が固定で、Gateway は cf-aig-gateway-id ヘッダで挟む (gatewayPath: null)
  paths: Partial<Record<ApiName, { path: string; gatewayPath: string | null }>>;
};

const PROVIDERS: Record<string, Provider> = {
  deepseek: {
    base: "https://api.deepseek.com", keyEnv: "DEEPSEEK_API_KEY",
    paths: { chat_completions: { path: "/chat/completions", gatewayPath: "/chat/completions" } },
  },
  openrouter: {
    base: "https://openrouter.ai/api", keyEnv: "OPENROUTER_API_KEY",
    paths: { chat_completions: { path: "/v1/chat/completions", gatewayPath: "/v1/chat/completions" } },
  },
  openai: {
    base: "https://api.openai.com", keyEnv: "OPENAI_API_KEY",
    paths: {
      chat_completions: { path: "/v1/chat/completions", gatewayPath: "/chat/completions" },
      responses: { path: "/v1/responses", gatewayPath: "/responses" },
    },
  },
  // Gemini は OpenAI 互換エンドポイントで喋らせる。キーは provider 名でそのまま Gateway の URL に入る
  "google-ai-studio": {
    base: "https://generativelanguage.googleapis.com", keyEnv: "GOOGLE_AI_STUDIO_API_KEY",
    paths: { chat_completions: { path: "/v1beta/openai/chat/completions", gatewayPath: "/v1beta/openai/chat/completions" } },
  },
  "workers-ai": {
    base: "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai",
    keyEnv: "CLOUDFLARE_API_TOKEN", accountEnv: "CLOUDFLARE_ACCOUNT_ID",
    paths: { chat_completions: { path: "/v1/chat/completions", gatewayPath: null } },
  },
};

// チャンク間の無音。総時間ではない
const READ_TIMEOUT_MS = 30_000;

// 管理画面で弾くための照会。未知の provider (mock を含む) は provider 側の話なので通す
export function supportedApi(provider: string, api: ApiName): boolean {
  const config = PROVIDERS[provider];
  return config === undefined || config.paths[api] !== undefined;
}

export function emptyResult(): AiResult {
  return { promptTokens: 0, cachedTokens: 0, completionTokens: 0, reasoningTokens: 0, finishReason: null, gatewayLogId: null };
}

const apiName = (model: AiModel): ApiName => (model.api === AI_MODEL_APIS.responses ? "responses" : "chat_completions");

// 上流をストリームで叩き、本文のデルタを onDelta に渡す。戻り値は使用量などのメタ情報
export async function streamCompletion(
  model: AiModel,
  messages: ChatMessageParam[],
  hints: Hints,
  env: AiEnv,
  onDelta: (text: string) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<AiResult> {
  if (model.provider === "mock") return streamMock(messages, hints, onDelta, signal);

  const config = PROVIDERS[model.provider];
  if (!config) throw new AiClientError(`unknown provider: ${model.provider}`);
  const paths = config.paths[apiName(model)];
  if (!paths) throw new AiClientError(`${model.provider} does not support ${apiName(model)}`);

  const format = apiName(model) === "responses" ? responses : chatCompletions;
  const route = resolvedRoute(model, env);
  const gateway = route !== "direct";
  // cf_aig / cf_aig_byok は「必ず通す」。設定が落ちていたら黙って直叩きに逃げず、はっきり落とす
  if (gateway && !gatewayConfigured(env)) {
    throw new AiClientError(`CF_AI_GATEWAY_ACCOUNT_ID / CF_AI_GATEWAY_NAME is not set (route: ${route})`);
  }

  const url = gateway && paths.gatewayPath !== null
    ? `https://gateway.ai.cloudflare.com/v1/${env.CF_AI_GATEWAY_ACCOUNT_ID}/${env.CF_AI_GATEWAY_NAME}/${model.provider}${paths.gatewayPath}`
    : `${config.base.replace("{account_id}", accountId(config, env) ?? "")}${paths.path}`;

  // BYOK は Gateway 側の保存キーを使う経路なので、こちらから Authorization を付けてはいけない
  const byok = route === "cf_aig_byok" && paths.gatewayPath !== null;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    ...(byok ? {} : bearer(apiKey(config, env))),
  };
  if (gateway) {
    if (paths.gatewayPath === null && env.CF_AI_GATEWAY_NAME) headers["cf-aig-gateway-id"] = env.CF_AI_GATEWAY_NAME;
    if (env.CF_AI_GATEWAY_TOKEN) headers["cf-aig-authorization"] = `Bearer ${env.CF_AI_GATEWAY_TOKEN}`;
  }

  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(format.body(model, messages, hints)), signal });
  if (!response.ok || !response.body) {
    throw new UpstreamError(`upstream returned ${response.status}`);
  }

  const result = emptyResult();
  result.gatewayLogId = response.headers.get("cf-aig-log-id");
  await readSse(response.body, async (payload) => {
    if (format.done(payload)) return true;
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      return false;
    }
    for (const text of format.consume(event as Record<string, any>, result)) await onDelta(text);
    return false;
  });
  return result;
}

// SSE の data 行を 1 件ずつ渡す。行が途中で切れたぶんは次のチャンクまで持ち越す。
// onData が true を返したら終端
async function readSse(body: ReadableStream<Uint8Array>, onData: (payload: string) => Promise<boolean>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await readWithTimeout(reader);
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line === "" || line.startsWith(":") || !line.startsWith("data:")) continue;
        if (await onData(line.slice("data:".length).trim())) return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function readWithTimeout(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new UpstreamError("upstream read timeout")), READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// 経路はモデルごとに決まる。auto だけは実行時に決まる。Gateway が使えるなら cf_aig_byok、駄目なら direct
function resolvedRoute(model: AiModel, env: AiEnv): "direct" | "cf_aig" | "cf_aig_byok" {
  if (model.route === AI_MODEL_ROUTES.direct) return "direct";
  if (model.route === AI_MODEL_ROUTES.cf_aig) return "cf_aig";
  if (model.route === AI_MODEL_ROUTES.cf_aig_byok) return "cf_aig_byok";
  return gatewayConfigured(env) ? "cf_aig_byok" : "direct";
}

const gatewayConfigured = (env: AiEnv) => isPresent(env.CF_AI_GATEWAY_ACCOUNT_ID) && isPresent(env.CF_AI_GATEWAY_NAME);

function accountId(config: Provider, env: AiEnv): string | null {
  if (!config.accountEnv) return null;
  const value = env[config.accountEnv];
  if (!isPresent(value)) throw new AiClientError(`${config.accountEnv} is not set`);
  return value!;
}

function apiKey(config: Provider, env: AiEnv): string {
  const value = env[config.keyEnv];
  if (!isPresent(value)) throw new AiClientError(`${config.keyEnv} is not set`);
  return value!;
}

const bearer = (key: string): Record<string, string> => (isPresent(key) ? { Authorization: `Bearer ${key}` } : {});

// --- 線の上を流れる形 ---------------------------------------------------------

type Format = {
  body(model: AiModel, messages: ChatMessageParam[], hints: Hints): Record<string, unknown>;
  // SSE の data 行 1 件ぶん。本文のデルタを返す
  consume(event: Record<string, any>, result: AiResult): string[];
  // 終端をリテラルの data 行で送ってくる形式のためのフック
  done(payload: string): boolean;
};

// thinking の無効化などはすべて ai_models.request_params 側で管理する。null を入れたらキーごと落とす
function applyRequestParams(model: AiModel, payload: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...payload, ...model.requestParams };
  return Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== null && v !== undefined));
}

const num = (v: unknown) => Math.trunc(Number(v) || 0);

// OpenAI Chat Completions 形式。deepseek / openrouter / workers-ai も同じ線で喋る
export const chatCompletions: Format = {
  done: (payload) => payload === "[DONE]",
  body(model, messages) {
    const payload: Record<string, unknown> = {
      model: model.upstreamModel,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    // 0 は「送らない」の意味
    if (model.maxOutputTokens > 0) payload.max_tokens = model.maxOutputTokens;
    return applyRequestParams(model, payload);
  },
  consume(event, result) {
    const usage = event.usage;
    if (usage && typeof usage === "object" && !Array.isArray(usage)) {
      if (usage.prompt_tokens != null) result.promptTokens = num(usage.prompt_tokens);
      if (usage.completion_tokens != null) result.completionTokens = num(usage.completion_tokens);
      // DeepSeek は prompt_cache_hit_tokens、OpenAI 互換は prompt_tokens_details.cached_tokens
      const cached = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens;
      if (cached != null) result.cachedTokens = num(cached);
      const reasoning = usage.completion_tokens_details?.reasoning_tokens;
      if (reasoning != null) result.reasoningTokens = num(reasoning);
    }
    const choice = Array.isArray(event.choices) ? event.choices[0] : undefined;
    if (!choice) return [];
    if (isPresent(choice.finish_reason)) result.finishReason = String(choice.finish_reason);
    const text = choice.delta?.content;
    return typeof text === "string" && text !== "" ? [text] : [];
  },
};

// 打ち切りの理由は chat completions 側の語彙に寄せる
const INCOMPLETE_REASONS: Record<string, string> = { max_output_tokens: "length", content_filter: "content_filter" };

// OpenAI Responses 形式。本文が型付きイベントで流れ、usage の名前が input/output になる
export const responses: Format = {
  done: () => false,
  body(model, messages, hints) {
    const payload: Record<string, unknown> = {
      model: model.upstreamModel,
      input: messages,
      stream: true,
      // 毎ターンプロンプトを組み直す stateless 運用なので、上流に応答を預ける理由が無い
      store: false,
    };
    if (model.maxOutputTokens > 0) payload.max_output_tokens = model.maxOutputTokens;
    // 同じチャットのリクエストをキャッシュノードへ寄せるためのヒント
    if (isPresent(hints.cacheKey)) payload.prompt_cache_key = hints.cacheKey;
    return applyRequestParams(model, payload);
  },
  consume(event, result) {
    switch (event.type) {
      case "response.output_text.delta":
        return typeof event.delta === "string" && event.delta !== "" ? [event.delta] : [];
      case "response.completed":
      case "response.incomplete": {
        const response = event.response;
        if (!response || typeof response !== "object") return [];
        const usage = response.usage;
        if (usage && typeof usage === "object") {
          if (usage.input_tokens != null) result.promptTokens = num(usage.input_tokens);
          if (usage.output_tokens != null) result.completionTokens = num(usage.output_tokens);
          if (usage.input_tokens_details?.cached_tokens != null) result.cachedTokens = num(usage.input_tokens_details.cached_tokens);
          if (usage.output_tokens_details?.reasoning_tokens != null) result.reasoningTokens = num(usage.output_tokens_details.reasoning_tokens);
        }
        const reason = response.incomplete_details?.reason;
        result.finishReason = reason ? (INCOMPLETE_REASONS[reason] ?? reason) : "stop";
        return [];
      }
      case "response.failed":
      case "error": {
        const source = event.response?.error ?? event.error ?? event;
        const message = isPresent(source?.message) ? source.message : isPresent(source?.code) ? source.code : event.type;
        throw new UpstreamError(`upstream error: ${message}`);
      }
      // response.reasoning_summary_text.delta は本文ではないので流さない
      default:
        return [];
    }
  },
};
