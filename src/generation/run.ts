// 1 通ぶんの生成 (本体の Amis::ChatCompletionJob)。
// SSE のリクエストの中で動く。クライアントが切断しても waitUntil で続くが、Workers の制約で切断から最大 30 秒まで。
// それを超えて止まったものは、streamed_at が更新されなくなるので stalled として失敗に倒される (stream.ts)
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { aiUsages, characters, chatMessages, chats, MESSAGE_STATUSES } from "../db/schema";
import type { Bindings } from "../env";
import type { Chat, ChatMessage, Plot } from "../views/context";
import { loadCasts } from "../views/context";
import { type AiResult, streamCompletion } from "./ai-client";
import { loreBlock, loreHitsFor } from "./lore-matcher";
import { allowsRating, contentRating, costMicro, findModelById, usableModel } from "./models";
import { PromptBuilder } from "./prompt-builder";
import { loadPromptInput, promptMessages } from "./prompt-input";
import { knownTexts, trim } from "./replay-trimmer";
import { isPresent } from "./ruby-text";
import { type SceneEntry, type SceneEvent, ScenePresenter } from "./scene-presenter";
import type { Emit } from "./sse";
import { summarize } from "./summary";
import { rateText } from "./text-rating";
import { variantsOf } from "./variants";

const PUBLISH_INTERVAL_MS = 100;
const PERSIST_INTERVAL_MS = 1000;
const WALL_CLOCK_LIMIT_MS = 180_000;
// プロンプトに載せる不採用の出力。増やすほど前の案に引きずられ、トークンも伸びる
const MAX_REJECTED = 3;
// ローリング要約を走らせる会話の長さ
const ROLLING_TRIGGER_MESSAGES = 40;

class Canceled extends Error {}
class WallClockExceeded extends Error {}

type Status = "normal" | "failed" | "canceled";
const STATUS_VALUES: Record<Status, number> = {
  normal: MESSAGE_STATUSES.normal, failed: MESSAGE_STATUSES.failed, canceled: MESSAGE_STATUSES.canceled,
};

// waitUntil: 要約のように、done を送ったあとに続ける処理を載せる
export type RunDeps = { db: Db; env: Bindings; ownerName: string; waitUntil: (promise: Promise<unknown>) => void };

// message はすでに pending から streaming に切り替えてある (このリクエストが生成を受け持つ)
export async function runGeneration(deps: RunDeps, chat: Chat, plot: Plot, message: ChatMessage, emit: Emit): Promise<void> {
  const run = new Generation(deps, chat, plot, message, emit);
  await run.perform();
}

class Generation {
  private presenter: ScenePresenter | null = null;
  private source: ChatMessage | null = null;
  private seq = 0;
  private started = 0;
  private ttftMs: number | null = null;

  constructor(
    private readonly deps: RunDeps,
    private chat: Chat,
    private readonly plot: Plot,
    private readonly message: ChatMessage,
    private readonly emit: Emit,
  ) {}

