#!/usr/bin/env node
/**
 * novel <command> [args...]
 *
 *   build   作品の novel.json に書いた出力を作る（src/build.mjs）
 *   pdf     日本語の原稿を縦書き（または横書き）の PDF にする（src/pdf.mjs）
 *   pdf-en  英語の原稿をペーパーバック風の PDF にする（src/en-pdf.mjs）
 *   count   原稿用紙換算の枚数を数える（src/count.mjs）
 *
 * 各コマンドのオプションは、それぞれのファイルの先頭のコメントにある。
 */

const COMMANDS = {
  build: () => import('../src/build.mjs'),
  pdf: () => import('../src/pdf.mjs'),
  'pdf-en': () => import('../src/en-pdf.mjs'),
  count: () => import('../src/count.mjs'),
};

const [command, ...argv] = process.argv.slice(2);
const load = COMMANDS[command];
if (!load) {
  console.error(`使い方: novel <${Object.keys(COMMANDS).join(' | ')}> [args...]`);
  process.exit(command ? 1 : 0);
}

try {
  await (await load()).main(argv);
} catch (err) {
  console.error('エラー:', err.message);
  process.exit(1);
}
