// 本体の MariaDB に Hyperdrive 経由でつなぐ。読むだけ (書き込みは本体の API を通す)
import type { Connection } from "mysql2/promise";
import type { Bindings } from "../env";

export type MainDb = {
  query: <T>(sql: string, params: unknown[]) => Promise<T[]>;
  close: () => Promise<void>;
};

// 最初に query したときにつなぐ。プールは Hyperdrive が持つので、使い終わったら close する。
// mysql2 はこのときに読み込む。DB を使わないリクエストと、DB を差し替えたテストでは読み込まれない
export function mainDb(env: Bindings): MainDb {
  let connection: Promise<Connection> | null = null;

  return {
    async query<T>(sql: string, params: unknown[]) {
      connection ??= import("mysql2/promise").then(({ createConnection }) => createConnection({
        host: env.HYPERDRIVE.host,
        user: env.HYPERDRIVE.user,
        password: env.HYPERDRIVE.password,
        database: env.HYPERDRIVE.database,
        port: env.HYPERDRIVE.port,
        // Workers では eval が使えない
        disableEval: true,
        // DATETIME はタイムゾーンなしで入っているので、本体と同じタイムゾーンで読み書きする
        timezone: env.MAIN_DB_TIMEZONE,
      }));
      const [rows] = await (await connection).query(sql, params);
      return rows as T[];
    },
    async close() {
      if (!connection) return;
      const conn = await connection.catch(() => null);
      await conn?.end().catch(() => undefined);
    },
  };
}
