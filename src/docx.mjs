#!/usr/bin/env node

/**
 * 原稿のtxtファイルを縦書きのWord文書（docx）にするスクリプト
 *
 * 応募先がWord形式を求めるとき用。用紙・余白・字数×行数はプレビューのレイアウトと同じ考え方で、
 * Wordの「ページ設定」（文字数と行数）にそのまま入るので、受け取った側がWordで開いても同じ字詰めになる。
 *
 * 使い方:
 *   novel docx -o output.docx file1.txt file2.txt ...
 *   novel docx -o output.docx ./src/od/story/
 *
 * オプション:
 *   -o, --output <file>   出力ファイル名（必須）
 *   --title <title>       タイトル（表紙に出す）
 *   --author <author>     著者名（タイトルとともに出す）
 *   --size WxH            1ページの字数×行数（例: --size 42x34）。省略時は --chars と行送りの既定から決める
 *   --chars N             1行の字数（--size があればそちらが優先。既定はプレビューと同じ30）
 *   --paper <name>        用紙（A4 / B5 / A5 / B6 / A6。既定: A4）
 *   --portrait            用紙を縦向きにする（既定: 横向き）
 *   --margin t,r,b,l      余白（mm。上,右,下,左。既定はプレビューと同じ 20,20,25,20）
 *   --no-chapter-break    章（【】の見出し）ごとに改ページしない（--part 指定時は部の頭でだけ改ページ）
 *   --part 060,085,...    部の境界となるファイル名プレフィックス（novel pdf の --part と同じ）。
 *                         部の頭で改ページし、章番号を「部-章」にする
 *   --no-synopsis         梗概（synopsis.txt）を入れない
 *   --coverless           表紙を作らず、梗概と本文の頭にタイトル・著者名を出す
 *   --blank-after-heading 章見出しと本文の間に空行を1行補う
 *   --scene-break <記号>  場面区切り（* の行）とファイルの継ぎ目に組む記号（既定: ＊）
 *   --scene-break-indent <字数>  区切りの行を中央でなく行頭から字数分下げて置く
 *   --template <file>     流し込む縦書きのWordテンプレート（既定: 同梱の A4 横）
 *   --open                生成後に開く
 *
 * 表紙と梗概はページ番号を振らないセクションに置き、本文の1ページ目から番号を振る。
 */

import { basename } from 'node:path';
import { computeMetrics, DEFAULT_LAYOUT, PAPER_SIZES } from './layout.mjs';
import { ARG, fail, openFile, parseCliArgs, requireOutput, runMain } from './lib/cli.mjs';
import { rewriteDocx } from './lib/docx.mjs';
import {
  CHARACTERS_FILENAME,
  computeSectionLabels,
  fileSeparatorLines,
  findSidecarFile,
  loadSynopsisLines,
  moveEpigraphsAfterHeading,
  requireInputFiles,
  resolvePartIndices,
  SYNOPSIS_FILENAME,
} from './lib/manuscript.mjs';
import {
  applyDocGrid,
  applyFontSize,
  applyPageSetup,
  buildBodyXml,
  countBodyChars,
  estimateBodyPages,
  injectBody,
  lineToRunsXml,
  paragraphXml,
  resolveTemplatePath,
  updateCoreProps,
} from './lib/tategaki-docx.mjs';
import {
  applyViewpointLabel,
  getFilteredLines,
  isEpigraphLine,
  isViewpointLine,
  SCENE_BREAK_MARK,
  trimBlankEdges,
} from './lib/text-parser.mjs';

const PAGE_BREAK_LINE = '［＃改ページ］';

function parseMargin(value) {
  const sides = value.split(',').map(Number);
  if (sides.length !== 4 || sides.some((n) => !Number.isFinite(n) || n < 0))
    fail('--margin は 20,20,25,20 の形式（上,右,下,左 の mm）で指定してください');
  const [top, right, bottom, left] = sides;
  return { top, right, bottom, left };
}

function parsePaper(value) {
  if (!(value in PAPER_SIZES)) fail(`--paper は ${Object.keys(PAPER_SIZES).join(' / ')} のどれかにしてください`);
  return value;
}

