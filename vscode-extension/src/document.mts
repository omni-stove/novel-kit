/**
 * 原稿テキストからプレビュー用の HTML/CSS と文字数統計を作る（vscode API に依存しない）。
 * 組版は PDF 出力と同じ scripts/lib のパーサと scripts/txt-to-pdf.mts の generateHtml を使う。
 */

import { dirname } from 'path';
import { parseTextLines, readLines } from '../../scripts/lib/text-parser.mts';
import {
  computeSectionLabels, getTextFilesFromDir, countGenkoRows,
  SYNOPSIS_FILENAME, CHARACTERS_FILENAME,
} from '../../scripts/lib/manuscript.mts';
import { generateHtml } from '../../scripts/txt-to-pdf.mts';

// 同じディレクトリの本文ファイル（PDF出力と同じ並び。梗概・人物紹介は除く）
export function listWorkFiles(filePath) {
  try {
    return getTextFilesFromDir(dirname(filePath), [SYNOPSIS_FILENAME, CHARACTERS_FILENAME]);
  } catch {
    return [];
  }
}

// generateHtml が返す PDF 用の文書から、webview に差し込むスタイルと本文を取り出す。
// スタイルは CSS ネストで #flow の内側に閉じ込め、ページ寸法（@page）は webview 側で再現するので捨てる
export function splitGeneratedHtml(html) {
  const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
  const body = html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? '';
  const scoped = style
    .replace(/@page\s*\{[^}]*\}/, '')
    .replace(/^(\s*)body\s*\{/m, '$1& {');
  return { css: `#flow {\n${scoped}\n}`, body: body.trim() };
}

export function computeStats(fileLines, metrics) {
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
    chars,
    // 400字詰め原稿用紙換算
    genkoPages: genkoRows / 20,
    // 現在のレイアウトでの連続換算（改ページを含まない）
    gridPages: gridRows / metrics.lines,
  };
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
  const sections = fileLines.map((lines, i) => parseTextLines(lines, {
    vertical: metrics.vertical,
    chars: metrics.chars,
    sectionNumber: labelOf(files[i]),
    lineNumbers: true,
  }));

  const html = generateHtml(sections, {
    vertical: metrics.vertical,
    chars: metrics.chars,
    lines: metrics.lines,
    chapterBreak: true,
  });

  return {
    files,
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
  const { computeMetrics, DEFAULT_LAYOUT } = await import('./layout.mts');

  const withWork = (files, fn) => {
    const dir = mkdtempSync(join(tmpdir(), 'novel-preview-'));
    try {
      for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
      return fn(dir);
    } finally {
      rmSync(dir, { recursive: true });
    }
  };

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
      expect(stats).toEqual({ chars: 45, genkoPages: 3 / 20, gridPages: 2 / 40 });
    });
  });
}
