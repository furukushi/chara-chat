// フレーバーの見出し算出（サーバ・クライアント共用の純粋関数）。
// category-tree.ts と同じ共用パターン: 実装の正はこのモジュールに置き、
// サーバ（server/src/actions.ts）とクライアント（client/src/App.tsx）の
// 双方がここを import する。

/** フレーバーの見出し: 貼られたテキストの先頭の非空行。履歴や一覧の省略表示に使う。 */
export function flavorTitle(text: string): string {
  const first = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return first.length > 60 ? `${first.slice(0, 60)}…` : first;
}
