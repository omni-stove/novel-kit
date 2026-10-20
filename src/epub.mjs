#!/usr/bin/env node

/**
 * txtファイルをEPUB形式に変換するスクリプト
 * Kindle、Apple Books、Koboなどの電子書籍リーダーで読める形式
 *
 * 使い方:
 *   novel epub -o output.epub file1.txt file2.txt ...
 *   novel epub -o output.epub ./directory/
 *
 * オプション:
 *   -o, --output <file>   出力ファイル名（必須）
 *   --title <text>        書籍タイトル（デフォルト: ファイル名）
 *   --author <text>       著者名
 *   --horizontal          横書きモード（デフォルトは縦書き）
 */

import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join, basename, resolve } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import { parseTextFileForEpub } from './lib/text-parser.mjs';
import { parseWithSectionNumbering, requireInputFiles, logSections, startsNewChapter, FILE_SEPARATOR_MARK } from './lib/manuscript.mjs';
import { parseCliArgs, ARG, requireOutput, runMain } from './lib/cli.mjs';

function parseArgs(argv) {
  return parseCliArgs(argv, [
    ARG.output,
    ARG.title,
    ARG.author,
    { key: 'vertical', flags: ['--horizontal'], value: false },
  ], { vertical: true });
}
function generateStyleCss(vertical) {
  const writingMode = vertical ? 'vertical-rl' : 'horizontal-tb';

  return `@charset "UTF-8";

body {
  font-family: "Hiragino Mincho ProN", "游明朝", "Yu Mincho", "Noto Serif JP", serif;
  font-size: 1em;
  line-height: 1.8;
  writing-mode: ${writingMode};
  -webkit-writing-mode: ${writingMode};
  -epub-writing-mode: ${writingMode};
  ${vertical ? 'text-orientation: upright;\n  -webkit-text-orientation: upright;\n  -epub-text-orientation: upright;' : ''}
  margin: 0;
  padding: 0;
}

p {
  margin: 0;
}

p.separator {
  text-align: center;
  text-indent: 0;
  margin-block-start: 1.5em;
  margin-block-end: 1.5em;
}

p.viewpoint {
  text-align: start;
  text-indent: 0;
}


.dash {
  ${vertical ? 'text-orientation: sideways;\n  -webkit-text-orientation: sideways;' : ''}
}

.ellipsis {
  ${vertical ? 'text-orientation: sideways;\n  -webkit-text-orientation: sideways;' : ''}
}

.wave-dash {
  ${vertical ? 'text-orientation: sideways;\n  -webkit-text-orientation: sideways;' : ''}
}

.latin {
  ${vertical ? 'text-combine-upright: all;\n  -webkit-text-combine: horizontal;' : ''}
}

.upright {
  ${vertical ? 'text-combine-upright: all;\n  -webkit-text-combine: horizontal;' : ''}
}

.tcy {
  ${vertical ? 'text-combine-upright: all;\n  -webkit-text-combine: horizontal;\n  text-orientation: mixed;' : ''}
}

.emphasis {
  -webkit-text-emphasis: filled sesame;
  text-emphasis: filled sesame;
  -webkit-text-emphasis-position: over right;
  text-emphasis-position: over right;
}

ruby {
  ruby-align: center;
  ruby-position: over;
  -webkit-ruby-position: before;
}

rt {
  font-size: 0.5em;
  line-height: 1;
}

.epigraph {
  text-indent: 0;
  margin-block-start: 1em;
  margin-block-end: 2em;
  font-size: 0.85em;
  opacity: 0.7;
  display: flex;
  flex-direction: column;
  min-block-size: 100%;
}
.epigraph .epigraph-quote {
  text-indent: 0;
  text-align: end;
}
.epigraph .epigraph-source {
  text-indent: 0;
  text-align: end;
  margin-block-start: auto;
}

h1.chapter-title {
  font-size: 1.5em;
  font-weight: normal;
  text-align: center;
  text-indent: 0;
  margin: 3em 0;
  page-break-after: avoid;
}

div.title-page {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  text-align: center;
}

div.title-page h1 {
  font-size: 2em;
  font-weight: normal;
  text-indent: 0;
}

div.title-page p.author {
  font-size: 1em;
  text-indent: 0;
  margin-top: 2em;
}
`;
}

