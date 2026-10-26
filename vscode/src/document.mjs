/**
 * 原稿テキストからプレビュー用の HTML/CSS と文字数統計を作る（vscode API に依存しない）。
 * 組版は PDF 出力と同じ src/lib のパーサと、日本語は src/pdf.mjs、
 * 英語は src/en-pdf.mjs の generateHtml を使う。
 */

import { basename, dirname } from 'node:path';
import { buildChapters, generateHtml as generateEnglishHtml, parseEnglishLines } from '../../src/en-pdf.mjs';
import { computeMetrics, detectLanguage } from '../../src/layout.mjs';
import {
  CHARACTERS_FILENAME,
  computeSectionLabels,
  countGenkoRows,
  getTextFilesFromDir,
  matchPartIndices,
  SYNOPSIS_FILENAME,
  startsNewChapter,
} from '../../src/lib/manuscript.mjs';
import {
  isMetaLine,
  isViewpointLine,
  parseTextLines,
  parseViewpointLine,
  readLines,
} from '../../src/lib/text-parser.mjs';
import { generateHtml } from '../../src/pdf.mjs';
import { t } from './l10n.mjs';

/** 原稿の行列から組版の言語（'ja' / 'en'）を判定する（メタ行は数えない） */
export const detectLanguageOfLines = (lines) => detectLanguage(lines, isMetaLine);

/** filePath と同じディレクトリの本文ファイル（PDF出力と同じ並び。梗概・人物紹介は除く）。読めなければ空配列 */
export function listWorkFiles(filePath) {
  try {
    return getTextFilesFromDir(dirname(filePath), [SYNOPSIS_FILENAME, CHARACTERS_FILENAME]);
  } catch {
    return [];
  }
}

/**
 * 部の境界（novel.json の parts）を作品のファイル（workFiles）の添字にする。PDF 出力と同じく、日本語は novel pdf、
 * 英語は novel pdf-en の解釈（英語は、まだ訳していないファイルの番号を飛ばす）。
 * 返す値: 新しい部が始まるファイルの添字（先頭のファイルは含めない）。parts が無ければ null
 */
function partStartIndices(workFiles, parts, language) {
  if (!parts) return null;
  const tokens =
    language === 'en' ? parts.filter((tok) => workFiles.some((f) => basename(f).match(/^\d+/)?.[0] === tok)) : parts;
  return matchPartIndices(tokens, workFiles).indices.filter((i) => i > 0);
}

/** CSS から @page ブロックを取り除く（名前付き・マージンボックスの入れ子も含む） */
function stripPageRules(css) {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf('@page', i);
    if (at < 0) {
      out += css.slice(i);
      break;
    }
    out += css.slice(i, at);
    const open = css.indexOf('{', at);
    if (open < 0) break;
    let depth = 0;
    let j = open;
    for (; j < css.length; j++) {
      if (css[j] === '{') depth++;
      if (css[j] === '}' && --depth === 0) break;
    }
    i = j + 1;
  }
  return out;
}

/**
 * generateHtml が返す PDF 用の文書から、webview に差し込むスタイルと本文 { css, body } を取り出す。
 * スタイルは CSS ネストで #flow の内側に閉じ込め（body の規則は #flow 自身に付け替える）、
 * @page は捨てる（ページ寸法は webview 側で再現する）
 */
