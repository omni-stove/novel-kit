/**
 * 作品の設定（novel.json）の画面に出すもの（vscode API に依存しない）。
 * 部の境界を選ぶための原稿ファイルの並びと章番号、出力の format ごとの項目、out を省いたときの出力先を作る。
 */

import { readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { normalizeOutputs, OUTPUT_FORMATS, outputKeys } from '../../src/build.mjs';
import { readParts } from '../../src/config.mjs';
import {
  CHARACTERS_FILENAME,
  collectInputFiles,
  computeSectionLabels,
  matchPartIndices,
  SYNOPSIS_FILENAME,
} from '../../src/lib/manuscript.mjs';
import { readLines } from '../../src/lib/text-parser.mjs';
import schema from '../schemas/novel.schema.json' with { type: 'json' };
import { headingOf } from './document.mjs';

/**
 * 設定の input（無ければ ["."]）の原稿ファイルを、novel pdf と同じ並びと章番号（parts があれば「部-章」）で返す。
 * 返す値: { files, missing: どのファイルにも当たらない parts の指定, error: 原稿を読めなかったときの理由 }。
 * files の要素: { name: 設定ファイルのディレクトリからのパス, token: ファイル名の先頭の番号（無ければ null）,
 *   title: 【】の見出し（見出しで始まらなければ null）, label: 章番号, startsPart: そのファイルから新しい部か }
 */
export function describeWorkFiles(configDir, raw, { linesOf = readLines } = {}) {
  const input = Array.isArray(raw?.input) && raw.input.length > 0 ? raw.input : ['.'];
  let paths;
  try {
    paths = collectInputFiles(
      input.map((p) => resolve(configDir, String(p))),
      [SYNOPSIS_FILENAME, CHARACTERS_FILENAME],
    );
  } catch (err) {
    return { files: [], missing: [], error: err.message };
  }
  const parts = readParts(raw);
  const matched = parts ? matchPartIndices(parts, paths) : { indices: [], missing: [] };
  const starts = new Set(matched.indices.filter((i) => i > 0));
  const labels = computeSectionLabels(paths, parts ? [...starts] : null);
  const files = paths.map((path, i) => {
    const title = headingOf(linesOf(path));
    return {
      name: relative(configDir, path),
      token: path.split(/[\\/]/).pop().match(/^\d+/)?.[0] ?? null,
      title,
      label: title === null ? null : labels[i],
      startsPart: starts.has(i),
    };
  });
  return { files, missing: matched.missing, error: null };
}

/**
 * 原稿の欄で選べるディレクトリ。configDir と、その下（3階層まで）で .txt を直に含むディレクトリを、
 * configDir からのパス（configDir 自身は "."）で返す。. で始まるものと node_modules はたどらない
 */
export function manuscriptDirs(configDir, depth = 3) {
  const dirs = [];
  const walk = (dir, level) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name.endsWith('.txt'))) dirs.push(relative(configDir, dir) || '.');
    if (level >= depth) return;
    for (const e of entries)
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(join(dir, e.name), level + 1);
  };
  walk(configDir, 0);
  return dirs.sort((a, b) => (a === '.' ? -1 : b === '.' ? 1 : a.localeCompare(b)));
}

/** 項目名 → 画面に出す名前 */
const FIELD_LABELS = {
  id: 'ID',
  title: 'タイトル',
  author: '著者名',
  genre: 'ジャンル',
  target: '想定読者',
  input: '原稿',
  parts: '部の境界',
  sceneBreak: '場面区切りの記号',
  sceneBreakIndent: '区切りの字下げ（字数）',
  writingMode: '文字方向',
  chars: '1行の字数',
  lines: '1ページの行数',
  coverless: '表紙なし',
  chapterBreak: '章ごとに改ページ',
  pageBreak: '章ごとに改ページ（chapterBreak と同じ）',
  synopsis: '梗概を入れる',
  synopsisOnTitle: '梗概をタイトルページに出す',
  blankAfterHeading: '章見出しの後に空行',
  review: '下読み用（先頭の約2万字）',
  recto: '章を右ページから',
  smartQuotes: 'カーリー引用符にする',
  size: '判型',
  dark: '黒背景・白文字',
  rubyParens: 'ルビを括弧表記に',
  contact: '連絡先（1行ずつ）',
};

