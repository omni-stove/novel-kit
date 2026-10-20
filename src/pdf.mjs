#!/usr/bin/env node

/**
 * txtファイルをマージして縦書きPDFを生成するスクリプト
 *
 * 使い方:
 *   node scripts/txt-to-pdf.mts -o output.pdf file1.txt file2.txt ...
 *   node scripts/txt-to-pdf.mts -o output.pdf ./directory/
 *
 * オプション:
 *   -o, --output <file>  出力ファイル名（必須）
 *   --title <text>       タイトル（1ページ目にタイトルのみ表示）
 *   --no-page-break      ファイル間のページブレークを無効化
 *   --no-chapter-break   章（視点切替）ごとの改ページを無効化。章境界は空行1つで連結し、
 *                        同一章内のファイル境界には区切り字「◇◇◇」を挟む（--part 非指定時のみ有効）
 *   --horizontal         横書きモード
 *   --size WxH           1ページの文字数（例: --size 40x40 → 40字×40行）
 *   --limit <n>          先頭からn個のファイルのみ処理
 *   --part 060,085,...   部の境界となるファイル名プレフィックス（co-split の --splits と同形式）。
 *                        該当ファイルから新しい部が始まる。各部の頭で改ページし、
 *                        本文先頭に「N章」を表示。
 *                        部の内側のファイル境界は改ページせず、章アンカーが跨ぐ境界はそのまま連結、
 *                        同一章内のファイル境界には区切り字「◇◇◇」を挟む。
 *                        1始まりのファイル順インデックス指定もフォールバックで受け付ける。
 *   --synopsis-on-title   梗概をタイトルページに表示（デフォルト: 別ページ）
 *   --no-synopsis        梗概（synopsis.txt）を入れない
 *   --coverless          表紙ページを作らず、梗概と本文の頭にタイトル・著者名を本文サイズで表示
 *   --open               生成後にプレビューを開く
 *   --blank-after-heading 章見出し（視点行）と本文の間に空行を1行補う（既定: 補わない）
 *   --count-only         原稿用紙換算（文字数・行数・枚数）のみを表示して終了
 *                        --size 未指定時は 20x20（400字詰め原稿用紙）
 *   --review             下読み用モード。表紙・梗概・人物紹介・部構成（--part）をすべて無視し、
 *                        先頭から約2万字に最も近いファイル境界までをスライスして1本のPDFを生成する。
 *   --pages 42,50-53     指定した本文ページだけを抜き出したPDFを出力する（修正差し替え用）。
 *                        指定は本文ノンブル基準（前付の i,ii… を除いた 1,2,3…）。カンマ区切り＋範囲（a-b）対応。
 *                        全ページにノンブルを振り切ってから指定外を削除するため、抜き出したページの
 *                        番号は全体版と完全に一致する。
 */

import { PDFDocument, PDFName, rgb } from 'pdf-lib';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { basename } from 'path';
import { inflateSync } from 'zlib';
import { escapeHtml, parseTextFile, readLines, countChars } from './lib/text-parser.mts';
import {
  parseWithSectionNumbering, logSections, requireInputFiles, countGenkoRows, resolvePartIndices, findSidecarFile, startsNewChapter,
  SYNOPSIS_FILENAME, CHARACTERS_FILENAME, FILE_SEPARATOR_MARK,
} from './lib/manuscript.mts';
import { googleFontsLinks, VERTICAL_GLYPH_CSS } from './lib/html.mts';
import { parseCliArgs, ARG, fail, requireOutput, buildPdfFromHtml, openFile, runMain } from './lib/cli.mts';

const EMPTY_LINE_HTML = '<p class="empty">&nbsp;</p>';
const SEPARATOR_BLOCK_HTML = `${EMPTY_LINE_HTML}\n<p class="separator">${FILE_SEPARATOR_MARK}</p>\n${EMPTY_LINE_HTML}\n`;

// 累積が targetChars 以上に達した時点で打ち切る。差分比較を <= にしているのは、
// 同じ差分なら、より多く含む側を優先するため
export function selectReviewBoundary(charCounts, targetChars) {
  if (charCounts.length === 0) return 0;
  let cum = 0;
  let bestEnd = 1;
  let bestDiff = Infinity;
  for (let i = 0; i < charCounts.length; i++) {
    cum += charCounts[i];
    const diff = Math.abs(cum - targetChars);
    if (diff <= bestDiff) {
      bestDiff = diff;
      bestEnd = i + 1;
    }
    if (cum >= targetChars) break;
  }
  return bestEnd;
}

