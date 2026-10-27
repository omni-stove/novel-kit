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
 *   --no-chapter-break    章ごとに改ページ（xhtml を分ける）せず、空行を1行空けて続ける
 *   --blank-after-heading 章見出し（視点行）と本文の間に空行を1行補う（既定: 補わない）
 *   --scene-break <記号>  場面区切り（* の行）とファイルの継ぎ目に組む記号（既定: ＊）
 *   --scene-break-indent <字数>  区切りの行を中央でなく行頭から字数分下げて置く（既定: 中央）
 *
 * 挿絵の注記（［＃挿絵（images/a.png）入る］）の画像は OEBPS/images/ に入れ、1ページに1枚で組む。
 */

import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { ARG, parseCliArgs, requireOutput, runMain } from './lib/cli.mjs';
import { AOZORA_CSS, IMAGE_MEDIA_TYPES, requireImage, separatorPlacementCss } from './lib/html.mjs';
import { logSections, parseWithSectionNumbering, requireInputFiles, startsNewChapter } from './lib/manuscript.mjs';
import { escapeXml, parseTextFileForEpub, SCENE_BREAK_MARK } from './lib/text-parser.mjs';

/**
 * 挿絵の画像を EPUB に入れる名前で登録する。同じ画像は1つにまとめ、別のディレクトリの同名のファイルとぶつからないよう連番で名付ける。
 * hrefOf(絶対パス) は章の XHTML から見た href を返し、images は manifest と書き出しに使う { id, href, path, mediaType } の配列
 */
export function createImageRegistry() {
  const byPath = new Map();
  return {
    images: () => [...byPath.values()],
    hrefOf(path) {
      let image = byPath.get(path);
      if (!image) {
        requireImage(path);
        const ext = extname(path).toLowerCase();
        const id = `image-${String(byPath.size + 1).padStart(3, '0')}`;
        image = { id, href: `images/${id}${ext}`, path, mediaType: IMAGE_MEDIA_TYPES[ext] };
        byPath.set(path, image);
      }
      return image.href;
    },
  };
}

export function parseArgs(argv) {
  return parseCliArgs(
    argv,
    [
      ARG.output,
      ARG.title,
      ARG.author,
      { key: 'vertical', flags: ['--horizontal'], value: false },
      { key: 'chapterBreak', flags: ['--no-chapter-break'], value: false },
      { key: 'blankAfterHeading', flags: ['--blank-after-heading'] },
      ARG.sceneBreak,
      ARG.sceneBreakIndent,
    ],
    { vertical: true, chapterBreak: true, sceneBreak: SCENE_BREAK_MARK },
  );
}
function generateStyleCss(vertical, sceneBreakIndent = null) {
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
  ${separatorPlacementCss(sceneBreakIndent)}
  margin-block-start: 1.5em;
  margin-block-end: 1.5em;
}

p.viewpoint {
  text-align: start;
  text-indent: 0;
}
${AOZORA_CSS}

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

