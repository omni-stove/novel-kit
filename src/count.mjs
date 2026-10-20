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

import { basename } from 'node:path';
import { ARG, parseCliArgs, runMain } from './lib/cli.mjs';
import { countGenkoRows, requireInputFiles } from './lib/manuscript.mjs';
import { readLines } from './lib/text-parser.mjs';

export function main(argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv, [ARG.size], { size: { cols: 20, rows: 20 } });
  const { cols, rows: rowsPerPage } = args.size;
  const files = requireInputFiles(args.files);
  const counts = files.map((f) => countGenkoRows(readLines(f), cols));
  const pagesOf = (rows) => (rows / rowsPerPage).toFixed(1);

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
  files.forEach((f, i) => {
    console.log(row(basename(f).padEnd(20), counts[i]));
  });
  console.log('─'.repeat(50));
  console.log(
    row('合計'.padEnd(18), {
      rows: counts.reduce((n, c) => n + c.rows, 0),
      chars: counts.reduce((n, c) => n + c.chars, 0),
    }),
  );
}

runMain(import.meta.url, main);

if (import.meta.vitest) {
  const { describe, test, expect, vi, afterEach } = import.meta.vitest;
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  describe('main', () => {
    let dir;
    let logs;

    const setup = (files) => {
      dir = mkdtempSync(join(tmpdir(), 'novel-count-test-'));
      for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
      logs = [];
      vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
    };

    afterEach(() => {
      vi.restoreAllMocks();
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = null;
    });

    test('--size 未指定なら 20字×20行（400字詰め原稿用紙）で数える', () => {
      setup({ '01.txt': `${'あ'.repeat(30)}\n` });
      main([join(dir, '01.txt')]);
      expect(logs).toEqual(['📄 01.txt', '総行数: 2 行', '20字×20行: 0.1 枚', '文字数: 30 字']);
    });

    test('--size WxH の字詰めで数える', () => {
      setup({ '01.txt': `${'あ'.repeat(30)}\n` });
      main(['--size', '40x10', join(dir, '01.txt')]);
      expect(logs).toContain('総行数: 1 行');
      expect(logs).toContain('40字×10行: 0.1 枚');
    });

    test('複数ファイルはファイルごとの行と合計を出す', () => {
      setup({ '01.txt': 'あ\n', '02.txt': 'いい\n' });
      main([dir]);
      expect(logs.some((l) => l.startsWith('  01.txt'))).toBe(true);
      expect(logs.some((l) => l.startsWith('  02.txt'))).toBe(true);
      expect(logs.at(-1)).toMatch(/^ {2}合計 +2行 +0\.1枚 +3字$/);
    });
  });
}
