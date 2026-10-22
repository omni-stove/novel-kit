/**
 * 設定ファイル（novel.json）の探索と読み書き。
 * 日本語のレイアウト（トップレベル）、英語のレイアウト（"english"）、表示範囲・倍率などの表示設定（"view"）と、
 * 作品情報（"id" / "title" / "author" / "genre" / "target" / "input" / "parts"。英語の出力の title / author / input は "english" の中）・
 * 出力の定義（"outputs"。novel build が読む）を持つ。
 * 原稿のあるディレクトリから上へ向かって探し、最初に見つかったもの（＝一番近いもの）を使う。
 * 作品ごと（src/<作品>/story/）にも、上位ディレクトリに置いて複数作品の共通設定にもできる。
 * 英訳（story/en/ など）も同じファイルの "english" を使うので、作品ごとに1つで済む。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { normalizeLayout } from './layout.mjs';

export const CONFIG_FILENAME = 'novel.json';

const isInside = (dir, root) => {
  const rel = relative(root, dir);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** startDir から rootDir まで（rootDir を含む）さかのぼって探す。rootDir の外へは出ない。見つからなければ null */
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

/** レイアウト以外の表示設定（"view" の下に持つ） */
export const DEFAULT_VIEW = {
  /** 表示範囲: 'work' = 同じディレクトリの本文ファイルを連結 / 'file' = 開いているファイルだけ */
  scope: 'work',
  /** 表示倍率: 'fit'（用紙を幅・高さとも表示領域に収める） / 数値（%、10〜400） */
  zoom: 'fit',
  /** プレビュー上で段落をクリックして編集するか */
  edit: true,
  /** 'page' = 用紙に組んでページで見せる / 'scroll' = カクヨム・小説家になろうのように横書きでページを区切らず縦に流す */
  mode: 'page',
};

export function normalizeView(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const percent = Number(r.zoom);
  return {
    scope: r.scope === 'file' ? 'file' : DEFAULT_VIEW.scope,
    zoom: Number.isFinite(percent) && percent >= 10 && percent <= 400 ? Math.round(percent) : DEFAULT_VIEW.zoom,
    edit: typeof r.edit === 'boolean' ? r.edit : DEFAULT_VIEW.edit,
    mode: r.mode === 'scroll' ? 'scroll' : DEFAULT_VIEW.mode,
  };
}

/**
 * novel build 用。設定ファイルのディレクトリ（dir）と、作品情報・出力の定義をレイアウトと合わせて返す。
 * id（出力ファイル名のもと）の既定は title。en は英語の出力（pdf-en / rtf-en）の作品の項目で、
 * "english" に書いた title / author / input（input の既定は ["en"]）だけを持つ
 */
export function readWorkConfig(filePath) {
  const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  const english = raw.english ?? {};
  return {
    ...readSettingsFile(filePath),
    dir: dirname(filePath),
    id: raw.id ?? raw.title ?? null,
    en: {
      ...('title' in english && { title: english.title }),
      ...('author' in english && { author: english.author }),
      input: english.input ?? ['en'],
    },
    title: raw.title ?? null,
    author: raw.author ?? null,
    genre: raw.genre ?? null,
    target: raw.target ?? null,
    input: raw.input ?? ['.'],
    outputs: raw.outputs ?? {},
  };
}

/**
 * 場面区切り（原稿の * の行）に組む記号。日本語はトップレベル、英語は english の sceneBreak。
 * 前後の空白を除き、書いていなければ（空でも）null（出力ごとの既定の記号を使う）
 */
export function readSceneBreak(raw) {
  const mark = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return { ja: mark(raw?.sceneBreak), en: mark(raw?.english?.sceneBreak) };
}

/**
 * 日本語の出力で区切りの行を行頭から何字下げて置くか（"sceneBreakIndent"）。0 以上の整数でなければ null（行の中央に置く）
 */