ruby.left-ruby {
  ruby-position: under;
  -webkit-ruby-position: after;
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

div.illust {
  page-break-before: always;
  page-break-after: always;
  break-before: page;
  break-after: page;
  text-align: center;
  text-indent: 0;
}

div.illust img {
  max-width: 100%;
  max-height: 100vh;
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

function generateContentOpf(bookId, title, author, files, hasTitle, vertical, images = []) {
  const direction = vertical ? 'rtl' : 'ltr';
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const manifestItems = [];
  const spineItems = [];

  manifestItems.push('    <item id="style" href="style.css" media-type="text/css" />');

  if (hasTitle) {
    manifestItems.push('    <item id="titlepage" href="titlepage.xhtml" media-type="application/xhtml+xml" />');
    spineItems.push('    <itemref idref="titlepage" />');
  }

  for (const { id } of files) {
    manifestItems.push(`    <item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml" />`);
    spineItems.push(`    <itemref idref="${id}" />`);
  }

  manifestItems.push('    <item id="toc" href="toc.xhtml" media-type="application/xhtml+xml" properties="nav" />');
  for (const image of images) {
    manifestItems.push(`    <item id="${image.id}" href="${image.href}" media-type="${image.mediaType}" />`);
  }

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

function generateTocXhtml(tocItems, hasTitle) {
  const navItems = [];

  if (hasTitle) {
    navItems.push('      <li><a href="titlepage.xhtml">表紙</a></li>');
  }

  for (const { href, title } of tocItems) {
    navItems.push(`      <li><a href="${href}">${title}</a></li>`);
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

/**
 * 1章を1つのxhtmlにする（目次と改ページの単位）。章題のない章の目次名は、章が1つなら書名、
 * 複数なら「番号. ファイル名」で代用する
 * sceneBreak: 章の途中で切れたファイルの継ぎ目に挟む記号（場面区切りと同じ）
 */
export function groupIntoChapters(sections, fileNames, bookTitle, sceneBreak = SCENE_BREAK_MARK) {
  const chapters = [];
  sections.forEach((section, i) => {
    if (startsNewChapter(sections, i)) {
      chapters.push({ xhtml: section.xhtml, title: section.chapterTitle, fileNames: [fileNames[i]] });
      return;
    }
    const chapter = chapters[chapters.length - 1];
    chapter.xhtml += `\n<p class="separator">${escapeXml(sceneBreak)}</p>\n${section.xhtml}`;
    chapter.fileNames.push(fileNames[i]);
  });

  chapters.forEach((chapter, i) => {
    if (chapter.title) return;
    chapter.title = chapters.length === 1 ? bookTitle : `${i + 1}. ${chapter.fileNames.join(', ')}`;
  });
  return chapters;
}

/**
 * 章を xhtml のファイルに割り当て、ファイル { id, title, xhtml } と目次の項目 { href, title } を返す。
 * chapterBreak なら1章1ファイル（リーダーはファイルの頭で改ページする）。false なら全章を1ファイルに入れ、
 * 章の間に空行を1行空けて、目次は各章の頭に付けた id へ飛ばす
 */
export function chapterFiles(chapters, { chapterBreak = true, bookTitle = '' } = {}) {
  const idOf = (i) => `chapter-${String(i + 1).padStart(3, '0')}`;
  if (chapterBreak) {
    return {
      files: chapters.map((ch, i) => ({ id: idOf(i), title: ch.title, xhtml: ch.xhtml })),
      toc: chapters.map((ch, i) => ({ href: `${idOf(i)}.xhtml`, title: ch.title })),
    };
  }
  const file = idOf(0);
  return {
    files: [
      {
        id: file,
        title: bookTitle,
        xhtml: chapters
          .map((ch, i) => `${i > 0 ? '<p><br /></p>\n' : ''}<section id="${idOf(i)}">\n${ch.xhtml}\n</section>`)
          .join('\n'),
      },
    ],
    toc: chapters.map((ch, i) => ({ href: `${file}.xhtml#${idOf(i)}`, title: ch.title })),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  requireOutput(args, 'output.epub');
  const inputFiles = requireInputFiles(args.files);

  const title = args.title || basename(args.output, '.epub');

  console.log(`入力ファイル: ${inputFiles.length}件`);

  const imageRegistry = createImageRegistry();
  const sections = parseWithSectionNumbering(inputFiles, parseTextFileForEpub, {
    sceneBreak: args.sceneBreak,
    blankAfterHeading: args.blankAfterHeading,
    illustSrc: imageRegistry.hrefOf,
  });
  const images = imageRegistry.images();
  const totalChars = logSections(sections, inputFiles);

  const chapters = groupIntoChapters(
    sections,
    inputFiles.map((f) => basename(f)),
    title,
    args.sceneBreak,
  );
  const { files, toc } = chapterFiles(chapters, { chapterBreak: args.chapterBreak, bookTitle: title });

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
    writeFileSync(join(oebpsDir, 'style.css'), generateStyleCss(args.vertical, args.sceneBreakIndent));
    writeFileSync(
      join(oebpsDir, 'content.opf'),
      generateContentOpf(bookId, title, args.author, files, hasTitle, args.vertical, images),
    );
    if (images.length > 0) mkdirSync(join(oebpsDir, 'images'));
    for (const image of images) copyFileSync(image.path, join(oebpsDir, image.href));
    writeFileSync(join(oebpsDir, 'toc.xhtml'), generateTocXhtml(toc, hasTitle));

    if (hasTitle) {
      writeFileSync(join(oebpsDir, 'titlepage.xhtml'), generateTitlePageXhtml(title, args.author));
    }

    files.forEach((file, i) => {
      writeFileSync(join(oebpsDir, `${file.id}.xhtml`), generateChapterXhtml(file.xhtml, file.title, i));
    });

    const outputPath = resolve(args.output);
    execSync(`cd "${tmpDir}" && zip -0Xq "${outputPath}" mimetype && zip -rq "${outputPath}" META-INF OEBPS`);

    console.log(`\nEPUB出力: ${args.output}`);
    console.log(`文字数: ${totalChars.toLocaleString()}字`);
    console.log(`章数: ${chapters.length}章`);
    if (images.length > 0) console.log(`挿絵: ${images.length}枚`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

runMain(import.meta.url, main);

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest;
  const section = (xhtml, opts = {}) => ({ xhtml, chapterTitle: null, hasViewpointStart: false, ...opts });

  describe('groupIntoChapters', () => {
    test('章の途中で切れたファイルは＊を挟んで前の章のxhtmlにつなぐ', () => {
      const chapters = groupIntoChapters(
        [section('<p>一</p>', { hasViewpointStart: true, chapterTitle: '1　朝' }), section('<p>続き</p>')],
        ['010.txt', '020.txt'],
        '本',
      );
      expect(chapters).toEqual([
        {
          xhtml: '<p>一</p>\n<p class="separator">＊</p>\n<p>続き</p>',
          title: '1　朝',
          fileNames: ['010.txt', '020.txt'],
        },
      ]);
    });
    test('【】の見出しで始まるファイルから新しい章にする', () => {
      const chapters = groupIntoChapters(
        [
          section('a'),
          section('b', { hasViewpointStart: true }),
          section('c', { hasViewpointStart: true, chapterTitle: '3' }),
        ],
        ['010.txt', '020.txt', '030.txt'],
        '本',
      );
      expect(chapters.map((ch) => ch.xhtml)).toEqual(['a', 'b', 'c']);
    });
    test('章題のない章の目次名は、1章だけなら書名、複数章なら「番号. ファイル名」', () => {
      expect(groupIntoChapters([section('a')], ['010.txt'], '本')[0].title).toBe('本');
      const chapters = groupIntoChapters(
        [section('a'), section('b', { hasViewpointStart: true }), section('c')],
        ['010.txt', '020.txt', '030.txt'],
        '本',
      );
      expect(chapters.map((ch) => ch.title)).toEqual(['1. 010.txt', '2. 020.txt, 030.txt']);
    });
    test('継ぎ目の記号は指定でき、XMLとしてエスケープする', () => {
      const chapters = groupIntoChapters([section('a'), section('b')], ['010.txt', '020.txt'], '本', '<*>');
      expect(chapters[0].xhtml).toBe('a\n<p class="separator">&lt;*&gt;</p>\nb');
    });
  });

  describe('chapterFiles', () => {
    const chapters = [
      { xhtml: 'a', title: '1' },
      { xhtml: 'b', title: '2' },
    ];
    test('既定は1章1ファイルで、目次はファイルへ飛ばす', () => {
      expect(chapterFiles(chapters)).toEqual({
        files: [
          { id: 'chapter-001', title: '1', xhtml: 'a' },
          { id: 'chapter-002', title: '2', xhtml: 'b' },
        ],
        toc: [
          { href: 'chapter-001.xhtml', title: '1' },
          { href: 'chapter-002.xhtml', title: '2' },
        ],
      });
    });
    test('chapterBreak: false なら1ファイルに空行を挟んでつなぎ、目次は章の頭の id へ飛ばす', () => {
      expect(chapterFiles(chapters, { chapterBreak: false, bookTitle: '本' })).toEqual({
        files: [
          {
            id: 'chapter-001',
            title: '本',
            xhtml:
              '<section id="chapter-001">\na\n</section>\n<p><br /></p>\n<section id="chapter-002">\nb\n</section>',
          },
        ],
        toc: [
          { href: 'chapter-001.xhtml#chapter-001', title: '1' },
          { href: 'chapter-001.xhtml#chapter-002', title: '2' },
        ],
      });
    });
  });

  describe('createImageRegistry', () => {
    test('同じ画像は1つにまとめ、同名の別の画像は連番で分ける', () => {
      const dir = mkdtempSync(join(tmpdir(), 'epub-test-'));
      try {
        for (const sub of ['a', 'b']) {
          mkdirSync(join(dir, sub));
          writeFileSync(join(dir, sub, 'fig.PNG'), '');
        }
        const registry = createImageRegistry();
        expect(registry.hrefOf(join(dir, 'a', 'fig.PNG'))).toBe('images/image-001.png');
        expect(registry.hrefOf(join(dir, 'b', 'fig.PNG'))).toBe('images/image-002.png');
        expect(registry.hrefOf(join(dir, 'a', 'fig.PNG'))).toBe('images/image-001.png');
        expect(registry.images().map((image) => image.mediaType)).toEqual(['image/png', 'image/png']);
        expect(() => registry.hrefOf(join(dir, 'none.png'))).toThrow('挿絵の画像が見つかりません');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('parseArgs', () => {
    test('既定は縦書き・場面区切り ＊、--horizontal で横書き', () => {
      expect(parseArgs(['-o', 'out.epub', 'a.txt'])).toEqual({
        files: ['a.txt'],
        output: 'out.epub',
        title: null,
        author: null,
        vertical: true,
        chapterBreak: true,
        blankAfterHeading: false,
        sceneBreak: '＊',
        sceneBreakIndent: null,
      });
      expect(parseArgs(['--horizontal']).vertical).toBe(false);
      expect(parseArgs(['--no-chapter-break', '--blank-after-heading'])).toMatchObject({
        chapterBreak: false,
        blankAfterHeading: true,
      });
    });
    test('--output・--title・--author・--scene-break を読む', () => {
      expect(
        parseArgs(['--output=o.epub', '--title', '書名', '--author', '著者', '--scene-break', '◆◆◆', 'dir/']),
      ).toMatchObject({ files: ['dir/'], output: 'o.epub', title: '書名', author: '著者', sceneBreak: '◆◆◆' });
    });
  });
}
