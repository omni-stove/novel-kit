#!/usr/bin/env node

/**
 * 英語原稿のtxtファイルを出版物レイアウト（ペーパーバック風・横書き）のPDFに変換するスクリプト
 *
 * 使い方:
 *   node scripts/txt-to-en-pdf.mts -o output.pdf file1.txt file2.txt ...
 *   node scripts/txt-to-en-pdf.mts -o output.pdf ./src/co/story/en/
 *
 * オプション:
 *   -o, --output <file>  出力ファイル名（必須）
 *   --title <title>      書名（タイトルページと柱に使用）
 *   --author <author>    著者名
 *   --5x8                5×8in トレードペーパーバック
 *   --6x9                6×9in USトレード（デフォルト）
 *   --a5                 A5サイズ
 *   --part 070,085,...   部の境界となるファイル名プレフィックス（txt-to-pdf.mts の --part と同形式）。
 *                        該当ファイルから新しい部（Part One, Part Two, ...）が始まり、部扉ページを挿入する。
 *                        章番号は部ごとにリセットされ、部に章が1つしかない場合は章番号を表示しない。
 *                        未訳などで該当ファイルが存在しない境界はスキップする。
 *   --recto              章を必ず右ページ（recto）から開始する
 *   --no-smart-quotes    ストレート引用符をカーリー引用符に変換しない
 *   --open               生成後にプレビューを開く
 *
 * 章が1つしかなく章題も無い場合は、章ヘッダ（章番号・POV）を出力しない。
 *
 * 原稿の記法:
 *   POV: name        章扉に視点人物名として表示
 *   【title】        章の開始（titleは章題、空なら番号のみ）
 *   末尾の【】       次章のアンカー（本文には出力しない）
 *   Epigraph: ...    章扉のエピグラフ
 *   Title: ...       無視
 *   Memo: ...        無視
 *   Source: ...      無視
 *   *text*           イタリック
 *   《《text》》     傍点（文字上に点を打つ強調）
 *   ◇◇◇ / ■■■ 等    場面区切り（* * * として出力）
 *   >>>              場面区切り（記号をそのまま出力。再生・信号パートの区切り用）
 *   空行             場面の小休止（行アキ）
 */

import { readFileSync, writeFileSync, statSync, unlinkSync } from 'fs';
import { basename } from 'path';
import { PDFDocument, PDFArray, PDFRawStream, StandardFonts, rgb } from 'pdf-lib';
import {
  readLines, getBodyLines, escapeXml,
  isEpigraphLine, parseEpigraphLine, parseViewpointLine, isSeparator,
} from './lib/text-parser.mts';
import { requireInputFiles, resolvePartIndices, startsNewChapter } from './lib/manuscript.mts';
import { chapterNumberWord } from './lib/english.mts';
import { googleFontsLinks } from './lib/html.mts';
import { parseCliArgs, ARG, buildPdfFromHtml, openFile, requireOutput, runMain } from './lib/cli.mts';

export const PAGE_SIZES = {
  '5x8': {
    name: '5×8in Trade Paperback', width: '5in', height: '8in',
    fontSize: '10.5pt', lineHeight: '1.35',
    margin: { top: '0.6in', bottom: '0.55in', inner: '0.7in', outer: '0.5in' },
  },
  '6x9': {
    name: '6×9in US Trade', width: '6in', height: '9in',
    fontSize: '11pt', lineHeight: '1.4',
    margin: { top: '0.7in', bottom: '0.6in', inner: '0.8in', outer: '0.6in' },
  },
  a5: {
    name: 'A5', width: '148mm', height: '210mm',
    fontSize: '11pt', lineHeight: '1.4',
    margin: { top: '16mm', bottom: '14mm', inner: '18mm', outer: '15mm' },
  },
};

