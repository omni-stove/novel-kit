#!/usr/bin/env node
/**
 * 原稿用紙換算スクリプト
 *
 * 使い方:
 *   novel count [--size WxH] <file-or-dir>...
 *
 * オプション:
 *   --size WxH   1枚の字詰め（省略時: 20x20 = 400字詰め原稿用紙）
 */

import { basename } from 'path';
import { readLines } from './lib/text-parser.mjs';
import { countGenkoRows, requireInputFiles } from './lib/manuscript.mjs';
import { parseCliArgs, ARG, runMain } from './lib/cli.mjs';

export function main(argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv, [ARG.size], { size: { cols: 20, rows: 20 } });
  const { cols, rows: rowsPerPage } = args.size;
  const files = requireInputFiles(args.files);
  const counts = files.map(f => countGenkoRows(readLines(f), cols));
  const pagesOf = rows => (rows / rowsPerPage).toFixed(1);

  if (files.length === 1) {
    const [{ rows, chars }] = counts;
    console.log(`📄 ${basename(files[0])}`);
    console.log(`総行数: ${rows} 行`);
    console.log(`${cols}字×${rowsPerPage}行: ${pagesOf(rows)} 枚`);
    console.log(`文字数: ${chars.toLocaleString()} 字`);
    return;
  }

  const row = (name, { rows, chars }) =>
    `  ${name} ${rows.toString().padStart(5)}行  ${pagesOf(rows).padStart(6)}枚  ${chars.toLocaleString().padStart(8)}字`;

  console.log(`📁 ${args.files.join(' ')}（${cols}字×${rowsPerPage}行）`);
  console.log('─'.repeat(50));
  files.forEach((f, i) => console.log(row(basename(f).padEnd(20), counts[i])));
  console.log('─'.repeat(50));
  console.log(row('合計'.padEnd(18), {
    rows: counts.reduce((n, c) => n + c.rows, 0),
    chars: counts.reduce((n, c) => n + c.chars, 0),
  }));
}

runMain(import.meta.url, main);
