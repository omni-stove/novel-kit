/**
 * 設定ファイル（novel-layout.json）の探索と読み書き。
 * 日本語のレイアウト（トップレベル）、英語のレイアウト（"english"）、表示範囲・倍率などの表示設定（"view"）を持つ。
 * 原稿のあるディレクトリから上へ向かって探し、最初に見つかったもの（＝一番近いもの）を使う。
 * 作品ごと（src/<作品>/story/）にも、上位ディレクトリに置いて複数作品の共通設定にもできる。
 * 英訳（story/en/ など）も同じファイルの "english" を使うので、作品ごとに1つで済む。
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, relative, isAbsolute } from 'path';
import { normalizeLayout } from './layout.mts';

export const LAYOUT_FILENAME = 'novel-layout.json';

const isInside = (dir, root) => {
  const rel = relative(root, dir);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

// startDir から rootDir まで（rootDir を含む）さかのぼって探す。rootDir の外へは出ない
export function findLayoutFile(startDir, rootDir = startDir) {
  let dir = startDir;
  while (isInside(dir, rootDir)) {
    const candidate = join(dir, LAYOUT_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// レイアウト以外の表示設定（"view" の下に持つ）
export const DEFAULT_VIEW = {
  // 表示範囲: 'work' = 同じディレクトリの本文ファイルを連結 / 'file' = 開いているファイルだけ
  scope: 'work',
  // 表示倍率: 'fit'（用紙を幅・高さとも表示領域に収める） / 数値（%）
  zoom: 'fit',
  // プレビュー上で段落をクリックして編集するか
  edit: true,
};

export function normalizeView(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const percent = Number(r.zoom);
  return {
    scope: r.scope === 'file' ? 'file' : DEFAULT_VIEW.scope,
    zoom: Number.isFinite(percent) && percent >= 10 && percent <= 400 ? Math.round(percent) : DEFAULT_VIEW.zoom,
    edit: typeof r.edit === 'boolean' ? r.edit : DEFAULT_VIEW.edit,
  };
}

// 壊れたJSONは例外にする（黙って既定に戻すと、次の保存で中身を上書きしてしまうため）
export function readSettingsFile(filePath) {
  const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  return {
    layout: normalizeLayout(raw),
    english: normalizeLayout(raw?.english, { english: true }),
    view: normalizeView(raw?.view),
  };
}

// 日本語のレイアウトの項目はトップレベルに、英語のレイアウトは "english" に、表示設定は "view" に書く
export function writeSettingsFile(filePath, { layout, english, view }) {
  const data = {
    ...normalizeLayout(layout),
    english: normalizeLayout(english, { english: true }),
    view: normalizeView(view),
  };
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest;
  const { mkdtempSync, mkdirSync, rmSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { DEFAULT_LAYOUT, DEFAULT_ENGLISH_LAYOUT } = await import('./layout.mts');

  const withTree = (fn) => {
    const root = mkdtempSync(join(tmpdir(), 'novel-layout-'));
    const story = join(root, 'src', 'work', 'story');
    mkdirSync(story, { recursive: true });
    try {
      return fn({ root, story });
    } finally {
      rmSync(root, { recursive: true });
    }
  };

  describe('findLayoutFile', () => {
    test('原稿のディレクトリから上へ探し、一番近いものを返す', () => {
      withTree(({ root, story }) => {
        expect(findLayoutFile(story, root)).toBeNull();
        writeSettingsFile(join(root, 'src', LAYOUT_FILENAME), {});
        expect(findLayoutFile(story, root)).toBe(join(root, 'src', LAYOUT_FILENAME));
        writeSettingsFile(join(story, LAYOUT_FILENAME), {});
        expect(findLayoutFile(story, root)).toBe(join(story, LAYOUT_FILENAME));
      });
    });
    test('rootDir より上は見ない', () => {
      withTree(({ root, story }) => {
        writeSettingsFile(join(root, LAYOUT_FILENAME), {});
        expect(findLayoutFile(story, join(root, 'src'))).toBeNull();
        expect(findLayoutFile(story, root)).toBe(join(root, LAYOUT_FILENAME));
      });
    });
  });

  describe('readSettingsFile / writeSettingsFile', () => {
    test('省略した項目は既定で埋めて読み、書くときは全項目を書き出す', () => {
      withTree(({ story }) => {
        const file = join(story, LAYOUT_FILENAME);
        writeFileSync(file, '{ "chars": 42, "lines": 34 }');
        expect(readSettingsFile(file)).toEqual({
          layout: { ...DEFAULT_LAYOUT, chars: 42, lines: 34 }, english: DEFAULT_ENGLISH_LAYOUT, view: DEFAULT_VIEW,
        });
        writeSettingsFile(file, {
          layout: { chars: 40, lines: 40 }, english: { paper: 'A5' }, view: { scope: 'file', zoom: '150', edit: false },
        });
        expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({
          ...DEFAULT_LAYOUT, chars: 40, lines: 40,
          english: { ...DEFAULT_ENGLISH_LAYOUT, paper: 'A5' },
          view: { scope: 'file', zoom: 150, edit: false },
        });
        expect(readSettingsFile(file).view).toEqual({ scope: 'file', zoom: 150, edit: false });
        expect(readSettingsFile(file).english.paper).toBe('A5');
      });
    });
    test('壊れたJSONは例外', () => {
      withTree(({ story }) => {
        const file = join(story, LAYOUT_FILENAME);
        writeFileSync(file, '{ chars: ');
        expect(() => readSettingsFile(file)).toThrow();
      });
    });
  });

  describe('normalizeView', () => {
    test('不正値は既定に戻す', () => {
      expect(normalizeView({ scope: 'x', zoom: 'big', edit: 'yes' })).toEqual(DEFAULT_VIEW);
      expect(normalizeView({ zoom: 'fit-page' }).zoom).toBe('fit');
      expect(normalizeView({ zoom: 'fit-width' }).zoom).toBe('fit');
      expect(normalizeView({ zoom: 120 }).zoom).toBe(120);
      expect(normalizeView({ zoom: 5000 }).zoom).toBe('fit');
    });
  });
}
