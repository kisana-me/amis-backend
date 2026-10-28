// 本体の test/services/amis/scene_presenter_test.rb を移したもの
import { describe, expect, it } from "vitest";
import { ScenePresenter, type ScenePresenterOptions } from "../src/generation/scene-presenter";

const PAYLOAD = `@: 教室のドアが開いた。
@yuki: ……あ、きみが噂の"転校生"？
よろしく
@nobody: 知らない子
@@cleared: true
@@ending: lover
`;

function feed(chunks: string[], options: ScenePresenterOptions = {}) {
  const presenter = new ScenePresenter({ speakerKeys: ["yuki", "ren"], ...options });
  for (const chunk of chunks) presenter.push(chunk);
  return presenter;
}

describe("ScenePresenter", () => {
  it("1文字ずつ流し込んでも正規化された scene になる", () => {
    const presenter = feed([...PAYLOAD]);
    expect(presenter.normalized()[0].text).toBe("教室のドアが開いた。");
    expect(presenter.normalized()[1].speaker).toBe("yuki");
    // @ で始まらない行は直前の行の続き
    expect(presenter.normalized()[1].text).toBe('……あ、きみが噂の"転校生"？\nよろしく');
  });

  it("UTF-8 のバイト境界で割れても、TextDecoder を通せば文字化けしない", () => {
    const bytes = new TextEncoder().encode(PAYLOAD);
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    for (let i = 0; i < bytes.length; i += 3) chunks.push(decoder.decode(bytes.slice(i, i + 3), { stream: true }));
    expect(feed(chunks).normalized()).toEqual(feed([...PAYLOAD]).normalized());
  });

  // 出演に紐づかない speaker は、AI がその場で出した新キャラとして名前のまま通す
  it("出演に無い speaker は名前のまま残し meta にも記録する", () => {
    const presenter = feed([PAYLOAD]);
    expect(presenter.normalized()[2].speaker).toBe("nobody");
    expect(presenter.unknownSpeakers).toEqual(["nobody"]);
  });

  // AI にユーザーの発言を作らせない。出してきた行は丸ごと捨てる
  it("ユーザーの役を speaker にした行は捨てる", () => {
    const presenter = feed(["@きさな: 「勝手に喋らされた」\n@yuki: 「こっちは残る」\n"], { selfNames: ["きさな"] });
    expect(presenter.normalized()).toEqual([{ speaker: "yuki", text: "こっちは残る" }]);
    expect(presenter.selfSpeakers).toEqual(["きさな"]);
    expect(presenter.takeEvents().filter((e) => e.i === 0)).toEqual([]);
  });

  it("ユーザーと同名の出演キャラがいるならキャラを優先する", () => {
    const presenter = feed(["@ユキ: 「キャラとして残る」\n"], { aliases: { ユキ: "yuki" }, selfNames: ["ユキ"] });
    expect(presenter.normalized()[0].speaker).toBe("yuki");
    expect(presenter.selfSpeakers).toEqual([]);
  });

  // 吹き出しに名前が出るので、本人のセリフに鉤括弧は要らない
  it("キャラ本人のセリフから鉤括弧を外す", () => {
    const presenter = feed([`@yuki: *深呼吸をして立ち上がる*
「……わかったわ。すぐ行く」
@: 「完璧じゃなくていい」という言葉が耳から離れなかった。
`]);
    expect(presenter.normalized()[0].text).toBe("*深呼吸をして立ち上がる*\n……わかったわ。すぐ行く");
    // 地の文の引用は本人のセリフではないので触らない
    expect(presenter.normalized()[1].text).toBe("「完璧じゃなくていい」という言葉が耳から離れなかった。");
  });

  it("1行に複数のセリフが入っているときは他人のぶんが混ざりうるので残す", () => {
    const presenter = feed(["@yuki: 「行くよ」と言って「早く」と急かした\n"]);
    expect(presenter.normalized()[0].text).toBe("「行くよ」と言って「早く」と急かした");
  });

  it("物語の外側からの注釈は本文から取り除く", () => {
    const presenter = feed([`@: 教室のドアが開いた。**（注：前回の出力で誤字が出てしまいましたので修正します）**
@yuki: （注：以下に続きを生成します）
@ren: *机に頬杖をついたまま*
「興味ないね」
`]);
    expect(presenter.normalized()[0].text).toBe("教室のドアが開いた。");
    // 注釈しか無い行は丸ごと消える
    expect(presenter.normalized()).toHaveLength(2);
    expect(presenter.normalized()[1].text).toBe("*机に頬杖をついたまま*\n興味ないね");
  });

  // プロンプトには speaker_key を出さず名前だけを書かせているので、返ってくるのも名前になる
  it("speaker の名前を speaker_key に解決する", () => {
    const presenter = feed([`@藤宮 恵佳: 「フルネーム」
@恵佳さん: 「下の名前＋さん」
@yuki: 「speaker_key 直書きも受ける」
`], { aliases: { "藤宮 恵佳": "ren", 恵佳: "ren" } });
    expect(presenter.normalized().map((l) => l.speaker)).toEqual(["ren", "ren", "yuki"]);
    expect(presenter.unknownSpeakers).toEqual([]);
  });

  it("名前の直後の [n] を表情として拾う", () => {
    const presenter = feed(["@yuki[2]: *目を伏せる*\n……そう\n"], { iconAids: { yuki: ["aid_normal", "aid_sad"] } });
    expect(presenter.normalized()[0].icon).toBe("aid_sad");
    expect(presenter.normalized()[0].text).toBe("*目を伏せる*\n……そう");
  });

  it("名前が無い [n] は地の文の挿絵として拾う", () => {
    const presenter = feed(["@[1]: 温室の奥で乾いた音がした。\n@yuki: 誰かいる\n"], { imageAids: ["aid_greenhouse"] });
    expect(presenter.normalized()[0].image).toBe("aid_greenhouse");
    expect(presenter.normalized()[0].speaker).toBeNull();
    // キャラの行には挿絵を載せない
    expect(presenter.normalized()[1]).not.toHaveProperty("image");
  });

  it("範囲外の番号は黙って落とす", () => {
    const presenter = feed(["@yuki[9]: やあ\n@[9]: 扉が開いた。\n"], { iconAids: { yuki: ["aid_normal"] }, imageAids: ["aid_one"] });
    expect(presenter.normalized()[0]).not.toHaveProperty("icon");
    expect(presenter.normalized()[1]).not.toHaveProperty("image");
    expect(presenter.unknownIcons).toEqual(["yuki:9"]);
  });

  // 行形式は「壊れる」状態が無い。途中で切れてもそこまでが残る
  it("途中で切れてもそこまでの行が残り、メタは進まない側に倒れる", () => {
    const presenter = feed([[...PAYLOAD].slice(0, 40).join("")]);
    expect(presenter.finalize()).toBe(true);
    expect(presenter.normalized()).toHaveLength(2);
    expect(presenter.isChapterCleared()).toBe(false);
    expect(presenter.endingKey).toBeNull();
  });

  it("書きかけのヘッダで切れたら、その破片は捨てる", () => {
    const presenter = feed(["@: 扉が開いた。\n@yu"]);
    expect(presenter.finalize()).toBe(true);
    expect(presenter.normalized().map((l) => l.text)).toEqual(["扉が開いた。"]);
  });

  it("メタ行を採用する", () => {
    const presenter = feed([PAYLOAD]);
    expect(presenter.finalize()).toBe(true);
    expect(presenter.isChapterCleared()).toBe(true);
    expect(presenter.endingKey).toBe("lover");
  });

  it("ending が - なら結末は確定していない", () => {
    const presenter = feed(["@: 扉が開いた。\n@@cleared: false\n@@ending: -\n"]);
    expect(presenter.finalize()).toBe(true);
    expect(presenter.isChapterCleared()).toBe(false);
    expect(presenter.endingKey).toBeNull();
  });

  it("本文が1文字も無ければ empty", () => {
    expect(feed([""]).isEmpty()).toBe(true);
    expect(feed([PAYLOAD]).isEmpty()).toBe(false);
  });

  // ヘッダを書き忘れた出力を丸ごと捨てると、1ターン分が消えてしまう
  it("ヘッダの無い出力は地の文として拾う", () => {
    const presenter = feed(["扉が開いた。誰かが立っている。"]);
    expect(presenter.finalize()).toBe(true);
    expect(presenter.normalized()).toEqual([{ speaker: null, text: "扉が開いた。誰かが立っている。" }]);
  });

  it("区切り線や記号だけの行は出さない", () => {
    const presenter = feed(["@: 扉が開いた。\n@: ---\n@yuki: おかえり\n@@cleared: true\n"]);
    expect(presenter.finalize()).toBe(true);
    expect(presenter.normalized().map((l) => l.text)).toEqual(["扉が開いた。", "おかえり"]);
    expect(presenter.noiseLines).toBe(1);
    expect(presenter.isChapterCleared()).toBe(true);
  });

  it("choices を拾う。無ければ空配列", () => {
    const presenter = feed([`${PAYLOAD}@@choice: 黙って見つめ返す\n@@choice: 名前を尋ねる\n@@choice: 教室を出る\n`]);
    expect(presenter.finalize()).toBe(true);
    expect(presenter.choices).toEqual(["黙って見つめ返す", "名前を尋ねる", "教室を出る"]);
    expect(feed([PAYLOAD]).choices).toEqual([]);
  });

  it("choices が壊れていても本文とメタは巻き添えにしない", () => {
    const presenter = feed([`${PAYLOAD}@@choice: \n@@choice: 選択肢\n`]);
    expect(presenter.finalize()).toBe(true);
    expect(presenter.normalized()).toHaveLength(3);
    expect(presenter.isChapterCleared()).toBe(true);
    expect(presenter.choices).toEqual(["選択肢"]);
  });

  it("場面の状態を拾う", () => {
    const presenter = feed(["@: 扉が開いた。\n@@time: 四月八日 放課後\n@@place: 旧校舎の階段\n@@air: 探り合っている\n@@cleared: false\n"]);
    expect(presenter.finalize()).toBe(true);
    expect(presenter.status).toEqual({ time: "四月八日 放課後", place: "旧校舎の階段", air: "探り合っている" });
    // 状態は本文に混ざらない
    expect(presenter.normalized().map((l) => l.text)).toEqual(["扉が開いた。"]);
  });

  it("段取りを拾い、本文には混ぜない", () => {
    const presenter = feed(["@@time: 四月八日 放課後\n@@beat: 雪が名乗りそこねる\n@: 扉が開いた。\n@@air: 探り合っている\n"]);
    expect(presenter.finalize()).toBe(true);
    expect(presenter.beat).toBe("雪が名乗りそこねる");
    expect(presenter.status).toEqual({ time: "四月八日 放課後", air: "探り合っている" });
    expect(presenter.normalized().map((l) => l.text)).toEqual(["扉が開いた。"]);
  });

  it("書かれなかった段取りは null のまま", () => {
    const presenter = feed(["@: 扉が開いた。\n@@beat: -\n"]);
    expect(presenter.finalize()).toBe(true);
    expect(presenter.beat).toBeNull();
  });

  it("長すぎる段取りは頭で切る", () => {
    const presenter = feed([`@: 扉が開いた。\n@@beat: ${"あ".repeat(200)}\n`]);
    expect(presenter.finalize()).toBe(true);
    expect([...presenter.beat!]).toHaveLength(120);
  });

  it("書かれなかった状態の項目は落とす", () => {
    const presenter = feed(["@: 扉が開いた。\n@@place: 旧校舎の階段\n@@air: -\n"]);
    expect(presenter.finalize()).toBe(true);
    expect(presenter.status).toEqual({ place: "旧校舎の階段" });
  });

  it("長すぎる状態は頭で切る", () => {
    const presenter = feed([`@: 扉が開いた。\n@@place: ${"あ".repeat(100)}\n`]);
    expect(presenter.finalize()).toBe(true);
    expect([...presenter.status.place]).toHaveLength(60);
  });

  it("行が伸びた分だけをイベントとして返す", () => {
    const presenter = new ScenePresenter({ speakerKeys: ["yuki"] });
    presenter.push("@yuki: こん");
    const first = presenter.takeEvents();
    presenter.push("にちは\n");
    const second = presenter.takeEvents();
    expect(first.map((e) => e.delta).join("")).toBe("こん");
    expect(second.filter((e) => !e.done).map((e) => e.delta).join("")).toBe("にちは");
    expect(presenter.takeEvents()).toEqual([]);
  });

  // 吹き出しは speaker が決まってから描く。本文より先にヘッダが確定している必要がある
  it("本文が流れ始める時点で speaker と表情が確定している", () => {
    const presenter = new ScenePresenter({ speakerKeys: ["yuki"], iconAids: { yuki: ["a", "b"] } });
    presenter.push("@yuki[2]: や");
    const event = presenter.takeEvents()[0];
    expect(event.speaker).toBe("yuki");
    expect(event.icon).toBe("b");
  });

  // ここから下は移植で足したもの (Ruby と JavaScript の文字の扱いの違い)
  it("全角スペースの区切りもヘッダの区切りとして食い、名前の前後の ASCII の空白だけを落とす", () => {
    const presenter = feed(["@yuki:　やあ\n@ 　ren : ほい\n"]);
    expect(presenter.normalized()).toEqual([{ speaker: "yuki", text: "やあ" }, { speaker: "　ren", text: "ほい" }]);
  });
});