export function parseArgs(argv) {
  return parseCliArgs(
    argv,
    [
      ARG.output,
      ARG.title,
      ARG.author,
      ARG.size,
      { key: 'chars', flags: ['--chars'], takesValue: true, parse: Number },
      { key: 'paper', flags: ['--paper'], takesValue: true, parse: parsePaper },
      { key: 'portrait', flags: ['--portrait'] },
      { key: 'margin', flags: ['--margin'], takesValue: true, parse: parseMargin },
      { key: 'chapterBreak', flags: ['--no-chapter-break'], value: false },
      ARG.parts,
      { key: 'noSynopsis', flags: ['--no-synopsis'] },
      { key: 'coverless', flags: ['--coverless'] },
      { key: 'blankAfterHeading', flags: ['--blank-after-heading'] },
      ARG.sceneBreak,
      ARG.sceneBreakIndent,
      { key: 'template', flags: ['--template'], takesValue: true },
      ARG.open,
    ],
    { chapterBreak: true },
  );
}

/** 引数の用紙・余白・字数×行数を、プレビューと同じレイアウトの寸法（computeMetrics）にする */
export function layoutMetrics(args) {
  return computeMetrics({
    ...DEFAULT_LAYOUT,
    paper: args.paper ?? DEFAULT_LAYOUT.paper,
    orientation: args.portrait ? 'portrait' : 'landscape',
    margin: args.margin ?? DEFAULT_LAYOUT.margin,
    chars: args.size?.cols ?? args.chars ?? DEFAULT_LAYOUT.chars,
    lines: args.size?.rows ?? null,
  });
}

/**
 * 原稿ファイルを、docx に流し込む1本の行配列にする。
 * 【】の見出しには PDF と同じ章番号（部があれば「部-章」）を付け、エピグラフは見出しの後ろへ移す。
 * 部の頭には改ページの注記を入れ、見出しで始まらないファイルの前には場面区切りを挟む。
 * 章ごとに改ページしないときは、章の境目に空行を1つ入れる。
 */
export function mergeDocxLines(
  inputFiles,
  { partFirstIndices = null, chapterBreak = true, blankAfterHeading = false, sceneBreak = SCENE_BREAK_MARK } = {},
) {
  const labels = computeSectionLabels(inputFiles, partFirstIndices);
  const partStarts = new Set(partFirstIndices ?? []);
  const out = [];

  inputFiles.forEach((file, i) => {
    const { lines, hasViewpointStart } = getFilteredLines(file, { keepEpigraphs: true });
    const body = trimBlankEdges(moveEpigraphsAfterHeading(lines));

    if (i > 0) {
      if (partStarts.has(i)) out.push(PAGE_BREAK_LINE);
      else if (!hasViewpointStart) out.push(...fileSeparatorLines(sceneBreak));
      else if (!chapterBreak) out.push('');
    }

    body.forEach((line, j) => {
      if (!isViewpointLine(line)) {
        out.push(line);
        return;
      }
      out.push(applyViewpointLabel(line, labels[i]));
      // エピグラフが続くときの空行は、表示行に展開する buildBodyXml がエピグラフの後ろに補う
      const next = body[j + 1] ?? '';
      if (blankAfterHeading && !isEpigraphLine(next) && next.trim() !== '') out.push('');
    });
  });

  return trimBlankEdges(out);
}

/** タイトルと、下揃えの著者名の段落。どちらも無ければ空 */
function titleParagraphs(title, author, fontHalfPt) {
  const paragraphs = [];
  if (title) paragraphs.push(paragraphXml(lineToRunsXml(title, { fontHalfPt, bold: true })));
  if (author) paragraphs.push(paragraphXml(lineToRunsXml(author, { fontHalfPt }), { right: true }));
  return paragraphs;
}

/**
 * 表紙・梗概のセクションの段落（ページ番号を振らない前付）。無ければ null。
 * heading はタイトル・著者名の段落。coverless なら表紙を作らず、梗概の頭に heading を出す
 */
