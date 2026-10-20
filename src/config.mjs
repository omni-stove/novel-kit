/**
 * 設定ファイル（novel.json）の探索と読み書き。
 * 日本語のレイアウト（トップレベル）、英語のレイアウト（"english"）、表示範囲・倍率などの表示設定（"view"）と、
 * 作品情報（"title" / "author" / "input"）・出力の定義（"outputs"。novel build が読む）を持つ。
 * 原稿のあるディレクトリから上へ向かって探し、最初に見つかったもの（＝一番近いもの）を使う。
 * 作品ごと（src/<作品>/story/）にも、上位ディレクトリに置いて複数作品の共通設定にもできる。
 * 英訳（story/en/ など）も同じファイルの "english" を使うので、作品ごとに1つで済む。
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, relative, isAbsolute } from 'path';
import { normalizeLayout } from './layout.mjs';

export const CONFIG_FILENAME = 'novel.json';

const isInside = (dir, root) => {
  const rel = relative(root, dir);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

// startDir から rootDir まで（rootDir を含む）さかのぼって探す。rootDir の外へは出ない
export function findConfigFile(startDir, rootDir = startDir) {
  let dir = startDir;
  while (isInside(dir, rootDir)) {
    const candidate = join(dir, CONFIG_FILENAME);
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

// novel build 用。設定ファイルのディレクトリ（dir）と、作品情報・出力の定義をレイアウトと合わせて返す
export function readWorkConfig(filePath) {
  const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  return {
    ...readSettingsFile(filePath),
    dir: dirname(filePath),
    title: raw.title ?? null,
    author: raw.author ?? null,
    input: raw.input ?? ['.'],
    outputs: raw.outputs ?? {},
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

// 日本語のレイアウトの項目はトップレベルに、英語のレイアウトは "english" に、表示設定は "view" に書く。
// 作品情報や出力の定義など、それ以外の項目はそのまま残す
export function writeSettingsFile(filePath, { layout, english, view }) {
  const current = existsSync(filePath) ? JSON.parse(readFileSync(filePath, 'utf-8')) : {};
  const data = {
    ...current,
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
  const { DEFAULT_LAYOUT, DEFAULT_ENGLISH_LAYOUT } = await import('./layout.mjs');

  const withTree = (fn) => {
    const root = mkdtempSync(join(tmpdir(), 'novel-config-'));
    const story = join(root, 'src', 'work', 'story');
    mkdirSync(story, { recursive: true });
    try {
      return fn({ root, story });
    } finally {
      rmSync(root, { recursive: true });
    }
  };

  describe('findConfigFile', () => {
    test('原稿のディレクトリから上へ探し、一番近いものを返す', () => {
      withTree(({ root, story }) => {
        expect(findConfigFile(story, root)).toBeNull();
        writeSettingsFile(join(root, 'src', CONFIG_FILENAME), {});
        expect(findConfigFile(story, root)).toBe(join(root, 'src', CONFIG_FILENAME));
        writeSettingsFile(join(story, CONFIG_FILENAME), {});
        expect(findConfigFile(story, root)).toBe(join(story, CONFIG_FILENAME));
      });
    });
    test('rootDir より上は見ない', () => {
      withTree(({ root, story }) => {
        writeSettingsFile(join(root, CONFIG_FILENAME), {});
        expect(findConfigFile(story, join(root, 'src'))).toBeNull();
        expect(findConfigFile(story, root)).toBe(join(root, CONFIG_FILENAME));
      });
    });
  });

  describe('readSettingsFile / writeSettingsFile', () => {
    test('省略した項目は既定で埋めて読み、書くときは全項目を書き出す', () => {
      withTree(({ story }) => {
        const file = join(story, CONFIG_FILENAME);
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
    test('レイアウトと表示設定以外の項目は書き換えても残す', () => {
      withTree(({ story }) => {
        const file = join(story, CONFIG_FILENAME);
        writeFileSync(file, '{ "title": "作品", "outputs": { "pdf": { "format": "pdf", "out": "out/a.pdf" } }, "chars": 42 }');
        writeSettingsFile(file, { layout: { chars: 40, lines: 40 }, english: {}, view: {} });
        const raw = JSON.parse(readFileSync(file, 'utf-8'));
        expect(raw.title).toBe('作品');
        expect(raw.outputs).toEqual({ pdf: { format: 'pdf', out: 'out/a.pdf' } });
        expect(raw.chars).toBe(40);
        expect(Object.keys(raw).slice(0, 2)).toEqual(['title', 'outputs']);
      });
    });
    test('readWorkConfig は作品情報と出力の定義を読み、input の既定は設定ファイルのディレクトリ', () => {
      withTree(({ story }) => {
        const file = join(story, CONFIG_FILENAME);
        writeFileSync(file, '{ "title": "作品", "outputs": { "pdf": { "format": "pdf", "out": "out/a.pdf" } } }');
        const config = readWorkConfig(file);
        expect(config).toMatchObject({ dir: story, title: '作品', author: null, input: ['.'] });
        expect(config.outputs.pdf.out).toBe('out/a.pdf');
        expect(config.layout).toEqual(DEFAULT_LAYOUT);
      });
    });
    test('壊れたJSONは例外', () => {
      withTree(({ story }) => {
        const file = join(story, CONFIG_FILENAME);
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
