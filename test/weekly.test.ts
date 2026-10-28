import { describe, expect, it } from "vitest";
import { usagePercent, weekStartedAt } from "../src/usage/weekly";

describe("weekStartedAt", () => {
  it("週は土曜 0 時 (JST) に始まる", () => {
    // 2026-10-30 (金) 23:59 JST → 2026-10-24 (土) 0:00 JST
    expect(weekStartedAt(new Date("2026-10-30T23:59:00+09:00")).toISOString()).toBe("2026-10-23T15:00:00.000Z");
    // 2026-10-31 (土) 0:00 JST → その日の 0:00
    expect(weekStartedAt(new Date("2026-10-31T00:00:00+09:00")).toISOString()).toBe("2026-10-30T15:00:00.000Z");
    // UTC ではまだ金曜でも、JST で土曜ならその日から
    expect(weekStartedAt(new Date("2026-10-30T16:00:00Z")).toISOString()).toBe("2026-10-30T15:00:00.000Z");
  });
});

describe("usagePercent", () => {
  it("上限に対する割合。100 で頭打ち、上限が 0 以下なら 0", () => {
    expect(usagePercent(1_250_000, 5_000_000)).toBe(25);
    expect(usagePercent(9_000_000, 5_000_000)).toBe(100);
    expect(usagePercent(100, 0)).toBe(0);
  });
});
