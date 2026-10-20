#!/usr/bin/env node

/**
 * 英語原稿のtxtファイルを出版物レイアウト（ペーパーバック風・横書き）のPDFに変換するスクリプト
 *
 * 使い方:
 *   novel pdf-en -o output.pdf file1.txt file2.txt ...
 *   novel pdf-en -o output.pdf ./src/co/story/en/
 *
 * オプション:
 *   -o, --output <file>  出力ファイル名（必須）
 *   --title <title>      書名（タイトルページと柱に使用）
 *   --author <author>    著者名
 *   --5x8                5×8in トレードペーパーバック
 *   --6x9                6×9in USトレード（デフォルト）
 *   --a5                 A5サイズ
 *   --part 070,085,...   部の境界となるファイル名プレフィックス（pdf.mjs の --part と同形式）。
 *                        該当ファイルから新しい部（Part One, Part Two, ...）が始まり、部扉ページを挿入する。
 *                        章番号は部ごとにリセットされ、部に章が1つしかない場合は章番号を表示しない。
 *                        未訳などで該当ファイルが存在しない境界はスキップする。
 *   --recto              章を必ず右ページ（recto）から開始する
 *   --no-smart-quotes    ストレート引用符をカーリー引用符に変換しない
 *   --open               生成後にプレビューを開く
 *   --scene-break <記号> 場面区切り（* の行）とファイルの継ぎ目に組む記号（既定: * * *）
 *
 * 章が1つしかなく章題も無い場合は、章ヘッダ（章番号）を出力しない。
 *
 * 原稿の記法:
 *   【title】        章の開始（titleは章題、空なら番号のみ）。【】で始まらないファイルは前の章の続き
 *   Epigraph: ...    章扉のエピグラフ
 *   Memo: ...        出力しない
 *   *text*           イタリック
 *   《《text》》     傍点（文字上に点を打つ強調）
 *   * / * * *        場面区切り（* * * として出力）
 *   ◇◇◇ / >>> 等    記号だけの行。書いた記号のまま中央に出す区切り
 *   ---              翻訳作業用の罫線（出力しない）
 *   空行             場面の小休止（行アキ）
 */

import { readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { PDFArray, PDFDocument, PDFRawStream, rgb, StandardFonts } from 'pdf-lib';
import { BOLD_CLOSE, BOLD_OPEN, parseAozoraLine, TCY_CLOSE, TCY_OPEN } from './lib/aozora.mjs';
import { ARG, buildPdfFromHtml, openFile, parseCliArgs, requireOutput, runMain } from './lib/cli.mjs';
import { chapterNumberWord } from './lib/english.mjs';
import { googleFontsLinks } from './lib/html.mjs';
import { requireInputFiles, resolvePartIndices, startsNewChapter } from './lib/manuscript.mjs';
import {
  escapeXml,
  getBodyLines,
  isEpigraphLine,
  isSceneBreak,
  isSeparator,
  parseEpigraphLine,
  parseViewpointLine,
  readLines,
} from './lib/text-parser.mjs';

/** 英語のペーパーバックでの場面区切りの既定（--scene-break 未指定時に組む記号） */
export const ENGLISH_SCENE_BREAK = '* * *';

export const PAGE_SIZES = {
  '5x8': {
    name: '5×8in Trade Paperback',
    width: '5in',
    height: '8in',
    fontSize: '10.5pt',
    lineHeight: '1.35',
    margin: { top: '0.6in', bottom: '0.55in', inner: '0.7in', outer: '0.5in' },
  },
  '6x9': {
    name: '6×9in US Trade',
    width: '6in',
    height: '9in',
    fontSize: '11pt',
    lineHeight: '1.4',
    margin: { top: '0.7in', bottom: '0.6in', inner: '0.8in', outer: '0.6in' },
  },
  a5: {
    name: 'A5',
    width: '148mm',
    height: '210mm',
    fontSize: '11pt',
    lineHeight: '1.4',
    margin: { top: '16mm', bottom: '14mm', inner: '18mm', outer: '15mm' },
  },
};

/** pdf-en のコマンドライン引数を解釈する。判型は pageSize に PAGE_SIZES のキーで入る */
export function parseArgs(argv) {
  return parseCliArgs(
    argv,
    [
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
      ARG.sceneBreak,
    ],
    { pageSize: '6x9', smartQuotes: true },
  );
}

function isRuleLine(line) {
  return /^-{3,}$/.test(line.trim());
}

export function smartQuotes(text) {
  return text
    .replace(/(^|[\s([—–“]|<em>)"/g, '$1“')
    .replace(/"/g, '”')
    .replace(/(^|[\s([—–“]|<em>)'/g, '$1‘')
    .replace(/'/g, '’');
}

export function formatInline(text, { curly = true } = {}) {
  let t = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // 引用符の開閉判定が<em>タグを文脈にできるよう、イタリック変換を先に行う
  t = t.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  if (curly) t = smartQuotes(t);
  t = t.replace(/《《(.+?)》》/g, '<span class="emphasis">$1</span>');
  // 縦中横は横組では意味を持たないので、印だけ外して中身を残す
  return t
    .replaceAll(BOLD_OPEN, '<strong>')
    .replaceAll(BOLD_CLOSE, '</strong>')
    .replaceAll(TCY_OPEN, '')
    .replaceAll(TCY_CLOSE, '');
}

/** 英語原稿のファイルを読み、parseEnglishLines で解釈する */
export function parseEnglishFile(filePath) {
  return parseEnglishLines(readLines(filePath));
}

/**
 * 英語原稿の行列を解釈し、本文ブロック・章題・エピグラフを返す。
 * 罫線（---）・Memo:・青空文庫の行の単位の注記（改ページ・字下げなど）は組まない。
 * 各ブロックの line は元テキストの行番号（0始まり）。
 * ファイルを介さないのは、未保存のエディタ内容をプレビューする VS Code 拡張から使うため。
 */
export function parseEnglishLines(sourceLines) {
  // 罫線（---）は翻訳作業用の目印なので、章頭・章末の判定より前に取り除く
  const kept = sourceLines.map((text, line) => ({ text, line })).filter((e) => !isRuleLine(e.text));
  const { lines, indices, hasViewpointStart } = getBodyLines(
    kept.map((e) => e.text),
    { keepEpigraphs: true },
  );
  const epigraphs = lines.filter((l) => isEpigraphLine(l)).map((l) => parseEpigraphLine(l));
  const bodyLines = lines
    .map((text, i) => ({ aozora: parseAozoraLine(text), line: kept[indices[i]].line }))
    .filter((e) => e.aozora.kind === 'text')
    .map((e) => ({ text: e.aozora.text, line: e.line }))
    .filter((e) => !isEpigraphLine(e.text));
  const headingIndex = hasViewpointStart ? bodyLines.findIndex((e) => e.text.trim() !== '') : -1;

  let chapterTitle = null;
  let titleLine = null;
  const blocks = [];

  bodyLines.forEach(({ text: line, line: n }, i) => {
    if (line.trim() === '') {
      blocks.push({ type: 'space', line: n });
    } else if (isSeparator(line)) {
      blocks.push({ type: 'ornament', mark: isSceneBreak(line) ? null : line.trim(), line: n });
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

  return { blocks, chapterTitle, titleLine, epigraphs, hasViewpointStart };
}

/**
 * ファイルごとの解釈結果を章にまとめる。【】で始まらないファイルは前の章に続け、継ぎ目に場面区切りを入れる。
 * partFirstIndices（先頭の 0 を含む。第1部にも部扉を付けるため）を渡すと、章番号を部ごとに振り直し、
 * 部に章が1つしかない章に soleInPart を付ける。
 * 各ブロックと章題には由来のファイル番号（parsedFiles の添字）を file として付ける。
 */
export function buildChapters(parsedFiles, partFirstIndices = null) {
  const partSet = partFirstIndices ? new Set(partFirstIndices) : null;
  const chapters = [];
  let partNumber = 0;
  let numberInPart = 0;

  parsedFiles.forEach((f, i) => {
    const startsPart = partSet?.has(i);
    const blocks = f.blocks.map((b) => ({ ...b, file: i }));

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
        epigraphs: [...f.epigraphs],
        blocks,
      });
    } else {
      const ch = chapters[chapters.length - 1];
      ch.blocks.push({ type: 'ornament' }, ...blocks);
      ch.epigraphs.push(...f.epigraphs);
    }
  });

  // 日本語版の【2】/【2-1】の使い分けに合わせる
  if (partSet) {
    const counts = new Map();
    for (const ch of chapters) counts.set(ch.part, (counts.get(ch.part) ?? 0) + 1);
    for (const ch of chapters) ch.soleInPart = counts.get(ch.part) === 1;
  }

  return chapters;
}

/**
 * 1章分の HTML を組む（部の先頭なら部扉を前に付ける）。
 * opts: smartQuotes / sceneBreak / bareChapterHead（章題が無ければ章ヘッダを出さない）/
 *   lineNumbers（段落・区切り・章題に data-file: ファイル番号 / data-line: 0始まりの行番号 を付ける）。
 * 章頭・場面区切り直後の段落は字下げしない。記号だけの区切り行は書いた記号のまま各記号の間に en スペースを挟み、
 * 場面区切りは sceneBreak（既定 ENGLISH_SCENE_BREAK）を空白を en スペースにして組む。
 */
export function chapterHtml(ch, opts) {
  const inline = (t) => formatInline(t, { curly: opts.smartQuotes });
  const parts = [];
  const lineAttr = (file, line) => (opts.lineNumbers && line != null ? ` data-file="${file}" data-line="${line}"` : '');

  // 柱の string-set を担うため、章ヘッダを出さないときも要素自体は空で残す
  const bareHead = opts.bareChapterHead && !ch.title;
  parts.push(`<header class="chapter-head${bareHead ? ' chapter-head-bare' : ''}">`);
  if (!bareHead) {
    if (!ch.soleInPart) parts.push(`<p class="chapter-number">${chapterNumberWord(ch.number)}</p>`);
    if (ch.title) parts.push(`<h2 class="chapter-title"${lineAttr(ch.file, ch.titleLine)}>${inline(ch.title)}</h2>`);
    else parts.push(`<h2 class="chapter-title chapter-title-hidden">Chapter ${chapterNumberWord(ch.number)}</h2>`);
  }
  parts.push('</header>');

  for (const { quote, source } of ch.epigraphs) {
    parts.push('<div class="epigraph">');
    parts.push(`<p class="epigraph-quote">${inline(quote)}</p>`);
    if (source) parts.push(`<p class="epigraph-source">—${inline(source)}</p>`);
    parts.push('</div>');
  }

  let afterBreak = true;
  for (const block of ch.blocks) {
    const attr = lineAttr(block.file, block.line);
    if (block.type === 'space') {
      parts.push(`<div class="scene-space"${attr}></div>`);
      afterBreak = true;
    } else if (block.type === 'ornament') {
      parts.push(
        block.mark
          ? `<p class="ornament"${attr}>${[...block.mark].map(escapeXml).join('&#x2002;')}</p>`
          : `<p class="ornament"${attr}>${escapeXml(opts.sceneBreak ?? ENGLISH_SCENE_BREAK).replace(/ /g, '&#x2002;')}</p>`,
      );
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

/**
 * 全章を組んだ印刷用 HTML を返す。size: PAGE_SIZES の1つ（または同じ形のオブジェクト）。
 * opts: title / author / recto / smartQuotes / sceneBreak / lineNumbers。
 * 章が1つしかない作品では、章題が無ければ章ヘッダを出さない。
 */
export function generateHtml(chapters, size, opts) {
  const m = size.margin;
  const inline = (t) => formatInline(t, { curly: opts.smartQuotes });
  const versoHeader = opts.author || opts.title || '';
  const rectoHeader = opts.title || '';

  const titlePage = opts.title
    ? `
<section class="title-page">
  <h1>${inline(opts.title)}</h1>
  ${opts.author ? `<p class="title-author">${inline(opts.author)}</p>` : ''}
</section>`
    : '';

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

    /* first-except は文字列が代入されたページ（＝章扉）で空になるため、
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

    /* chapter:left/:right より詳細度を上げるため名前付きでも指定する */
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

    /* 柱を出さないため front ページとして扱う */
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

    .chapter-head-bare {
      margin-bottom: 0;
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
${chapters.map((ch) => chapterHtml(ch, { ...opts, bareChapterHead: chapters.length === 1 })).join('\n')}
</body>
</html>`;
}

function cssLenToPt(v) {
  if (v.endsWith('in')) return parseFloat(v) * 72;
  if (v.endsWith('mm')) return (parseFloat(v) * 72) / 25.4;
  return parseFloat(v);
}

/** ページのコンテンツストリームの合計バイト数を返す（白ページの推定用）。読めなければ Infinity */
function pageContentBytes(doc, page) {
  try {
    const contents = page.node.Contents();
    if (!contents) return 0;
    const streams = contents instanceof PDFArray ? contents.asArray().map((o) => doc.context.lookup(o)) : [contents];
    return streams.reduce((n, s) => n + (s instanceof PDFRawStream ? s.contents.length : 0), 0);
  } catch {
    return Infinity;
  }
}

/**
 * PDF にノンブルを打って上書きし、総ページ数を返す。タイトルページ（とその直後の白ページ）は前付として除き、
 * 以降を1始まりで数える。白ページ（recto 開始で挿入される空きページ）は数には入れるが印字しない。
 */
export async function stampPageNumbers(pdfPath, size, { hasTitlePage }) {
  const doc = await PDFDocument.load(readFileSync(pdfPath));
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const pages = doc.getPages();
  const fontSize = 9;
  const y = cssLenToPt(size.margin.bottom) * 0.45;

  const isBlank = (p) => pageContentBytes(doc, p) < 160;

  let frontPages = hasTitlePage ? 1 : 0;
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

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  requireOutput(args, 'output.pdf');

  const size = PAGE_SIZES[args.pageSize];
  console.log(`判型: ${size.name}`);

  const inputFiles = requireInputFiles(args.files);

  // 翻訳は先頭から進む前提なので、未訳で存在しない境界を飛ばしても部番号はずれない
  let partFirstIndices = null;
  if (args.parts && args.parts.length > 0) {
    const present = args.parts.filter((tok) => inputFiles.some((f) => basename(f).match(/^\d+/)?.[0] === tok));
    const missing = args.parts.filter((tok) => !present.includes(tok));
    if (missing.length > 0) console.log(`部境界（ファイルなしのためスキップ）: ${missing.join(', ')}`);
    const resolved = resolvePartIndices(present, inputFiles).filter((i) => i > 0);
    partFirstIndices = [0, ...resolved];
    console.log(
      `部の境界: ${partFirstIndices.map((idx, i) => `Part ${chapterNumberWord(i + 1)}=${basename(inputFiles[idx])}`).join(', ')}`,
    );
  }

  const parsedFiles = inputFiles.map((f) => parseEnglishFile(f));
  const chapters = buildChapters(parsedFiles, partFirstIndices);

  let totalWords = 0;
  for (const ch of chapters) {
    const words = ch.blocks
      .filter((b) => b.type === 'para')
      .reduce((n, b) => n + b.text.split(/\s+/).filter(Boolean).length, 0);
    totalWords += words;
    const num = ch.part !== null ? (ch.soleInPart ? `${ch.part}` : `${ch.part}-${ch.number}`) : `${ch.number}`;
    const label = ch.title ? ` "${ch.title}"` : '';
    console.log(`  Chapter ${num}${label}: ${words.toLocaleString()} words`);
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
  const { writeFileSync: wf, unlinkSync: ul } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { inflateSync } = await import('node:zlib');
  const { PDFName } = await import('pdf-lib');

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
      number: 1,
      title: '',
      epigraphs: [],
      blocks: [{ type: 'para', text: 'Body.' }],
      part: null,
      startsPart: false,
      soleInPart: false,
    };
    test('通常は章番号を出す', () => {
      const html = chapterHtml(ch, { smartQuotes: true });
      expect(html).toContain('chapter-number');
    });
    test('bareChapterHeadでは章ヘッダを空にする', () => {
      const html = chapterHtml(ch, { smartQuotes: true, bareChapterHead: true });
      expect(html).toContain('chapter-head-bare');
      expect(html).not.toContain('chapter-number');
    });
    test('bareChapterHeadでも章題があればヘッダを出す', () => {
      const html = chapterHtml({ ...ch, title: 'One' }, { smartQuotes: true, bareChapterHead: true });
      expect(html).not.toContain('chapter-head-bare');
      expect(html).toContain('chapter-title');
    });
  });

  describe('parseEnglishFile / buildChapters', () => {
    test('章マーカーを解釈し、Memo 行と罫線は出さない', () => {
      const tmp = join(tmpdir(), `en-pdf-${process.pid}-a.txt`);
      wf(tmp, 'Memo: Nadia Solis\n【-21Y】\nFirst paragraph.\n\nSecond paragraph.\n---\n');
      try {
        const parsed = parseEnglishFile(tmp);
        expect(parsed.chapterTitle).toBe('-21Y');
        expect(parsed.hasViewpointStart).toBe(true);
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

    test('視点行なしの継続ファイルは前章に結合され場面区切りが入る', () => {
      const a = join(tmpdir(), `en-pdf-${process.pid}-b.txt`);
      const b = join(tmpdir(), `en-pdf-${process.pid}-c.txt`);
      wf(a, '【One】\nBody A.\n');
      wf(b, 'Body B.\n');
      try {
        const chapters = buildChapters([parseEnglishFile(a), parseEnglishFile(b)]);
        expect(chapters).toHaveLength(1);
        expect(chapters[0].blocks.map((bl) => bl.type)).toEqual(['para', 'ornament', 'para']);
      } finally {
        ul(a);
        ul(b);
      }
    });

    test('部境界で章番号がリセットされ、部の先頭章にstartsPartが付く', () => {
      const files = ['f', 'g', 'h'].map((s) => join(tmpdir(), `en-pdf-${process.pid}-${s}.txt`));
      wf(files[0], '【One】\nBody A.\n');
      wf(files[1], '【Two】\nBody B.\n');
      wf(files[2], '【Three】\nBody C.\n');
      try {
        const chapters = buildChapters(
          files.map((f) => parseEnglishFile(f)),
          [0, 2],
        );
        expect(chapters.map((ch) => [ch.part, ch.number, ch.startsPart])).toEqual([
          [1, 1, true],
          [1, 2, false],
          [2, 1, true],
        ]);
        expect(chapters.map((ch) => ch.soleInPart)).toEqual([false, false, true]);
      } finally {
        for (const f of files) ul(f);
      }
    });

    test('* の行は * * * の場面区切り、ほかの記号だけの行（>>> など）は書いたまま、--- は出さない', () => {
      const tmp = join(tmpdir(), `en-pdf-${process.pid}-v.txt`);
      wf(tmp, 'Body A.\n\n*\n\nBody B.\n\n>>>\n\n---\n\nBody C.\n');
      try {
        const parsed = parseEnglishFile(tmp);
        const ornaments = parsed.blocks.filter((b) => b.type === 'ornament');
        expect(ornaments.map((b) => b.mark)).toEqual([null, '>>>']);
        const html = chapterHtml(
          {
            number: 1,
            title: null,
            epigraphs: [],
            blocks: parsed.blocks,
            part: null,
            startsPart: false,
            soleInPart: false,
          },
          { smartQuotes: true },
        );
        expect(html).toContain('<p class="ornament">*&#x2002;*&#x2002;*</p>');
        expect(html).toContain('<p class="ornament">&gt;&#x2002;&gt;&#x2002;&gt;</p>');
        expect(
          chapterHtml(
            {
              number: 1,
              title: null,
              epigraphs: [],
              blocks: parsed.blocks,
              part: null,
              startsPart: false,
              soleInPart: false,
            },
            { smartQuotes: true, sceneBreak: '~' },
          ),
        ).toContain('<p class="ornament">~</p>');
      } finally {
        ul(tmp);
      }
    });

    test('lineNumbers で段落にファイル番号と行番号を付け、継ぎ目の区切りには付けない', () => {
      const a = join(tmpdir(), `en-pdf-${process.pid}-ln-a.txt`);
      const b = join(tmpdir(), `en-pdf-${process.pid}-ln-b.txt`);
      wf(a, 'Memo: X\n【One】\nBody A.\n\nBody A2.\n');
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
        ul(a);
        ul(b);
      }
    });
  });

  describe('parseArgs', () => {
    test('既定は 6×9in・スマートクォートあり', () => {
      const args = parseArgs(['-o', 'out.pdf', 'a.txt', 'dir/']);
      expect(args).toMatchObject({
        output: 'out.pdf',
        pageSize: '6x9',
        smartQuotes: true,
        recto: false,
        open: false,
        title: null,
        author: null,
        parts: null,
        sceneBreak: null,
        files: ['a.txt', 'dir/'],
      });
    });
    test('判型フラグで PAGE_SIZES のキーを選ぶ', () => {
      expect(parseArgs(['--5x8']).pageSize).toBe('5x8');
      expect(parseArgs(['--a5']).pageSize).toBe('a5');
      expect(parseArgs(['--a5', '--6x9']).pageSize).toBe('6x9');
      for (const key of ['5x8', '6x9', 'a5']) expect(PAGE_SIZES[key]).toBeDefined();
    });
    test('値付きオプションとフラグを解釈する', () => {
      const args = parseArgs([
        '--output=o.pdf',
        '--title',
        'T',
        '--author',
        'A',
        '--part',
        '070,085',
        '--recto',
        '--no-smart-quotes',
        '--open',
        '--scene-break',
        '~',
      ]);
      expect(args).toMatchObject({
        output: 'o.pdf',
        title: 'T',
        author: 'A',
        parts: ['070', '085'],
        recto: true,
        smartQuotes: false,
        open: true,
        sceneBreak: '~',
      });
    });
  });

  describe('formatInline（青空文庫の注記）', () => {
    test('太字は strong にし、縦中横は印を外して中身だけ残す', () => {
      expect(formatInline(`${BOLD_OPEN}bold${BOLD_CLOSE} ${TCY_OPEN}12${TCY_CLOSE}`)).toBe('<strong>bold</strong> 12');
    });
  });

  describe('parseEnglishLines', () => {
    test('Epigraph: 行は本文から外して epigraphs に入れる', () => {
      const parsed = parseEnglishLines(['【One】', 'Epigraph: To be.——Hamlet', 'Body.']);
      expect(parsed.epigraphs).toEqual([{ quote: 'To be.', source: 'Hamlet' }]);
      expect(parsed.blocks).toEqual([{ type: 'para', text: 'Body.', line: 2 }]);
    });
    test('青空文庫の行の単位の注記（改ページなど）は組まない', () => {
      const parsed = parseEnglishLines(['【One】', 'Body A.', '［＃改ページ］', 'Body B.']);
      expect(parsed.blocks.map((b) => b.text)).toEqual(['Body A.', 'Body B.']);
    });
    test('【】で始まらない行列は章を始めない', () => {
      const parsed = parseEnglishLines(['Body.']);
      expect(parsed.hasViewpointStart).toBe(false);
      expect(parsed.chapterTitle).toBeNull();
    });
    test('【】が空なら章題なし、】の後ろの本文は段落にする', () => {
      const parsed = parseEnglishLines(['【】Body.']);
      expect(parsed.hasViewpointStart).toBe(true);
      expect(parsed.chapterTitle).toBeNull();
      expect(parsed.blocks).toEqual([{ type: 'para', text: 'Body.', line: 0 }]);
    });
  });

  describe('chapterHtml（組み方）', () => {
    const base = {
      number: 2,
      title: null,
      epigraphs: [],
      blocks: [],
      part: null,
      startsPart: false,
      soleInPart: false,
    };
    test('章頭と場面区切り・行アキの直後の段落だけ字下げしない', () => {
      const html = chapterHtml(
        {
          ...base,
          blocks: [
            { type: 'para', text: 'A.' },
            { type: 'para', text: 'B.' },
            { type: 'space' },
            { type: 'para', text: 'C.' },
            { type: 'ornament' },
            { type: 'para', text: 'D.' },
          ],
        },
        { smartQuotes: true },
      );
      expect(html).toContain('<p class="noindent">A.</p>\n<p>B.</p>');
      expect(html).toContain('<p class="noindent">C.</p>');
      expect(html).toContain('<p class="noindent">D.</p>');
    });
    test('部に章が1つしかなければ章番号を出さない', () => {
      expect(chapterHtml({ ...base, part: 1, soleInPart: true }, { smartQuotes: true })).not.toContain(
        'chapter-number',
      );
    });
    test('部の先頭章の前に部扉を入れる', () => {
      const html = chapterHtml({ ...base, part: 2, startsPart: true }, { smartQuotes: true });
      expect(html.startsWith('<section class="part-page">\n<p class="part-number">Part Two</p>')).toBe(true);
    });
    test('エピグラフを章ヘッダの後に組む', () => {
      const html = chapterHtml(
        {
          ...base,
          epigraphs: [
            { quote: 'Q', source: 'S' },
            { quote: 'R', source: null },
          ],
        },
        { smartQuotes: true },
      );
      expect(html).toContain('<p class="epigraph-quote">Q</p>\n<p class="epigraph-source">—S</p>');
      expect(html).toContain('<p class="epigraph-quote">R</p>\n</div>');
    });
  });

  describe('generateHtml', () => {
    const chapter = (title) => ({
      number: 1,
      title,
      epigraphs: [],
      blocks: [{ type: 'para', text: 'Body.' }],
      part: null,
      startsPart: false,
      soleInPart: false,
    });
    test('章が1つしかなく章題も無ければ章ヘッダを出さない', () => {
      const html = generateHtml([chapter(null)], PAGE_SIZES['6x9'], { smartQuotes: true });
      expect(html).toContain('class="chapter-head chapter-head-bare"');
      expect(html).not.toContain('<p class="chapter-number">');
    });
    test('章が複数あれば章題が無くても章番号を出す', () => {
      const html = generateHtml([chapter(null), { ...chapter(null), number: 2 }], PAGE_SIZES['6x9'], {
        smartQuotes: true,
      });
      expect(html).not.toContain('class="chapter-head chapter-head-bare"');
      expect(html).toContain('<p class="chapter-number">');
    });
    test('書名があればタイトルページと柱に使い、著者名はタイトルページと左ページの柱に使う', () => {
      const html = generateHtml([chapter('One')], PAGE_SIZES['6x9'], {
        smartQuotes: true,
        title: 'Book',
        author: 'Me',
      });
      expect(html).toContain('<h1>Book</h1>');
      expect(html).toContain('<p class="title-author">Me</p>');
      expect(html).toContain('string-set: verso-header "Me", recto-header "Book"');
      expect(generateHtml([chapter('One')], PAGE_SIZES['6x9'], { smartQuotes: true })).not.toContain('title-page"');
    });
    test('recto では章と部扉を右ページから始める', () => {
      expect(generateHtml([chapter('One')], PAGE_SIZES['6x9'], { smartQuotes: true, recto: true })).toContain(
        'break-before: recto',
      );
      expect(generateHtml([chapter('One')], PAGE_SIZES['6x9'], { smartQuotes: true })).not.toContain('recto;');
    });
  });

  describe('stampPageNumbers', () => {
    const stampedNumbers = async (path) => {
      const doc = await PDFDocument.load(readFileSync(path));
      return doc.getPages().map((page) => {
        const contents = page.node.Contents();
        const streams =
          contents instanceof PDFArray ? contents.asArray().map((o) => doc.context.lookup(o)) : [contents];
        const texts = streams.flatMap((/** @type {import('pdf-lib').PDFRawStream} */ st) => {
          if (!st) return [];
          const raw = st.dict.get(PDFName.of('Filter')) ? inflateSync(st.contents) : st.contents;
          return [
            ...Buffer.from(raw)
              .toString('latin1')
              .matchAll(/<([0-9A-F]+)> Tj/g),
          ].map((m) => Buffer.from(m[1], 'hex').toString());
        });
        return texts.find((t) => /^\d+$/.test(t)) ?? null;
      });
    };

    test('タイトルページとその直後の白ページを除いて1から数え、白ページは数えるが印字しない', async () => {
      const src = await PDFDocument.create();
      const font = await src.embedFont(StandardFonts.TimesRoman);
      const filled = () => {
        const page = src.addPage([432, 648]);
        for (let i = 0; i < 10; i++) page.drawText('Lorem ipsum dolor sit amet.', { x: 50, y: 600 - i * 20, font });
      };
      filled(); // タイトルページ
      src.addPage([432, 648]);
      filled();
      src.addPage([432, 648]);
      filled();
      const tmp = join(tmpdir(), `en-pdf-${process.pid}-stamp.pdf`);
      wf(tmp, await src.save());
      try {
        expect(await stampPageNumbers(tmp, PAGE_SIZES['6x9'], { hasTitlePage: true })).toBe(5);
        expect(await stampedNumbers(tmp)).toEqual([null, null, '1', null, '3']);
      } finally {
        ul(tmp);
      }
    });
  });
}
