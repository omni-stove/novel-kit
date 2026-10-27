#!/usr/bin/env node

/**
 * txtファイルを文庫本見開きレイアウトの縦書きPDFに変換するスクリプト
 *
 * 使い方:
 *   novel novel-pdf -o output.pdf file1.txt file2.txt ...
 *   novel novel-pdf -o output.pdf ./directory/
 *
 * オプション:
 *   -o, --output <file>  出力ファイル名（必須）
 *   --title <title>      タイトル
 *   --author <author>    著者名
 *   --a6                 A6・文庫本（40字×17行。デフォルト）
 *   --shinsho            新書判・新書（42字×16行）
 *   --shiroku            四六判・文芸の単行本（42字×18行）
 *   --b6                 B6・ソフトカバーの単行本（42字×17行）
 *   --a5                 A5・同人誌・大判の本（45字×20行）
 *   --dark               ダークモード（黒背景・白文字）
 *   --open               生成後にプレビューを開く
 *   --no-chapter-break   章ごとに改ページせず、空行を1行空けて続ける
 *   --blank-after-heading 章見出し（視点行）と本文の間に空行を1行補う（既定: 補わない）
 *   --scene-break <記号>  場面区切り（* の行）とファイルの継ぎ目に組む記号（既定: ＊）
 *   --scene-break-indent <字数>  区切りの行を中央でなく行頭から字数分下げて置く（既定: 中央）
 *
 * 判型ごとに字数×行数が決まっていて（src/layout.mjs の TRIM_SIZES）、文字サイズと行送りはそこから決まる。
 * 挿絵の注記（［＃挿絵（images/a.png）入る］）の画像は、1ページに1枚、版面に収まる大きさで組む。
 */

