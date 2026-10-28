// 本体の test/services/ai_client_test.rb を移したもの
import { describe, expect, it } from "vitest";
import { type AiResult, chatCompletions, emptyResult, responses, streamCompletion, supportedApi, UpstreamError } from "../src/generation/ai-client";
import type { AiModel } from "../src/views/context";

const MESSAGES = [
  { role: "system", content: "あなたは記録係です" },
  { role: "user", content: "こんにちは" },
];

function model(overrides: Partial<AiModel> = {}): AiModel {
  return {
    id: 1, aid: "model", name: "test", description: "", provider: "openai", upstreamModel: "gpt-5.6-sol",
    api: 1, route: 0, tier: 0, status: 0, maxRating: 2, contextWindow: 0, maxOutputTokens: 4_096,
    inputPriceMicro: 0, cachedInputPriceMicro: 0, outputPriceMicro: 0, position: 0, requestParams: {}, meta: {},
    createdAt: new Date(), updatedAt: new Date(), ...overrides,
  };
}

function feed(format: typeof responses, events: Record<string, any>[], result: AiResult = emptyResult()) {
  let text = "";
  for (const event of events) text += format.consume(event, result).join("");
  return [text, result] as const;
}

describe("responses", () => {
  it("body は input / max_output_tokens / store: false で組む", () => {
    const body = responses.body(model(), MESSAGES, {});
    expect(body.input).toEqual(MESSAGES);
    expect(body.max_output_tokens).toBe(4_096);
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body).not.toHaveProperty("messages");
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("max_output_tokens は 0 なら送らない", () => {
    expect(responses.body(model({ maxOutputTokens: 0 }), MESSAGES, {})).not.toHaveProperty("max_output_tokens");
  });

  it("cache_key があれば prompt_cache_key として渡す", () => {
    expect(responses.body(model(), MESSAGES, { cacheKey: "abc123" }).prompt_cache_key).toBe("abc123");
    expect(responses.body(model(), MESSAGES, {})).not.toHaveProperty("prompt_cache_key");
  });

  it("request_params の null はキーごと落ちる", () => {
    const body = responses.body(model({ requestParams: { reasoning: { effort: "low" }, store: null } }), MESSAGES, {});
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body).not.toHaveProperty("store");
  });

  it("output_text のデルタだけを流す", () => {
    const [text] = feed(responses, [
      { type: "response.created" },
      { type: "response.output_text.delta", delta: "こん" },
      { type: "response.reasoning_summary_text.delta", delta: "推論の要約" },
      { type: "response.output_text.delta", delta: "にちは" },
      { type: "response.output_text.done", text: "こんにちは" },
    ]);
    expect(text).toBe("こんにちは");
  });

  it("usage は input/output を prompt/completion に寄せる", () => {
    const [, result] = feed(responses, [{
      type: "response.completed",
      response: {
        status: "completed",
        usage: {
          input_tokens: 1200, output_tokens: 300,
          input_tokens_details: { cached_tokens: 1024 }, output_tokens_details: { reasoning_tokens: 64 },
        },
      },
    }]);
    expect(result).toMatchObject({ promptTokens: 1200, cachedTokens: 1024, completionTokens: 300, reasoningTokens: 64, finishReason: "stop" });
  });

  it("打ち切りは chat completions の語彙に寄せる", () => {
    const [, result] = feed(responses, [{ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }]);
    expect(result.finishReason).toBe("length");
  });

  it("失敗イベントは UpstreamError にする", () => {
    expect(() => responses.consume({ type: "error", code: "rate_limit_exceeded", message: "slow down" }, emptyResult()))
      .toThrow(new UpstreamError("upstream error: slow down"));
  });

  it("[DONE] は来ない", () => {
    expect(responses.done("[DONE]")).toBe(false);
  });
});

describe("chat completions", () => {
  it("body は messages / max_tokens で組む", () => {
    const body = chatCompletions.body(model({ api: 0, provider: "deepseek" }), MESSAGES, {});
    expect(body.messages).toEqual(MESSAGES);
    expect(body.max_tokens).toBe(4_096);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(chatCompletions.done("[DONE]")).toBe(true);
  });

  it("デルタと usage をこれまでどおり読む", () => {
    const [text, result] = feed(chatCompletions, [
      { choices: [{ delta: { content: "やあ" } }] },
      { choices: [{ delta: { content: "" }, finish_reason: "stop" }] },
      { usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 90 } },
    ]);
    expect(text).toBe("やあ");
    expect(result.finishReason).toBe("stop");
    expect(result.cachedTokens).toBe(90);
  });
});

describe("provider と api の組み合わせ", () => {
  it("provider が対応していない形式は使えない", () => {
    expect(supportedApi("openai", "responses")).toBe(true);
    expect(supportedApi("deepseek", "responses")).toBe(false);
    // mock を含む未知の provider は provider 側の話なので通す
    expect(supportedApi("mock", "responses")).toBe(true);
    expect(supportedApi("google-ai-studio", "chat_completions")).toBe(true);
    expect(supportedApi("google-ai-studio", "responses")).toBe(false);
  });
});

// ここから下は移植で足したもの
describe("streamCompletion", () => {
  it("mock は台本を少しずつ流し、場面の状態とクリアの判定まで書く", async () => {
    let text = "";
    const result = await streamCompletion(model({ provider: "mock" }), MESSAGES, { speakerNames: ["雪"], turnsInChapter: 2, objective: "仲直り" }, {}, (d) => {
      text += d;
    });
    expect(text).toMatch(/^@: /);
    expect(text).toContain("@雪: *相手の言葉を反芻するように*\n「こんにちは……ね」");
    expect(text).toContain("@@cleared: true");
    expect(text).not.toContain("@@ending");
    expect(result.finishReason).toBe("stop");
  });

  it("上流の SSE を行ごとに読み、途中で切れた行は次のチャンクとつなぐ", async () => {
    const chunks = ['data: {"choices":[{"delta":{"content":"や', 'あ"}}]}\n\ndata: {"usage":{"prompt_tokens":5,"completion_tokens":1}}\n', "data: [DONE]\n"];
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }), { headers: { "cf-aig-log-id": "log1" } });
    try {
      let text = "";
      const result = await streamCompletion(model({ api: 0, provider: "deepseek", route: 1 }), MESSAGES, {}, { DEEPSEEK_API_KEY: "key" }, (d) => {
        text += d;
      });
      expect(text).toBe("やあ");
      expect(result).toMatchObject({ promptTokens: 5, completionTokens: 1, gatewayLogId: "log1" });
    } finally {
      globalThis.fetch = original;
    }
  });
});