/** 作品の項目（トップレベル）と、英語の出力の項目（"english" の中）の名前 */
const WORK_KEYS = ['id', 'title', 'author', 'genre', 'target', 'input', 'sceneBreak', 'sceneBreakIndent'];
const ENGLISH_KEYS = ['title', 'author', 'input', 'sceneBreak'];

const typesOf = (prop) => (Array.isArray(prop.type) ? prop.type : prop.type ? [prop.type] : []);

/**
 * スキーマの1項目を、画面の入力欄の種類にする。
 * kind: 'boolean' / 'enum'（options から選ぶ）/ 'integer' / 'number' / 'list'（文字列の配列）/ 'string'。
 * label: 画面に出す名前、nullable: null（その出力では使わない）を書けるか
 */
function fieldOf(key, prop) {
  const types = typesOf(prop);
  const nullable = types.includes('null');
  const base = { key, label: FIELD_LABELS[key] ?? key, description: prop.description ?? '', nullable };
  if (prop.enum) return { ...base, kind: 'enum', options: prop.enum };
  if (types.includes('boolean')) return { ...base, kind: 'boolean' };
  if (types.includes('array')) return { ...base, kind: 'list' };
  if (types.includes('integer')) return { ...base, kind: 'integer', min: prop.minimum, max: prop.maximum };
  if (types.includes('number')) return { ...base, kind: 'number', min: prop.minimum, max: prop.maximum };
  return { ...base, kind: 'string' };
}

/** format → その出力に書ける項目の入力欄（format / out を除く。並びは novel build が読む順） */
export function outputFields() {
  const props = schema.definitions.output.properties;
  return Object.fromEntries(
    OUTPUT_FORMATS.map((format) => [
      format,
      outputKeys(format)
        .filter((key) => key !== 'format' && key !== 'out')
        .map((key) => fieldOf(key, props[key])),
    ]),
  );
}

/** 作品の項目 { work: トップレベル, english: "english" の中 } の入力欄 */
export function workFields() {
  return {
    work: WORK_KEYS.map((key) => fieldOf(key, schema.properties[key])),
    english: ENGLISH_KEYS.map((key) => fieldOf(key, schema.properties.english.properties[key])),
  };
}

/** format の説明（スキーマの format の description から、「pdf: …」の部分を抜き出したもの） */
export function formatDescriptions() {
  const text = schema.definitions.output.properties.format.description;
  return Object.fromEntries(
    OUTPUT_FORMATS.map((format) => [format, text.match(new RegExp(`[、。]${format}: ([^、）]+)`))?.[1] ?? '']),
  );
}

/**
 * 出力名 → out を省いたときの出力先（novel build と同じ決め方）。決められない出力（id も title も無いなど）は null。
 * 出力の書き方が誤っていればその理由を error に返す
 */
export function describeOutputs(raw) {
  const outputs = raw?.outputs ?? {};
  const id = raw?.id ?? raw?.title ?? null;
  let error = null;
  try {
    normalizeOutputs(outputs, id);
  } catch (err) {
    error = err.message;
  }
  const entries = Array.isArray(outputs) ? outputs.map((name) => [name, true]) : Object.entries(outputs);
  const defaultOut = Object.fromEntries(
    entries.map(([name, value]) => {
      const output = value && typeof value === 'object' ? { ...value, out: null } : {};
      try {
        return [name, normalizeOutputs({ [name]: output }, id)[name].out];
      } catch {
        return [name, null];
      }
    }),
  );
  return { defaultOut, error };
}

