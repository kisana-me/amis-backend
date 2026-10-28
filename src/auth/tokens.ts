// サインイン Cookie からトークンを取り出す (amiverse-docs/session-cookie.md §3, §4, §6)

export const COOKIE_NAME = "amiverse";

// 新形式はトークンを "." でつないだだけの値。本体の SessionManagement::TOKENS_FORMAT と同じ
const TOKENS_FORMAT = /^[0-9a-z]+(\.[0-9a-z]+)*$/;
const LOOKUP_LENGTH = 36;

// 本体の get_tokens と同じ順番で見る。Cookie から 1 つも取れなければ Bearer。
// 旧形式 (Rails の暗号化 Cookie) は読まない。サイトを開いた時点で本体が新形式に書き換えるので、
// 届いても未サインインとして扱う
export function extractTokens(cookie: string | undefined, authorization: string | undefined): string[] {
  if (cookie && TOKENS_FORMAT.test(cookie)) return cookie.split(".");

  if (!authorization) return [];
  // 本体の auth.sub(/\ABearer\s+/i, "") と同じく、Bearer が付いていなければ値全体をトークンとみなす
  const token = authorization.replace(/^Bearer\s+/i, "");
  return token.trim() ? [token] : [];
}

// 本体の TokenTools#generate_lookup と同じ。SHA-256 の 16 進数表記の先頭 36 文字
export async function tokenLookup(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, LOOKUP_LENGTH);
}