function generateChapterXhtml(chapterContent, chapterTitle, chapterIndex) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="ja" lang="ja">
<head>
  <meta charset="UTF-8" />
  <title>${chapterTitle || `Chapter ${chapterIndex + 1}`}</title>
  <link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
${chapterContent}
</body>
</html>`;
}

function generateTitlePageXhtml(title, author) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="ja" lang="ja">
<head>
  <meta charset="UTF-8" />
  <title>${title}</title>
  <link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
  <div class="title-page">
    <div>
      <h1>${title}</h1>
${author ? `      <p class="author">${author}</p>` : ''}
    </div>
  </div>
</body>
</html>`;
}

function generateContainerXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" />
  </rootfiles>
</container>`;
}

function generateContentOpf(bookId, title, author, chapters, hasTitle, vertical) {
  const direction = vertical ? 'rtl' : 'ltr';
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const manifestItems = [];
  const spineItems = [];

  manifestItems.push('    <item id="style" href="style.css" media-type="text/css" />');

  if (hasTitle) {
    manifestItems.push('    <item id="titlepage" href="titlepage.xhtml" media-type="application/xhtml+xml" />');
    spineItems.push('    <itemref idref="titlepage" />');
  }

  for (let i = 0; i < chapters.length; i++) {
    const id = `chapter-${String(i + 1).padStart(3, '0')}`;
    manifestItems.push(`    <item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml" />`);
    spineItems.push(`    <itemref idref="${id}" />`);
  }

  manifestItems.push('    <item id="toc" href="toc.xhtml" media-type="application/xhtml+xml" properties="nav" />');

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId" xml:lang="ja" dir="${direction}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="BookId">urn:uuid:${bookId}</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:language>ja</dc:language>
${author ? `    <dc:creator id="creator">${author}</dc:creator>\n    <meta refines="#creator" property="role" scheme="marc:relators">aut</meta>\n    <meta refines="#creator" property="file-as">${author}</meta>` : ''}
    <meta property="dcterms:modified">${now}</meta>
    <meta property="rendition:layout">reflowable</meta>
    <meta property="rendition:spread">none</meta>
  </metadata>
  <manifest>
${manifestItems.join('\n')}
  </manifest>
  <spine page-progression-direction="${direction}">
${spineItems.join('\n')}
  </spine>
</package>`;
}

function generateTocXhtml(chapters, hasTitle) {
  const navItems = [];

  if (hasTitle) {
    navItems.push('      <li><a href="titlepage.xhtml">表紙</a></li>');
  }

  for (let i = 0; i < chapters.length; i++) {
    const id = `chapter-${String(i + 1).padStart(3, '0')}`;
    const title = chapters[i].title;
    navItems.push(`      <li><a href="${id}.xhtml">${title}</a></li>`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="ja" lang="ja">
<head>
  <meta charset="UTF-8" />
  <title>目次</title>
</head>
<body>
  <nav epub:type="toc">
    <h1>目次</h1>
    <ol>
${navItems.join('\n')}
    </ol>
  </nav>
</body>
</html>`;
}