function splitGeneratedHtml(html) {
  const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
  const body = html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? '';
  const scoped = stripPageRules(style.replace(/\/\*[\s\S]*?\*\//g, '')).replace(/^(\s*)body\s*\{/m, '$1& {');
  return { css: `#flow {\n${scoped}\n}`, body: body.trim() };
}

/**
 * 文字数統計。英語は { language: 'en', words: 語数（空白区切り）, chars: 文字数（空白を除く） }。
 * 日本語は { language: 'ja', chars: 文字数, genkoPages: 400字詰め原稿用紙換算,
 * gridPages: 現在のレイアウトでの連続換算（改ページを含まない） }
 */
export function computeStats(fileLines, metrics) {
  if (metrics.language === 'en') {
    let words = 0;
    let chars = 0;
    for (const lines of fileLines) {
      for (const block of parseEnglishLines(lines).blocks) {
        if (block.type !== 'para') continue;
        words += block.text.split(/\s+/).filter(Boolean).length;
        chars += block.text.replace(/\s/g, '').length;
      }
    }
    return { language: 'en', words, chars };
  }

  let chars = 0;
  let genkoRows = 0;
  let gridRows = 0;
  for (const lines of fileLines) {
    const genko = countGenkoRows(lines, 20);
    chars += genko.chars;
    genkoRows += genko.rows;
    gridRows += countGenkoRows(lines, metrics.chars).rows;
  }
  return {
    language: 'ja',
    chars,
    genkoPages: genkoRows / 20,
    gridPages: gridRows / metrics.lines,
  };
}

/**
 * 英語組版（en-pdf.mjs）の HTML。ファイルは章にまとめられるので、段落は data-file でファイルを指す。
 * partStarts: 新しい部が始まるファイルの添字（null なら部に分けない）
 */
function buildEnglishHtml(fileLines, metrics, sceneBreak, partStarts) {
  const m = metrics.layout.margin;
  const chapters = buildChapters(
    fileLines.map((lines) => parseEnglishLines(lines)),
    partStarts && [0, ...partStarts],
  );
  return generateEnglishHtml(
    chapters,
    {
      width: `${metrics.paperW}mm`,
      height: `${metrics.paperH}mm`,
      fontSize: `${metrics.fontSizePt}pt`,
      lineHeight: String(metrics.lineHeight),
      // プレビューは単ページなので、見開きの内側の余白を左、外側を右に当てる
      margin: { top: `${m.top}mm`, bottom: `${m.bottom}mm`, inner: `${m.left}mm`, outer: `${m.right}mm` },
    },
    { smartQuotes: true, lineNumbers: true, sceneBreak },
  );
}

/**
 * scope: 'file' は filePath だけ、'work' は同じディレクトリの本文ファイルすべてを連結する。
 * linesOf: ファイルの行列を返す関数（エディタで開いているファイルは未保存の内容を返すために差し替える）
 * sceneBreak: 場面区切り（* の行）に組む記号（null なら PDF 出力と同じ既定）
 * sceneBreakIndent: 日本語の区切りの行を行頭から下げる字数（null なら中央）
 * parts: 部の境界（novel.json の parts。null なら部に分けない）。章番号を PDF と同じ「部-章」にし、作品全体の表示では部の頭で改ページする
 * 返す値: { files, language, sources: ファイルごとの行列（プレビューで段落を編集するときの元テキスト）, css, body, stats }
 */
export function buildDocument({
  filePath,
  scope,
  metrics,
  linesOf = readLines,
  sceneBreak = null,
  sceneBreakIndent = null,
  parts = null,
}) {
  const workFiles = listWorkFiles(filePath);
  const inWork = workFiles.includes(filePath);
  const whole = scope === 'work' && inWork;
  const files = whole ? workFiles : [filePath];
  const partStarts = inWork ? partStartIndices(workFiles, parts, metrics.language) : null;
  // 単独表示でも章番号は作品全体での通し番号に揃える
  const labels = inWork ? computeSectionLabels(workFiles, partStarts) : [];
  const labelOf = (f) => (inWork ? labels[workFiles.indexOf(f)] : null);

  const fileLines = files.map((f) => linesOf(f));
  const html =
    metrics.language === 'en'
      ? buildEnglishHtml(fileLines, metrics, sceneBreak ?? undefined, whole ? partStarts : null)
      : generateHtml(
          fileLines.map((lines, i) =>
            parseTextLines(lines, {
              vertical: metrics.vertical,
              chars: metrics.chars,
              sectionNumber: labelOf(files[i]),
              lineNumbers: true,
              sceneBreak: sceneBreak ?? undefined,
            }),
          ),
          {
            vertical: metrics.vertical,
            chars: metrics.chars,
            lines: metrics.lines,
            chapterBreak: true,
            sceneBreak: sceneBreak ?? undefined,
            sceneBreakIndent,
            // generateHtml は1始まりのファイル順で受け取る
            parts: whole && partStarts ? [1, ...partStarts.map((i) => i + 1)] : null,
          },
        );

  return {
    files,
    language: metrics.language,
    sources: fileLines,
    ...splitGeneratedHtml(html),
    stats: computeStats(fileLines, metrics),
  };
}

/** ファイルの行列が【】の見出しで始まれば、その見出し（【】の中。空なら ''）。始まらなければ null */
export function headingOf(lines) {
  const first = lines.find((l) => l.trim() !== '' && !isMetaLine(l));
  return first && isViewpointLine(first) ? parseViewpointLine(first).title : null;
}

/**
 * 作品の目次。filePath と同じディレクトリの本文ファイルを、PDF出力と同じ規則で章にまとめる
 * （【】の見出しで始まるファイルから新しい章。番号はプレビューと同じで、parts を渡せば「部-章」）。
 * 返す値: { language, chapters }。章: { label, title, file: 先頭のファイル, count, files: [{ file, count }] }。count は日本語は文字数、英語は語数
 */
export function buildOutline(filePath, { linesOf = readLines, parts = null } = {}) {
  const workFiles = listWorkFiles(filePath);
  if (!workFiles.includes(filePath)) return { language: 'ja', chapters: [] };
  const fileLines = workFiles.map((f) => linesOf(f));
  const language = detectLanguageOfLines(fileLines.flat());
  const labels = computeSectionLabels(workFiles, partStartIndices(workFiles, parts, language));
  const heads = fileLines.map(headingOf);
  const sections = heads.map((title) => ({ hasViewpointStart: title !== null }));
  const countOf = (lines) => {
    const stats = computeStats([lines], { language, chars: 20, lines: 20 });
    return language === 'en' ? stats.words : stats.chars;
  };

  const chapters = [];
  workFiles.forEach((file, i) => {
    const count = countOf(fileLines[i]);
    if (startsNewChapter(sections, i)) {
      chapters.push({ label: labels[i], title: heads[i] || null, file, count: 0, files: [] });
    }
    const chapter = chapters.at(-1);
    chapter.files.push({ file, count });
    chapter.count += count;
  });
  return { language, chapters };
}

/** レイアウトの表記。日本語は字数×行数、英語は文字サイズ・行送りと、そこから決まるおよその字数×行数 */
export function describeLayout(layout, { english = false } = {}) {
  const m = computeMetrics(layout, { english });
  if ('charsApprox' in m)
    return t('{0}pt · leading {1} (about {2} chars × {3} lines)', m.fontSizePt, m.lineHeight, m.charsApprox, m.lines);
  return t('{0} chars × {1} lines', m.chars, m.lines);
}

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest;
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { BUILTIN_ENGLISH_PRESETS, computeMetrics, DEFAULT_LAYOUT } = await import('../../src/layout.mjs');

  const withWork = (files, fn) => {
    const dir = mkdtempSync(join(tmpdir(), 'novel-preview-'));
    try {
      for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
      return fn(dir);
    } finally {
      rmSync(dir, { recursive: true });
    }
  };

  describe('stripPageRules', () => {
    test('名前付き・入れ子の @page を含めて取り除き、他の規則は残す', () => {
      const css =
        '@page { size: A4; }\n@page chapter:left { @top-center { content: "x"; } }\n.a { color: red; }\n@page :blank { @top-center { content: none; } }\n';
      expect(stripPageRules(css).trim()).toBe('.a { color: red; }');
    });
  });

  describe('splitGeneratedHtml', () => {
    test('@page を捨て、body のスタイルを #flow 自身に付け替える', () => {
      const { css, body } = splitGeneratedHtml(generateHtml([{ html: '<p>本文</p>' }], { vertical: true, chars: 30 }));
      expect(css.startsWith('#flow {')).toBe(true);
      expect(css).not.toContain('@page');
      expect(css).not.toMatch(/^\s*body\s*\{/m);
      expect(css).toMatch(/& \{\s*font-family/);
      expect(body).toBe('<div class="section">\n<p>本文</p>\n</div>');
    });
  });

  describe('英語組版', () => {
    const metrics = computeMetrics(BUILTIN_ENGLISH_PRESETS.A5, { english: true });

    test('en-pdf の組版で、段落にファイル番号と行番号が付き、@page は残らない', () => {
      withWork({ '010.txt': 'Memo: Nol\n【One】\nFirst "para".\n', '020.txt': 'Second para.\n' }, (dir) => {
        const doc = buildDocument({ filePath: join(dir, '010.txt'), scope: 'work', metrics });
        expect(doc.language).toBe('en');
        expect(doc.files.map((f) => f.slice(dir.length + 1))).toEqual(['010.txt', '020.txt']);
        expect(doc.body).toContain('<p class="noindent" data-file="0" data-line="2">First “para”.</p>');
        expect(doc.body).toContain('<p class="noindent" data-file="1" data-line="0">Second para.</p>');
        expect(doc.body).toContain('<h2 class="chapter-title" data-file="0" data-line="1">One</h2>');
        expect(doc.body).not.toContain('title-page');
        expect(doc.css).not.toContain('@page');
        expect(doc.css).toMatch(/& \{\s*font-family: "EB Garamond"/);
        expect(doc.stats).toEqual({ language: 'en', words: 4, chars: 23 });
      });
    });

    test('parts を渡すと部扉を入れて章番号を部ごとに振り直し、まだ無いファイルの番号は飛ばす', () => {
      withWork({ '010.txt': '【One】\nA.\n', '020.txt': '【Two】\nB.\n', '050.txt': '【Three】\nC.\n' }, (dir) => {
        const doc = buildDocument({ filePath: join(dir, '010.txt'), scope: 'work', metrics, parts: ['050', '099'] });
        expect((doc.body.match(/class="part-page"/g) || []).length).toBe(2);
        expect(doc.body).toContain('Part Two');
      });
    });

    test('detectLanguageOfLines はメタ行を数えない', () => {
      expect(detectLanguageOfLines(['Memo: Nadia Solis', 'Lead: The Sirens', '私は海を見た。'])).toBe('ja');
      expect(detectLanguageOfLines(['Memo: オーティ', 'I saw the sea.'])).toBe('en');
    });
  });

  describe('場面区切りの記号', () => {
    test('sceneBreak を渡すと、日本語・英語とも * の行とファイルの継ぎ目をその記号で組む', () => {
      const ja = computeMetrics({ ...DEFAULT_LAYOUT, chars: 40, lines: 40 });
      withWork({ '010.txt': '【】\n一\n\n*\n\n二\n', '020.txt': '続き\n' }, (dir) => {
        const doc = buildDocument({ filePath: join(dir, '010.txt'), scope: 'work', metrics: ja, sceneBreak: '＊＊＊' });
        expect((doc.body.match(/class="separator">＊＊＊/g) || []).length).toBe(2);
      });
      const en = computeMetrics(BUILTIN_ENGLISH_PRESETS.A5, { english: true });
      withWork({ '010.txt': '【One】\nFirst.\n\n*\n\nSecond.\n' }, (dir) => {
        const doc = buildDocument({ filePath: join(dir, '010.txt'), scope: 'work', metrics: en, sceneBreak: '~' });
        expect(doc.body).toMatch(/<p class="ornament"[^>]*>~<\/p>/);
      });
    });
  });

  describe('buildOutline', () => {
    test('見出しで始まるファイルから章にし、続きのファイルは同じ章に入れる', () => {
      withWork(
        {
          '010.txt': 'Memo: x\n【旅立ち】\n一二三\n',
          '020.txt': '四五\n',
          '030.txt': '【】\n六\n',
          'synopsis.txt': '梗概\n',
        },
        (dir) => {
          const { language, chapters } = buildOutline(join(dir, '020.txt'));
          expect(language).toBe('ja');
          expect(
            chapters.map((ch) => [ch.label, ch.title, ch.count, ch.files.map((f) => f.file.slice(dir.length + 1))]),
          ).toEqual([
            ['1', '旅立ち', 5, ['010.txt', '020.txt']],
            ['2', null, 1, ['030.txt']],
          ]);
          expect(chapters.map((ch) => ch.file)).toEqual([join(dir, '010.txt'), join(dir, '030.txt')]);
        },
      );
    });
    test('英語は語数を数え、linesOf の内容（未保存の編集）を使う', () => {
      withWork({ '010.txt': '【One】\nFirst para.\n' }, (dir) => {
        const file = join(dir, '010.txt');
        const { language, chapters } = buildOutline(file, { linesOf: () => ['【One】', 'Three words here.'] });
        expect(language).toBe('en');
        expect(chapters[0].count).toBe(3);
      });
    });
    test('parts を渡すと PDF と同じ「部-章」で採番する', () => {
      withWork({ '010.txt': '【】\n一\n', '020.txt': '【】\n二\n', '050.txt': '【】\n三\n' }, (dir) => {
        const { chapters } = buildOutline(join(dir, '010.txt'), { parts: ['050'] });
        expect(chapters.map((ch) => ch.label)).toEqual(['1-1', '1-2', '2']);
      });
    });
    test('作品の外のファイル（梗概など）は空', () => {
      withWork({ '010.txt': '【】\n一\n', 'synopsis.txt': '梗概\n' }, (dir) => {
        expect(buildOutline(join(dir, 'synopsis.txt')).chapters).toEqual([]);
      });
    });
  });

  describe('buildDocument', () => {
    const metrics = computeMetrics({ ...DEFAULT_LAYOUT, chars: 40, lines: 40 });

    test('単独表示でも章番号は作品内の通し番号になり、行番号が付く', () => {
      withWork({ '010.txt': '【】\n一\n', '020.txt': 'Memo: A\n【】\n二\n', 'synopsis.txt': '梗概\n' }, (dir) => {
        const doc = buildDocument({ filePath: join(dir, '020.txt'), scope: 'file', metrics });
        expect(doc.files).toEqual([join(dir, '020.txt')]);
        expect(doc.body).toContain('【<span class="tcy">2</span>】');
        expect(doc.body).toMatch(/<p class="paragraph-short" data-line="2">/);
        expect(doc.stats.chars).toBe(1);
      });
    });

    test('parts を渡すと単独表示でも「部-章」で採番し、作品全体では章ごとでなく部の頭で改ページする', () => {
      withWork({ '010.txt': '【】\n一\n', '020.txt': '【】\n二\n', '050.txt': '【】\n三\n' }, (dir) => {
        const single = buildDocument({ filePath: join(dir, '020.txt'), scope: 'file', metrics, parts: ['050'] });
        expect(single.body).toContain(
          '【<span class="tcy">1</span><span class="hyphen">－</span><span class="tcy">2</span>】',
        );
        const whole = buildDocument({ filePath: join(dir, '010.txt'), scope: 'work', metrics, parts: ['050'] });
        expect(whole.body).toContain('【<span class="tcy">2</span>】');
        expect((whole.body.match(/class="section page-break part-section"/g) || []).length).toBe(2);
        expect(whole.body).not.toContain('class="section page-break"');
      });
    });

    test('作品全体では本文ファイルを連結し、開いているファイルは linesOf の内容を使う', () => {
      withWork({ '010.txt': '【】\n一\n', '020.txt': '【】\n二\n', 'synopsis.txt': '梗概\n' }, (dir) => {
        const edited = join(dir, '020.txt');
        const doc = buildDocument({
          filePath: edited,
          scope: 'work',
          metrics,
          linesOf: (f) => (f === edited ? ['【】', '未保存の本文'] : readLines(f)),
        });
        expect(doc.files.map((f) => f.slice(dir.length + 1))).toEqual(['010.txt', '020.txt']);
        expect((doc.body.match(/<div class="section/g) || []).length).toBe(2);
        expect(doc.body).toContain('未保存の本文');
        expect(doc.sources).toEqual([readLines(join(dir, '010.txt')), ['【】', '未保存の本文']]);
        expect(doc.body).not.toContain('梗概');
      });
    });

    test('本文ファイルの並びに入らないファイル（梗概など）は単独で表示する', () => {
      withWork({ '010.txt': '【】\n一\n', 'synopsis.txt': '梗概\n' }, (dir) => {
        const doc = buildDocument({ filePath: join(dir, 'synopsis.txt'), scope: 'work', metrics });
        expect(doc.files).toEqual([join(dir, 'synopsis.txt')]);
        expect(doc.body).toContain('梗概');
      });
    });
  });

  describe('describeLayout', () => {
    test('英語では文字サイズと行送りを出し、日本語の表示では日本語で出す', async () => {
      const { readFileSync } = await import('node:fs');
      const { setBundle } = await import('./l10n.mjs');
      expect(describeLayout(DEFAULT_LAYOUT)).toBe('30 chars × 41 lines');
      expect(describeLayout(BUILTIN_ENGLISH_PRESETS.A5, { english: true })).toMatch(
        /^11pt · leading 1\.4 \(about \d+ chars × \d+ lines\)$/,
      );
      setBundle(JSON.parse(readFileSync(new URL('../l10n/bundle.l10n.ja.json', import.meta.url), 'utf8')));
      try {
        expect(describeLayout(DEFAULT_LAYOUT)).toBe('30字×41行');
        expect(describeLayout(BUILTIN_ENGLISH_PRESETS.A5, { english: true })).toMatch(
          /^11pt・行送り1\.4（約\d+字×\d+行）$/,
        );
      } finally {
        setBundle(undefined);
      }
    });
  });

  describe('computeStats', () => {
    test('原稿用紙換算と現在のレイアウトでの換算を返す', () => {
      const stats = computeStats([['あ'.repeat(45)]], computeMetrics({ ...DEFAULT_LAYOUT, chars: 40, lines: 40 }));
      expect(stats).toEqual({ language: 'ja', chars: 45, genkoPages: 3 / 20, gridPages: 2 / 40 });
    });
  });
}