export function parsePageSpec(spec) {
  if (spec == null) return null;
  const ranges = [];
  for (const part of String(spec).split(',')) {
    const t = part.trim();
    if (t === '') continue;
    const m = t.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return null;
    const a = parseInt(m[1], 10);
    const b = m[2] != null ? parseInt(m[2], 10) : a;
    if (a < 1 || b < 1) return null;
    ranges.push([Math.min(a, b), Math.max(a, b)]);
  }
  return ranges.length > 0 ? ranges : null;
}

export function pageInRanges(n, ranges) {
  return ranges.some(([s, e]) => n >= s && n <= e);
}

function parsePlainTextFile(filePath, vertical = true) {
  const htmlParts = [];

  for (const line of readLines(filePath)) {
    if (line.trim() === '') {
      htmlParts.push('<p class="empty">&nbsp;</p>');
    } else {
      htmlParts.push(`<p>${escapeHtml(line, { vertical, rubyLayout: true })}</p>`);
    }
  }

  return htmlParts.join('\n');
}

function parseArgs(argv) {
  const args = parseCliArgs(argv, [
    ARG.output,
    ARG.title,
    ARG.author,
    { key: 'pageBreak', flags: ['--no-page-break'], value: false },
    { key: 'chapterBreak', flags: ['--no-chapter-break'], value: false },
    { key: 'vertical', flags: ['--horizontal'], value: false },
    ARG.size,
    { key: 'limit', flags: ['--limit'], takesValue: true, parse: v => parseInt(v, 10) },
    { key: 'synopsisOnTitle', flags: ['--synopsis-on-title'] },
    { key: 'noSynopsis', flags: ['--no-synopsis'] },
    { key: 'coverless', flags: ['--coverless'] },
    ARG.open,
    { key: 'countOnly', flags: ['--count-only'] },
    ARG.parts,
    { key: 'review', flags: ['--review'] },
    { key: 'pages', flags: ['--pages'], takesValue: true, parse: parsePageSpec },
    { key: 'blankAfterHeading', flags: ['--blank-after-heading'] },
  ], { pageBreak: true, chapterBreak: true, vertical: true, chars: null, lines: null });
  if (args.size) {
    args.chars = args.size.cols;
    args.lines = args.size.rows;
  }
  return args;
}

// A4横（297mm x 210mm）前提の寸法
function calcVerticalLayout(options) {
  const chars = options.chars || 30;
  const lines = options.lines || null;

  const availHeight = 165; // mm
  const fontSizeMm = availHeight / chars;
  const fontSizePt = fontSizeMm / 0.3528;

  let lineHeight;
  if (lines) {
    const availWidth = 257; // mm
    const columnPitchMm = availWidth / lines;
    lineHeight = columnPitchMm / fontSizeMm;
  } else {
    lineHeight = 1.125;
  }

  return { fontSizePt: Math.floor(fontSizePt * 10) / 10, lineHeight, chars };
}

