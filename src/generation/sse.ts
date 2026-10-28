// SSE のレスポンス。送るのは本体の Amis::ChatChannel と同じ JSON (snapshot → delta … → done)。
// クライアントが切断しても書き込みのエラーは握りつぶし、生成そのものは最後まで続ける
export type Emit = (payload: Record<string, unknown>) => Promise<void>;

export function sseResponse(ctx: Pick<ExecutionContext, "waitUntil">, run: (emit: Emit) => Promise<void>): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let open = true;

  // 書き込みの完了は待たない。待つと、受け取りの遅い接続や読まれていない接続に生成が縛られる (背圧)。
  // 書いた順番はストリームが守る
  const emit: Emit = async (payload) => {
    if (!open) return;
    writer.write(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)).catch(() => {
      // 切断された。以降は送らないが、生成は止めない
      open = false;
    });
  };

  // レスポンスを返したあとも生成を続けられるよう waitUntil に載せる (切断後は最大 30 秒まで)
  ctx.waitUntil(run(emit).finally(() => {
    if (open) writer.close().catch(() => undefined);
  }));

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      // 中継でまとめて送られると、パラパラ表示にならない
      "X-Accel-Buffering": "no",
    },
  });
}
