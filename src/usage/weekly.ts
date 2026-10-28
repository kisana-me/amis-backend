// 週の原価上限 (本体の AiQuotaService の weekly_* と同じ)。コインと無料枠は廃止した
import { and, eq, gte, sum } from "drizzle-orm";
import type { Db } from "../db/client";
import { aiUsages } from "../db/schema";

// 週は土曜 0 時 (JST) に切り替わる (本体の WEEK_START_DAY = :saturday、Time.zone = Tokyo)
const SATURDAY = 6;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function weekStartedAt(now: Date): Date {
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  const daysSince = (jst.getUTCDay() - SATURDAY + 7) % 7;
  const midnight = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate()) - daysSince * DAY_MS;
  return new Date(midnight - JST_OFFSET_MS);
}

export async function weeklyCostMicro(db: Db, accountId: number, now = new Date()): Promise<number> {
  const [row] = await db
    .select({ total: sum(aiUsages.costMicro) })
    .from(aiUsages)
    .where(and(eq(aiUsages.accountId, accountId), gte(aiUsages.createdAt, weekStartedAt(now))));
  return Number(row?.total ?? 0);
}

// 原価そのものはフロントに出さない。上限に対する割合 (0-100) だけを渡す。上限が 0 以下なら無制限
export function usagePercent(spentMicro: number, limitMicro: number): number {
  if (limitMicro <= 0) return 0;
  return Math.min(Math.round((spentMicro * 100) / limitMicro), 100);
}
