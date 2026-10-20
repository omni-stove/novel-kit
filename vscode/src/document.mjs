/**
 * 原稿テキストからプレビュー用の HTML/CSS と文字数統計を作る（vscode API に依存しない）。
 * 組版は PDF 出力と同じ src/lib のパーサと、日本語は src/pdf.mjs、
 * 英語は src/en-pdf.mjs の generateHtml を使う。
 */

import { dirname } from 'path';
import { isMetaLine, parseTextLines, readLines } from '../../src/lib/text-parser.mjs';
import {
  computeSectionLabels, getTextFilesFromDir, countGenkoRows,
  SYNOPSIS_FILENAME, CHARACTERS_FILENAME,
} from '../../src/lib/manuscript.mjs';
import { generateHtml } from '../../src/pdf.mjs';
import { buildChapters, generateHtml as generateEnglishHtml, parseEnglishLines } from '../../src/en-pdf.mjs';
import { detectLanguage } from '../../src/layout.mjs';

// 原稿の行列から組版の言語（'ja' / 'en'）を判定する（メタ行は数えない）
export const detectLanguageOfLines = (lines) => detectLanguage(lines, isMetaLine);

// 同じディレクトリの本文ファイル（PDF出力と同じ並び。梗概・人物紹介は除く）
export function listWorkFiles(filePath) {
  try {
    return getTextFilesFromDir(dirname(filePath), [SYNOPSIS_FILENAME, CHARACTERS_FILENAME]);
  } catch {
    return [];
  }
}