function parseArgs(argv) {
  return parseCliArgs(argv, [
    ARG.output,
    ARG.title,
    ARG.author,
    { key: 'pageSize', flags: ['--5x8'], value: '5x8' },
    { key: 'pageSize', flags: ['--6x9'], value: '6x9' },
    { key: 'pageSize', flags: ['--a5'], value: 'a5' },
    ARG.parts,
    { key: 'recto', flags: ['--recto'] },
    { key: 'smartQuotes', flags: ['--no-smart-quotes'], value: false },
    ARG.open,
  ], { pageSize: '6x9', smartQuotes: true });
}

function isRuleLine(line) {
  return /^-{3,}$/.test(line.trim()) || /^\*(\s*\*)+$/.test(line.trim());
}

// 記号をそのまま紙面に出す場面区切り（>>> = 再生・信号パートの区切り）
function isVerbatimSeparator(line) {
  return /^>{2,}$/.test(line.trim());
}

export function smartQuotes(text) {
  return text
    .replace(/(^|[\s([—–“]|<em>)"/g, '$1“')
    .replace(/"/g, '”')
    .replace(/(^|[\s([—–“]|<em>)'/g, '$1‘')
    .replace(/'/g, '’');
}

export function formatInline(text, { curly = true } = {}) {
  let t = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // 引用符の開閉判定が<em>タグを文脈にできるよう、イタリック変換を先に行う
  t = t.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  if (curly) t = smartQuotes(t);
  t = t.replace(/《《(.+?)》》/g, '<span class="emphasis">$1</span>');
  return t;
}

export function parseEnglishFile(filePath) {
  return parseEnglishLines(readLines(filePath));
}

// ファイルを介さず行列から解釈する（未保存のエディタ内容をプレビューする VS Code 拡張用）。
// 各ブロックの line は元テキストの行番号（0始まり）
export function parseEnglishLines(sourceLines) {
  // 罫線（--- / * * *）は翻訳作業用の目印で、紙面にも章頭・章末の判定にも関わらせない
  const kept = sourceLines.map((text, line) => ({ text, line })).filter(e => !isRuleLine(e.text));
  const { lines, indices, hasViewpointStart, hasViewpointEnd, pov } = getBodyLines(
    kept.map(e => e.text),
    { keepEpigraphs: true },
  );
  const epigraphs = lines.filter(l => isEpigraphLine(l)).map(l => parseEpigraphLine(l));
  const bodyLines = lines
    .map((text, i) => ({ text, line: kept[indices[i]].line }))
    .filter(e => !isEpigraphLine(e.text));
  const headingIndex = hasViewpointStart ? bodyLines.findIndex(e => e.text.trim() !== '') : -1;

  let chapterTitle = null;
  let titleLine = null;
  const blocks = [];

  bodyLines.forEach(({ text: line, line: n }, i) => {
    if (line.trim() === '') {
      blocks.push({ type: 'space', line: n });
    } else if (isSeparator(line) || isVerbatimSeparator(line)) {
      blocks.push({ type: 'ornament', mark: isVerbatimSeparator(line) ? line.trim() : null, line: n });
    } else if (i === headingIndex) {
      const { title, rest } = parseViewpointLine(line);
      chapterTitle = title || null;
      titleLine = n;
      if (rest) blocks.push({ type: 'para', text: rest, line: n });
    } else {
      blocks.push({ type: 'para', text: line.trim(), line: n });
    }
  });

  while (blocks.length > 0 && blocks[0].type !== 'para') blocks.shift();
  while (blocks.length > 0 && blocks[blocks.length - 1].type !== 'para') blocks.pop();

  return { blocks, chapterTitle, titleLine, pov, epigraphs, hasViewpointStart, hasViewpointEnd };
}

// partFirstIndices は先頭の 0 を含む（第1部にも部扉を付けるため）。
// 各ブロックと章題には由来のファイル番号（parsedFiles の添字）を file として付ける
export function buildChapters(parsedFiles, partFirstIndices = null) {
  const partSet = partFirstIndices ? new Set(partFirstIndices) : null;
  const chapters = [];
  let partNumber = 0;
  let numberInPart = 0;

  parsedFiles.forEach((f, i) => {
    const startsPart = partSet !== null && partSet.has(i);
    const blocks = f.blocks.map(b => ({ ...b, file: i }));

    if (startsPart || startsNewChapter(parsedFiles, i)) {
      if (startsPart) {
        partNumber++;
        numberInPart = 0;
      }
      numberInPart++;
      chapters.push({
        number: partSet ? numberInPart : chapters.length + 1,
        part: partSet ? partNumber : null,
        startsPart,
        title: f.chapterTitle,
        titleLine: f.titleLine ?? null,
        file: i,
        pov: f.pov,
        epigraphs: [...f.epigraphs],
        blocks,
      });
    } else {
      const ch = chapters[chapters.length - 1];
      // 継続ファイルとの継ぎ目は場面区切りとして扱う
      ch.blocks.push({ type: 'ornament' }, ...blocks);
      ch.epigraphs.push(...f.epigraphs);
    }
  });

  // 章が1つしかない部では章番号を出さない（日本語版の【2】/【2-1】の使い分けに対応）
  if (partSet) {
    const counts = new Map();
    for (const ch of chapters) counts.set(ch.part, (counts.get(ch.part) ?? 0) + 1);
    for (const ch of chapters) ch.soleInPart = counts.get(ch.part) === 1;
  }

  return chapters;
}

// lineNumbers: 段落・区切り・章題に元テキストの位置（data-file: ファイル番号 / data-line: 0始まりの行番号）を付ける
export function chapterHtml(ch, opts) {
  const inline = t => formatInline(t, { curly: opts.smartQuotes });
  const parts = [];
  const lineAttr = (file, line) => (opts.lineNumbers && line != null ? ` data-file="${file}" data-line="${line}"` : '');

  // 章が1つだけの作品で章題も無い場合は章ヘッダを出さない。
  // ただし柱のstring-setを担うため、要素自体は空で残す
  const bareHead = opts.bareChapterHead && !ch.title;
  parts.push(`<header class="chapter-head${bareHead ? ' chapter-head-bare' : ''}">`);
  if (!bareHead) {
    if (!ch.soleInPart) parts.push(`<p class="chapter-number">${chapterNumberWord(ch.number)}</p>`);
    if (ch.title) parts.push(`<h2 class="chapter-title"${lineAttr(ch.file, ch.titleLine)}>${inline(ch.title)}</h2>`);
    else parts.push(`<h2 class="chapter-title chapter-title-hidden">Chapter ${chapterNumberWord(ch.number)}</h2>`);
    if (ch.pov) parts.push(`<p class="chapter-pov">${inline(ch.pov)}</p>`);
  }
  parts.push('</header>');

  for (const { quote, source } of ch.epigraphs) {
    parts.push('<div class="epigraph">');
    parts.push(`<p class="epigraph-quote">${inline(quote)}</p>`);
    if (source) parts.push(`<p class="epigraph-source">—${inline(source)}</p>`);
    parts.push('</div>');
  }

  let afterBreak = true; // 章頭・場面区切り直後の段落は字下げしない
  for (const block of ch.blocks) {
    const attr = lineAttr(block.file, block.line);
    if (block.type === 'space') {
      parts.push(`<div class="scene-space"${attr}></div>`);
      afterBreak = true;
    } else if (block.type === 'ornament') {
      // mark付きは記号をそのまま出力（>>> 等）。* * * と同じく各記号の間にenスペースを挟む
      parts.push(block.mark
        ? `<p class="ornament"${attr}>${[...block.mark].map(escapeXml).join('&#x2002;')}</p>`
        : `<p class="ornament"${attr}>*&#x2002;*&#x2002;*</p>`);
      afterBreak = true;
    } else {
      parts.push(`<p${afterBreak ? ' class="noindent"' : ''}${attr}>${inline(block.text)}</p>`);
      afterBreak = false;
    }
  }

  const cls = ch.number === 1 && (ch.part === null || ch.part === 1) ? 'chapter chapter-first' : 'chapter';
  const partPage = ch.startsPart
    ? `<section class="part-page">\n<p class="part-number">Part ${chapterNumberWord(ch.part)}</p>\n</section>\n`
    : '';
  return `${partPage}<section class="${cls}">\n${parts.join('\n')}\n</section>`;
}

// size: PAGE_SIZES の1つ（または同じ形のオブジェクト）。opts: title / author / recto / smartQuotes / lineNumbers
export function generateHtml(chapters, size, opts) {
  const m = size.margin;
  const inline = t => formatInline(t, { curly: opts.smartQuotes });
  const versoHeader = opts.author || opts.title || '';
  const rectoHeader = opts.title || '';

  const titlePage = opts.title ? `
<section class="title-page">
  <h1>${inline(opts.title)}</h1>
  ${opts.author ? `<p class="title-author">${inline(opts.author)}</p>` : ''}
</section>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
${googleFontsLinks('EB+Garamond:ital,wght@0,400;0,500;0,600;1,400')}
  <style>
    /* ノンブルはVivliostyleのpageカウンタがリセットできないため、
       ビルド後にpdf-libでスタンプする（stampPageNumbers参照） */
    @page {
      size: ${size.width} ${size.height};
      margin-top: ${m.top};
      margin-bottom: ${m.bottom};
      font-family: "EB Garamond", Georgia, serif;
    }

    @page :left {
      margin-left: ${m.outer};
      margin-right: ${m.inner};
    }

    @page :right {
      margin-left: ${m.inner};
      margin-right: ${m.outer};
    }

    /* 柱は string-set + first-except で出す。
       first-except は「文字列が代入されたページ（＝章扉）では空」になるため、
       章の開始ページだけ柱が消える。 */
    @page chapter:left {
      @top-center {
        content: string(verso-header, first-except);
        font-size: 8.5pt;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: #444;
      }
    }

    @page chapter:right {
      @top-center {
        content: string(recto-header, first-except);
        font-size: 8.5pt;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: #444;
      }
    }

    /* 白ページ（recto開始で挿入される空きページ）には柱を出さない。
       chapter:left/:right より詳細度を上げるため名前付きで指定する */
    @page :blank {
      @top-center { content: none; }
    }

    @page chapter:blank {
      @top-center { content: none; }
    }

    .chapter-head {
      string-set: verso-header "${versoHeader.replace(/"/g, '\\"')}", recto-header "${rectoHeader.replace(/"/g, '\\"')}";
    }

    @page front {
      @top-center { content: none; }
    }

    body {
      font-family: "EB Garamond", Georgia, "Times New Roman", serif;
      font-size: ${size.fontSize};
      line-height: ${size.lineHeight};
      font-kerning: normal;
      font-variant-ligatures: common-ligatures;
      color: #111;
      margin: 0;
    }

    .title-page {
      page: front;
      break-after: ${opts.recto ? 'verso' : 'page'};
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-start;
      padding-top: 30%;
      height: 100%;
      box-sizing: border-box;
      text-align: center;
    }

    .title-page h1 {
      font-size: 24pt;
      font-weight: 500;
      letter-spacing: 0.06em;
      margin: 0;
    }

    .title-page .title-author {
      text-indent: 0;
      font-size: 12pt;
      letter-spacing: 0.2em;
      text-transform: uppercase;
      margin-top: 3em;
    }

    .chapter {
      page: chapter;
      break-before: ${opts.recto ? 'recto' : 'page'};
    }

    /* 部扉。柱を出さないため front ページとして扱う */
    .part-page {
      page: front;
      break-before: ${opts.recto ? 'recto' : 'page'};
      display: flex;
      flex-direction: column;
      align-items: center;
      padding-top: 38%;
      height: 100%;
      box-sizing: border-box;
      text-align: center;
    }

    .part-page .part-number {
      text-indent: 0;
      font-size: 14pt;
      font-weight: 500;
      letter-spacing: 0.3em;
      text-transform: uppercase;
      color: #333;
      margin: 0;
    }


    .chapter-head {
      margin-top: 12%;
      margin-bottom: 2em;
      text-align: center;
      break-after: avoid;
    }

    .chapter-number {
      text-align: center;
      text-indent: 0;
      font-size: 10pt;
      letter-spacing: 0.3em;
      text-transform: uppercase;
      color: #555;
      margin: 0 0 0.8em;
    }

    .chapter-title {
      font-size: 16pt;
      font-weight: 500;
      font-style: italic;
      margin: 0;
    }

    .chapter-title-hidden {
      display: none;
    }

    /* 章ヘッダなし（単章作品）。本文開始位置の沈み込みだけ残す */
    .chapter-head-bare {
      margin-bottom: 0;
    }

    .chapter-pov {
      text-align: center;
      text-indent: 0;
      font-size: 9.5pt;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: #555;
      margin: 1.2em 0 0;
    }

    .epigraph {
      margin: 0 1.5em 2.5em 3em;
      font-style: italic;
      text-align: right;
    }

    .epigraph p {
      text-align: right;
      text-indent: 0;
    }

    .epigraph-quote { margin: 0; }
    .epigraph-source {
      margin: 0.4em 0 0;
      font-style: normal;
      font-size: 0.9em;
    }

    p {
      margin: 0;
      text-indent: 1.3em;
      text-align: justify;
      hyphens: auto;
      -webkit-hyphens: auto;
      orphans: 2;
      widows: 2;
    }

    p.noindent { text-indent: 0; }

    /* 《《text》》 の傍点。横組なので文字の上に点を打つ */
    .emphasis {
      text-emphasis: filled dot;
      text-emphasis-position: over right;
    }

    .scene-space {
      height: 1lh;
    }

    /* 上下マージンは行送りの整数倍にする（区切り全体で3lh）。
       半端な値にすると以降の行がベースライングリッドから外れ、見開きで行が揃わない */
    p.ornament {
      text-indent: 0;
      text-align: center;
      margin: 1lh 0;
      letter-spacing: 0.2em;
      break-inside: avoid;
    }
  </style>
</head>
<body>
${titlePage}
${chapters.map(ch => chapterHtml(ch, { ...opts, bareChapterHead: chapters.length === 1 })).join('\n')}
</body>
</html>`;
}

function cssLenToPt(v) {
  if (v.endsWith('in')) return parseFloat(v) * 72;
  if (v.endsWith('mm')) return parseFloat(v) * 72 / 25.4;
  return parseFloat(v);
}

// コンテンツストリームの合計サイズで白ページを推定する（recto開始で挿入される空きページ）
function pageContentBytes(doc, page) {
  try {
    const contents = page.node.Contents();
    if (!contents) return 0;
    const streams = contents instanceof PDFArray
      ? contents.asArray().map(o => doc.context.lookup(o))
      : [contents];
    return streams.reduce((n, s) => n + (s instanceof PDFRawStream ? s.contents.length : 0), 0);
  } catch {
    return Infinity;
  }
}

// タイトルページ以降の本文ページに1始まりのノンブルを打つ。白ページは数には入れるが印字しない
async function stampPageNumbers(pdfPath, size, { hasTitlePage }) {
  const doc = await PDFDocument.load(readFileSync(pdfPath));
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const pages = doc.getPages();
  const fontSize = 9;
  const y = cssLenToPt(size.margin.bottom) * 0.45;

  const isBlank = p => pageContentBytes(doc, p) < 160;

  let frontPages = hasTitlePage ? 1 : 0;
  // recto開始でタイトルページ直後に白ページが挿入された場合は前付に含める
  while (frontPages > 0 && frontPages < pages.length && isBlank(pages[frontPages])) frontPages++;

  for (let i = frontPages; i < pages.length; i++) {
    const page = pages[i];
    if (isBlank(page)) continue;
    const num = String(i - frontPages + 1);
    const w = font.widthOfTextAtSize(num, fontSize);
    page.drawText(num, {
      x: page.getWidth() / 2 - w / 2,
      y,
      size: fontSize,
      font,
      color: rgb(0.2, 0.2, 0.2),
    });
  }

  writeFileSync(pdfPath, await doc.save());
  return pages.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  requireOutput(args, 'output.pdf');

  const size = PAGE_SIZES[args.pageSize];
  console.log(`判型: ${size.name}`);

  const inputFiles = requireInputFiles(args.files);

  // 部境界の解決。未訳などで存在しない境界はスキップする（翻訳は先頭から進む前提なので部番号はずれない）
  let partFirstIndices = null;
  if (args.parts && args.parts.length > 0) {
    const present = args.parts.filter(tok => inputFiles.some(f => basename(f).match(/^\d+/)?.[0] === tok));
    const missing = args.parts.filter(tok => !present.includes(tok));
    if (missing.length > 0) console.log(`部境界（ファイルなしのためスキップ）: ${missing.join(', ')}`);
    const resolved = resolvePartIndices(present, inputFiles).filter(i => i > 0);
    partFirstIndices = [0, ...resolved];
    console.log(`部の境界: ${partFirstIndices.map((idx, i) => `Part ${chapterNumberWord(i + 1)}=${basename(inputFiles[idx])}`).join(', ')}`);
  }

  const parsedFiles = inputFiles.map(f => parseEnglishFile(f));
  const chapters = buildChapters(parsedFiles, partFirstIndices);

  let totalWords = 0;
  for (const ch of chapters) {
    const words = ch.blocks
      .filter(b => b.type === 'para')
      .reduce((n, b) => n + b.text.split(/\s+/).filter(Boolean).length, 0);
    totalWords += words;
    const num = ch.part !== null ? (ch.soleInPart ? `${ch.part}` : `${ch.part}-${ch.number}`) : `${ch.number}`;
    const label = ch.title ? ` "${ch.title}"` : '';
    const pov = ch.pov ? ` (POV: ${ch.pov})` : '';
    console.log(`  Chapter ${num}${label}${pov}: ${words.toLocaleString()} words`);
  }

  const html = generateHtml(chapters, size, args);
  console.log('\nPDF生成中...');
  unlinkSync(buildPdfFromHtml(html, args.output));

  const pageCount = await stampPageNumbers(args.output, size, { hasTitlePage: Boolean(args.title) });
  const fileSize = statSync(args.output).size;

  console.log(`\nPDF出力: ${args.output}`);
  console.log(`語数: ${totalWords.toLocaleString()} words / ${chapters.length}章`);
  console.log(`頁数: ${pageCount}頁 (${(fileSize / 1024 / 1024).toFixed(1)}MB)`);

  if (args.open) {
    openFile(args.output);
  }
}

runMain(import.meta.url, main);

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest;
  const { writeFileSync: wf, unlinkSync: ul } = await import('fs');
  const { join } = await import('path');
  const { tmpdir } = await import('os');

  describe('smartQuotes', () => {
    test('ダブルクォートを開閉で使い分ける', () => {
      expect(smartQuotes('"Hello," she said.')).toBe('“Hello,” she said.');
    });
    test('アポストロフィは閉じ引用符になる', () => {
      expect(smartQuotes("What's up")).toBe('What’s up');
    });
    test('引用内のシングルクォート', () => {
      expect(smartQuotes(`"Bach. 'Jesu.'"`)).toBe('“Bach. ‘Jesu.’”');
    });
    test('イタリックと引用符の入れ子はどちらの順でも開閉が正しい', () => {
      expect(formatInline('*"Execute."*')).toBe('<em>“Execute.”</em>');
      expect(formatInline('"*Execute.*"')).toBe('“<em>Execute.</em>”');
    });
  });

  describe('formatInline', () => {
    test('アスタリスク囲みをemに変換', () => {
      expect(formatInline('*May I stay?*')).toBe('<em>May I stay?</em>');
    });
    test('HTML特殊文字をエスケープ', () => {
      expect(formatInline('a < b & c')).toBe('a &lt; b &amp; c');
    });
    test('curly=falseでは引用符を変換しない', () => {
      expect(formatInline('"x"', { curly: false })).toBe('"x"');
    });
    test('《《》》囲みを傍点spanに変換', () => {
      expect(formatInline('《《really》》')).toBe('<span class="emphasis">really</span>');
    });
  });

  describe('chapterHtml', () => {
    const ch = {
      number: 1, title: '', pov: 'Nol', epigraphs: [],
      blocks: [{ type: 'para', text: 'Body.' }],
      part: null, startsPart: false, soleInPart: false,
    };
    test('通常は章番号とPOVを出す', () => {
      const html = chapterHtml(ch, { smartQuotes: true });
      expect(html).toContain('chapter-number');
      expect(html).toContain('chapter-pov');
    });
    test('bareChapterHeadでは章ヘッダを空にする', () => {
      const html = chapterHtml(ch, { smartQuotes: true, bareChapterHead: true });
      expect(html).toContain('chapter-head-bare');
      expect(html).not.toContain('chapter-number');
      expect(html).not.toContain('chapter-pov');
    });
    test('bareChapterHeadでも章題があればヘッダを出す', () => {
      const html = chapterHtml({ ...ch, title: 'One' }, { smartQuotes: true, bareChapterHead: true });
      expect(html).not.toContain('chapter-head-bare');
      expect(html).toContain('chapter-title');
    });
  });

  describe('parseEnglishFile / buildChapters', () => {
    test('POV行・章マーカー・末尾アンカーを解釈する', () => {
      const tmp = join(tmpdir(), `en-pdf-${process.pid}-a.txt`);
      wf(tmp, 'POV: Nadia Solis\n【-21Y】\nFirst paragraph.\n\nSecond paragraph.\n【】\n---\n');
      try {
        const parsed = parseEnglishFile(tmp);
        expect(parsed.pov).toBe('Nadia Solis');
        expect(parsed.chapterTitle).toBe('-21Y');
        expect(parsed.hasViewpointStart).toBe(true);
        expect(parsed.hasViewpointEnd).toBe(true);
        expect(parsed.titleLine).toBe(1);
        expect(parsed.blocks).toEqual([
          { type: 'para', text: 'First paragraph.', line: 2 },
          { type: 'space', line: 3 },
          { type: 'para', text: 'Second paragraph.', line: 4 },
        ]);
      } finally {
        ul(tmp);
      }
    });

    test('Title:行は本文に含めない', () => {
      const tmp = join(tmpdir(), `en-pdf-${process.pid}-title.txt`);
      wf(tmp, 'Title: The Sirens Sing Nevermore\nPOV: Outi\nFirst paragraph.\n');
      try {
        const parsed = parseEnglishFile(tmp);
        expect(parsed.blocks).toEqual([{ type: 'para', text: 'First paragraph.', line: 2 }]);
      } finally {
        ul(tmp);
      }
    });

    test('視点行なしの継続ファイルは前章に結合され場面区切りが入る', () => {
      const a = join(tmpdir(), `en-pdf-${process.pid}-b.txt`);
      const b = join(tmpdir(), `en-pdf-${process.pid}-c.txt`);
      wf(a, '【One】\nBody A.\n');
      wf(b, 'Body B.\n');
      try {
        const chapters = buildChapters([parseEnglishFile(a), parseEnglishFile(b)]);
        expect(chapters).toHaveLength(1);
        expect(chapters[0].blocks.map(bl => bl.type)).toEqual(['para', 'ornament', 'para']);
      } finally {
        ul(a); ul(b);
      }
    });

    test('部境界で章番号がリセットされ、部の先頭章にstartsPartが付く', () => {
      const files = ['f', 'g', 'h'].map(s => join(tmpdir(), `en-pdf-${process.pid}-${s}.txt`));
      wf(files[0], '【One】\nBody A.\n【】\n');
      wf(files[1], '【Two】\nBody B.\n【】\n');
      wf(files[2], '【Three】\nBody C.\n');
      try {
        const chapters = buildChapters(files.map(f => parseEnglishFile(f)), [0, 2]);
        expect(chapters.map(ch => [ch.part, ch.number, ch.startsPart])).toEqual([
          [1, 1, true],
          [1, 2, false],
          [2, 1, true],
        ]);
        expect(chapters.map(ch => ch.soleInPart)).toEqual([false, false, true]);
      } finally {
        files.forEach(f => ul(f));
      }
    });

    test('>>> は記号をそのまま出す区切り、■■■ は * * * になる', () => {
      const tmp = join(tmpdir(), `en-pdf-${process.pid}-v.txt`);
      wf(tmp, 'Body A.\n\n■■■\n\nBody B.\n\n>>>\n\nBody C.\n');
      try {
        const parsed = parseEnglishFile(tmp);
        const ornaments = parsed.blocks.filter(b => b.type === 'ornament');
        expect(ornaments.map(b => b.mark)).toEqual([null, '>>>']);
        const html = chapterHtml({
          number: 1, title: null, pov: null, epigraphs: [], blocks: parsed.blocks,
          part: null, startsPart: false, soleInPart: false,
        }, { smartQuotes: true });
        expect(html).toContain('<p class="ornament">*&#x2002;*&#x2002;*</p>');
        expect(html).toContain('<p class="ornament">&gt;&#x2002;&gt;&#x2002;&gt;</p>');
      } finally {
        ul(tmp);
      }
    });

    test('lineNumbers で段落にファイル番号と行番号を付け、継ぎ目の区切りには付けない', () => {
      const a = join(tmpdir(), `en-pdf-${process.pid}-ln-a.txt`);
      const b = join(tmpdir(), `en-pdf-${process.pid}-ln-b.txt`);
      wf(a, 'POV: X\n【One】\nBody A.\n\nBody A2.\n');
      wf(b, 'Body B.\n');
      try {
        const chapters = buildChapters([parseEnglishFile(a), parseEnglishFile(b)]);
        const html = chapterHtml(chapters[0], { smartQuotes: true, lineNumbers: true });
        expect(html).toContain('<h2 class="chapter-title" data-file="0" data-line="1">One</h2>');
        expect(html).toContain('<p class="noindent" data-file="0" data-line="2">Body A.</p>');
        expect(html).toContain('<div class="scene-space" data-file="0" data-line="3"></div>');
        expect(html).toContain('<p class="noindent" data-file="0" data-line="4">Body A2.</p>');
        expect(html).toContain('<p class="ornament">*&#x2002;*&#x2002;*</p>');
        expect(html).toContain('<p class="noindent" data-file="1" data-line="0">Body B.</p>');
        expect(chapterHtml(chapters[0], { smartQuotes: true })).not.toContain('data-line');
      } finally {
        ul(a); ul(b);
      }
    });

    test('前ファイルが【】で終わると次ファイルは新しい章になる', () => {
      const a = join(tmpdir(), `en-pdf-${process.pid}-d.txt`);
      const b = join(tmpdir(), `en-pdf-${process.pid}-e.txt`);
      wf(a, '【One】\nBody A.\n【】\n');
      wf(b, 'Body B.\n');
      try {
        const chapters = buildChapters([parseEnglishFile(a), parseEnglishFile(b)]);
        expect(chapters).toHaveLength(2);
        expect(chapters[1].number).toBe(2);
      } finally {
        ul(a); ul(b);
      }
    });
  });
}
