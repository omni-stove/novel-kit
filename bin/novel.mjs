#!/usr/bin/env node
/**
 * novel <command> [args...]
 *
 *   build      作品の novel.json に書いた出力を作る（src/build.mjs）
 *   pdf        日本語の原稿を縦書き（または横書き）の PDF にする（src/pdf.mjs）
 *   pdf-en     英語の原稿をペーパーバック風の PDF にする（src/en-pdf.mjs）
 *   novel-pdf  文庫本見開きの縦書き PDF にする（src/novel-pdf.mjs）
 *   epub       EPUB にする（src/epub.mjs）
 *   rtf        RTF にする。既定は英語投稿用の Shunn 形式、--ja で日本語原稿（src/rtf.mjs）
 *   docx       縦書きの Word 文書にする（src/docx.mjs）
 *   split      章ごとの txt に分ける（src/split.mjs）
 *   merge      1つの txt にまとめる（src/merge.mjs）
 *   count      原稿用紙換算の枚数を数える（src/count.mjs）
 *   import     RTF を原稿の txt にする（src/import.mjs）
 *
 * 各コマンドのオプションは、それぞれのファイルの先頭のコメントにある。
 */

const COMMANDS = {
  build: () => import('../src/build.mjs'),
  pdf: () => import('../src/pdf.mjs'),
  'pdf-en': () => import('../src/en-pdf.mjs'),
  'novel-pdf': () => import('../src/novel-pdf.mjs'),
  epub: () => import('../src/epub.mjs'),
  rtf: () => import('../src/rtf.mjs'),
  docx: () => import('../src/docx.mjs'),
  split: () => import('../src/split.mjs'),
  merge: () => import('../src/merge.mjs'),
  count: () => import('../src/count.mjs'),
  import: () => import('../src/import.mjs'),
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
