/**
 * 拡張に同梱する novel CLI（bin/novel.mjs と同じコマンド）
 *
 *   node dist/novel-cli.cjs <build | pdf | pdf-en | novel-pdf | epub | rtf | docx | split | merge | count> [args...]
 *
 * 拡張から VS Code の Node で起動する。PDF にするところは、隣に置いた dist/pdf-renderer.cjs が行う。
 * docx のテンプレートは、隣に置いた dist/tategaki-a4-42x34.docx を使う。
 */

import { join } from 'node:path';
import { main as build } from '../../src/build.mjs';
import { main as count } from '../../src/count.mjs';
import { main as docx } from '../../src/docx.mjs';
import { main as pdfEn } from '../../src/en-pdf.mjs';
import { main as epub } from '../../src/epub.mjs';
import { main as merge } from '../../src/merge.mjs';
import { main as novelPdf } from '../../src/novel-pdf.mjs';
import { main as pdf } from '../../src/pdf.mjs';
import { main as rtf } from '../../src/rtf.mjs';
import { main as split } from '../../src/split.mjs';

const COMMANDS = { build, pdf, 'pdf-en': pdfEn, 'novel-pdf': novelPdf, epub, rtf, docx, split, merge, count };

const [command, ...argv] = process.argv.slice(2);
const run = COMMANDS[command];
if (!run) {
  console.error(`使い方: novel-cli <${Object.keys(COMMANDS).join(' | ')}> [args...]`);
  process.exit(1);
}

process.env.NOVEL_PDF_RENDERER ||= join(__dirname, 'pdf-renderer.cjs');
process.env.NOVEL_DOCX_TEMPLATE ||= join(__dirname, 'tategaki-a4-42x34.docx');
Promise.resolve()
  .then(() => run(argv))
  .catch((err) => {
    console.error('エラー:', err.message);
    process.exit(1);
  });
