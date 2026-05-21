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
 *   --coverless          表紙ページを作らず、梗概と本文の頭にタイトル・著者名を本文サイズで表示
 *   --open               生成後にプレビューを開く
 *   --count-only         原稿用紙換算（文字数・行数・枚数）のみを表示して終了
 *                        --size 未指定時は 20x20（400字詰め原稿用紙）
 *   --review             下読み用モード。表紙・梗概・人物紹介・部構成（--part）をすべて無視し、
 *                        先頭から約2万字に最も近いファイル境界までをスライスして1本のPDFを生成する。
 */

import { PDFDocument, PDFName, rgb } from 'pdf-lib';
import { readFileSync, writeFileSync, statSync, existsSync, unlinkSync } from 'fs';
import { basename, resolve, dirname } from 'path';
import { inflateSync } from 'zlib';
import { execSync } from 'child_process';
import { join } from 'path';
import { escapeHtml, parseTextFile, parseWithSectionNumbering, getTextFilesFromDir, getFilteredLines, isMemoLine, isSeparator, isViewpointLine, countChars, logSections } from './lib/text-parser.mts';

// 本文の消費行数と文字数を text-parser ベースで集計
function countManuscript(inputFiles, charsPerLine) {
  const cap = charsPerLine * 2;
  const stripMarkup = (line) => line
    .replace(/\|(.+?)《(.+?)》/g, '$1')
    .replace(/《《(.+?)》》/g, '$1')
    .replace(/<<(.+?)>>/g, '$1');

  let totalLines = 0;
  let totalChars = 0;
  for (const filePath of inputFiles) {
    const { lines } = getFilteredLines(filePath);
    let lastWasViewpoint = false;
    for (const line of lines) {
      if (line.trim() === '') { totalLines += 1; lastWasViewpoint = false; continue; }
      if (isSeparator(line)) { totalLines += 1; lastWasViewpoint = false; continue; }
      if (isViewpointLine(line)) {
        const processed = stripMarkup(line);
        totalChars += [...processed].length;
        let units = 0;
        for (const ch of processed) units += /[0-9A-Za-z]/.test(ch) ? 1 : 2;
        totalLines += Math.ceil(units / cap);
        lastWasViewpoint = true;
        continue;
      }
      if (lastWasViewpoint) { totalLines += 1; lastWasViewpoint = false; }
      const processed = stripMarkup(line);
      totalChars += [...processed].length;
      let units = 0;
      for (const ch of processed) units += /[0-9A-Za-z]/.test(ch) ? 1 : 2;
      totalLines += Math.ceil(units / cap);
    }
  }
  return { totalLines, totalChars };
}

// 各要素の文字数を順に累積し、累積値が targetChars に最も近くなる「区切り目（1始まりの末尾位置）」を返す。
// 累積が targetChars 以上に達した時点で打ち切る（同じ差分なら、より多く含む側を優先）。
// charCounts が空なら 0、長さ1なら 1 を返す。
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

const SYNOPSIS_FILENAME = 'synopsis.txt';
const CHARACTERS_FILENAME = 'characters.txt';

// 指定ファイルを入力ディレクトリ群から探す
function findSidecarFile(inputFiles, inputPaths, filename) {
  for (const p of inputPaths) {
    try {
      if (statSync(p).isDirectory()) {
        const sidecarPath = join(p, filename);
        if (existsSync(sidecarPath)) return sidecarPath;
      }
    } catch { /* ignore */ }
  }
  if (inputFiles.length > 0) {
    const dir = dirname(inputFiles[0]);
    const sidecarPath = join(dir, filename);
    if (existsSync(sidecarPath)) return sidecarPath;
  }
  return null;
}

function findSynopsisFile(inputFiles, inputPaths) {
  return findSidecarFile(inputFiles, inputPaths, SYNOPSIS_FILENAME);
}

