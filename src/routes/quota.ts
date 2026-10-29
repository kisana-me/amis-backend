import { Hono } from "hono";
import type { AppEnv } from "../env";
import { requireSignin } from "../middleware/auth";
import { usagePercent, weeklyCostMicro } from "../usage/weekly";

export const quotaRoutes = new Hono<AppEnv>();

// 今週の利用率 (本体の V1::Amis::StatusController の quota)
quotaRoutes.post("/quota", requireSignin, async (c) => {
  const spent = await weeklyCostMicro(c.var.db, c.var.currentAccount!.id);
  return c.json({ status: "success", quota: { weekly_usage_percent: usagePercent(spent, Number(c.env.WEEKLY_COST_LIMIT_MICRO)) } });
});
