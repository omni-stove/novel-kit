#!/usr/bin/env node
/**
 * 400字詰め原稿用紙換算スクリプト
 *
 * 使い方:
 *   node scripts/count-pages.mts <file-or-dir>
 */

import { readFileSync, statSync } from 'fs';
import { basename } from 'path';
import {
  isMemoLine,
  isEpigraphLine,
  isPovLine,
  isViewpointLine,
  isSeparator,
  stripInlineMarkup,
  getTextFilesFromDir,
} from './lib/text-parser.mts';

// 垂れ下がり対象文字（行末なら前のマスに入る）
const TARE_CHARS = '。、」）』】〉》';

export function countLinesFor20Chars(line) {
  const chars = [...line];
  const len = chars.length;

  if (len === 0) return 1;

  let rows = 0;
  let pos = 0;

  while (pos < len) {
    const remaining = len - pos;

    if (remaining <= 20) {
      rows++;
      break;
    }

    const char21 = chars[pos + 20];
    if (TARE_CHARS.includes(char21)) {
      rows++;
      pos += 21;
    } else {
      rows++;
      pos += 20;
    }
  }

  return rows;
}

function countPagesForFile(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  let totalRows = 0;
  let charCount = 0;

  for (const rawLine of lines) {
    if (isMemoLine(rawLine)) continue;
    if (isEpigraphLine(rawLine)) continue;
    if (isPovLine(rawLine)) continue;
    if (isSeparator(rawLine)) continue;

    const line = stripInlineMarkup(rawLine);
    const trimmed = line.trim();

    if (trimmed === '') {
      totalRows++;
      continue;
    }

    // 視点行【】は章タイトルとして1行扱い
    if (isViewpointLine(rawLine)) {
      totalRows++;
      charCount += [...stripInlineMarkup(rawLine.replace(/^【.*?】/, ''))].length;
      continue;
    }

    totalRows += countLinesFor20Chars(line);
    charCount += [...line].length;
  }

  const pages = totalRows / 20;
  return { totalRows, pages, charCount };
}

function main() {
  const args = process.argv.slice(2);
  const target = args[0] || 'story.txt';

  try {
    const stat = statSync(target);

    if (stat.isDirectory()) {
      const files = getTextFilesFromDir(target);
      let grandTotalRows = 0;
      let grandTotalChars = 0;

      console.log(`📁 ${target}`);
      console.log('─'.repeat(50));

      for (const file of files) {
        const { totalRows, pages, charCount } = countPagesForFile(file);
        grandTotalRows += totalRows;
        grandTotalChars += charCount;
        console.log(`  ${basename(file).padEnd(20)} ${totalRows.toString().padStart(5)}行  ${pages.toFixed(1).padStart(6)}枚  ${charCount.toLocaleString().padStart(8)}字`);
      }

      console.log('─'.repeat(50));
      const grandPages = grandTotalRows / 20;
      console.log(`  ${'合計'.padEnd(18)} ${grandTotalRows.toString().padStart(5)}行  ${grandPages.toFixed(1).padStart(6)}枚  ${grandTotalChars.toLocaleString().padStart(8)}字`);

    } else {
      const { totalRows, pages, charCount } = countPagesForFile(target);
      console.log(`📄 ${basename(target)}`);
      console.log(`総行数: ${totalRows} 行`);
      console.log(`400字詰め: ${pages.toFixed(1)} 枚`);
      console.log(`文字数: ${charCount.toLocaleString()} 字`);
    }
  } catch (err) {
    console.error(`エラー: ${err.message}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest;

  describe('countLinesFor20Chars', () => {
    test('空行は1行', () => {
      expect(countLinesFor20Chars('')).toBe(1);
    });
    test('20字以下は1行', () => {
      expect(countLinesFor20Chars('あ'.repeat(1))).toBe(1);
      expect(countLinesFor20Chars('あ'.repeat(20))).toBe(1);
    });
    test('21字目が垂れ下がり対象なら1行に収まる', () => {
      const line = 'あ'.repeat(20) + '。';
      expect(countLinesFor20Chars(line)).toBe(1);
    });
    test('21字目が通常字なら2行', () => {
      const line = 'あ'.repeat(21);
      expect(countLinesFor20Chars(line)).toBe(2);
    });
    test('40字（垂れ下がりなし）は2行', () => {
      const line = 'あ'.repeat(40);
      expect(countLinesFor20Chars(line)).toBe(2);
    });
    test('41字（20+20+1）は3行', () => {
      const line = 'あ'.repeat(41);
      expect(countLinesFor20Chars(line)).toBe(3);
    });
    test('1行目末尾だけ垂れ下がる場合（21+20=41 → 2行）', () => {
      const line = 'あ'.repeat(20) + '。' + 'あ'.repeat(20);
      expect(countLinesFor20Chars(line)).toBe(2);
    });
    test('代表的な垂れ下がり字（、」）』】〉》）も対象', () => {
      for (const ch of '、」）』】〉》') {
        const line = 'あ'.repeat(20) + ch;
        expect(countLinesFor20Chars(line)).toBe(1);
      }
    });
  });
}
