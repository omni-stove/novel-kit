#!/usr/bin/env node
/**
 * 400字詰め原稿用紙換算スクリプト
 *
 * 使い方:
 *   node scripts/count-pages.mts <file-or-dir>
 */

import { statSync } from 'fs';
import { basename } from 'path';
import {
  readLines,
  isMemoLine,
  isEpigraphLine,
  isPovLine,
  isViewpointLine,
  isSeparator,
  stripInlineMarkup,
} from './lib/text-parser.mts';
import { getTextFilesFromDir } from './lib/manuscript.mts';
import { countWrappedRows } from './lib/grid.mts';
import { runMain } from './lib/cli.mts';

const COLS = 20;
const ROWS = 20;

function countPagesForFile(filePath) {
  let totalRows = 0;
  let charCount = 0;

  for (const rawLine of readLines(filePath)) {
    if (isMemoLine(rawLine)) continue;
    if (isEpigraphLine(rawLine)) continue;
    if (isPovLine(rawLine)) continue;
    if (isSeparator(rawLine)) continue;

    const line = stripInlineMarkup(rawLine);

    if (line.trim() === '') {
      totalRows++;
      continue;
    }

    // 視点行【】は章タイトルとして1行扱い
    if (isViewpointLine(rawLine)) {
      totalRows++;
      charCount += [...stripInlineMarkup(rawLine.replace(/^【.*?】/, ''))].length;
      continue;
    }

    totalRows += countWrappedRows(line, COLS);
    charCount += [...line].length;
  }

  return { totalRows, pages: totalRows / ROWS, charCount };
}

function main() {
  const target = process.argv[2] || 'story.txt';

  if (statSync(target).isDirectory()) {
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
    const grandPages = grandTotalRows / ROWS;
    console.log(`  ${'合計'.padEnd(18)} ${grandTotalRows.toString().padStart(5)}行  ${grandPages.toFixed(1).padStart(6)}枚  ${grandTotalChars.toLocaleString().padStart(8)}字`);
    return;
  }

  const { totalRows, pages, charCount } = countPagesForFile(target);
  console.log(`📄 ${basename(target)}`);
  console.log(`総行数: ${totalRows} 行`);
  console.log(`400字詰め: ${pages.toFixed(1)} 枚`);
  console.log(`文字数: ${charCount.toLocaleString()} 字`);
}

runMain(import.meta.url, main);
