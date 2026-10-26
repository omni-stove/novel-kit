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
import { t } from './l10n.mjs';

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
const fieldLabels = () => ({
  id: t('ID'),
  title: t('Title'),
  author: t('Author'),
  genre: t('Genre'),
  target: t('Target readers'),
  input: t('Manuscript'),
  parts: t('Part boundaries'),
  sceneBreak: t('Scene break mark'),
  sceneBreakIndent: t('Separator indent (characters)'),
  writingMode: t('Writing direction'),
  chars: t('Characters per line'),
  lines: t('Lines per page'),
  coverless: t('No cover'),
  chapterBreak: t('New page for each chapter'),
  pageBreak: t('New page for each chapter (same as chapterBreak)'),
  synopsis: t('Include the synopsis'),
  synopsisOnTitle: t('Synopsis on the title page'),
  blankAfterHeading: t('Blank line after chapter headings'),
  review: t('For first readers (about the first 20,000 characters)'),
  recto: t('Chapters start on a right-hand page'),
  smartQuotes: t('Curly quotes'),
  size: t('Trim size'),
  dark: t('White on black'),
  rubyParens: t('Ruby in parentheses'),
  contact: t('Contact (one per line)'),
});

/**
 * 入力欄の説明（work: トップレベル、english: "english" の中、output: 出力の項目）。
 * スキーマの description の英訳で、日本語の訳はスキーマの description と同じ文にする（テストで確かめる）
 */
const fieldDescriptions = () => ({
  work: {
    id: t('Base of output file names (defaults to title). novel build names the outputs without out after it'),
    title: t('Title of the work (used on the PDF title page and running heads)'),
    author: t('Author name'),
    genre: t('Genre (put at the top of the split / merge outputs)'),
    target: t('Target readers (put at the top of the split / merge outputs)'),
    input: t(
      'Manuscript files or directories (relative to the directory of this settings file, joined in order. Defaults to ["."])',
    ),
    sceneBreak: t(
      'Mark set in Japanese outputs for scene breaks (lines of * / *** / * * * in the manuscript) and for the seams of files that end mid-chapter (default ＊). Example: "＊　＊　＊"',
    ),
    sceneBreakIndent: t(
      'In Japanese outputs, place separator lines (scene breaks and lines of marks only, such as ◇◇◇) this many characters from the line start instead of centered (centered by default; the split / merge text puts them at the line start). Centering is half a character off the grid when (characters per line − characters of the mark) is odd, so use this to keep to the grid. Example: 19 to put ＊ in the center cell of a 40-character line',
    ),
  },
  english: {
    title: t('Title of the English outputs (pdf-en / rtf-en) (defaults to the title of the work)'),
    author: t('Author name of the English outputs (pdf-en / rtf-en) (defaults to the author of the work)'),
    input: t(
      'Manuscript of the English outputs (pdf-en / rtf-en) (relative to the directory of this settings file. Defaults to ["en"])',
    ),
    sceneBreak: t(
      'Mark set for scene breaks in English outputs (pdf-en and the preview) (default * * *; spaces become letter spacing)',
    ),
  },
  output: {
    title: t(
      'Title for this output only (defaults to the title of the work — for pdf-en / rtf-en, that of english if any; null leaves it out)',
    ),
    author: t(
      'Author name for this output only (defaults to the author of the work — for pdf-en / rtf-en, that of english if any; null leaves it out)',
    ),
    input: t(
      'Manuscript for this output only (defaults to the input of the work — for pdf-en / rtf-en, that of english if any)',
    ),
    writingMode: t('Writing direction (vertical / horizontal)'),
    chars: t('Number of characters per line'),
    lines: t('Lines per page (null for automatic leading)'),
    coverless: t('Make no cover, and put the title and author at body size at the head of the synopsis and the body'),
    chapterBreak: t('false to not start a new page for each chapter (pdf / rtf / rtf-en / docx)'),
    pageBreak: t('Same as chapterBreak. false to not start a new page for each chapter (pdf)'),
    synopsis: t('false to leave out the synopsis (synopsis.txt)'),
    synopsisOnTitle: t('Put the synopsis on the title page'),
    blankAfterHeading: t('Add a blank line between chapter headings (viewpoint lines) and the body'),
    review: t(
      'For first readers. Ignore the cover, synopsis, character list and parts, and typeset about the first 20,000 characters',
    ),
    recto: t('Always start chapters on a right-hand page'),
    smartQuotes: t('false to not turn straight quotes into curly quotes'),
    genre: t('Genre for this output only (split / merge)'),
    target: t('Target readers for this output only (split / merge)'),
    size: t('Trim size of novel-pdf (default a6)'),
    dark: t('Make novel-pdf white text on black'),
    rubyParens: t('Write ruby in parentheses, as 漢字（かんじ）, in rtf / merge'),
    contact: t('Contact details at the top left of the first page of rtf-en (one line per item)'),
    sceneBreak: t(
      'Scene break mark for this output only (defaults to sceneBreak; english.sceneBreak for pdf-en, # for rtf-en)',
    ),
    sceneBreakIndent: t(
      'Indent of separator lines for this output only (in characters; null to center; defaults to sceneBreakIndent). pdf / novel-pdf / epub / rtf / docx / split / merge',
    ),
  },
});

