#!/usr/bin/env node
/**
 * 400字詰め原稿用紙換算スクリプト
 * text-parserを応用し、Memo行・POV行・ルビ等を適切に処理
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { basename, join } from 'path';
import {
  isMemoLine,
  isEpigraphLine,
  isPovLine,
  isViewpointLine,
  isSeparator,
} from './lib/text-parser.mts';

// 垂れ下がり対象文字（行末なら前のマスに入る）
const TARE_CHARS = '。、」）』】〉》';

/**
 * ルビ・傍点を除去してプレーンテキストに変換
 * |漢字《ルビ》→ 漢字
 * 《《傍点》》→ 傍点
 * <<横倒し>> → 横倒し
 */
export function stripRubyAndEmphasis(text) {
  let result = text;
  // 横倒し
  result = result.replace(/<<(.+?)>>/g, '$1');
  // 傍点
  result = result.replace(/《《(.+?)》》/g, '$1');
  // ルビ（親文字のみ残す）
  result = result.replace(/\|(.+?)《(.+?)》/g, '$1');
  return result;
}

/**
 * 1行を20字詰めで何行になるか計算（垂れ下がり対応）
 */
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

    // 21字目が垂れ下がり対象なら21字で1行
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

/**
 * ファイルの400字詰め計算
 * @returns {{ totalRows: number, pages: number, charCount: number }}
 */
function countPagesForFile(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  let totalRows = 0;
  let charCount = 0;

  for (const rawLine of lines) {
    // Memo行・Epigraph行・POV行はスキップ
    if (isMemoLine(rawLine)) continue;
    if (isEpigraphLine(rawLine)) continue;
    if (isPovLine(rawLine)) continue;

    // 区切り記号行（◇など）はスキップ
    if (isSeparator(rawLine)) continue;

    // ルビ・傍点を除去
    const line = stripRubyAndEmphasis(rawLine);
    const trimmed = line.trim();

    // 空行は1行としてカウント
    if (trimmed === '') {
      totalRows++;
      continue;
    }

    // 視点行【】は章タイトルとして1行
    if (isViewpointLine(rawLine)) {
      totalRows++;
      charCount += [...stripRubyAndEmphasis(rawLine.replace(/^【.*?】/, ''))].length;
      continue;
    }

    // 通常行：20字詰めで何行になるか計算
    const lineRows = countLinesFor20Chars(line);
    totalRows += lineRows;
    charCount += [...line].length;
  }

  const pages = totalRows / 20;
  return { totalRows, pages, charCount };
}

/**
 * ディレクトリ内のtxtファイルを番号順で取得
 */
function getTextFiles(dirPath) {
  return readdirSync(dirPath)
    .filter(f => f.endsWith('.txt') && f !== 'synopsis.txt')
    .sort((a, b) => {
      const numA = parseInt(a.match(/\d+/)?.[0] || '0', 10);
      const numB = parseInt(b.match(/\d+/)?.[0] || '0', 10);
      return numA - numB;
    })
    .map(f => join(dirPath, f));
}

function main() {
  const args = process.argv.slice(2);
  const target = args[0] || 'story.txt';

  try {
    const stat = statSync(target);

    if (stat.isDirectory()) {
      // ディレクトリの場合：全txtファイルを集計
      const files = getTextFiles(target);
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
      // ファイルの場合：単一ファイルを計算
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

  describe('stripRubyAndEmphasis', () => {
    test('ルビは親文字のみ残す', () => {
      expect(stripRubyAndEmphasis('|漢字《かんじ》')).toBe('漢字');
    });
    test('傍点は中身だけ残す', () => {
      expect(stripRubyAndEmphasis('《《強調》》')).toBe('強調');
    });
    test('横倒しは中身だけ残す', () => {
      expect(stripRubyAndEmphasis('<<ABC>>')).toBe('ABC');
    });
    test('複数記法が混在しても全部解除', () => {
      expect(stripRubyAndEmphasis('|漢字《かんじ》と《《強調》》と<<X>>')).toBe('漢字と強調とX');
    });
    test('特別な記法がなければそのまま返す', () => {
      expect(stripRubyAndEmphasis('普通の本文')).toBe('普通の本文');
    });
  });

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