function findCharactersFile(inputFiles, inputPaths) {
  return findSidecarFile(inputFiles, inputPaths, CHARACTERS_FILENAME);
}

// プレーンテキストの行をHTMLに変換（梗概・人物紹介で共通）
function parsePlainTextFile(filePath, vertical = true) {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const htmlParts = [];

  for (const line of lines) {
    if (line.trim() === '') {
      htmlParts.push('<p class="empty">&nbsp;</p>');
    } else {
      htmlParts.push(`<p>${escapeHtml(line, { vertical })}</p>`);
    }
  }

  return htmlParts.join('\n');
}

function parseSynopsisFile(filePath, vertical = true) {
  return parsePlainTextFile(filePath, vertical);
}

function parseCharactersFile(filePath, vertical = true) {
  return parsePlainTextFile(filePath, vertical);
}

// 引数をパース
function parseArgs(args) {
  const result = {
    output: null,
    title: null,
    author: null,
    files: [],
    pageBreak: true,
    vertical: true,
    open: false,
    synopsisOnTitle: false,
    coverless: false,
    limit: null,
    chars: null,
    lines: null,
    countOnly: false,
    parts: null,
    review: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-o' || arg === '--output') {
      result.output = args[++i];
    } else if (arg === '--title') {
      result.title = args[++i];
    } else if (arg === '--author') {
      result.author = args[++i];
    } else if (arg === '--no-page-break') {
      result.pageBreak = false;
    } else if (arg === '--horizontal') {
      result.vertical = false;
    } else if (arg === '--size') {
      const size = args[++i];
      const [chars, lines] = size.split('x').map(Number);
      result.chars = chars;
      result.lines = lines;
    } else if (arg === '--limit') {
      result.limit = parseInt(args[++i], 10);
    } else if (arg === '--synopsis-on-title') {
      result.synopsisOnTitle = true;
    } else if (arg === '--coverless') {
      result.coverless = true;
    } else if (arg === '--open') {
      result.open = true;
    } else if (arg === '--count-only') {
      result.countOnly = true;
    } else if (arg === '--part' || arg === '--parts') {
      const val = args[++i];
      result.parts = val.split(',').map(s => s.trim()).filter(s => s.length > 0);
    } else if (arg.startsWith('--part=') || arg.startsWith('--parts=')) {
      const val = arg.slice(arg.indexOf('=') + 1);
      result.parts = val.split(',').map(s => s.trim()).filter(s => s.length > 0);
    } else if (arg === '--review') {
      result.review = true;
    } else if (!arg.startsWith('-')) {
      result.files.push(arg);
    }
  }

  return result;
}

// 縦書き時のレイアウト計算（A4横: 297mm x 210mm）
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