export function generateHtml(sections, options, synopsisHtml = null, synopsisCharCount = 0, charactersHtml = null) {
  const writingMode = options.vertical ? 'vertical-rl' : 'horizontal-tb';
  const layout = options.vertical ? calcVerticalLayout(options) : null;

  const explicitPartIndices = options.parts && options.parts.length > 0
    ? options.parts.map(p => p - 1).sort((a, b) => a - b).filter(i => i > 0 && i < sections.length)
    : null;
  const partFirstIndexSet = explicitPartIndices ? new Set([0, ...explicitPartIndices]) : null;
  // 部の内側と --no-chapter-break では章が変わっても改ページせず、空行1つで連結する
  const chapterPageBreak = !partFirstIndexSet && options.chapterBreak !== false;

  const sectionDiv = (className, html) => `<div class="${className}">\n${html}\n</div>`;

  const sectionHtmls = sections.map((s, i) => {
    const html = s.html
      .replace(/(<p class="empty"[^>]*>&nbsp;<\/p>\n?)+$/, '')
      .replace(/^(<p class="empty"[^>]*>&nbsp;<\/p>\n)+/, '');

    if (partFirstIndexSet?.has(i)) return sectionDiv('section page-break part-section', html);
    if (i === 0) return sectionDiv('section', html);
    if (!startsNewChapter(sections, i)) return sectionDiv('section', `${SEPARATOR_BLOCK_HTML}${html}`);
    if (chapterPageBreak) return sectionDiv('section page-break', html);
    return sectionDiv('section', `${EMPTY_LINE_HTML}\n${html}`);
  });

  const coverlessHeading = options.coverless && options.title
    ? `<p class="coverless-title">${options.title}</p>\n${options.author ? `<p class="coverless-author">${options.author}</p>\n` : ''}`
    : '';

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
${googleFontsLinks('Noto+Serif+JP:wght@400')}
  <style>
    @page {
      size: A4 landscape;
      margin: 20mm 20mm 25mm 20mm;
    }

    body {
      font-family: "Noto Serif JP", "游明朝", "Yu Mincho", "Hiragino Mincho Pro", serif;
      font-size: ${options.vertical ? `${layout.fontSizePt}pt` : '10.5pt'};
      line-height: ${options.vertical ? layout.lineHeight : '1.8'};
      writing-mode: ${writingMode};
      ${options.vertical ? 'text-orientation: mixed;' : ''}
      ${options.vertical ? `height: ${layout.chars}em;` : ''}
      hanging-punctuation: allow-end last;
      text-spacing-trim: space-all;
      orphans: 2;
      widows: 2;
    }

    .section.page-break {
      page-break-before: always;
    }

    .section.page-break:first-child {
      page-break-before: auto;
    }

    p {
      margin: 0;
    }

    p.empty {
      text-indent: 0;
      break-before: avoid;
    }

    p.dialogue-short, p.paragraph-short {
      break-inside: avoid;
    }

    p.dialogue-long, p.paragraph-long {
      orphans: 1;
      widows: 1;
    }

    p.separator {
      text-align: center;
      text-indent: 0;
    }

    .separator-block {
      break-inside: avoid;
    }

    .separator-block p.separator {
      text-align: center;
      text-indent: 0;
      margin-block: 1lh;
    }

    p.viewpoint {
      text-align: start;
      text-indent: 0;
    }


    .epigraph-page .viewpoint {
      text-align: start;
      text-indent: 0;
    }
    .epigraph-page .epigraph-quote {
      text-indent: 0;
      text-align: end;
      /* 引用元の文字数ぶん本文を押し上げ、本文末尾を引用元の先頭に揃える。
         padding だと行長が縮んで本文が折り返してしまうため、
         レイアウトに影響しない translate で描画位置だけをずらす。
         押し上げ量は「本文の先頭が上から一字下げの位置」を上限にクランプする */
      translate: ${options.vertical
        ? `0 calc(-1em * max(0, min(var(--epigraph-source-len, 0), ${layout.chars} - var(--epigraph-quote-len, ${layout.chars}) - 1)))`
        : 'calc(var(--epigraph-source-len, 0) * -1em) 0'};
    }
    .epigraph-page .epigraph-source,
    .epigraph-page .epigraph-line {
      text-indent: 0;
      text-align: end;
      height: ${options.vertical ? `${layout.chars}em` : '165mm'};
    }

    .dash {
      text-orientation: sideways;
      vertical-align: central;
    }
${VERTICAL_GLYPH_CSS}
    .title-page {
      display: flex;
      align-items: center;
      justify-content: center;
      page-break-after: always;
      height: 100%;
    }

    .title-page h1 {
      font-size: 24pt;
      font-weight: normal;
      margin: 0;
    }

    .title-page .author {
      font-size: 14pt;
      margin-top: 2em;
    }

    .title-page.with-synopsis {
      display: block;
    }

    .title-page.with-synopsis h1 {
      font-size: inherit;
      font-weight: bold;
      text-align: center;
      text-indent: 0;
    }

    .title-page.with-synopsis .author {
      font-size: inherit;
      text-align: center;
      text-indent: 0;
      margin-bottom: 2em;
    }

    .coverless-title {
      font-size: inherit;
      font-weight: bold;
      text-align: start;
      text-indent: 0;
      margin: 0;
    }

    .coverless-author {
      font-size: inherit;
      text-align: end;
      text-indent: 0;
      margin: 0;
      ${options.vertical ? `height: ${layout.chars}em;` : ''}
    }

    .synopsis-page {
      page-break-before: always;
      page-break-after: always;
    }

    .synopsis-charcount {
      text-align: end;
      text-indent: 0;
    }

    .synopsis-heading {
      font-size: 1.2em;
      font-weight: bold;
      text-align: center;
      margin-bottom: 1em;
    }

    .characters-page {
      page-break-before: always;
      page-break-after: always;
    }

    .part-heading {
      text-indent: 0;
      text-align: start;
      margin: 0;
      break-after: avoid;
      break-inside: avoid;
      widows: 1;
      orphans: 1;
    }

    .characters-heading {
      font-size: 1.2em;
      font-weight: bold;
      text-align: center;
      margin-bottom: 1em;
    }
  </style>
</head>
<body>
${(() => {
  if (options.coverless) {
    return synopsisHtml
      ? `<div class="synopsis-page">${coverlessHeading && `${coverlessHeading}${EMPTY_LINE_HTML}\n`}${synopsisHtml}</div>`
      : '';
  }

  if (options.title && options.synopsisOnTitle && synopsisHtml) {
    return `<div class="title-page with-synopsis"><h1>${options.title}</h1>${options.author ? `<p class="author">${options.author}</p>` : ''}<p class="empty">&nbsp;</p>\n${synopsisHtml}</div>`;
  }

  const titleBlock = options.title
    ? `<div class="title-page"><h1>${options.title}</h1>${options.author ? `<p class="author">${options.author}</p>` : ''}</div>`
    : '';
  const synopsisBlock = synopsisHtml
    ? `\n<div class="synopsis-page"><h2 class="synopsis-heading">梗概</h2>\n${synopsisHtml}</div>`
    : '';
  return titleBlock + synopsisBlock;
})()}
${charactersHtml ? `<div class="characters-page"><h2 class="characters-heading">登場人物</h2>\n${charactersHtml}\n</div>` : ''}
${(() => {
  if (!coverlessHeading || sectionHtmls.length === 0) {
    return sectionHtmls.join('\n');
  }
  const first = sectionHtmls[0].replace(/^(<div class="[^"]+">\n)/, `$1${coverlessHeading}`);
  return [first, ...sectionHtmls.slice(1)].join('\n');
})()}
</body>
</html>`;
}

function decompressStream(stream) {
  if (!stream || typeof stream.getContents !== 'function') return '';
  const raw = stream.getContents();
  try {
    return new TextDecoder().decode(inflateSync(Buffer.from(raw)));
  } catch {
    return new TextDecoder().decode(raw);
  }
}

function removeBlankPages(pdfDoc, titlePageIndex) {
  const pagesToRemove = [];
  const pageCount = pdfDoc.getPageCount();

  for (let i = 0; i < pageCount; i++) {
    if (i === titlePageIndex) continue;

    try {
      const page = pdfDoc.getPage(i);
      const contentsRef = page.node.get(PDFName.of('Contents'));

      if (!contentsRef) {
        pagesToRemove.push(i);
        continue;
      }

      const resolved = pdfDoc.context.lookup(contentsRef);
      const contentText = decompressStream(resolved);
      const tjCount = (contentText.match(/Tj/g) || []).length;

      if (tjCount === 0) {
        pagesToRemove.push(i);
      }
    } catch {
      // 解析エラーはスキップ
    }
  }

  for (let i = pagesToRemove.length - 1; i >= 0; i--) {
    pdfDoc.removePage(pagesToRemove[i]);
  }

  return pagesToRemove.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.countOnly) {
    // 原稿用紙換算の既定は 20字×20行（400字詰め）
    if (args.chars == null && args.lines == null) {
      args.chars = 20;
      args.lines = 20;
    } else if (args.chars == null || args.lines == null) {
      fail('--count-only には --size WxH の両方を指定してください');
    }
  }

  if (!args.countOnly) requireOutput(args, 'output.pdf');

  if (args.pages === null && process.argv.some(a => a === '--pages' || a.startsWith('--pages='))) {
    fail('--pages の指定が不正です（例: --pages 42 / 42-45 / 42,50,60-62）');
  }

  let inputFiles = requireInputFiles(args.files, [SYNOPSIS_FILENAME, CHARACTERS_FILENAME]);

  if (args.limit != null && args.limit > 0) {
    inputFiles = inputFiles.slice(0, args.limit);
  }

  console.log(`入力ファイル: ${inputFiles.length}件`);

  if (args.review) {
    args.coverless = true;
    args.synopsisOnTitle = false;
    args.parts = null;

    const targetChars = 20000;
    const charCounts = inputFiles.map(f => countGenkoRows(readLines(f), args.chars || 30).chars);
    const bestEnd = selectReviewBoundary(charCounts, targetChars);
    const slice = inputFiles.slice(0, bestEnd);
    const sliceChars = charCounts.slice(0, bestEnd).reduce((n, c) => n + c, 0);
    console.log(`下読みモード: ${basename(inputFiles[0])} 〜 ${basename(inputFiles[bestEnd - 1])} (${slice.length}ファイル, ${sliceChars.toLocaleString()}字)`);
    inputFiles = slice;
  }

  if (args.parts && args.parts.length > 0) {
    args.parts = resolvePartIndices(args.parts, inputFiles).map(i => i + 1);
    const allParts = [1, ...args.parts.filter(p => p > 1)];
    console.log(`部の境界: ${allParts.map((p, i) => `第${i + 1}部=${basename(inputFiles[p - 1])}`).join(', ')}`);
  }

  if (args.countOnly) {
    const counts = inputFiles.map(f => countGenkoRows(readLines(f), args.chars));
    const totalLines = counts.reduce((n, c) => n + c.rows, 0);
    const totalChars = counts.reduce((n, c) => n + c.chars, 0);
    const pages = totalLines / args.lines;
    const pagesCeil = Math.ceil(pages);
    console.log(`\n原稿用紙換算 (${args.chars}字×${args.lines}行)`);
    console.log(`文字数: ${totalChars.toLocaleString()}字`);
    console.log(`行数: ${totalLines.toLocaleString()}行`);
    console.log(`枚数: ${pages.toFixed(2)}枚 (切上 ${pagesCeil}枚)`);
    return;
  }

  const synopsisPath = args.review || args.noSynopsis ? null : findSidecarFile(inputFiles, args.files, SYNOPSIS_FILENAME);
  let synopsisHtml = null;
  let synopsisCharCount = 0;
  if (synopsisPath) {
    const synopsisLines = readLines(synopsisPath).filter(l => l.trim() !== '');
    synopsisCharCount = synopsisLines.reduce((sum, line) => {
      const html = escapeHtml(line, { vertical: args.vertical });
      const text = html.replace(/<rt>.*?<\/rt>/g, '').replace(/<[^>]+>/g, '').replace(/[\s\u00A0]/g, '');
      return sum + [...text].length;
    }, 0);
    console.log(`梗概: ${basename(synopsisPath)}  （${synopsisCharCount.toLocaleString()}文字）`);
    synopsisHtml = parsePlainTextFile(synopsisPath, args.vertical);
  }

  const charactersPath = args.review ? null : findSidecarFile(inputFiles, args.files, CHARACTERS_FILENAME);
  let charactersHtml = null;
  if (charactersPath) {
    console.log(`人物紹介: ${basename(charactersPath)}`);
    charactersHtml = parsePlainTextFile(charactersPath, args.vertical);
  }

  const partFirstIndices = args.parts && args.parts.length > 0
    ? args.parts.map(p => p - 1).filter(i => i > 0 && i < inputFiles.length)
    : null;
  const sections = parseWithSectionNumbering(inputFiles, parseTextFile, {
    vertical: args.vertical,
    chars: args.chars || 30,
    partFirstIndices,
    blankAfterHeading: args.blankAfterHeading,
  });
  logSections(sections, inputFiles);

  const html = generateHtml(sections, args, synopsisHtml, synopsisCharCount, charactersHtml);

  console.log('PDF生成中...');
  console.log(`HTML出力: ${buildPdfFromHtml(html, args.output)}`);
  const pdfBuffer = readFileSync(args.output);

  const pdfDoc = await PDFDocument.load(pdfBuffer);

  const titlePageIndex = (args.title && !args.coverless) ? 0 : -1;
  const removedCount = removeBlankPages(pdfDoc, titlePageIndex);
  if (removedCount > 0) {
    console.log(`白紙ページを${removedCount}ページ除去しました`);
  }

  const pageCount = pdfDoc.getPageCount();

  // 前付ページ数を確定（前付のみレンダリングして実ページ数を取得）
  let frontMatterPages = 0;
  const hasCover = args.title && !args.coverless;
  const hasFrontMatter = hasCover || (synopsisHtml && !args.synopsisOnTitle) || charactersHtml;
  if (hasFrontMatter) {
    const fmHtml = generateHtml([], args, synopsisHtml, synopsisCharCount, charactersHtml);
    const fmPdfPath = args.output.replace(/\.pdf$/, '.fm.pdf');
    const fmHtmlPath = buildPdfFromHtml(fmHtml, fmPdfPath, { quiet: true });
    const fmDoc = await PDFDocument.load(readFileSync(fmPdfPath));
    removeBlankPages(fmDoc, hasCover ? 0 : -1);
    frontMatterPages = fmDoc.getPageCount();
    try { unlinkSync(fmHtmlPath); unlinkSync(fmPdfPath); } catch {}
    console.log(`前付ページ数: ${frontMatterPages}`);
  }

  for (let i = 0; i < pageCount; i++) {
    const page = pdfDoc.getPage(i);
    const { width } = page.getSize();
    const pageNum = (i + 1) - frontMatterPages;
    const text = pageNum <= 0
      ? ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'][i] || `${i + 1}`
      : `${pageNum}`;
    const fontSize = 10;
    const textWidth = fontSize * text.length * 0.5;
    page.drawText(text, {
      x: width / 2 - textWidth / 2,
      y: 40,
      size: fontSize,
      color: rgb(0, 0, 0),
    });
  }

  // --pages: ノンブルを振り切った後で、本文ノンブルが指定範囲に入らないページを削除する。
  // ノンブルは全体版と同じ計算で描画済みなので、抜き出したページの番号は全体版と一致する（差し替え用）。
  let extractedBodyNums = null;
  if (args.pages) {
    const keep = [];
    for (let i = 0; i < pageCount; i++) {
      const bodyNum = (i + 1) - frontMatterPages;
      if (bodyNum >= 1 && pageInRanges(bodyNum, args.pages)) keep.push(i);
    }
    if (keep.length === 0) fail('--pages の指定に該当する本文ページがありません');
    const keepSet = new Set(keep);
    for (let i = pageCount - 1; i >= 0; i--) {
      if (!keepSet.has(i)) pdfDoc.removePage(i);
    }
    extractedBodyNums = keep.map(i => (i + 1) - frontMatterPages);
  }

  if (args.vertical) {
    const viewerPrefs = pdfDoc.catalog.getOrCreateViewerPreferences();
    viewerPrefs.setReadingDirection('R2L');
  }

  const finalPdf = await pdfDoc.save();
  writeFileSync(args.output, finalPdf);

  console.log(`\nPDF出力: ${args.output}`);
  if (extractedBodyNums) {
    console.log(`抽出ページ（本文ノンブル）: ${extractedBodyNums.join(', ')}（計${extractedBodyNums.length}頁）`);
    console.log(`ノンブルは全体版（計${pageCount - frontMatterPages}頁）と一致しています`);
  } else {
    const totalChars = sections.reduce((sum, s) => sum + countChars(s.html), 0);
    console.log(`文字数: ${totalChars.toLocaleString()}字`);
    const chapterCount = sections.filter(s => s.hasViewpointStart).length;
    console.log(`章数: ${chapterCount}章`);
    if (frontMatterPages > 0) {
      console.log(`枚数: タイトル・梗概 ${frontMatterPages}枚 ＋ 本文 ${pageCount - frontMatterPages}枚 ＝ 計${pageCount}枚`);
    } else {
      console.log(`枚数: ${pageCount}枚`);
    }
  }

  if (args.open) {
    openFile(args.output);
  }
}

runMain(import.meta.url, main);

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest;

  const makeSection = (overrides = {}) => ({
    html: '<p>本文</p>',
    hasViewpointStart: false,
    hasViewpointEnd: false,
    hasEmptyViewpointStart: false,
    pov: null,
    ...overrides,
  });

  const baseOptions = {
    title: null,
    author: null,
    vertical: true,
    chars: 30,
    lines: null,
    synopsisOnTitle: false,
    coverless: false,
    parts: null,
  };


  describe('generateHtml', () => {
    test('--part指定時: 部の境界は page-break part-section', () => {
      const sections = [
        makeSection({ html: '<p>1部1ファイル目</p>' }),
        makeSection({ html: '<p>2部1ファイル目</p>' }),
      ];
      const html = generateHtml(sections, { ...baseOptions, parts: [2] });

      const partSectionCount = (html.match(/page-break part-section/g) || []).length;
      expect(partSectionCount).toBe(2);
      expect(html).toMatch(/<div class="section page-break part-section">\s*<p>1部1ファイル目<\/p>/);
      expect(html).toMatch(/<div class="section page-break part-section">\s*<p>2部1ファイル目<\/p>/);
    });

    test('--part指定時: 同一part内かつアンカーなしのファイル境界には◇◇◇が前後空行付きで挿入される', () => {
      const sections = [
        makeSection({ html: '<p>1ファイル目</p>' }),
        makeSection({ html: '<p>2ファイル目</p>' }),
        makeSection({ html: '<p>3ファイル目</p>' }),
      ];
      const html = generateHtml(sections, { ...baseOptions, parts: [1] });

      const separatorCount = (html.match(/<p class="separator">◇◇◇<\/p>/g) || []).length;
      expect(separatorCount).toBe(2);
      expect(html).toContain('<div class="section">\n<p class="empty">&nbsp;</p>\n<p class="separator">◇◇◇</p>\n<p class="empty">&nbsp;</p>\n<p>2ファイル目</p>');
      expect(html).toContain('<div class="section">\n<p class="empty">&nbsp;</p>\n<p class="separator">◇◇◇</p>\n<p class="empty">&nbsp;</p>\n<p>3ファイル目</p>');
    });

    test('--part指定時: 章アンカーがファイルを跨ぐ境界には◇◇◇は入らず、空行1つで連結', () => {
      const sections = [
        makeSection({ html: '<p>1ファイル目</p>', hasViewpointEnd: true }),
        makeSection({
          html: '<p class="viewpoint">【視点者】</p>\n<p class="empty">&nbsp;</p>\n<p>2ファイル目</p>',
          hasViewpointStart: true,
        }),
      ];
      const html = generateHtml(sections, { ...baseOptions, parts: [1] });

      expect(html.includes('◇◇◇')).toBe(false);
      expect((html.match(/page-break part-section/g) || []).length).toBe(1);
      expect(html.includes('<div class="section page-break">')).toBe(false);
      expect(html).toMatch(/<div class="section">\n<p class="empty">&nbsp;<\/p>\n<p class="viewpoint">【視点者】<\/p>/);
    });

    test('--part指定時: ファイル末尾の空行は剥がされる', () => {
      const sections = [
        makeSection({ html: '<p>1ファイル目</p>\n<p class="empty">&nbsp;</p>\n<p class="empty">&nbsp;</p>' }),
        makeSection({ html: '<p>2ファイル目</p>' }),
      ];
      const html = generateHtml(sections, { ...baseOptions, parts: [1] });

      const firstDivMatch = html.match(/<div class="section page-break part-section">\n([\s\S]*?)<\/div>/);
      expect(firstDivMatch).not.toBeNull();
      expect(firstDivMatch[1].includes('<p class="empty">')).toBe(false);
      expect(firstDivMatch[1]).toMatch(/<p>1ファイル目<\/p>/);
    });

    test('--part指定時: ファイル先頭の空行は◇◇◇境界で剥がされる', () => {
      const sections = [
        makeSection({ html: '<p>1ファイル目</p>' }),
        makeSection({ html: '<p class="empty">&nbsp;</p>\n<p class="empty">&nbsp;</p>\n<p>2ファイル目</p>' }),
      ];
      const html = generateHtml(sections, { ...baseOptions, parts: [1] });

      expect(html).toMatch(/<p class="empty">&nbsp;<\/p>\n<p>2ファイル目<\/p>/);
      expect(html).not.toMatch(/<p class="separator">◇◇◇<\/p>\n<p class="empty">&nbsp;<\/p>\n<p class="empty">&nbsp;<\/p>\n<p class="empty">&nbsp;<\/p>/);
    });

    test('--part未指定時: 視点切替で改ページ、それ以外は◇◇◇', () => {
      const sections = [
        makeSection({ html: '<p>1ファイル目</p>' }),
        makeSection({ html: '<p>2ファイル目</p>' }),
        makeSection({
          html: '<p class="viewpoint">【視点】</p>\n<p>3ファイル目</p>',
          hasViewpointStart: true,
        }),
      ];
      const html = generateHtml(sections, baseOptions);

      const separatorCount = (html.match(/<p class="separator">◇◇◇<\/p>/g) || []).length;
      expect(separatorCount).toBe(1);
      expect(html).toMatch(/<div class="section page-break">\n<p class="viewpoint">【視点】<\/p>/);
    });

    test('--part未指定時: 前ファイルが【】で終わると次ファイル先頭で改ページ', () => {
      const sections = [
        makeSection({ html: '<p>1ファイル目</p>', hasViewpointEnd: true }),
        makeSection({ html: '<p>2ファイル目</p>' }),
      ];
      const html = generateHtml(sections, baseOptions);

      expect(html.includes('◇◇◇')).toBe(false);
      expect(html).toMatch(/<div class="section page-break">\n<p>2ファイル目<\/p>/);
    });

    test('--part未指定時: ◇◇◇は前後空行付きで挿入される', () => {
      const sections = [
        makeSection({ html: '<p>1ファイル目</p>' }),
        makeSection({ html: '<p>2ファイル目</p>' }),
      ];
      const html = generateHtml(sections, baseOptions);

      expect(html).toContain('<div class="section">\n<p class="empty">&nbsp;</p>\n<p class="separator">◇◇◇</p>\n<p class="empty">&nbsp;</p>\n<p>2ファイル目</p>');
    });

    test('coverless: 最初のセクションの先頭（章頭/partの頭）の前に空行が入らない', () => {
      const sections = [
        makeSection({
          html: '<p class="viewpoint">【視点】</p>\n<p>本文</p>',
          hasViewpointStart: true,
        }),
      ];
      const html = generateHtml(sections, {
        ...baseOptions,
        coverless: true,
        title: 'タイトル',
        author: '著者',
      });

      expect(html).toMatch(/<p class="coverless-title">タイトル<\/p>\n<p class="coverless-author">著者<\/p>\n<p class="viewpoint">【視点】<\/p>/);
      expect(html).not.toMatch(/<p class="coverless-author">著者<\/p>\n<p class="empty">/);
    });

    test('coverless かつ --part指定時も最初のpart先頭の前に空行が入らない', () => {
      const sections = [
        makeSection({ html: '<p>1部本文</p>' }),
        makeSection({ html: '<p>2部本文</p>' }),
      ];
      const html = generateHtml(sections, {
        ...baseOptions,
        coverless: true,
        title: 'タイトル',
        parts: [2],
      });

      expect(html).toMatch(/<p class="coverless-title">タイトル<\/p>\n<p>1部本文<\/p>/);
      expect(html).not.toMatch(/<p class="coverless-title">タイトル<\/p>\n<p class="empty">/);
    });

    test('--no-chapter-break: 章境界でも改ページせず空行1つで連結', () => {
      const sections = [
        makeSection({ html: '<p>1ファイル目</p>' }),
        makeSection({ html: '<p>2ファイル目</p>' }),
        makeSection({
          html: '<p class="viewpoint">【視点】</p>\n<p>3ファイル目</p>',
          hasViewpointStart: true,
        }),
      ];
      const html = generateHtml(sections, { ...baseOptions, chapterBreak: false });

      // 改ページ用のクラスは一切付かない
      expect(html.includes('<div class="section page-break')).toBe(false);
      // 同一章内のファイル境界には◇◇◇
      expect((html.match(/<p class="separator">◇◇◇<\/p>/g) || []).length).toBe(1);
      // 章境界（視点切替）は空行1つで連結
      expect(html).toMatch(/<div class="section">\n<p class="empty">&nbsp;<\/p>\n<p class="viewpoint">【視点】<\/p>/);
    });

    test('--no-chapter-break: 先頭ファイルの頭の空行は剥がされる', () => {
      const sections = [makeSection({ html: '<p class="empty">&nbsp;</p>\n<p>1ファイル目</p>' })];
      const html = generateHtml(sections, { ...baseOptions, chapterBreak: false });
      expect(html).toMatch(/<div class="section">\n<p>1ファイル目<\/p>/);
    });

    test('--no-chapter-break: 前ファイルが【】で終わる章境界も空行1つで連結', () => {
      const sections = [
        makeSection({ html: '<p>1ファイル目</p>', hasViewpointEnd: true }),
        makeSection({ html: '<p>2ファイル目</p>' }),
      ];
      const html = generateHtml(sections, { ...baseOptions, chapterBreak: false });

      expect(html.includes('<div class="section page-break')).toBe(false);
      expect(html.includes('◇◇◇')).toBe(false);
      expect(html).toMatch(/<div class="section">\n<p class="empty">&nbsp;<\/p>\n<p>2ファイル目<\/p>/);
    });
  });

  describe('selectReviewBoundary', () => {
    test('空配列は0', () => {
      expect(selectReviewBoundary([], 20000)).toBe(0);
    });

    test('全部足してもtargetに届かない場合は全件', () => {
      expect(selectReviewBoundary([3000, 4000, 5000], 20000)).toBe(3);
    });

    test('targetを最初に超えた境界が最も近ければそこで止まる', () => {
      // 累積: 5000, 12000, 21000 → target=20000 との差は |5000-20000|=15000, 8000, 1000
      expect(selectReviewBoundary([5000, 7000, 9000], 20000)).toBe(3);
    });

    test('targetを超える前の方がtargetに近ければ手前で止まる', () => {
      // 累積: 19500, 30000 → 差は 500, 10000 → bestEndは1（19500の方が近い）
      expect(selectReviewBoundary([19500, 10500], 20000)).toBe(1);
    });

    test('累積がちょうど一致する境界を選ぶ', () => {
      // 累積: 10000, 20000, 30000 → 差は 10000, 0, 10000 → bestEnd=2
      expect(selectReviewBoundary([10000, 10000, 10000], 20000)).toBe(2);
    });

    test('差が同じなら多く含む方（後ろ）を採用', () => {
      // 累積: 15000, 25000 → 差は 5000, 5000 → <= で更新するので bestEnd=2
      expect(selectReviewBoundary([15000, 10000], 20000)).toBe(2);
    });

    test('最初の1ファイルでtargetを大幅超過してもそれを返す', () => {
      expect(selectReviewBoundary([50000, 1000], 20000)).toBe(1);
    });
  });

  describe('parsePageSpec / pageInRanges', () => {
    test('parsePageSpec: 単一ページ', () => {
      expect(parsePageSpec('42')).toEqual([[42, 42]]);
    });

    test('parsePageSpec: 範囲指定', () => {
      expect(parsePageSpec('42-45')).toEqual([[42, 45]]);
    });

    test('parsePageSpec: カンマ区切り＋範囲の混在（空白も許容）', () => {
      expect(parsePageSpec('42, 50, 60-62')).toEqual([[42, 42], [50, 50], [60, 62]]);
    });

    test('parsePageSpec: 逆順の範囲は昇順に正規化', () => {
      expect(parsePageSpec('45-42')).toEqual([[42, 45]]);
    });

    test('parsePageSpec: 不正な指定は null', () => {
      expect(parsePageSpec('abc')).toBeNull();
      expect(parsePageSpec('0')).toBeNull();
      expect(parsePageSpec('1-')).toBeNull();
      expect(parsePageSpec('')).toBeNull();
    });

    test('pageInRanges: 範囲内外を判定', () => {
      const ranges = [[42, 42], [50, 50], [60, 62]];
      expect(pageInRanges(42, ranges)).toBe(true);
      expect(pageInRanges(61, ranges)).toBe(true);
      expect(pageInRanges(43, ranges)).toBe(false);
      expect(pageInRanges(63, ranges)).toBe(false);
    });
  });
}
