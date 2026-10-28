// 本体の ActiveModel のエラーメッセージと同じ言い回しで組み立てる (config/locales/ja.yml)
export class ValidationErrors {
  readonly messages: string[] = [];

  add(message: string) {
    this.messages.push(message);
  }

  blank(attribute: string) {
    this.add(`${attribute}を入力してください`);
  }

  tooLong(attribute: string, count: number) {
    this.add(`${attribute}は${count}文字以内で入力してください`);
  }

  get any() {
    return this.messages.length > 0;
  }

  // 本体の full_messages.to_sentence と同じく読点でつなぐ
  toSentence() {
    return this.messages.join("、");
  }
}