// 1章を1つのxhtmlにする（目次と改ページの単位）。章題のない章の目次名はファイル名で代用する
export function groupIntoChapters(sections, fileNames, bookTitle) {
  const chapters = [];
  sections.forEach((section, i) => {
    if (startsNewChapter(sections, i)) {
      chapters.push({ xhtml: section.xhtml, title: section.chapterTitle, fileNames: [fileNames[i]] });
      return;
    }
    const chapter = chapters[chapters.length - 1];
    chapter.xhtml += `\n<p class="separator">${FILE_SEPARATOR_MARK}</p>\n${section.xhtml}`;
    chapter.fileNames.push(fileNames[i]);
  });

  chapters.forEach((chapter, i) => {
    if (chapter.title) return;
    chapter.title = chapters.length === 1 ? bookTitle : `${i + 1}. ${chapter.fileNames.join(', ')}`;
  });
  return chapters;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  requireOutput(args, 'output.epub');
  const inputFiles = requireInputFiles(args.files);

  const title = args.title || basename(args.output, '.epub');

  console.log(`入力ファイル: ${inputFiles.length}件`);

  const sections = parseWithSectionNumbering(inputFiles, parseTextFileForEpub);
  const totalChars = logSections(sections, inputFiles);

  const chapters = groupIntoChapters(sections, inputFiles.map(f => basename(f)), title);

  const tmpDir = mkdtempSync(join(tmpdir(), 'epub-'));
  const oebpsDir = join(tmpDir, 'OEBPS');
  const metaInfDir = join(tmpDir, 'META-INF');
  mkdirSync(oebpsDir);
  mkdirSync(metaInfDir);

  try {
    const bookId = randomUUID();
    const hasTitle = !!args.title;

    writeFileSync(join(tmpDir, 'mimetype'), 'application/epub+zip');
    writeFileSync(join(metaInfDir, 'container.xml'), generateContainerXml());
    writeFileSync(join(oebpsDir, 'style.css'), generateStyleCss(args.vertical));
    writeFileSync(join(oebpsDir, 'content.opf'), generateContentOpf(bookId, title, args.author, chapters, hasTitle, args.vertical));
    writeFileSync(join(oebpsDir, 'toc.xhtml'), generateTocXhtml(chapters, hasTitle));

    if (hasTitle) {
      writeFileSync(join(oebpsDir, 'titlepage.xhtml'), generateTitlePageXhtml(title, args.author));
    }

    for (let i = 0; i < chapters.length; i++) {
      const id = `chapter-${String(i + 1).padStart(3, '0')}`;
      const xhtml = generateChapterXhtml(chapters[i].xhtml, chapters[i].title, i);
      writeFileSync(join(oebpsDir, `${id}.xhtml`), xhtml);
    }

    const outputPath = resolve(args.output);
    execSync(`cd "${tmpDir}" && zip -0Xq "${outputPath}" mimetype && zip -rq "${outputPath}" META-INF OEBPS`);

    console.log(`\nEPUB出力: ${args.output}`);
    console.log(`文字数: ${totalChars.toLocaleString()}字`);
    console.log(`章数: ${chapters.length}章`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

runMain(import.meta.url, main);

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest;
  const section = (xhtml, opts = {}) => ({ xhtml, chapterTitle: null, hasViewpointStart: false, hasViewpointEnd: false, ...opts });

  describe('groupIntoChapters', () => {
    test('章の途中で切れたファイルは◇◇◇を挟んで前の章のxhtmlにつなぐ', () => {
      const chapters = groupIntoChapters(
        [section('<p>一</p>', { hasViewpointStart: true, chapterTitle: '1　朝' }), section('<p>続き</p>')],
        ['010.txt', '020.txt'],
        '本',
      );
      expect(chapters).toEqual([{
        xhtml: '<p>一</p>\n<p class="separator">◇◇◇</p>\n<p>続き</p>',
        title: '1　朝',
        fileNames: ['010.txt', '020.txt'],
      }]);
    });
    test('視点行で始まるファイルと、前のファイルが【】で終わるファイルから新しい章にする', () => {
      const chapters = groupIntoChapters(
        [section('a', { hasViewpointEnd: true }), section('b'), section('c', { hasViewpointStart: true, chapterTitle: '3' })],
        ['010.txt', '020.txt', '030.txt'],
        '本',
      );
      expect(chapters.map(ch => ch.xhtml)).toEqual(['a', 'b', 'c']);
    });
    test('章題のない章の目次名は、1章だけなら書名、複数章なら「番号. ファイル名」', () => {
      expect(groupIntoChapters([section('a')], ['010.txt'], '本')[0].title).toBe('本');
      const chapters = groupIntoChapters(
        [section('a', { hasViewpointEnd: true }), section('b'), section('c')],
        ['010.txt', '020.txt', '030.txt'],
        '本',
      );
      expect(chapters.map(ch => ch.title)).toEqual(['1. 010.txt', '2. 020.txt, 030.txt']);
    });
  });
}