  async perform(): Promise<void> {
    const { db, env } = this.deps;
    await this.emit({ type: "snapshot", seq: 0, scene: [], status: "streaming" });
    const abort = new AbortController();
    let persistTimer: ReturnType<typeof setInterval> | undefined;
    let model = null;

    try {
      const rating = await contentRating(db, this.plot);
      model = await usableModel(db, rating, await findModelById(db, this.message.aiModelId ?? this.chat.aiModelId));
      // 送ってから生成するまでの間にレーティングが上がることがある。上流に渡す直前のここが最後の関所
      if (!model || !allowsRating(model, rating)) throw new Error("レーティングが変わったため、このモデルでは生成できません");

      // やり直しなら、いま表示している返答とその兄弟をまとめて「不採用」として渡す
      const regenerateOf = this.message.meta.regenerate_of;
      if (typeof regenerateOf === "string" && regenerateOf !== "") {
        const [source] = await db.select().from(chatMessages)
          .where(and(eq(chatMessages.chatId, this.chat.id), eq(chatMessages.aid, regenerateOf))).limit(1);
        this.source = source ?? null;
      }
      const rejected = this.source ? (await variantsOf(db, this.source)).slice(-MAX_REJECTED).reverse() : [];

      // 直近の会話に当たった設定。不採用にした返答はプロンプトから外しているので、走査からも外す
      const hits = await loreHitsFor(db, this.chat, rejected.map((m) => m.id));
      if (hits.length > 0) {
        // 発火の記録。title はその時点の写しで、見出しが空なら当たったキーワードを出す
        this.message.meta = {
          ...this.message.meta,
          lores: hits.map((hit) => ({ id: hit.entry.id, title: isPresent(hit.entry.title) ? hit.entry.title : hit.keyword })),
        };
        await db.update(chatMessages).set({ meta: this.message.meta }).where(eq(chatMessages.id, this.message.id));
      }

      const builder = new PromptBuilder(await loadPromptInput(db, this.chat, this.plot, this.deps.ownerName, {
        autoContinue: this.message.meta.auto === true,
        rejected,
        instruction: typeof this.message.meta.instruction === "string" ? this.message.meta.instruction : null,
        loreBlock: loreBlock(hits),
      }));
      const prompt = builder.build();
      this.presenter = new ScenePresenter({
        speakerKeys: builder.speakerKeys, aliases: builder.speakerAliases, selfNames: builder.selfNames,
        iconAids: builder.iconAids, imageAids: builder.imageAids,
      });

      this.started = Date.now();
      let lastPublish = 0;
      let canceled = false;
      // 差分が来ない間 (推論中など) も streamed_at を進める。止まった生成と見分けるため
      persistTimer = setInterval(() => {
        void this.persistSnapshot().then((alive) => {
          if (!alive && !canceled) {
            canceled = true;
            abort.abort(new Canceled());
          }
        });
      }, PERSIST_INTERVAL_MS);

      const result = await streamCompletion(model, prompt, builder.hints(), env, async (delta) => {
        const now = Date.now();
        if (canceled) throw new Canceled();
        if (now - this.started > WALL_CLOCK_LIMIT_MS) throw new WallClockExceeded("wall clock exceeded");
        this.ttftMs ??= now - this.started;
        this.presenter!.push(delta);
        if (now - lastPublish >= PUBLISH_INTERVAL_MS) {
          await this.publish();
          lastPublish = now;
        }
      }, abort.signal);

      clearInterval(persistTimer);
      if (canceled) throw new Canceled();
      this.presenter.finalize();
      await this.finalize("normal", result, null, model);
    } catch (error) {
      clearInterval(persistTimer);
      const reason = abort.signal.aborted ? abort.signal.reason : error;
      if (reason instanceof Canceled) await this.finalize("canceled", null, null, model);
      else await this.finalize("failed", null, error, model);
    }
  }

  // 部分パーサが確定させた「行 i の text が伸びた分」を送る。同じ行への複数デルタは 1 回にまとめる
  private async publish(): Promise<void> {
    for (const event of coalesce(this.presenter!.takeEvents())) await this.emit({ ...event, seq: ++this.seq });
  }

  // 途中経過を D1 に書く。status が streaming でなくなっていたら (キャンセルされたら) false を返す
  private async persistSnapshot(): Promise<boolean> {
    const result = await this.deps.db.update(chatMessages)
      .set({ content: this.presenter?.normalized() ?? [], streamedAt: new Date() })
      .where(and(eq(chatMessages.id, this.message.id), eq(chatMessages.status, MESSAGE_STATUSES.streaming)))
      .run();
    return result.meta.changes > 0;
  }

  private async finalize(status: Status, result: AiResult | null, error: unknown, model: Awaited<ReturnType<typeof usableModel>>): Promise<void> {
    const { db } = this.deps;
    try {
      await this.publish().catch(() => undefined);
      const raw = this.presenter?.normalized() ?? [];
      // 履歴を丸ごと出力してくるモデルがあるので、既出の行は先頭から畳む。
      // やり直しでは、やり直す対象そのものを既出に数えると今回のぶんが丸ごと消える
      const scene = trim(raw, await knownTexts(db, this.chat.id, this.source?.id ?? this.message.id));
      const text = scene.map((line) => line.text).join("\n");
      const meta = { ...this.message.meta, ...this.finalizeMeta(error, raw.length - scene.length) };

      const values = {
        status: STATUS_VALUES[status],
        content: scene,
        streamedAt: new Date(),
        autoRating: isPresent(text) ? rateText(text) : null,
        meta,
      };
      // 完了の書き込みは streaming のときだけ。直前にキャンセルされていたら、キャンセルとして書き直す
      if (status === "normal") {
        const done = await db.update(chatMessages).set(values)
          .where(and(eq(chatMessages.id, this.message.id), eq(chatMessages.status, MESSAGE_STATUSES.streaming))).run();
        if (done.meta.changes === 0) return this.finalize("canceled", result, null, model);
      } else {
        await db.update(chatMessages).set(values).where(eq(chatMessages.id, this.message.id));
      }

      if (status === "normal") await this.adoptVariant(scene);
      if (result && model) await this.recordUsage(result, model);
      if (status === "normal") await this.applyProgress();

      const sceneStatus = (meta.scene_status ?? {}) as Record<string, string>;
      await this.emit({
        seq: ++this.seq, type: "done", status, scene,
        ...(Object.keys(sceneStatus).length > 0 ? { scene_status: sceneStatus } : {}),
      });
    } catch (finalizeError) {
      console.error("generation finalize failed", finalizeError);
      await this.emit({ seq: ++this.seq, type: "done", status: "failed", scene: [] });
    }
  }