export function readSceneBreakIndent(raw) {
  const n = raw?.sceneBreakIndent;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** 部の境界（"parts"）。ファイル名の先頭の番号の配列で、書いていなければ（空でも）null */
export function readParts(raw) {
  const parts = Array.isArray(raw?.parts) ? raw.parts.map(String).filter((p) => p.trim()) : [];
  return parts.length > 0 ? parts : null;
}

// 壊れたJSONは例外にする（黙って既定に戻すと、次の保存で中身を上書きしてしまうため）
export function readSettingsFile(filePath) {
  const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  return {
    layout: normalizeLayout(raw),
    english: normalizeLayout(raw?.english, { english: true }),
    view: normalizeView(raw?.view),
    sceneBreak: readSceneBreak(raw),
    sceneBreakIndent: readSceneBreakIndent(raw),
    parts: readParts(raw),
  };
}

/**
 * 日本語のレイアウトの項目はトップレベルに、英語のレイアウトは "english" に、表示設定は "view" に書く。
 * 作品情報や出力の定義など、それ以外の項目（english の中の sceneBreak なども）はそのまま残す
 * @param {string} filePath
 * @param {{ layout?: object, english?: object, view?: object }} settings
 */
export function writeSettingsFile(filePath, { layout, english, view }) {
  const current = existsSync(filePath) ? JSON.parse(readFileSync(filePath, 'utf-8')) : {};
  const data = {
    ...current,
    ...normalizeLayout(layout),
    english: { ...current.english, ...normalizeLayout(english, { english: true }) },
    view: normalizeView(view),
  };
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest;
  const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
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
          layout: { ...DEFAULT_LAYOUT, chars: 42, lines: 34 },
          english: DEFAULT_ENGLISH_LAYOUT,
          view: DEFAULT_VIEW,
          sceneBreak: { ja: null, en: null },
          sceneBreakIndent: null,
          parts: null,
        });
        writeSettingsFile(file, {
          layout: { chars: 40, lines: 40 },
          english: { paper: 'A5' },
          view: { scope: 'file', zoom: '150', edit: false, mode: 'scroll' },
        });
        expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({
          ...DEFAULT_LAYOUT,
          chars: 40,
          lines: 40,
          english: { ...DEFAULT_ENGLISH_LAYOUT, paper: 'A5' },
          view: { scope: 'file', zoom: 150, edit: false, mode: 'scroll' },
        });
        expect(readSettingsFile(file).view).toEqual({ scope: 'file', zoom: 150, edit: false, mode: 'scroll' });
        expect(readSettingsFile(file).english.paper).toBe('A5');
      });
    });
    test('レイアウトと表示設定以外の項目は書き換えても残す', () => {
      withTree(({ story }) => {
        const file = join(story, CONFIG_FILENAME);
        writeFileSync(
          file,
          '{ "title": "作品", "outputs": { "pdf": { "format": "pdf", "out": "out/a.pdf" } }, "chars": 42 }',
        );
        writeSettingsFile(file, { layout: { chars: 40, lines: 40 }, english: {}, view: {} });
        const raw = JSON.parse(readFileSync(file, 'utf-8'));
        expect(raw.title).toBe('作品');
        expect(raw.outputs).toEqual({ pdf: { format: 'pdf', out: 'out/a.pdf' } });
        expect(raw.chars).toBe(40);
        expect(Object.keys(raw).slice(0, 2)).toEqual(['title', 'outputs']);
      });
    });
    test('場面区切りの記号は sceneBreak と english.sceneBreak から読み、レイアウトを書き換えても残す', () => {
      withTree(({ story }) => {
        const file = join(story, CONFIG_FILENAME);
        writeFileSync(file, '{ "sceneBreak": "＊　＊　＊", "english": { "sceneBreak": "~ ~ ~" } }');
        expect(readSettingsFile(file).sceneBreak).toEqual({ ja: '＊　＊　＊', en: '~ ~ ~' });
        writeSettingsFile(file, { layout: {}, english: { paper: 'A5' }, view: {} });
        expect(readSettingsFile(file).sceneBreak).toEqual({ ja: '＊　＊　＊', en: '~ ~ ~' });
        expect(readSettingsFile(file).english.paper).toBe('A5');
      });
    });
    test('部の境界は文字列の配列で読み、無いか空なら null', () => {
      expect(readParts({ parts: ['050', 100] })).toEqual(['050', '100']);
      expect(readParts({ parts: [] })).toBeNull();
      expect(readParts({})).toBeNull();
    });
    test('場面区切りの記号は前後の空白を除き、空なら null', () => {
      expect(readSceneBreak({ sceneBreak: '  ◆  ', english: { sceneBreak: ' ' } })).toEqual({ ja: '◆', en: null });
      expect(readSceneBreak(null)).toEqual({ ja: null, en: null });
    });
    test('区切りの字下げは 0 以上の整数だけを読み、それ以外は null（中央）', () => {
      expect(readSceneBreakIndent({ sceneBreakIndent: 19 })).toBe(19);
      expect(readSceneBreakIndent({ sceneBreakIndent: 0 })).toBe(0);
      expect(readSceneBreakIndent({ sceneBreakIndent: -1 })).toBeNull();
      expect(readSceneBreakIndent({ sceneBreakIndent: 1.5 })).toBeNull();
      expect(readSceneBreakIndent({})).toBeNull();
    });
    test('readWorkConfig は作品情報と出力の定義を読み、input の既定は設定ファイルのディレクトリ', () => {
      withTree(({ story }) => {
        const file = join(story, CONFIG_FILENAME);
        writeFileSync(file, '{ "title": "作品", "outputs": { "pdf": { "format": "pdf", "out": "out/a.pdf" } } }');
        const config = readWorkConfig(file);
        expect(config).toMatchObject({
          dir: story,
          id: '作品',
          en: { input: ['en'] },
          title: '作品',
          author: null,
          genre: null,
          input: ['.'],
          parts: null,
        });
        expect(config.outputs.pdf.out).toBe('out/a.pdf');
        expect(config.layout).toEqual(DEFAULT_LAYOUT);
      });
    });
    test('readWorkConfig は english の title / author / input を英語の出力の作品の項目にする', () => {
      withTree(({ story }) => {
        const file = join(story, CONFIG_FILENAME);
        writeFileSync(
          file,
          '{ "id": "w", "title": "作品", "english": { "title": "Work", "input": ["en", "after.txt"], "paper": "A5" } }',
        );
        const config = readWorkConfig(file);
        expect(config.id).toBe('w');
        expect(config.en).toEqual({ title: 'Work', input: ['en', 'after.txt'] });
        expect(config.english.paper).toBe('A5');
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
      expect(normalizeView({ zoom: 9 }).zoom).toBe('fit');
      expect(normalizeView({ zoom: '150.4' }).zoom).toBe(150);
      expect(normalizeView(undefined)).toEqual(DEFAULT_VIEW);
    });
  });
}