// @page ブロックを取り除く（名前付き・マージンボックスの入れ子も含む）
export function stripPageRules(css) {
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

// generateHtml が返す PDF 用の文書から、webview に差し込むスタイルと本文を取り出す。
// スタイルは CSS ネストで #flow の内側に閉じ込め、ページ寸法（@page）は webview 側で再現するので捨てる
export function splitGeneratedHtml(html) {
  const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
  const body = html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? '';
  const scoped = stripPageRules(style.replace(/\/\*[\s\S]*?\*\//g, ''))
    .replace(/^(\s*)body\s*\{/m, '$1& {');
  return { css: `#flow {\n${scoped}\n}`, body: body.trim() };
}

// 英語は語数（空白区切り）と文字数（空白を除く）。日本語は文字数と原稿用紙換算
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
    // 400字詰め原稿用紙換算
    genkoPages: genkoRows / 20,
    // 現在のレイアウトでの連続換算（改ページを含まない）
    gridPages: gridRows / metrics.lines,
  };
}

// 英語組版（en-pdf.mjs）。ファイルは章にまとめられるので、段落は data-file でファイルを指す
function buildEnglishHtml(fileLines, metrics) {
  const m = metrics.layout.margin;
  const chapters = buildChapters(fileLines.map(lines => parseEnglishLines(lines)));
  return generateEnglishHtml(chapters, {
    width: `${metrics.paperW}mm`,
    height: `${metrics.paperH}mm`,
    fontSize: `${metrics.fontSizePt}pt`,
    lineHeight: String(metrics.lineHeight),
    // 見開きの内側の余白は左、外側は右として扱う（プレビューは単ページ）
    margin: { top: `${m.top}mm`, bottom: `${m.bottom}mm`, inner: `${m.left}mm`, outer: `${m.right}mm` },
  }, { smartQuotes: true, lineNumbers: true });
}

/**
 * scope: 'file' は filePath だけ、'work' は同じディレクトリの本文ファイルすべてを連結する。
 * linesOf: ファイルの行列を返す関数（エディタで開いているファイルは未保存の内容を返すために差し替える）
 */
export function buildDocument({ filePath, scope, metrics, linesOf = readLines }) {
  const workFiles = listWorkFiles(filePath);
  const inWork = workFiles.includes(filePath);
  const files = scope === 'work' && inWork ? workFiles : [filePath];
  // 単独表示でも章番号は作品全体での通し番号にする
  const labels = inWork ? computeSectionLabels(workFiles) : [];
  const labelOf = (f) => (inWork ? labels[workFiles.indexOf(f)] : null);

  const fileLines = files.map(f => linesOf(f));
  const html = metrics.language === 'en'
    ? buildEnglishHtml(fileLines, metrics)
    : generateHtml(fileLines.map((lines, i) => parseTextLines(lines, {
      vertical: metrics.vertical,
      chars: metrics.chars,
      sectionNumber: labelOf(files[i]),
      lineNumbers: true,
    })), {
      vertical: metrics.vertical,
      chars: metrics.chars,
      lines: metrics.lines,
      chapterBreak: true,
    });

  return {
    files,
    language: metrics.language,
    // プレビュー側で段落を編集するときに見せる元テキスト（ファイルごとの行列）
    sources: fileLines,
    ...splitGeneratedHtml(html),
    stats: computeStats(fileLines, metrics),
  };
}

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest;
  const { mkdtempSync, writeFileSync, rmSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
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
      const css = '@page { size: A4; }\n@page chapter:left { @top-center { content: "x"; } }\n.a { color: red; }\n@page :blank { @top-center { content: none; } }\n';
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
      withWork({ '010.txt': 'POV: Nol\n【One】\nFirst "para".\n【】\n', '020.txt': 'Second para.\n' }, (dir) => {
        const doc = buildDocument({ filePath: join(dir, '010.txt'), scope: 'work', metrics });
        expect(doc.language).toBe('en');
        expect(doc.files.map(f => f.slice(dir.length + 1))).toEqual(['010.txt', '020.txt']);
        expect(doc.body).toContain('<p class="noindent" data-file="0" data-line="2">First “para”.</p>');
        expect(doc.body).toContain('<p class="noindent" data-file="1" data-line="0">Second para.</p>');
        expect(doc.body).toContain('<h2 class="chapter-title" data-file="0" data-line="1">One</h2>');
        expect(doc.body).not.toContain('title-page');
        expect(doc.css).not.toContain('@page');
        expect(doc.css).toMatch(/& \{\s*font-family: "EB Garamond"/);
        expect(doc.stats).toEqual({ language: 'en', words: 4, chars: 23 });
      });
    });

    test('detectLanguageOfLines はメタ行を数えない', () => {
      expect(detectLanguageOfLines(['POV: Nadia Solis', 'Title: The Sirens', '私は海を見た。'])).toBe('ja');
      expect(detectLanguageOfLines(['POV: オーティ', 'I saw the sea.'])).toBe('en');
    });
  });

  describe('buildDocument', () => {
    const metrics = computeMetrics({ ...DEFAULT_LAYOUT, chars: 40, lines: 40 });

    test('単独表示でも章番号は作品内の通し番号になり、行番号が付く', () => {
      withWork({ '010.txt': '【】\n一\n', '020.txt': 'POV: A\n【】\n二\n', 'synopsis.txt': '梗概\n' }, (dir) => {
        const doc = buildDocument({ filePath: join(dir, '020.txt'), scope: 'file', metrics });
        expect(doc.files).toEqual([join(dir, '020.txt')]);
        expect(doc.body).toContain('【<span class="tcy">2</span>】');
        expect(doc.body).toMatch(/<p class="paragraph-short" data-line="2">/);
        expect(doc.stats.chars).toBe(1);
      });
    });

    test('作品全体では本文ファイルを連結し、開いているファイルは linesOf の内容を使う', () => {
      withWork({ '010.txt': '【】\n一\n', '020.txt': '【】\n二\n', 'synopsis.txt': '梗概\n' }, (dir) => {
        const edited = join(dir, '020.txt');
        const doc = buildDocument({
          filePath: edited,
          scope: 'work',
          metrics,
          linesOf: f => (f === edited ? ['【】', '未保存の本文'] : readLines(f)),
        });
        expect(doc.files.map(f => f.slice(dir.length + 1))).toEqual(['010.txt', '020.txt']);
        expect((doc.body.match(/<div class="section/g) || []).length).toBe(2);
        expect(doc.body).toContain('未保存の本文');
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

  describe('computeStats', () => {
    test('原稿用紙換算と現在のレイアウトでの換算を返す', () => {
      const stats = computeStats([['あ'.repeat(45)]], computeMetrics({ ...DEFAULT_LAYOUT, chars: 40, lines: 40 }));
      expect(stats).toEqual({ language: 'ja', chars: 45, genkoPages: 3 / 20, gridPages: 2 / 40 });
    });
  });
}