// HTML生成
export function generateHtml(sections, options, synopsisHtml = null, synopsisCharCount = 0, charactersHtml = null) {
  const writingMode = options.vertical ? 'vertical-rl' : 'horizontal-tb';
  const layout = options.vertical ? calcVerticalLayout(options) : null;

  const explicitPartIndices = options.parts && options.parts.length > 0
    ? options.parts.map(p => p - 1).sort((a, b) => a - b).filter(i => i > 0 && i < sections.length)
    : null;
  const partFirstIndices = explicitPartIndices
    ? [0, ...explicitPartIndices]
    : null;
  const partOrderMap = partFirstIndices
    ? new Map(partFirstIndices.map((idx, i) => [idx, i + 1]))
    : null;

  const stripLeadingEmpties = (html) => html.replace(/^(<p class="empty">&nbsp;<\/p>\n)+/, '');
  const stripTrailingEmpties = (html) => html.replace(/(<p class="empty">&nbsp;<\/p>\n?)+$/, '');

  const separatorBlock = '<p class="empty">&nbsp;</p>\n<p class="separator">◇◇◇</p>\n<p class="empty">&nbsp;</p>\n';

  const sectionHtmls = sections.map((s, i) => {
    const trimmedHtml = stripTrailingEmpties(s.html);

    if (partFirstIndices) {
      const partNum = partOrderMap.get(i);
      if (partNum != null) {
        const html = stripLeadingEmpties(trimmedHtml);
        return `<div class="section page-break part-section">\n${html}\n</div>`;
      }
      const prevEndsViewpoint = i > 0 && sections[i - 1].hasViewpointEnd;
      const isChapterBoundary = s.hasViewpointStart || prevEndsViewpoint;
      if (i > 0 && !isChapterBoundary) {
        const html = stripLeadingEmpties(trimmedHtml);
        return `<div class="section">\n${separatorBlock}${html}\n</div>`;
      }
      if (i > 0 && isChapterBoundary) {
        const html = stripLeadingEmpties(trimmedHtml);
        return `<div class="section">\n<p class="empty">&nbsp;</p>\n${html}\n</div>`;
      }
      return `<div class="section">\n${trimmedHtml}\n</div>`;
    }

    const prevEndsViewpoint = i > 0 && sections[i - 1].hasViewpointEnd;
    const needsPageBreak = i === 0 || s.hasViewpointStart || prevEndsViewpoint;
    const className = (needsPageBreak && i > 0) ? 'section page-break' : 'section';

    if (i > 0 && !needsPageBreak) {
      const html = stripLeadingEmpties(trimmedHtml);
      return `<div class="${className}">\n${separatorBlock}${html}\n</div>`;
    }

    let html = trimmedHtml;
    if (needsPageBreak) {
      html = stripLeadingEmpties(html);
    }

    return `<div class="${className}">\n${html}\n</div>`;
  });

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Serif+JP:wght@400&display=swap" rel="stylesheet">
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


    .epigraph-page {
    }
    .epigraph-page .viewpoint {
      text-align: start;
      text-indent: 0;
    }
    .epigraph-page .epigraph-quote {
      text-indent: 0;
      text-align: end;
    }
    .epigraph-page .epigraph-source {
      text-indent: 0;
      text-align: end;
      height: ${options.vertical ? `${layout.chars}em` : '165mm'};
    }

    .dash {
      text-orientation: sideways;
    }

    .latin {
      text-combine-upright: all;
      -webkit-text-combine: horizontal;
    }

    .sideways-latin {
      text-orientation: sideways;
    }

    .sideways-latin rt {
      text-orientation: mixed;
    }

    .upright {
      text-combine-upright: all;
      -webkit-text-combine: horizontal;
    }

    .tcy {
      text-combine-upright: all;
      -webkit-text-combine: horizontal;
    }

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

    .emphasis {
      text-emphasis: filled sesame;
      text-emphasis-position: over right;
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

    ruby {
      ruby-align: center;
      position: relative;
    }

    rt {
      font-size: 0.5em;
      position: absolute;
      left: 100%;
      margin-left: -0.4em;
      top: 50%;
      transform: translateY(-50%);
      white-space: nowrap;
    }
  </style>
</head>
<body>
${(() => {
  const coverlessHeading = options.coverless && options.title
    ? `<p class="coverless-title">${options.title}</p>\n${options.author ? `<p class="coverless-author">${options.author}</p>\n` : ''}<p class="empty">&nbsp;</p>\n`
    : '';

  if (options.coverless) {
    const synopsisBlock = synopsisHtml
      ? `<div class="synopsis-page">${coverlessHeading}${synopsisHtml}</div>`
      : '';
    return synopsisBlock;
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
  if (!options.coverless || !options.title || sectionHtmls.length === 0) {
    return sectionHtmls.join('\n');
  }
  const coverlessHeading = `<p class="coverless-title">${options.title}</p>\n${options.author ? `<p class="coverless-author">${options.author}</p>\n` : ''}`;
  const first = sectionHtmls[0].replace(/^(<div class="[^"]+">\n)/, `$1${coverlessHeading}`);
  return [first, ...sectionHtmls.slice(1)].join('\n');
})()}
</body>
</html>`;
}

// PDFストリームを解凍してテキストを取得
function decompressStream(stream) {
  if (!stream || typeof stream.getContents !== 'function') return '';
  const raw = stream.getContents();
  try {
    return new TextDecoder().decode(inflateSync(Buffer.from(raw)));
  } catch {
    return new TextDecoder().decode(raw);
  }
}

// 白紙ページを検出して除去
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

// メイン処理
async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.countOnly) {
    // 原稿用紙換算の既定は 20字×20行（400字詰め）
    if (args.chars == null && args.lines == null) {
      args.chars = 20;
      args.lines = 20;
    } else if (args.chars == null || args.lines == null) {
      console.error('エラー: --count-only には --size WxH の両方を指定してください');
      process.exit(1);
    }
  }

  if (!args.countOnly && !args.output) {
    console.error('エラー: 出力ファイルを指定してください (-o output.pdf)');
    process.exit(1);
  }

  if (args.files.length === 0) {
    console.error('エラー: 入力ファイルまたはディレクトリを指定してください');
    process.exit(1);
  }

  // 入力ファイルのリストを作成
  let inputFiles = [];
  for (const path of args.files) {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      inputFiles.push(...getTextFilesFromDir(path, [SYNOPSIS_FILENAME, CHARACTERS_FILENAME]));
    } else {
      inputFiles.push(path);
    }
  }

  // --limit で件数を制限
  if (args.limit != null && args.limit > 0) {
    inputFiles = inputFiles.slice(0, args.limit);
  }

  if (inputFiles.length === 0) {
    console.error('エラー: txtファイルが見つかりません');
    process.exit(1);
  }

  console.log(`入力ファイル: ${inputFiles.length}件`);

  // --review: 表紙・梗概・人物紹介・部構成をoverrideし、先頭から約2万字に最も近い
  // ファイル境界までを切り出して1本のPDFを生成
  // --title / --author が指定されていれば coverless 形式で本文先頭に出す
  if (args.review) {
    args.coverless = true;
    args.synopsisOnTitle = false;
    args.parts = null;

    const targetChars = 20000;
    const charsPerLine = args.chars || 30;
    const charCounts = inputFiles.map(f => countManuscript([f], charsPerLine).totalChars);
    const bestEnd = selectReviewBoundary(charCounts, targetChars);
    const slice = inputFiles.slice(0, bestEnd);
    const { totalChars: sliceChars } = countManuscript(slice, charsPerLine);
    console.log(`下読みモード: ${basename(inputFiles[0])} 〜 ${basename(inputFiles[bestEnd - 1])} (${slice.length}ファイル, ${sliceChars.toLocaleString()}字)`);
    inputFiles = slice;
  }

  // --part の値（ファイル名プレフィックス or 1始まりインデックス）を 1始まりインデックスに正規化
  if (args.parts && args.parts.length > 0) {
    const resolved = [];
    for (const tok of args.parts) {
      const idxByPrefix = inputFiles.findIndex(f => {
        const m = basename(f).match(/^\d+/);
        return m && m[0] === tok;
      });
      if (idxByPrefix >= 0) {
        resolved.push(idxByPrefix + 1);
        continue;
      }
      const asInt = parseInt(tok, 10);
      if (!isNaN(asInt) && asInt >= 1 && asInt <= inputFiles.length) {
        resolved.push(asInt);
        continue;
      }
      console.error(`エラー: --part の値 "${tok}" に対応するファイルが見つかりません`);
      process.exit(1);
    }
    args.parts = [...new Set(resolved)].sort((a, b) => a - b);
    const allParts = [1, ...args.parts.filter(p => p > 1)];
    console.log(`部の境界: ${allParts.map((p, i) => `第${i + 1}部=${basename(inputFiles[p - 1])}`).join(', ')}`);
  }

  // --count-only: text-parser で原稿用紙換算して終了（vivliostyle 起動なし）
  if (args.countOnly) {
    const { totalLines, totalChars } = countManuscript(inputFiles, args.chars);
    const pages = totalLines / args.lines;
    const pagesCeil = Math.ceil(pages);
    console.log(`\n原稿用紙換算 (${args.chars}字×${args.lines}行)`);
    console.log(`文字数: ${totalChars.toLocaleString()}字`);
    console.log(`行数: ${totalLines.toLocaleString()}行`);
    console.log(`枚数: ${pages.toFixed(2)}枚 (切上 ${pagesCeil}枚)`);
    return;
  }

  // 梗概ファイルを探す（--review時はスキップ）
  const synopsisPath = args.review ? null : findSynopsisFile(inputFiles, args.files);
  let synopsisHtml = null;
  let synopsisCharCount = 0;
  if (synopsisPath) {
    const synopsisContent = readFileSync(synopsisPath, 'utf-8');
    const synopsisLines = synopsisContent.split('\n').filter(l => l.trim() !== '');
    synopsisCharCount = synopsisLines.reduce((sum, line) => {
      const html = escapeHtml(line, { vertical: args.vertical });
      const text = html.replace(/<rt>.*?<\/rt>/g, '').replace(/<[^>]+>/g, '').replace(/[\s\u00A0]/g, '');
      return sum + [...text].length;
    }, 0);
    console.log(`梗概: ${basename(synopsisPath)}  （${synopsisCharCount.toLocaleString()}文字）`);
    synopsisHtml = parseSynopsisFile(synopsisPath, args.vertical);
  }

  // 人物紹介ファイルを探す（--review時はスキップ）
  const charactersPath = args.review ? null : findCharactersFile(inputFiles, args.files);
  let charactersHtml = null;
  if (charactersPath) {
    console.log(`人物紹介: ${basename(charactersPath)}`);
    charactersHtml = parseCharactersFile(charactersPath, args.vertical);
  }

  // 各ファイルをHTMLセクションに変換
  const partFirstIndices = args.parts && args.parts.length > 0
    ? args.parts.map(p => p - 1).filter(i => i > 0 && i < inputFiles.length)
    : null;
  const sections = parseWithSectionNumbering(inputFiles, parseTextFile, {
    vertical: args.vertical,
    chars: args.chars || 30,
    partFirstIndices,
  });
  logSections(sections, inputFiles);

  // HTML生成
  const html = generateHtml(sections, args, synopsisHtml, synopsisCharCount, charactersHtml);

  // デバッグ用にHTMLを保存
  const htmlPath = args.output.replace(/\.pdf$/, '.html');
  writeFileSync(htmlPath, html);
  console.log(`HTML出力: ${htmlPath}`);

  // Vivliostyle CLIでPDF生成
  console.log('PDF生成中...');
  execSync(`./node_modules/.bin/vivliostyle build "${htmlPath}" -o "${args.output}"`, { stdio: 'inherit' });
  const pdfBuffer = readFileSync(args.output);

  // pdf-libでページ番号を追加
  const pdfDoc = await PDFDocument.load(pdfBuffer);

  // 白紙ページを除去
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
    const fmHtmlPath = args.output.replace(/\.pdf$/, '.fm.html');
    const fmPdfPath = args.output.replace(/\.pdf$/, '.fm.pdf');
    writeFileSync(fmHtmlPath, fmHtml);
    execSync(`./node_modules/.bin/vivliostyle build "${fmHtmlPath}" -o "${fmPdfPath}"`, { stdio: 'pipe' });
    const fmDoc = await PDFDocument.load(readFileSync(fmPdfPath));
    removeBlankPages(fmDoc, hasCover ? 0 : -1);
    frontMatterPages = fmDoc.getPageCount();
    try { unlinkSync(fmHtmlPath); unlinkSync(fmPdfPath); } catch {}
    console.log(`前付ページ数: ${frontMatterPages}`);
  }

  // 全ページにループし、通し番号から前付分を引く。≤ 0 なら非表示
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

  // 縦書き時はページ方向を右→左に設定
  if (args.vertical) {
    const viewerPrefs = pdfDoc.catalog.getOrCreateViewerPreferences();
    viewerPrefs.setReadingDirection('R2L');
  }

  const finalPdf = await pdfDoc.save();
  writeFileSync(args.output, finalPdf);

  const totalChars = sections.reduce((sum, s) => sum + countChars(s.html), 0);
  console.log(`\nPDF出力: ${args.output}`);
  console.log(`文字数: ${totalChars.toLocaleString()}字`);
  const chapterCount = sections.filter(s => s.hasViewpointStart).length;
  console.log(`章数: ${chapterCount}章`);
  if (frontMatterPages > 0) {
    console.log(`枚数: タイトル・梗概 ${frontMatterPages}枚 ＋ 本文 ${pageCount - frontMatterPages}枚 ＝ 計${pageCount}枚`);
  } else {
    console.log(`枚数: ${pageCount}枚`);
  }

  if (args.open) {
    execSync(`open "${resolve(args.output)}"`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error('エラー:', err.message);
    process.exit(1);
  });
}

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;

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

  const SEPARATOR_BLOCK = '<p class="empty">&nbsp;</p>\n<p class="separator">◇◇◇</p>\n<p class="empty">&nbsp;</p>\n';

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
    expect(html).toMatch(new RegExp(`<div class="section">\\n${SEPARATOR_BLOCK.replace(/[/]/g, '\\/')}<p>2ファイル目<\\/p>`));
    expect(html).toMatch(new RegExp(`<div class="section">\\n${SEPARATOR_BLOCK.replace(/[/]/g, '\\/')}<p>3ファイル目<\\/p>`));
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

    expect(html).toMatch(new RegExp(`<div class="section">\\n${SEPARATOR_BLOCK.replace(/[/]/g, '\\/')}<p>2ファイル目<\\/p>`));
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

  test('selectReviewBoundary: 空配列は0', () => {
    expect(selectReviewBoundary([], 20000)).toBe(0);
  });

  test('selectReviewBoundary: 全部足してもtargetに届かない場合は全件', () => {
    expect(selectReviewBoundary([3000, 4000, 5000], 20000)).toBe(3);
  });

  test('selectReviewBoundary: targetを最初に超えた境界が最も近ければそこで止まる', () => {
    // 累積: 5000, 12000, 21000 → target=20000 との差は |5000-20000|=15000, 8000, 1000
    expect(selectReviewBoundary([5000, 7000, 9000], 20000)).toBe(3);
  });

  test('selectReviewBoundary: targetを超える前の方がtargetに近ければ手前で止まる', () => {
    // 累積: 19500, 30000 → 差は 500, 10000 → bestEndは1（19500の方が近い）
    expect(selectReviewBoundary([19500, 10500], 20000)).toBe(1);
  });

  test('selectReviewBoundary: 累積がちょうど一致する境界を選ぶ', () => {
    // 累積: 10000, 20000, 30000 → 差は 10000, 0, 10000 → bestEnd=2
    expect(selectReviewBoundary([10000, 10000, 10000], 20000)).toBe(2);
  });

  test('selectReviewBoundary: 差が同じなら多く含む方（後ろ）を採用', () => {
    // 累積: 15000, 25000 → 差は 5000, 5000 → <= で更新するので bestEnd=2
    expect(selectReviewBoundary([15000, 10000], 20000)).toBe(2);
  });

  test('selectReviewBoundary: 最初の1ファイルでtargetを大幅超過してもそれを返す', () => {
    expect(selectReviewBoundary([50000, 1000], 20000)).toBe(1);
  });
}