import { execSync } from 'node:child_process';
import { readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { PDFDocument, PDFName, rgb, StandardFonts } from 'pdf-lib';
import { TRIM_SIZES, trimMetrics } from './layout.mjs';
import { ARG, buildPdfFromHtml, openFile, parseCliArgs, requireOutput, runMain } from './lib/cli.mjs';
import { AOZORA_CSS, googleFontsLinks, imageDataUri, separatorPlacementCss, VERTICAL_GLYPH_CSS } from './lib/html.mjs';
import { logSections, parseWithSectionNumbering, requireInputFiles, startsNewChapter } from './lib/manuscript.mjs';
import { escapeHtml, parseTextFile, SCENE_BREAK_MARK } from './lib/text-parser.mjs';

function mmToPt(mm) {
  return (mm * 72) / 25.4;
}

export function parseArgs(argv) {
  return parseCliArgs(
    argv,
    [
      ARG.output,
      ARG.title,
      ARG.author,
      ...Object.keys(TRIM_SIZES).map((key) => ({ key: 'pageSize', flags: [`--${key}`], value: key })),
      { key: 'dark', flags: ['--dark'] },
      ARG.open,
      { key: 'chapterBreak', flags: ['--no-chapter-break'], value: false },
      { key: 'blankAfterHeading', flags: ['--blank-after-heading'] },
      ARG.sceneBreak,
      ARG.sceneBreakIndent,
    ],
    { pageSize: 'a6', chapterBreak: true, sceneBreak: SCENE_BREAK_MARK },
  );
}

function generateHtml(sections, size, options) {
  const m = { top: size.margin.top, bottom: size.margin.bottom, left: size.margin.side, right: size.margin.side };

  const sectionHtmls = sections.map((s, i) => {
    const newChapter = startsNewChapter(sections, i);
    const needsPageBreak = newChapter && options.chapterBreak !== false;
    const className = needsPageBreak ? 'section page-break' : 'section';
    let lead = '';
    if (!newChapter) lead = `<p class="separator">${escapeHtml(options.sceneBreak)}</p>\n`;
    else if (i > 0 && !needsPageBreak) lead = '<p class="empty">&nbsp;</p>\n';

    let html = s.html;
    if (newChapter) {
      html = html.replace(/^(<p class="empty">&nbsp;<\/p>\n)+/, '');
    }

    return `<div class="${className}">\n${lead}${html}\n</div>`;
  });

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
${googleFontsLinks('Noto+Serif+JP:wght@400')}
  <style>
    @page {
      size: ${size.width}mm ${size.height}mm;
      margin: ${m.top}mm ${m.right}mm ${m.bottom}mm ${m.left}mm;${
        options.dark
          ? `
      background: #1a1a1a;`
          : ''
      }
    }
${
  options.dark
    ? `
    html {
      background: #1a1a1a;
    }
`
    : ''
}
    body {
      font-family: "Noto Serif JP", "游明朝", "Yu Mincho", "Hiragino Mincho Pro", serif;
      font-size: ${size.fontSizePt}pt;
      line-height: ${size.lineHeight};
      writing-mode: vertical-rl;
      text-orientation: upright;
      hanging-punctuation: allow-end last;${
        options.dark
          ? `
      color: #d4d4d4;`
          : ''
      }
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
      break-after: avoid;
    }

    p.separator {
      ${separatorPlacementCss(options.sceneBreakIndent)}
    }

    .separator-block {
      break-inside: avoid;
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
    }
    .epigraph-page .epigraph-source {
      text-indent: 0;
      text-align: end;
      height: ${size.height - m.top - m.bottom}mm;
    }

    .dash {
      text-orientation: sideways;
    }

    .illust {
      break-before: page;
      break-after: page;
      display: flex;
      align-items: center;
      justify-content: center;
      width: ${size.width - m.left - m.right}mm;
      /* 版面の高さちょうどだと丸めで次のページにあふれて白紙のページができるため */
      height: ${size.height - m.top - m.bottom - 1}mm;
      text-indent: 0;
    }
    .illust img {
      max-width: 100%;
      max-height: 100%;
    }
${VERTICAL_GLYPH_CSS}${AOZORA_CSS}
    .title-page {
      display: flex;
      align-items: center;
      justify-content: center;
      page-break-after: always;
      height: 100%;
    }

    .title-blank {
      page-break-after: always;
      height: 100%;
    }

    .title-page h1 {
      font-size: 16pt;
      font-weight: normal;
      margin: 0;
    }

    .title-page .author {
      font-size: 10pt;
      margin-top: 2em;
    }
  </style>
</head>
<body>
${options.title ? `<div class="title-page"><h1>${options.title}</h1>${options.author ? `<p class="author">${options.author}</p>` : ''}</div><div class="title-blank"></div>` : ''}
${sectionHtmls.join('\n')}
</body>
</html>`;
}

async function createSpreadPdf(singlePageBuffer, size, { titlePages = 0, dark = false } = {}) {
  const singleDoc = await PDFDocument.load(singlePageBuffer);
  const pageCount = singleDoc.getPageCount();
  const spreadDoc = await PDFDocument.create();

  const pageW = mmToPt(size.width);
  const pageH = mmToPt(size.height);
  const spreadW = pageW * 2;

  const font = await spreadDoc.embedFont(StandardFonts.Helvetica);
  const fontSize = 7;
  const numY = mmToPt(5);
  const numMargin = mmToPt(8);
  const numColor = dark ? rgb(0.6, 0.6, 0.6) : rgb(0.4, 0.4, 0.4);
  const lineOpacity = dark ? 0.3 : 0.15;

  // 1ページずつ embed するとフォントリソースがページごとに重複するため、全ページを一括で embed する
  const allPages = singleDoc.getPages();
  const embeddedPages = await spreadDoc.embedPages(allPages);

  for (let i = 0; i < pageCount; i += 2) {
    const spreadPage = spreadDoc.addPage([spreadW, pageH]);

    if (dark) {
      spreadPage.drawRectangle({
        x: 0,
        y: 0,
        width: spreadW,
        height: pageH,
        color: rgb(0.102, 0.102, 0.102),
      });
    }

    spreadPage.drawPage(embeddedPages[i], { x: pageW, y: 0 });

    const isTitleSpread = i < titlePages;

    if (!isTitleSpread) {
      const rightNum = String(i + 1 - titlePages);
      const rightNumW = font.widthOfTextAtSize(rightNum, fontSize);
      spreadPage.drawText(rightNum, {
        x: spreadW - numMargin - rightNumW,
        y: numY,
        size: fontSize,
        font,
        color: numColor,
      });
    }

    if (i + 1 < pageCount) {
      spreadPage.drawPage(embeddedPages[i + 1], { x: 0, y: 0 });

      if (!isTitleSpread) {
        const leftNum = String(i + 2 - titlePages);
        spreadPage.drawText(leftNum, {
          x: numMargin,
          y: numY,
          size: fontSize,
          font,
          color: numColor,
        });
      }
    }

    spreadPage.drawLine({
      start: { x: pageW, y: 0 },
      end: { x: pageW, y: pageH },
      thickness: 0.5,
      opacity: lineOpacity,
    });
  }

  spreadDoc.catalog.set(PDFName.of('PageLayout'), PDFName.of('SinglePage'));

  return spreadDoc.save();
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  requireOutput(args, 'output.pdf');

  const size = trimMetrics(args.pageSize);
  console.log(`判型: ${size.name}・${size.use} (${size.width}×${size.height}mm) 見開き`);
  console.log(`${size.chars}字×${size.lines}行/頁・文字 ${size.fontSizePt}pt\n`);

  const inputFiles = requireInputFiles(args.files);

  const sections = parseWithSectionNumbering(inputFiles, parseTextFile, {
    blankAfterHeading: args.blankAfterHeading,
    sceneBreak: args.sceneBreak,
    illustSrc: imageDataUri,
  });
  const totalChars = logSections(sections, inputFiles);

  const html = generateHtml(sections, size, args);

  const singlePdfPath = args.output.replace(/\.pdf$/, '-single.pdf');
  console.log('\n単ページPDF生成中...');
  const htmlPath = buildPdfFromHtml(html, singlePdfPath);

  const singlePageBuffer = readFileSync(singlePdfPath);
  const singleDoc = await PDFDocument.load(singlePageBuffer);
  const singlePageCount = singleDoc.getPageCount();
  const singleSize = statSync(singlePdfPath).size;
  console.log(`単ページPDF: ${(singleSize / 1024 / 1024).toFixed(1)}MB (${singlePageCount}頁)`);

  console.log('見開きPDF合成中...');
  const spreadBuffer = await createSpreadPdf(singlePageBuffer, size, {
    titlePages: args.title ? 2 : 0,
    dark: args.dark,
  });
  const rawPath = args.output.replace(/\.pdf$/, '-raw.pdf');
  writeFileSync(rawPath, spreadBuffer);
  const rawSize = statSync(rawPath).size;
  console.log(`見開き(raw): ${(rawSize / 1024 / 1024).toFixed(1)}MB`);

  // 合成後の PDF に残るフォントの重複を除くため、Ghostscript で圧縮し直す
  console.log('PDF圧縮中...');
  execSync(
    `gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dNOPAUSE -dBATCH -dQUIET -dSubsetFonts=true -dCompressFonts=true -sOutputFile="${args.output}" "${rawPath}"`,
    { stdio: 'inherit' },
  );
  const finalSize = statSync(args.output).size;
  console.log(`圧縮後: ${(finalSize / 1024 / 1024).toFixed(1)}MB`);

  unlinkSync(rawPath);
  unlinkSync(singlePdfPath);
  unlinkSync(htmlPath);

  const spreadDoc = await PDFDocument.load(spreadBuffer);
  const spreadCount = spreadDoc.getPageCount();
  const charsPerPage = Math.round(totalChars / singlePageCount);

  console.log(`\nPDF出力: ${args.output}`);
  console.log(`文字数: ${totalChars.toLocaleString()}字`);
  console.log(`単ページ: ${singlePageCount}頁 → 見開き: ${spreadCount}枚`);
  console.log(`平均: ${charsPerPage.toLocaleString()}字/頁`);

  if (args.open) {
    openFile(args.output);
  }
}

runMain(import.meta.url, main);

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest;

  describe('parseArgs', () => {
    test('既定は A6 文庫本・場面区切りは ＊', () => {
      expect(parseArgs(['-o', 'out.pdf', 'a.txt', 'dir/'])).toMatchObject({
        output: 'out.pdf',
        pageSize: 'a6',
        sceneBreak: '＊',
        dark: false,
        open: false,
        chapterBreak: true,
        blankAfterHeading: false,
        title: null,
        author: null,
        files: ['a.txt', 'dir/'],
      });
    });
    test('判型フラグで TRIM_SIZES のキーを選ぶ', () => {
      expect(parseArgs(['--shiroku']).pageSize).toBe('shiroku');
      expect(parseArgs(['--a5']).pageSize).toBe('a5');
      expect(parseArgs(['--a5', '--a6']).pageSize).toBe('a6');
    });
    test('値付きオプションとフラグを解釈する', () => {
      expect(
        parseArgs([
          '--output=o.pdf',
          '--title',
          'T',
          '--author',
          'A',
          '--dark',
          '--open',
          '--no-chapter-break',
          '--blank-after-heading',
          '--scene-break',
          '◆◆◆',
        ]),
      ).toMatchObject({
        output: 'o.pdf',
        title: 'T',
        author: 'A',
        dark: true,
        open: true,
        chapterBreak: false,
        blankAfterHeading: true,
        sceneBreak: '◆◆◆',
      });
    });
  });
}
