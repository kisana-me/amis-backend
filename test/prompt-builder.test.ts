// 本体の test/services/amis/prompt_builder_test.rb を移したもの。
// 結末 (@@ending) を廃止したので、その行を書かせないことを確かめるテストに変えてある
import { describe, expect, it } from "vitest";
import { type PromptInput, PromptBuilder } from "../src/generation/prompt-builder";
import type { ChatMessage } from "../src/views/context";

// プレフィックスキャッシュのため、ビルド結果はバイト単位で同一である必要がある
const VOLATILE = /\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}/;

let nextId = 1;
function message(values: Partial<ChatMessage>): ChatMessage {
  return {
    id: nextId++, aid: `msg${nextId}`, chatId: 1, role: 1, status: 0, content: [], chapterKey: "ch1",
    speakerCharacterId: null, replacedById: null, aiModelId: null, userRating: 0, autoRating: null, modRating: null,
    rating: 0, streamedAt: null, meta: {}, createdAt: new Date(), updatedAt: new Date(), ...values,
  };
}

type Overrides = Omit<Partial<PromptInput>, "chat" | "plot"> & { chat?: Partial<PromptInput["chat"]>; plot?: Partial<PromptInput["plot"]> };

function input(overrides: Overrides = {}): PromptInput {
  return {
    ownerName: "テスト",
    persona: null,
    hasLores: false,
    plotImages: [],
    messages: [],
    casts: [
      { speakerKey: "yuki", roleName: "", roleDescription: "", name: "ユキ", persona: "一人称は「わたし」。素っ気ない。", images: [] },
      { speakerKey: "ren", roleName: "", roleDescription: "", name: "レン", persona: "一人称は「俺」。皮肉屋。", images: [] },
    ],
    ...overrides,
    chat: { aid: "chataid0000001", currentChapterKey: "ch1", turnsInChapter: 0, choiceMode: false, replyStyle: 0, finished: false, summaries: [], ...overrides.chat },
    plot: {
      situation: "春。主人公は転校初日の教室に立っている。",
      chapters: [
        { key: "ch1", title: "出会い", objective: "名前を覚えられる" },
        { key: "final", title: "答え", objective: "関係が決まる" },
      ],
      ...overrides.plot,
    },
  };
}

const lastAssistant = (i: PromptInput) => new PromptBuilder(i).build().reverse().find((m) => m.role === "assistant")!.content;

