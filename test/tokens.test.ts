import { describe, expect, it } from "vitest";
import { extractTokens, tokenLookup } from "../src/auth/tokens";

describe("extractTokens", () => {
  it("新形式の Cookie を . で分ける", () => {
    expect(extractTokens("abc123.def456", undefined)).toEqual(["abc123", "def456"]);
  });

  it("新形式の Cookie があれば Bearer は見ない", () => {
    expect(extractTokens("abc123", "Bearer zzz")).toEqual(["abc123"]);
  });

  it("旧形式の Cookie は読まず、Bearer があればそちらを使う", () => {
    const legacy = "dGVzdA%3D%3D--aXY%3D--dGFn";
    expect(extractTokens(legacy, undefined)).toEqual([]);
    expect(extractTokens("dGVzdA==--aXY=--dGFn", "Bearer zzz")).toEqual(["zzz"]);
  });

  it("大文字や空の要素を含む値は新形式とみなさない", () => {
    expect(extractTokens("ABC", undefined)).toEqual([]);
    expect(extractTokens("abc..def", undefined)).toEqual([]);
    expect(extractTokens("", undefined)).toEqual([]);
  });

  it("Bearer は大文字小文字を区別せず、付いていなければ値全体をトークンにする (本体と同じ)", () => {
    expect(extractTokens(undefined, "bearer   tok")).toEqual(["tok"]);
    expect(extractTokens(undefined, "tok")).toEqual(["tok"]);
    expect(extractTokens(undefined, "Bearer ")).toEqual([]);
  });
});

describe("tokenLookup", () => {
  it("SHA-256 の 16 進数表記の先頭 36 文字", async () => {
    // sha256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    expect(await tokenLookup("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b003");
  });
});