/** 作品の項目（トップレベル）と、英語の出力の項目（"english" の中）の名前 */
const WORK_KEYS = ['id', 'title', 'author', 'genre', 'target', 'input', 'sceneBreak', 'sceneBreakIndent'];
const ENGLISH_KEYS = ['title', 'author', 'input', 'sceneBreak'];

const typesOf = (prop) => (Array.isArray(prop.type) ? prop.type : prop.type ? [prop.type] : []);

/**
 * スキーマの1項目を、画面の入力欄の種類にする。
 * kind: 'boolean' / 'enum'（options から選ぶ）/ 'integer' / 'number' / 'list'（文字列の配列）/ 'string'。
 * label: 画面に出す名前、description: 説明（section の fieldDescriptions）、nullable: null（その出力では使わない）を書けるか
 */
function fieldOf(key, prop, section) {
  const types = typesOf(prop);
  const nullable = types.includes('null');
  const base = {
    key,
    label: fieldLabels()[key] ?? key,
    description: fieldDescriptions()[section][key] ?? '',
    nullable,
  };
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
        .map((key) => fieldOf(key, props[key], 'output')),
    ]),
  );
}

/** 作品の項目 { work: トップレベル, english: "english" の中 } の入力欄 */
export function workFields() {
  return {
    work: WORK_KEYS.map((key) => fieldOf(key, schema.properties[key], 'work')),
    english: ENGLISH_KEYS.map((key) => fieldOf(key, schema.properties.english.properties[key], 'english')),
  };
}

/** format の説明。日本語の訳は、スキーマの format の description の「pdf: …」の部分と同じ文にする（テストで確かめる） */
export const formatDescriptions = () => ({
  pdf: t('Vertical/horizontal PDF'),
  'pdf-en': t('English paperback-style PDF'),
  'novel-pdf': t('Bunko-style two-page spread PDF'),
  epub: '',
  rtf: t('RTF of a Japanese manuscript'),
  'rtf-en': t('RTF in Shunn format'),
  docx: t('Vertical Word document'),
  split: t('One txt per chapter'),
  merge: t('All in one txt'),
});

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
  const { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } = await import('node:fs');
  const { setBundle } = await import('./l10n.mjs');
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
    test('format の説明は、すべての形式にある', () => {
      expect(Object.keys(formatDescriptions())).toEqual(OUTPUT_FORMATS);
    });
    test('日本語の表示では、入力欄と format の説明がスキーマの description と同じ', () => {
      setBundle(JSON.parse(readFileSync(new URL('../l10n/bundle.l10n.ja.json', import.meta.url), 'utf8')));
      try {
        const props = { output: schema.definitions.output.properties, work: schema.properties };
        const english = schema.properties.english.properties;
        const shown = [
          ...Object.values(outputFields())
            .flat()
            .map((f) => [f.description, props.output[f.key].description]),
          ...workFields().work.map((f) => [f.description, props.work[f.key].description]),
          ...workFields().english.map((f) => [f.description, english[f.key].description]),
        ];
        expect(shown.filter(([a, b]) => a !== b)).toEqual([]);
        const formats = props.output.format.description;
        const fromSchema = (format) => formats.match(new RegExp(`[、。]${format}: ([^、）]+)`))?.[1] ?? '';
        expect(formatDescriptions()).toEqual(Object.fromEntries(OUTPUT_FORMATS.map((f) => [f, fromSchema(f)])));
      } finally {
        setBundle(undefined);
      }
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
