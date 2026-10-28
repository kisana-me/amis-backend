// 生成の前に確かめる制限 (本体の AiQuotaService#consume! のうち、コイン以外で残したもの)。
// 順番は今と同じで、レート制限 → 週の原価上限
import type { Db } from "../db/client";
import type { Bindings } from "../env";
import { weeklyCostMicro } from "./weekly";

export class LimitError extends Error {
  constructor(message: string, readonly status: 403 | 429, readonly code?: string) {
    super(message);
  }
}

export async function checkLimits(db: Db, env: Pick<Bindings, "SEND_LIMITER" | "WEEKLY_COST_LIMIT_MICRO">, accountId: number) {
  const { success } = await env.SEND_LIMITER.limit({ key: `account:${accountId}` });
  if (!success) throw new LimitError("少し時間をおいてから送信してください", 429);

  const limit = Number(env.WEEKLY_COST_LIMIT_MICRO);
  if (limit > 0 && (await weeklyCostMicro(db, accountId)) >= limit) {
    throw new LimitError("今週の利用上限に達しました 土曜0時にリセットされます", 403, "weekly_limit");
  }
}
