// Ruby / ActiveSupport の文字列の扱いを合わせるための小物。
// 本体の出力と同じ結果になるよう、JavaScript の既定の動き (trim が全角スペースも消すなど) とは分けて使う

// Ruby の strip / \s と同じく、ASCII の空白 (と NUL) だけを見る
const ASCII_SPACE = "[ \\t\\n\\v\\f\\r\\0]";
const LEADING = new RegExp(`^${ASCII_SPACE}+`);
const TRAILING = new RegExp(`${ASCII_SPACE}+$`);

export function rubyStrip(value: string): string {
  return value.replace(LEADING, "").replace(TRAILING, "");
}

// ActiveSupport の String#blank? と同じく、Unicode の空白だけなら空とみなす (全角スペースも空白)
export function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  return /^[\s\u0085]*$/u.test(String(value));
}

export const isPresent = (value: unknown) => !isBlank(value);

// 文字数 (コードポイント) で頭から切る。Ruby の str[0, n] と同じ
export function headChars(value: string, length: number): string {
  return Array.from(value).slice(0, length).join("");
}

export function charLength(value: string): number {
  return Array.from(value).length;
}

// Onigmo の [[:blank:]] (タブと Unicode の空白区切り)
export const BLANK = "[\\t\\p{Zs}]";
