// wrangler は .txt を文字列のモジュールとして読み込む (プロンプトの文面に使う)
declare module "*.txt" {
  const content: string;
  export default content;
}
