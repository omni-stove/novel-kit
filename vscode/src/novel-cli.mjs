/**
 * 拡張に同梱する novel CLI（PDF出力に使う pdf / pdf-en だけ）
 *
 *   node dist/novel-cli.cjs <pdf | pdf-en> [args...]
 *
 * 拡張から VS Code の Node で起動する。PDF にするところは、隣に置いた dist/pdf-renderer.cjs が行う。
 */

import { join } from 'node:path';
import { main as pdfEn } from '../../src/en-pdf.mjs';
import { main as pdf } from '../../src/pdf.mjs';

const COMMANDS = { pdf, 'pdf-en': pdfEn };

const [command, ...argv] = process.argv.slice(2);
const run = COMMANDS[command];
if (!run) {
  console.error(`使い方: novel-cli <${Object.keys(COMMANDS).join(' | ')}> [args...]`);
  process.exit(1);
}

process.env.NOVEL_PDF_RENDERER ||= join(__dirname, 'pdf-renderer.cjs');
Promise.resolve()
  .then(() => run(argv))
  .catch((err) => {
    console.error('エラー:', err.message);
    process.exit(1);
  });
