// 本体の SecureRandom.base36(14) と同じ形の aid。36 で割り切れないぶんは捨てて引き直し、文字に偏りを出さない
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const LIMIT = 256 - (256 % ALPHABET.length);

export function newAid(length = 14): string {
  let aid = "";
  while (aid.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length))) {
      if (byte < LIMIT && aid.length < length) aid += ALPHABET[byte % ALPHABET.length];
    }
  }
  return aid;
}