  private finalizeMeta(error: unknown, replayedLines: number): Record<string, unknown> {
    const p = this.presenter;
    const meta: Record<string, unknown> = {};
    if (error) meta.error = String(error instanceof Error ? `${error.name}: ${error.message}` : error).slice(0, 500);
    if (p?.parseError) meta.parse_error = p.parseError;
    if (p && p.unknownSpeakers.length > 0) meta.unknown_speakers = p.unknownSpeakers;
    // 引き当てられなかった表情番号。多いならラベルの書き方かモデルを疑う
    if (p && p.unknownIcons.length > 0) meta.unknown_icons = p.unknownIcons;
    if (p && p.selfSpeakers.length > 0) meta.self_speakers = p.selfSpeakers;
    if (p && p.noiseLines > 0) meta.noise_lines = p.noiseLines;
    if (replayedLines > 0) meta.replayed_lines = replayedLines;
    // 選択肢は本文ではないので meta に置く。空なら書かず、UI は自由入力のままにする
    if (this.chat.choiceMode && p && p.choices.length > 0) meta.choices = p.choices;
    // 場面の状態。次のターンの few-shot に戻して、時間と場所のドリフトを抑える
    if (p && Object.keys(p.status).length > 0) meta.scene_status = p.status;
    // 本文の前に書かせた段取り。UI には出さないが、戻さないと 2 回目から書かなくなる
    if (p?.beat) meta.scene_beat = p.beat;
    return meta;
  }

  // やり直したぶんを表示側に採用し、いままでの 1 本を兄弟へ下げる。空の出力では何もしない
  private async adoptVariant(scene: SceneEntry[]): Promise<void> {
    if (!this.source || !scene.some((line) => isPresent(line.text))) return;
    const variants = await variantsOf(this.deps.db, this.source);
    const current = variants.find((v) => v.status === MESSAGE_STATUSES.normal);
    await this.deps.db.batch([
      this.deps.db.update(chatMessages).set({ replacedById: this.message.id }).where(eq(chatMessages.id, variants.at(-1)!.id)),
      ...(current ? [this.deps.db.update(chatMessages).set({ status: MESSAGE_STATUSES.replaced }).where(eq(chatMessages.id, current.id))] : []),
    ]);
  }

  private async recordUsage(result: AiResult, model: NonNullable<Awaited<ReturnType<typeof usableModel>>>): Promise<void> {
    await this.deps.db.insert(aiUsages).values({
      accountId: this.chat.accountId,
      aiModelId: model.id,
      chatId: this.chat.id,
      chatMessageId: this.message.id,
      purpose: 0,
      promptTokens: result.promptTokens,
      cachedTokens: result.cachedTokens,
      completionTokens: result.completionTokens,
      reasoningTokens: result.reasoningTokens,
      costMicro: costMicro(model, result),
      gatewayLogId: result.gatewayLogId,
      finishReason: result.finishReason,
      ttftMs: this.ttftMs,
      latencyMs: this.started ? Date.now() - this.started : null,
    });
  }

  private async applyProgress(): Promise<void> {
    const { db } = this.deps;
    const casts = (await loadCasts(db, [this.plot])).get(this.plot.id) ?? [];
    const lead = casts.find((c) => c.plotCharacter.isLead) ?? casts[0];
    // やり直しはターンを増やさないので、人気指標も二重に数えない
    if (lead && !this.source) {
      await db.update(characters).set({ messagesCount: sql`${characters.messagesCount} + 1` }).where(eq(characters.id, lead.character.id));
    }

    // コンテキストが青天井に伸びないよう、古いぶんを要約に畳む
    [this.chat] = await db.select().from(chats).where(eq(chats.id, this.chat.id)).limit(1);
    if ((await promptMessages(db, this.chat)).length > ROLLING_TRIGGER_MESSAGES) {
      this.deps.waitUntil(summarize(this.deps, this.chat.id));
    }
  }
}

function coalesce(events: SceneEvent[]): SceneEvent[] {
  const merged = new Map<number, SceneEvent>();
  for (const event of events) {
    const current = merged.get(event.i);
    if (!current) {
      merged.set(event.i, { ...event });
      continue;
    }
    current.delta += event.delta;
    current.speaker = event.speaker;
    if (event.icon !== undefined) current.icon = event.icon;
    if (event.image !== undefined) current.image = event.image;
    current.done ||= event.done;
  }
  return [...merged.values()].filter((e) => e.delta !== "" || e.done);
}