/** novel.json に書く文字列（2字下げの JSON と末尾の改行。拡張が書くほかの設定と同じ） */
export const serializeWork = (raw) => `${JSON.stringify(raw, null, 2)}\n`;

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest;
  const { mkdirSync, mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { dirname, join } = await import('node:path');

  const withWork = (files, fn) => {
    const dir = mkdtempSync(join(tmpdir(), 'novel-settings-'));
    try {
      for (const [name, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, name)), { recursive: true });
        writeFileSync(join(dir, name), content);
      }
      return fn(dir);
    } finally {
      rmSync(dir, { recursive: true });
    }
  };

  describe('describeWorkFiles', () => {
    test('原稿を novel pdf の並びで返し、parts の境界から「部-章」で採番する', () => {
      withWork(
        {
          '010.txt': '【旅立ち】\n一\n',
          '020.txt': '続き\n',
          '050.txt': '【】\n二\n',
          '100.txt': '【】\n三\n',
          'synopsis.txt': '梗概\n',
        },
        (dir) => {
          const { files, missing, error } = describeWorkFiles(dir, { parts: ['050', '999'] });
          expect(error).toBeNull();
          expect(missing).toEqual(['999']);
          expect(files).toEqual([
            { name: '010.txt', token: '010', title: '旅立ち', label: '1', startsPart: false },
            { name: '020.txt', token: '020', title: null, label: null, startsPart: false },
            { name: '050.txt', token: '050', title: '', label: '2-1', startsPart: true },
            { name: '100.txt', token: '100', title: '', label: '2-2', startsPart: false },
          ]);
          expect(describeWorkFiles(dir, {}).files.map((f) => f.label)).toEqual(['1', null, '2', '3']);
        },
      );
    });
    test('input のディレクトリが無ければ error を返す', () => {
      withWork({}, (dir) => {
        expect(describeWorkFiles(dir, { input: ['no-such-dir'] }).error).toMatch(/no-such-dir/);
      });
    });
  });

  describe('outputFields', () => {
    test('format ごとに書ける項目を、スキーマの型から入力欄の種類にする', () => {
      const fields = outputFields();
      expect(Object.keys(fields)).toEqual(OUTPUT_FORMATS);
      const pdf = Object.fromEntries(fields.pdf.map((f) => [f.key, f]));
      expect(pdf.coverless.kind).toBe('boolean');
      expect(pdf.parts).toBeUndefined();
      expect(pdf.writingMode).toMatchObject({ kind: 'enum', options: ['vertical', 'horizontal'] });
      expect(pdf.lines).toMatchObject({ kind: 'integer', nullable: true });
      expect(pdf.title).toMatchObject({ kind: 'string', nullable: true });
      expect(pdf.format).toBeUndefined();
      expect(fields['novel-pdf'].map((f) => f.key)).toContain('size');
    });
    test('出力と作品の項目には、すべて画面に出す名前がある', () => {
      const all = [...Object.values(outputFields()).flat(), ...workFields().work, ...workFields().english];
      expect(all.filter((f) => f.label === f.key).map((f) => f.key)).toEqual([]);
      expect(workFields().work.find((f) => f.key === 'input').kind).toBe('list');
    });
    test('format の説明をスキーマから取る', () => {
      expect(formatDescriptions()).toMatchObject({ pdf: '縦書き/横書き PDF', 'pdf-en': '英語のペーパーバック風 PDF' });
    });
  });

  describe('manuscriptDirs', () => {
    test('.txt を直に含むディレクトリを、設定ファイルのディレクトリからのパスで返す', () => {
      withWork(
        {
          'note.txt': '',
          'ja/010.txt': '',
          'en/010.txt': '',
          'story/part1/010.txt': '',
          'out/a.pdf': '',
          '.git/x.txt': '',
          'node_modules/m/x.txt': '',
        },
        (dir) => {
          expect(manuscriptDirs(dir)).toEqual(['.', 'en', 'ja', join('story', 'part1')]);
        },
      );
    });
  });

  describe('describeOutputs', () => {
    test('out を省いた出力の出力先を novel build と同じに決める', () => {
      const { defaultOut, error } = describeOutputs({
        title: '作品',
        outputs: { pdf: { coverless: true }, review: { format: 'pdf' }, epub: { out: 'x.epub' } },
      });
      expect(error).toBeNull();
      expect(defaultOut).toEqual({ pdf: '作品.pdf', review: '作品-review.pdf', epub: '作品.epub' });
      expect(describeOutputs({ id: 'w', outputs: ['pdf-en'] }).defaultOut).toEqual({ 'pdf-en': 'w-en.pdf' });
    });
    test('書き方の誤りは error に返す', () => {
      expect(describeOutputs({ outputs: { x: { format: 'odt' } } }).error).toMatch(/odt/);
      expect(describeOutputs({ outputs: { pdf: {} } }).defaultOut).toEqual({ pdf: null });
    });
  });
}