function frontMatterXml(heading, coverless, synopsisLines, fontHalfPt) {
  const parts = [];
  if (!coverless && heading.length > 0) parts.push(heading.join(''));
  if (synopsisLines) {
    const synopsis = [
      ...(coverless && heading.length > 0 ? [...heading, paragraphXml('')] : []),
      paragraphXml(lineToRunsXml('梗概', { fontHalfPt, bold: true })),
      ...synopsisLines.map((line) => paragraphXml(line.trim() === '' ? '' : lineToRunsXml(line, { fontHalfPt }))),
    ];
    parts.push(synopsis.join(''));
  }
  if (parts.length === 0) return null;
  return parts.join('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  requireOutput(args, 'output.docx');
  const inputFiles = requireInputFiles(args.files, [SYNOPSIS_FILENAME, CHARACTERS_FILENAME]);
  const templatePath = resolveTemplatePath(args.template);

  const metrics = layoutMetrics(args);
  const cols = metrics.chars;
  const rows = metrics.lines;
  // Word の文字サイズは半ポイント刻みなので、字送りからはみ出さないよう切り捨てる
  const fontHalfPt = Math.floor(metrics.fontSizePt * 2);

  const partFirstIndices =
    args.parts && args.parts.length > 0 ? resolvePartIndices(args.parts, inputFiles).filter((i) => i > 0) : null;
  if (partFirstIndices) {
    const starts = [0, ...partFirstIndices];
    console.log(`部の境界: ${starts.map((p, i) => `第${i + 1}部=${basename(inputFiles[p])}`).join(', ')}`);
  }
  const chapterBreak = !partFirstIndices && args.chapterBreak;

  const lines = mergeDocxLines(inputFiles, {
    partFirstIndices,
    chapterBreak,
    blankAfterHeading: args.blankAfterHeading,
    sceneBreak: args.sceneBreak ?? SCENE_BREAK_MARK,
  });
  for (const f of inputFiles) console.log(`処理中: ${basename(f)}`);

  const synopsisPath = args.noSynopsis ? null : findSidecarFile(inputFiles, args.files, SYNOPSIS_FILENAME);
  const synopsisLines = synopsisPath ? loadSynopsisLines(synopsisPath) : null;
  if (synopsisPath) console.log(`梗概: ${basename(synopsisPath)}`);

  const heading = titleParagraphs(args.title, args.author, fontHalfPt);
  const headParagraphs = args.coverless && heading.length > 0 ? [...heading, paragraphXml('')] : [];
  const bodyXml = buildBodyXml(lines, {
    cols,
    headParagraphs,
    chapterBreak,
    sceneBreak: args.sceneBreak ?? SCENE_BREAK_MARK,
    sceneBreakIndent: args.sceneBreakIndent,
    fontHalfPt,
  });
  const frontXml = frontMatterXml(heading, args.coverless, synopsisLines, fontHalfPt);

  await rewriteDocx(templatePath, args.output, {
    'word/document.xml': (xml) =>
      applyDocGrid(
        applyPageSetup(injectBody(xml, bodyXml, frontXml), {
          paperW: metrics.paperW,
          paperH: metrics.paperH,
          margin: metrics.layout.margin,
          landscape: metrics.layout.orientation === 'landscape',
        }),
        { cols, rows, fontPt: fontHalfPt / 2 },
      ),
    'word/styles.xml': (xml) => applyFontSize(xml, fontHalfPt),
    'docProps/core.xml': (xml) => updateCoreProps(xml, args.title ?? '', args.author ?? ''),
  });

  const headLines = args.coverless ? [args.title, args.author, ''].filter((l) => l != null) : [];
  const pages = estimateBodyPages(lines, { cols, rows, headLines, chapterBreak });
  console.log(`\nDOCX出力: ${args.output}`);
  console.log(
    `${cols}字×${rows}行・${fontHalfPt / 2}pt / 文字数: ${countBodyChars(lines).toLocaleString()}字 / 本文 約${pages}ページ`,
  );

  if (args.open) openFile(args.output);
}

runMain(import.meta.url, main);

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest;
  const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { default: JSZip } = await import('jszip');

  const withWork = async (files, fn) => {
    const dir = mkdtempSync(join(tmpdir(), 'novel-docx-'));
    try {
      for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
      return await fn(dir);
    } finally {
      rmSync(dir, { recursive: true });
    }
  };

  describe('layoutMetrics', () => {
    test('既定はプレビューの既定と同じ A4横・30字', () => {
      const m = layoutMetrics(parseArgs([]));
      expect(m.layout).toMatchObject({ paper: 'A4', orientation: 'landscape', chars: 30 });
    });
    test('--size / --paper / --portrait / --margin をレイアウトにする', () => {
      const m = layoutMetrics(parseArgs(['--size', '42x34', '--paper', 'B5', '--portrait', '--margin', '10,11,12,13']));
      expect(m).toMatchObject({ chars: 42, lines: 34, paperW: 182, paperH: 257 });
      expect(m.layout.margin).toEqual({ top: 10, right: 11, bottom: 12, left: 13 });
    });
  });

  describe('mergeDocxLines', () => {
    test('章番号を付け、見出しで始まらないファイルの前に場面区切りを挟む', () =>
      withWork({ 'a.txt': '【旅立ち】\n一\n', 'b.txt': '続き\n', 'c.txt': '【】\n二\n' }, (dir) => {
        const files = ['a.txt', 'b.txt', 'c.txt'].map((f) => join(dir, f));
        expect(mergeDocxLines(files)).toEqual(['【1　旅立ち】', '一', '', '＊', '', '続き', '【2】', '二']);
      }));
    test('部の頭に改ページを入れ「部-章」で採番し、章で改ページしないなら章の境目に空行を入れる', () =>
      withWork({ 'a.txt': '【】\n一\n', 'b.txt': '【】\n二\n', 'c.txt': '【】\n三\n' }, (dir) => {
        const files = ['a.txt', 'b.txt', 'c.txt'].map((f) => join(dir, f));
        expect(mergeDocxLines(files, { partFirstIndices: [2], chapterBreak: false })).toEqual([
          '【1-1】',
          '一',
          '',
          '【1-2】',
          '二',
          PAGE_BREAK_LINE,
          '【2】',
          '三',
        ]);
      }));
    test('エピグラフを見出しの後ろへ移し、blankAfterHeading なら見出しの後に空行を補う', () =>
      withWork({ 'a.txt': 'Lead: 引用\n【】\n本文\n', 'b.txt': '【】\n二\n' }, (dir) => {
        const files = ['a.txt', 'b.txt'].map((f) => join(dir, f));
        expect(mergeDocxLines(files, { blankAfterHeading: true })).toEqual([
          '【1】',
          'Lead: 引用',
          '本文',
          '【2】',
          '',
          '二',
        ]);
      }));
  });

  describe('main', () => {
    const documentOf = async (path) =>
      (await JSZip.loadAsync(readFileSync(path))).file('word/document.xml').async('string');

    test('表紙・梗概を番号なしのセクションに置き、用紙・余白・字詰めをレイアウトどおりにする', () =>
      withWork(
        { '010.txt': '【】\n|漢字《かんじ》の本文\n', '020.txt': '【】\n二章\n', 'synopsis.txt': '梗概の本文\n' },
        async (dir) => {
          const out = join(dir, 'out.docx');
          await main(['-o', out, '--title', '題', '--author', '著者', '--size', '42x34', dir]);
          const xml = await documentOf(out);
          const [front, body] = xml.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/g);
          expect(front).not.toContain('w:footerReference');
          expect(body).toContain('<w:pgNumType w:start="1"/>');
          expect(body).toContain('<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>');
          expect(body).toMatch(/<w:pgMar w:top="1134" w:right="1134" w:bottom="1417" w:left="1134"/);
          expect(xml.indexOf('梗概の本文')).toBeLessThan(xml.indexOf('<w:pPr><w:sectPr'));
          expect(xml).toContain('<w:rt>');
          expect(xml.match(/<w:br w:type="page"\/>/g)).toHaveLength(2);
        },
      ));
    test('--coverless --no-synopsis なら前付を作らず、本文の頭にタイトルを出す', () =>
      withWork({ '010.txt': '本文\n', 'synopsis.txt': '梗概\n' }, async (dir) => {
        const out = join(dir, 'out.docx');
        await main(['-o', out, '--title', '題', '--coverless', '--no-synopsis', dir]);
        const xml = await documentOf(out);
        expect(xml.match(/<w:sectPr/g)).toHaveLength(1);
        expect(xml).not.toContain('梗概');
        expect(xml.indexOf('題')).toBeLessThan(xml.indexOf('本文'));
      }));
  });
}