describe("PromptBuilder", () => {
  it("同じ入力で 2 回ビルドしたら完全一致する", () => {
    expect(JSON.stringify(new PromptBuilder(input()).build())).toBe(JSON.stringify(new PromptBuilder(input()).build()));
  });

  it("設定集が付いていないプロットには設定集の区画を出さない", () => {
    expect(new PromptBuilder(input()).systemPrompt()).not.toContain("# 設定集");
  });

  it("設定集が付いているプロットには設定集の区画を、出力規約と出演キャラのあいだに出す", () => {
    const prompt = new PromptBuilder(input({ hasLores: true })).systemPrompt();
    expect(prompt).toContain("# 設定集(ロアブック/キーワードRAG)");
    expect(prompt).toContain("【設定】");
    expect(prompt.indexOf("# 出力規約")).toBeLessThan(prompt.indexOf("# 設定集"));
    expect(prompt.indexOf("# 設定集")).toBeLessThan(prompt.indexOf("# 出演キャラ"));
  });

  // 発火の有無で分岐させると system プロンプトが毎ターン変わり、後ろの会話履歴が丸ごとキャッシュミスになる
  it("設定集の区画は発火の有無で変わらない", () => {
    const quiet = new PromptBuilder(input({ hasLores: true })).systemPrompt();
    const fired = new PromptBuilder(input({ hasLores: true, loreBlock: "【設定】\n【黒森】狩場", messages: [message({ role: 0, content: [{ speaker: null, text: "黒森へ向かう" }] })] })).systemPrompt();
    expect(fired).toBe(quiet);
  });

  it("可変要素が 現在の章 より前に現れない", () => {
    const prompt = new PromptBuilder(input()).systemPrompt();
    const prefix = prompt.slice(0, prompt.indexOf("# 現在の章"));
    expect(prefix).not.toMatch(VOLATILE);
    expect(prefix).not.toContain("chataid0000001");
    expect(prefix).not.toContain("名前を覚えられる");
  });

  it("セクションはキャッシュ順に並ぶ", () => {
    const headings = new PromptBuilder(input()).systemPrompt().match(/^# .+$/gm);
    expect(headings).toEqual(["# 絶対ルール", "# 演出方針", "# 出力規約", "# チャットの設定", "# 出演キャラ", "# 状況設定", "# ユーザーの役", "# 現在の章", "# 出力の締めくくり"]);
  });

  it("章が進んでも 現在の章 までのプレフィックスは変わらない", () => {
    const before = new PromptBuilder(input()).systemPrompt();
    const after = new PromptBuilder(input({ chat: { currentChapterKey: "final" } })).systemPrompt();
    const boundary = before.indexOf("# 現在の章");
    expect(after.slice(0, boundary)).toBe(before.slice(0, boundary));
    expect(after).not.toBe(before);
  });

  // speaker_key は内部の値。モデルには名前だけを書かせ、受け取った名前をこちらで戻す
  it("プロンプトに speaker_key を出さず、名前で書かせる", () => {
    const prompt = new PromptBuilder(input()).systemPrompt();
    expect(prompt).not.toContain("speaker_key");
    expect(prompt).toContain("speaker にはこの名前をそのまま書いてください: ユキ / レン");
  });

  it("名前・姓名の一部・speaker_key を speaker_key に戻せる", () => {
    const aliases = new PromptBuilder(input()).speakerAliases;
    expect(aliases.ユキ).toBe("yuki");
    expect(aliases.yuki).toBe("yuki");
    expect(aliases.レン).toBe("ren");
  });

  it("どちらの人物か決まらない別名は対応表から捨てる", () => {
    const base = input();
    base.casts[1].roleName = "ユキ";
    const aliases = new PromptBuilder(base).speakerAliases;
    expect(aliases).not.toHaveProperty("ユキ");
    expect(aliases.レン).toBe("ren");
  });

  it("やり直しでは対象を会話から外し、末尾に不採用として渡す", () => {
    const assistant = message({ content: [{ speaker: "yuki", text: "……どうも" }] });
    const prompt = new PromptBuilder(input({
      messages: [message({ role: 0, content: [{ speaker: null, text: "はじめまして" }] }), assistant],
      rejected: [assistant],
      instruction: "もっと短く",
    })).build();
    const tail = prompt.at(-1)!;
    expect(tail.role).toBe("user");
    expect(tail.content).toContain("# 不採用の出力");
    expect(tail.content).toContain("……どうも");
    expect(tail.content).toContain("もっと短く");
    // assistant で渡すとモデルがその続きを書き始めるうえ、ReplayTrimmer が冒頭を畳んでしまう
    expect(prompt.filter((m) => m.role === "assistant")).toEqual([]);
    expect(prompt.at(-2)!.content).toContain("# 現在の設定");
    expect(prompt.slice(0, -2).map((m) => m.role)).toEqual(["system", "user"]);
    expect(prompt[1].content).toBe("はじめまして");
  });

  it("行形式の出力例とメタ行の書き方を含み、結末 (@@ending) は書かせない", () => {
    const prompt = new PromptBuilder(input()).systemPrompt();
    expect(prompt).toMatch(/^@: \S/m);
    expect(prompt).toContain("@@cleared:");
    expect(prompt).not.toContain("@@ending");
    expect(prompt).toContain("JSON・見出し・コードブロック");
    // 最終章でも結末のキーは並べない
    expect(new PromptBuilder(input({ chat: { currentChapterKey: "final" } })).systemPrompt()).toContain("これは最終章です。ねらいが達成されたら @@cleared を true にしてください。");
  });

  it("選択肢で応答はメタ行に入れさせる (本文には書かせない)", () => {
    const block = new PromptBuilder(input({ chat: { choiceMode: true } })).build().at(-1)!.content;
    expect(block).toContain("`@@choice:` の行でちょうど 3 個");
    expect(block).toContain("選択肢を本文の行に書いてはいけません");
    expect(block).not.toContain("@@ending");
  });

  it("選択肢が切られているときは書かないよう明示する", () => {
    const block = new PromptBuilder(input()).build().at(-1)!.content;
    expect(block).toContain("`@@choice:` の行を書いてはいけません");
    expect(block).not.toContain("`@@choice:` の行でちょうど 3 個");
  });

  it("設定を切り替えても system プロンプトは 1 バイトも変わらない", () => {
    expect(new PromptBuilder(input({ chat: { choiceMode: true, replyStyle: 2 } })).systemPrompt()).toBe(new PromptBuilder(input()).systemPrompt());
  });

  it("現在の設定は会話の末尾に、設定集より後ろ・やり直しの指示より前に置く", () => {
    const messages = new PromptBuilder(input({ hasLores: true, autoContinue: true, loreBlock: "【設定】\n【黒森】狩場だった" })).build();
    expect(messages.slice(-3).map((m) => m.role)).toEqual(["user", "user", "user"]);
    expect(messages.at(-3)!.content).toContain("【黒森】狩場だった");
    expect(messages.at(-2)!.content).toContain("# 現在の設定");
    expect(messages.at(-1)!.content).toContain("ユーザーは今回指示をしませんでした");
  });

  it("応答スタイルは選ばれた 1 つだけを末尾に書く", () => {
    const block = new PromptBuilder(input({ chat: { replyStyle: 2 } })).build().at(-1)!.content;
    expect(block).toContain("地の文を厚めにしてください");
    expect(block).not.toContain("セリフを多めにしてください");
  });

  it("ユーザー入力の *…* の扱いを、可変のペルソナ名より前に置く", () => {
    const prompt = new PromptBuilder(input()).systemPrompt();
    const section = prompt.slice(prompt.indexOf("# ユーザーの役"));
    expect(section).toContain("それはユーザーの役の動作・表情・内心です");
    expect(section.indexOf("ユーザーの役の動作")).toBeLessThan(section.indexOf("名前: "));
  });

  it("履歴の assistant には choices を含めて返す。無ければ足さない", () => {
    const withChoices = lastAssistant(input({ messages: [message({ content: [{ speaker: "yuki", text: "「……よろしく」" }], meta: { choices: ["名前を尋ねる", "黙って頷く", "教室を見回す"] } })] }));
    expect(withChoices.split("\n").slice(-3)).toEqual(["@@choice: 名前を尋ねる", "@@choice: 黙って頷く", "@@choice: 教室を見回す"]);
    expect(lastAssistant(input({ messages: [message({ content: [{ speaker: "yuki", text: "「……よろしく」" }] })] }))).not.toContain("@@choice:");
  });

  it("履歴の assistant には場面の状態を、出力規約と同じ並びで戻す (air だけ本文の後ろ)", () => {
    const lines = lastAssistant(input({ messages: [message({
      content: [{ speaker: "yuki", text: "……よろしく" }],
      meta: { scene_status: { time: "四月八日 放課後", place: "教室", air: "探り合っている" }, scene_beat: "雪が名乗りそこねる" },
    })] })).split("\n");
    expect(lines.slice(-5, -2)).toEqual(["@@time: 四月八日 放課後", "@@place: 教室", "@@beat: 雪が名乗りそこねる"]);
    expect(lines.at(-1)).toBe("@@air: 探り合っている");
    expect(lines.indexOf("@ユキ: ……よろしく")).toBe(3);
  });

  it("段取りや状態を持たない履歴には、その行を足さない", () => {
    const content = lastAssistant(input({ messages: [message({ content: [{ speaker: "yuki", text: "……よろしく" }], meta: { scene_status: { time: "四月八日 放課後" } } })] }));
    expect(content).not.toContain("@@beat:");
    expect(lastAssistant(input({ messages: [message({ content: [{ speaker: "yuki", text: "……よろしく" }] })] }))).not.toContain("@@time:");
  });

  it("履歴の assistant は行形式で、表情と挿絵は番号に戻す", () => {
    const base = input({
      plotImages: [{ aid: "greenhouse", situation: "温室" }],
      messages: [message({ content: [
        { speaker: null, text: "教室のドアが開いた。", image: "greenhouse" },
        { speaker: "yuki", text: "*目を伏せる*\n……そう", icon: "sad" },
      ] })],
    });
    base.casts[0].images = [{ aid: "normal", situation: "通常" }, { aid: "sad", situation: "悲しい" }];
    expect(lastAssistant(base).split("\n")).toEqual(["@[1]: 教室のドアが開いた。", "@ユキ[2]: *目を伏せる*", "……そう"]);
  });

  it("自動継続では末尾にだけ指示が足され、プレフィックスは変わらない", () => {
    const normal = new PromptBuilder(input()).build();
    const auto = new PromptBuilder(input({ autoContinue: true })).build();
    expect(auto.slice(0, normal.length)).toEqual(normal);
    expect(auto.length - normal.length).toBe(1);
    expect(auto.at(-1)!.role).toBe("user");
  });

  it("章が空なら @@cleared を常に false にするよう指示する", () => {
    expect(new PromptBuilder(input({ plot: { chapters: [] }, chat: { currentChapterKey: "" } })).systemPrompt()).toContain("@@cleared は常に false");
  });
});
