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
 *   --recto              章を必ず右ページ（recto）から開始する
 *   --no-smart-quotes    ストレート引用符をカーリー引用符に変換しない
 *   --open               生成後にプレビューを開く
 *
 * 原稿の記法:
 *   POV: name        章扉に視点人物名として表示
 *   【title】        章の開始（titleは章題、空なら番号のみ）
 *   末尾の【】       次章のアンカー（本文には出力しない）
 *   Epigraph: ...    章扉のエピグラフ
 *   Memo: ...        無視
 *   *text*           イタリック
 *   ◇◇◇ / *** / ---  場面区切り（* * * として出力）
 *   空行             場面の小休止（行アキ）
 */

import { readFileSync, writeFileSync, statSync, unlinkSync } from 'fs';
import { PDFDocument, PDFArray, PDFRawStream, StandardFonts, rgb } from 'pdf-lib';
import {
  isMemoLine, isPovLine, parsePovLine,
  isEpigraphLine, parseEpigraphLine,
  isViewpointLine, isSeparator,
} from './lib/text-parser.mts';
import { collectInputFiles } from './lib/text-parser.mts';
import { parseCliArgs, fail, vivliostyleBuild, openFile } from './lib/cli.mts';

// 判型定義
const PAGE_SIZES = {
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

const NUMBER_WORDS = [
  'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen',
  'Eighteen', 'Nineteen', 'Twenty', 'Twenty-One', 'Twenty-Two', 'Twenty-Three',
  'Twenty-Four', 'Twenty-Five', 'Twenty-Six', 'Twenty-Seven', 'Twenty-Eight',
  'Twenty-Nine', 'Thirty', 'Thirty-One', 'Thirty-Two', 'Thirty-Three',
  'Thirty-Four', 'Thirty-Five', 'Thirty-Six', 'Thirty-Seven', 'Thirty-Eight',
  'Thirty-Nine', 'Forty',
];

function chapterNumberWord(n) {
  return NUMBER_WORDS[n - 1] ?? String(n);
}

function parseArgs(argv) {
  return parseCliArgs(argv, [
    { key: 'output', flags: ['-o', '--output'], takesValue: true },
    { key: 'title', flags: ['--title'], takesValue: true },
    { key: 'author', flags: ['--author'], takesValue: true },
    { key: 'pageSize', flags: ['--5x8'], value: '5x8' },
    { key: 'pageSize', flags: ['--6x9'], value: '6x9' },
    { key: 'pageSize', flags: ['--a5'], value: 'a5' },
    { key: 'recto', flags: ['--recto'] },
    { key: 'smartQuotes', flags: ['--no-smart-quotes'], value: false },
    { key: 'open', flags: ['--open'] },
  ], { output: null, title: null, author: null, pageSize: '6x9', recto: false, smartQuotes: true, open: false });
}

function isRuleLine(line) {
  return /^-{3,}$/.test(line.trim()) || /^\*(\s*\*)+$/.test(line.trim());
}

export function smartQuotes(text) {
  return text
    .replace(/(^|[\s([—–“])"/g, '$1“')
    .replace(/"/g, '”')
    .replace(/(^|[\s([—–“])'/g, '$1‘')
    .replace(/'/g, '’');
}

export function formatInline(text, { curly = true } = {}) {
  let t = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  if (curly) t = smartQuotes(t);
  t = t.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return t;
}

// 1ファイルを解析して { blocks, chapterTitle, pov, epigraphs, hasViewpointStart, hasViewpointEnd } を返す
export function parseEnglishFile(filePath) {
  const lines = readFileSync(filePath, 'utf-8').split('\n');
  const isMeta = l => isMemoLine(l) || isPovLine(l) || isEpigraphLine(l);

  const povLine = lines.find(l => isPovLine(l));
  const pov = povLine ? parsePovLine(povLine) : null;
  const epigraphs = lines.filter(l => isEpigraphLine(l)).map(l => parseEpigraphLine(l));

  // 本文行（メタ行・罫線を除く）の先頭/末尾が視点行かどうか
  const contentIdx = [];
  lines.forEach((l, i) => {
    if (l.trim() !== '' && !isMeta(l) && !isRuleLine(l)) contentIdx.push(i);
  });
  const hasViewpointStart = contentIdx.length > 0 && isViewpointLine(lines[contentIdx[0]]);
  const hasViewpointEnd = contentIdx.length > 0 && isViewpointLine(lines[contentIdx[contentIdx.length - 1]]);
  const endViewpointLineIndex = hasViewpointEnd ? contentIdx[contentIdx.length - 1] : -1;

  let chapterTitle = null;
  const blocks = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isMeta(line) || isRuleLine(line) || i === endViewpointLineIndex) continue;

    if (line.trim() === '') {
      blocks.push({ type: 'space' });
      continue;
    }

    if (isSeparator(line)) {
      blocks.push({ type: 'ornament' });
      continue;
    }

    if (isViewpointLine(line) && i === contentIdx[0]) {
      const m = line.match(/^【(.*)】(.*)$/);
      chapterTitle = m[1].trim() || null;
      const rest = m[2].trim();
      if (rest) blocks.push({ type: 'para', text: rest });
      continue;
    }

    blocks.push({ type: 'para', text: line.trim() });
  }

  // 先頭・末尾の space/ornament をトリム
  while (blocks.length > 0 && blocks[0].type !== 'para') blocks.shift();
  while (blocks.length > 0 && blocks[blocks.length - 1].type !== 'para') blocks.pop();

  return { blocks, chapterTitle, pov, epigraphs, hasViewpointStart, hasViewpointEnd };
}

// ファイル列を章にまとめる。視点行で始まるファイル（または前ファイルが【】で終わる場合）が新章
export function buildChapters(parsedFiles) {
  const chapters = [];
  parsedFiles.forEach((f, i) => {
    const prevEndsViewpoint = i > 0 && parsedFiles[i - 1].hasViewpointEnd;
    const startsNewChapter = i === 0 || f.hasViewpointStart || prevEndsViewpoint;

    if (startsNewChapter) {
      chapters.push({
        number: chapters.length + 1,
        title: f.chapterTitle,
        pov: f.pov,
        epigraphs: [...f.epigraphs],
        blocks: [...f.blocks],
      });
    } else {
      const ch = chapters[chapters.length - 1];
      // 継続ファイルとの継ぎ目は場面区切りとして扱う
      ch.blocks.push({ type: 'ornament' }, ...f.blocks);
      ch.epigraphs.push(...f.epigraphs);
    }
  });
  return chapters;
}

function chapterHtml(ch, opts) {
  const inline = t => formatInline(t, { curly: opts.smartQuotes });
  const parts = [];

  parts.push('<header class="chapter-head">');
  parts.push(`<p class="chapter-number">${chapterNumberWord(ch.number)}</p>`);
  if (ch.title) parts.push(`<h2 class="chapter-title">${inline(ch.title)}</h2>`);
  else parts.push(`<h2 class="chapter-title chapter-title-hidden">Chapter ${chapterNumberWord(ch.number)}</h2>`);
  if (ch.pov) parts.push(`<p class="chapter-pov">${inline(ch.pov)}</p>`);
  parts.push('</header>');

  for (const { quote, source } of ch.epigraphs) {
    parts.push('<div class="epigraph">');
    parts.push(`<p class="epigraph-quote">${inline(quote)}</p>`);
    if (source) parts.push(`<p class="epigraph-source">—${inline(source)}</p>`);
    parts.push('</div>');
  }

  let afterBreak = true; // 章頭・場面区切り直後の段落は字下げしない
  for (const block of ch.blocks) {
    if (block.type === 'space') {
      parts.push('<div class="scene-space"></div>');
      afterBreak = true;
    } else if (block.type === 'ornament') {
      parts.push('<p class="ornament">*&#x2002;*&#x2002;*</p>');
      afterBreak = true;
    } else {
      parts.push(`<p${afterBreak ? ' class="noindent"' : ''}>${inline(block.text)}</p>`);
      afterBreak = false;
    }
  }

  const cls = ch.number === 1 ? 'chapter chapter-first' : 'chapter';
  return `<section class="${cls}">\n${parts.join('\n')}\n</section>`;
}

function generateHtml(chapters, size, opts) {
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
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet">
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
      font-size: 12pt;
      letter-spacing: 0.2em;
      text-transform: uppercase;
      margin-top: 3em;
    }

    .chapter {
      page: chapter;
      break-before: ${opts.recto ? 'recto' : 'page'};
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

    .scene-space {
      height: 1lh;
    }

    p.ornament {
      text-indent: 0;
      text-align: center;
      margin: 0.85lh 0;
      letter-spacing: 0.2em;
      break-inside: avoid;
    }
  </style>
</head>
<body>
${titlePage}
${chapters.map(ch => chapterHtml(ch, opts)).join('\n')}
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

  if (!args.output) fail('出力ファイルを指定してください (-o output.pdf)');
  if (args.files.length === 0) fail('入力ファイルまたはディレクトリを指定してください');

  const size = PAGE_SIZES[args.pageSize];
  console.log(`判型: ${size.name}`);

  const inputFiles = collectInputFiles(args.files);
  if (inputFiles.length === 0) fail('txtファイルが見つかりません');

  const parsedFiles = inputFiles.map(f => parseEnglishFile(f));
  const chapters = buildChapters(parsedFiles);

  let totalWords = 0;
  for (const ch of chapters) {
    const words = ch.blocks
      .filter(b => b.type === 'para')
      .reduce((n, b) => n + b.text.split(/\s+/).filter(Boolean).length, 0);
    totalWords += words;
    const label = ch.title ? ` "${ch.title}"` : '';
    const pov = ch.pov ? ` (POV: ${ch.pov})` : '';
    console.log(`  Chapter ${ch.number}${label}${pov}: ${words.toLocaleString()} words`);
  }

  const html = generateHtml(chapters, size, args);
  const htmlPath = args.output.replace(/\.pdf$/, '.html');
  writeFileSync(htmlPath, html);

  console.log('\nPDF生成中...');
  vivliostyleBuild(htmlPath, args.output);
  unlinkSync(htmlPath);

  const pageCount = await stampPageNumbers(args.output, size, { hasTitlePage: Boolean(args.title) });
  const fileSize = statSync(args.output).size;

  console.log(`\nPDF出力: ${args.output}`);
  console.log(`語数: ${totalWords.toLocaleString()} words / ${chapters.length}章`);
  console.log(`頁数: ${pageCount}頁 (${(fileSize / 1024 / 1024).toFixed(1)}MB)`);

  if (args.open) {
    openFile(args.output);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error('エラー:', err.message);
    process.exit(1);
  });
}

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
        expect(parsed.blocks).toEqual([
          { type: 'para', text: 'First paragraph.' },
          { type: 'space' },
          { type: 'para', text: 'Second paragraph.' },
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
        expect(chapters[0].blocks.map(bl => bl.type)).toEqual(['para', 'ornament', 'para']);
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
