/**
 * novel build: 作品の設定ファイル（novel.json）の "outputs" に書いた出力を作る。
 *
 * 使い方:
 *   novel build <作品のディレクトリ or novel.json> [出力名...] [--out-dir dir] [--pages 42,50-53] [--limit n] [--target 読者] [--ruby-parens]
 *   出力名を省略すると、"outputs" のすべてを作る。
 *   出力は --out-dir のディレクトリ（プロジェクトのルートから。絶対パスも可。省略時は out）に出す。
 *   --pages / --limit は pdf、--target は split / merge、--ruby-parens は merge の出力にだけ効く。
 *
 * 設定ファイル（パスは設定ファイルのディレクトリから）:
 *   {
 *     "id": "work",                                    // 出力ファイル名のもと（省略時は title）
 *     "title": "作品名", "author": "著者名", "genre": "SF", "target": "想定読者",
 *     "input": ["."],                                  // 原稿のファイルかディレクトリ（並び順どおりに連結）
 *     "parts": ["070", "085"],                         // 部の境界になるファイル名の先頭の番号
 *     "chars": 40, "lines": 40, ...                    // 日本語のレイアウト（プレビューと共通）
 *     "english": { "title": "Title", "paper": "6x9in", ... },  // 英語の出力の作品の項目と、英語のレイアウト
 *     "outputs": {
 *       "pdf": { "coverless": true },                  // 出力名が format なら format は省ける
 *       "review": { "format": "pdf", "review": true },
 *       "pdf-en": true,                                // 項目が無ければ true
 *       "epub": { "out": "作品名.epub" }                 // out は出力先ディレクトリから
 *     }
 *   }
 * "outputs" は出力名の配列（["pdf", "epub"]）でも書ける。
 * out を省くと id と format（format と違う出力名ならその名前）から決める。
 * プロジェクトのルートは、設定ファイルから上へたどって最初に package.json があるディレクトリ。
 * 作品の項目（title / author / genre / target / input / parts）は出力ごとに上書きでき、null を書けばその出力では使わない。
 * 英語の出力（pdf-en / rtf-en）の title / author / input は "english" に書いたものを先に使う（input の既定は ["en"]）。
 * レイアウトの "writingMode" / "chars" / "lines" も出力ごとに上書きできる。
 * 場面区切り（原稿の * の行）の記号は "sceneBreak"（日本語の出力）/ "english": { "sceneBreak" }（pdf-en）に書き、
 * 出力ごとの "sceneBreak" で上書きできる（rtf-en は出力ごとの指定だけ。省略時は #）。
 *
 * format（novel <format> と同じコマンドで作る）と、それぞれの項目:
 *   pdf        縦書き（横書き）の PDF。coverless, chapterBreak（false で章ごとに改ページしない）,
 *              pageBreak（false でファイル間で改ページしない）, synopsis（false で梗概を入れない）,
 *              synopsisOnTitle, blankAfterHeading, review
 *   pdf-en     英語のペーパーバック風 PDF。recto, smartQuotes（false でカーリー引用符にしない）。判型は英語のレイアウトの用紙から選ぶ
 *   novel-pdf  文庫本見開きの縦書き PDF。size（"a6" / "b6" / "a5"）, dark, blankAfterHeading
 *   epub       EPUB。縦書きか横書きかはレイアウトの writingMode
 *   rtf        日本語原稿の RTF。rubyParens, chapterBreak, contact
 *   rtf-en     英語投稿用（Shunn 形式）の RTF。rubyParens, chapterBreak, contact
 *   split      章ごとの txt（out はディレクトリ）。input はディレクトリ1つ
 *   merge      1つにまとめた txt。input はディレクトリ1つ。rubyParens
 * parts を使うのは pdf / pdf-en / split / merge。
 */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { CONFIG_FILENAME, findConfigFile, readWorkConfig } from './config.mjs';
import { computeMetrics, enPdfPageSize, matchesPdfScriptPage } from './layout.mjs';
import { fail } from './lib/cli.mjs';

const LAYOUT_OVERRIDES = ['writingMode', 'chars', 'lines'];

function findProjectRoot(dir) {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, 'package.json'))) return d;
    if (dirname(d) === d) return dir;
  }
}

function locateConfig(target) {
  const path = resolve(target);
  if (!existsSync(path)) fail(`${target} が見つかりません`);
  if (statSync(path).isFile()) return path;
  const file = findConfigFile(path, findProjectRoot(path));
  if (!file) fail(`${target} から上に ${CONFIG_FILENAME} が見つかりません`);
  return file;
}

/** 実行しているディレクトリからの相対パスにする（ログを読みやすくするため）。外にあるものは絶対パスのまま */
const cwdRelative = (path) => {
  const rel = relative(process.cwd(), path);
  return rel.startsWith('..') ? path : rel || '.';
};

const flag = (cond, name) => (cond ? [name] : []);
const option = (value, name) => (value == null ? [] : [name, String(value)]);

const ENGLISH_FORMATS = ['pdf-en', 'rtf-en'];

/** 作品の項目を出力ごとに上書きする。出力に書いてあれば null でもそれを使う。英語の出力は次に english の項目を見る */
function workValue(output, config, key) {
  if (key in output) return output[key];
  if (ENGLISH_FORMATS.includes(output.format) && key in config.en) return config.en[key];
  return config[key];
}

/** 場面区切りの記号。出力に書いてあればそれ、無ければ作品の設定（どちらも無ければコマンドの既定） */
const sceneBreakArgs = (output, workMark) => option(output.sceneBreak ?? workMark, '--scene-break');

function layoutOf(output, config) {
  const layout = { ...config.layout };
  for (const key of LAYOUT_OVERRIDES) if (key in output) layout[key] = output[key];
  return layout;
}

function pdfArgs(output, config, { warn, pages, limit }) {
  const layout = layoutOf(output, config);
  if (!matchesPdfScriptPage(layout))
    warn('PDF は A4横・既定の余白で組みます（用紙・余白の設定はプレビューにだけ効きます）');

  let size = [];
  if (layout.writingMode === 'horizontal') size = ['--horizontal'];
  else if (layout.lines != null) size = ['--size', `${layout.chars}x${computeMetrics(layout).lines}`];
  else if (layout.chars !== 30) size = ['--chars', String(layout.chars)];

  return [
    ...size,
    ...flag(output.coverless, '--coverless'),
    ...flag(output.chapterBreak === false, '--no-chapter-break'),
    ...flag(output.pageBreak === false, '--no-page-break'),
    ...flag(output.synopsis === false, '--no-synopsis'),
    ...flag(output.synopsisOnTitle, '--synopsis-on-title'),
    ...flag(output.blankAfterHeading, '--blank-after-heading'),
    ...flag(output.review, '--review'),
    ...option(workValue(output, config, 'parts')?.join(','), '--part'),
    ...sceneBreakArgs(output, config.sceneBreak?.ja),
    ...option(pages, '--pages'),
    ...option(limit, '--limit'),
  ];
}

function enPdfArgs(output, config, { warn }) {
  const pageSize = enPdfPageSize(config.english);
  if (!pageSize)
    warn(
      '英語の PDF は 6×9in / 5×8in / A5（縦）のどれかで組みます。英語のレイアウトの用紙がどれでもないため 6×9in にします',
    );
  return [
    `--${pageSize ?? '6x9'}`,
    ...flag(output.recto, '--recto'),
    ...flag(output.smartQuotes === false, '--no-smart-quotes'),
    ...option(workValue(output, config, 'parts')?.join(','), '--part'),
    ...sceneBreakArgs(output, config.sceneBreak?.en),
  ];
}

const novelPdfArgs = (output, config) => [
  ...(output.size ? [`--${output.size}`] : []),
  ...flag(output.dark, '--dark'),
  ...flag(output.blankAfterHeading, '--blank-after-heading'),
  ...sceneBreakArgs(output, config.sceneBreak?.ja),
];

const epubArgs = (output, config) => [
  ...flag(layoutOf(output, config).writingMode === 'horizontal', '--horizontal'),
  ...sceneBreakArgs(output, config.sceneBreak?.ja),
];

/** rtf（日本語）は作品の sceneBreak、rtf-en（Shunn 形式）は出力ごとの指定だけを使う */
const rtfArgs = (style) => (output, config) => [
  style,
  ...option(output.contact?.join(';'), '--contact'),
  ...flag(output.rubyParens, '--ruby-parens'),
  ...flag(output.chapterBreak === false, '--no-chapter-break'),
  ...sceneBreakArgs(output, style === '--ja' ? config.sceneBreak?.ja : null),
];

/** split / merge は <原稿のディレクトリ> <出力先> <作品名> <ジャンル> を順に受け取る */
function textArgv(output, config, out, { target, rubyParens }, { merge }) {
  const input = workValue(output, config, 'input');
  if (input?.length !== 1) fail(`${output.format} の input は原稿のディレクトリ1つにしてください`);
  const parts = workValue(output, config, 'parts');
  return [
    cwdRelative(join(config.dir, input[0])),
    out,
    workValue(output, config, 'title') ?? '',
    workValue(output, config, 'genre') ?? '',
    ...(parts ? [`--splits=${parts.join(',')}`] : []),
    ...option(target ?? workValue(output, config, 'target'), '--target'),
    ...flag(merge && (rubyParens || output.rubyParens), '--ruby-parens'),
    ...sceneBreakArgs(output, config.sceneBreak?.ja),
  ];
}

/**
 * load: 実行するコマンドのモジュール。args: そのコマンドに渡すオプション（ファイルを作る形式）か、
 * argv: 引数全体（split / merge）。open: 作ったファイルを --open で開くか。
 * file: out を省いたときに id に付ける [接尾辞, 拡張子]
 */
const FORMATS = {
  pdf: { load: () => import('./pdf.mjs'), args: pdfArgs, open: true, file: ['', '.pdf'] },
  'pdf-en': { load: () => import('./en-pdf.mjs'), args: enPdfArgs, open: true, file: ['-en', '.pdf'] },
  'novel-pdf': { load: () => import('./novel-pdf.mjs'), args: novelPdfArgs, open: true, file: ['-novel', '.pdf'] },
  epub: { load: () => import('./epub.mjs'), args: epubArgs, open: false, file: ['', '.epub'] },
  rtf: { load: () => import('./rtf.mjs'), args: rtfArgs('--ja'), open: true, file: ['', '.rtf'] },
  'rtf-en': { load: () => import('./rtf.mjs'), args: rtfArgs('--shunn'), open: true, file: ['-en', '.rtf'] },
  split: {
    load: () => import('./split.mjs'),
    argv: (...a) => textArgv(...a, { merge: false }),
    file: ['-chapters', ''],
  },
  merge: { load: () => import('./merge.mjs'), argv: (...a) => textArgv(...a, { merge: true }), file: ['-all', '.txt'] },
};

/**
 * 設定の "outputs"（出力名の配列か、出力名 → 項目。項目が無ければ true）を、出力名 → { format, out, ...項目 } にそろえる。
 * format の既定は出力名、out の既定は id と format（format と違う出力名ならその名前）から決める
 */
export function normalizeOutputs(outputs, id) {
  const entries = Array.isArray(outputs) ? outputs.map((name) => [name, true]) : Object.entries(outputs ?? {});
  return Object.fromEntries(
    entries.map(([name, value]) => {
      const output = value === true ? {} : value;
      if (!output || typeof output !== 'object') fail(`出力 "${name}" は項目のオブジェクトか true にしてください`);
      const format = output.format ?? name;
      if (!FORMATS[format])
        fail(`出力 "${name}" の format "${format}" には対応していません（${Object.keys(FORMATS).join(' / ')}）`);
      if (output.out != null) return [name, { ...output, format }];
      if (!id) fail(`出力 "${name}" の out を決められません（out か、作品の id / title を書いてください）`);
      const [suffix, ext] = FORMATS[format].file;
      return [name, { ...output, format, out: `${id}${name === format ? suffix : `-${name}`}${ext}` }];
    }),
  );
}

/** その場かぎりの指定として、設定に書いた出力に足すもの（--pages / --limit / --target / --ruby-parens / --out-dir）と出力名 */
function passThroughArgs(argv) {
  const parsed = { pages: null, limit: null, target: null, rubyParens: false, outDir: null, names: [] };
  for (let i = 0; i < argv.length; i++) {
    const [name, inline] = argv[i].split(/=(.*)/s);
    if (['--pages', '--limit', '--target'].includes(name)) parsed[name.slice(2)] = inline ?? argv[++i];
    else if (name === '--out-dir') parsed.outDir = inline ?? argv[++i];
    else if (name === '--ruby-parens') parsed.rubyParens = true;
    else if (argv[i].startsWith('-')) fail(`不明なオプション: ${argv[i]}`);
    else parsed.names.push(argv[i]);
  }
  return parsed;
}

/** 出力先ディレクトリ（--out-dir）の既定。--out-dir はプロジェクトのルートから（絶対パスも可） */
const DEFAULT_OUT_DIR = 'out';

export function outputPath(output, root, { outDir = null, pages = null } = {}) {
  const dir = resolve(root, outDir ?? DEFAULT_OUT_DIR);
  // 抜き出した版で全体版を上書きしないよう、出力名に -p<指定> を付ける
  const file = output.format === 'pdf' && pages ? output.out.replace(/(\.pdf)?$/, `-p${pages}.pdf`) : output.out;
  return resolve(dir, file);
}

/** 1つの出力（normalizeOutputs でそろえたもの）を、その format のコマンドに渡す引数にする */
export function outputArgv(name, output, config, root, extra = {}, warn = () => {}) {
  const format = FORMATS[output.format];
  const out = cwdRelative(outputPath(output, root, extra));
  if (format.argv) return format.argv(output, config, out, extra);

  return [
    ...option(workValue(output, config, 'title'), '--title'),
    ...option(workValue(output, config, 'author'), '--author'),
    ...format.args(output, config, { ...extra, warn: (message) => warn(`${name}: ${message}`) }),
    '-o',
    out,
    ...workValue(output, config, 'input').map((p) => cwdRelative(join(config.dir, p))),
    ...flag(format.open, '--open'),
  ];
}

export async function main(argv = process.argv.slice(2)) {
  const [target, ...rest] = argv;
  if (!target) fail('作品のディレクトリか novel.json を指定してください（例: novel build src/od/story pdf）');
  const file = locateConfig(target);
  const config = readWorkConfig(file);
  const root = findProjectRoot(config.dir);
  const { names, ...extra } = passThroughArgs(rest);
  const outputs = normalizeOutputs(config.outputs, config.id);

  const available = Object.keys(outputs);
  if (available.length === 0) fail(`${cwdRelative(file)} に outputs がありません`);
  const missing = names.filter((n) => !available.includes(n));
  if (missing.length > 0)
    fail(`${cwdRelative(file)} に出力 ${missing.join(', ')} がありません（あるのは ${available.join(', ')}）`);

  for (const name of names.length > 0 ? names : available) {
    const output = outputs[name];
    const outArgv = outputArgv(name, output, config, root, extra, (message) => console.warn(`警告: ${message}`));
    mkdirSync(dirname(outputPath(output, root, extra)), { recursive: true });
    console.log(`\n▶ ${name}: novel ${output.format} ${outArgv.join(' ')}`);
    await (await FORMATS[output.format].load()).main(outArgv);
  }
}

if (import.meta.vitest) {
  const { describe, test, expect, vi } = import.meta.vitest;
  const { DEFAULT_LAYOUT, DEFAULT_ENGLISH_LAYOUT } = await import('./layout.mjs');

  const config = (overrides = {}) => ({
    dir: '/p/src/work/story',
    id: 'w',
    en: { input: ['en'] },
    title: '作品',
    author: '著者',
    genre: null,
    target: null,
    input: ['.'],
    parts: null,
    layout: DEFAULT_LAYOUT,
    english: DEFAULT_ENGLISH_LAYOUT,
    view: {},
    outputs: {},
    ...overrides,
  });
  const argvOf = (output, c = config(), extra) => outputArgv('x', output, c, '/p', extra);

  describe('outputArgv', () => {
    test('既定のレイアウト（30字・行数自動）なら字詰めの指定を付けない', () => {
      const argv = outputArgv('pdf', { format: 'pdf', out: 'a.pdf' }, config(), process.cwd());
      expect(argv).toEqual(['--title', '作品', '--author', '著者', '-o', 'out/a.pdf', '/p/src/work/story', '--open']);
    });

    test('字数×行数はレイアウトから、出力の指定があればそちらを使う', () => {
      expect(
        argvOf({ format: 'pdf', out: 'a.pdf' }, config({ layout: { ...DEFAULT_LAYOUT, chars: 42, lines: 34 } })),
      ).toContain('42x34');
      expect(
        argvOf(
          { format: 'pdf', out: 'a.pdf', chars: 30, lines: null },
          config({ layout: { ...DEFAULT_LAYOUT, chars: 40, lines: 40 } }),
        ),
      ).not.toContain('--size');
      expect(argvOf({ format: 'pdf', out: 'a.pdf', chars: 40 })).toEqual(expect.arrayContaining(['--chars', '40']));
      expect(argvOf({ format: 'pdf', out: 'a.pdf', writingMode: 'horizontal' })).toContain('--horizontal');
    });

    test('pdf の項目をフラグにする', () => {
      const argv = argvOf({
        format: 'pdf',
        out: 'a.pdf',
        coverless: true,
        chapterBreak: false,
        synopsis: false,
        blankAfterHeading: true,
        parts: ['070', '085'],
        review: true,
      });
      expect(argv).toEqual(
        expect.arrayContaining([
          '--coverless',
          '--no-chapter-break',
          '--no-synopsis',
          '--blank-after-heading',
          '--review',
          '--part',
          '070,085',
        ]),
      );
      expect(argv).not.toContain('--no-page-break');
    });

    test('英語の出力の title / author / input は english の項目、無ければ作品の項目', () => {
      const c = config({ en: { title: 'Work', input: ['en'] } });
      const argv = argvOf({ format: 'pdf-en', out: 'a.pdf' }, c);
      expect(argv.slice(0, 4)).toEqual(['--title', 'Work', '--author', '著者']);
      expect(argv.at(-2)).toBe('/p/src/work/story/en');
      expect(argvOf({ format: 'rtf-en', out: 'a.rtf' }, c)).toEqual(expect.arrayContaining(['--title', 'Work']));
      expect(argvOf({ format: 'pdf', out: 'a.pdf' }, c).slice(0, 2)).toEqual(['--title', '作品']);
      expect(argvOf({ format: 'pdf-en', out: 'a.pdf', title: 'T' }, c).slice(0, 2)).toEqual(['--title', 'T']);
    });

    test('作品の項目は出力ごとに上書きでき、null ならその出力では使わない', () => {
      const argv = argvOf({
        format: 'pdf-en',
        out: 'a.pdf',
        title: 'Title',
        author: 'Author',
        input: ['intro.txt', 'en'],
      });
      expect(argv.slice(0, 4)).toEqual(['--title', 'Title', '--author', 'Author']);
      expect(argv.slice(-3, -1)).toEqual(['/p/src/work/story/intro.txt', '/p/src/work/story/en']);
      expect(argvOf({ format: 'pdf', out: 'a.pdf', title: null })).not.toContain('--title');
      expect(argvOf({ format: 'pdf', out: 'a.pdf' }, config({ parts: ['050'] }))).toEqual(
        expect.arrayContaining(['--part', '050']),
      );
      expect(argvOf({ format: 'pdf', out: 'a.pdf', parts: null }, config({ parts: ['050'] }))).not.toContain('--part');
    });

    test('pdf-en の判型は英語のレイアウトの用紙から選ぶ', () => {
      expect(argvOf({ format: 'pdf-en', out: 'a.pdf' })).toContain('--6x9');
      expect(
        argvOf({ format: 'pdf-en', out: 'a.pdf' }, config({ english: { ...DEFAULT_ENGLISH_LAYOUT, paper: '5x8in' } })),
      ).toContain('--5x8');
    });

    test('--pages を付けると pdf の出力名に -p<指定> を足す', () => {
      const argv = argvOf({ format: 'pdf', out: 'a.pdf' }, config(), { pages: '3-4' });
      expect(argv).toEqual(expect.arrayContaining(['--pages', '3-4', '/p/out/a-p3-4.pdf']));
    });

    test('出力先は --out-dir のディレクトリから（既定は out）', () => {
      const out = (extra) => argvOf({ format: 'epub', out: 'a.epub' }, config(), extra).at(-2);
      expect(out()).toBe('/p/out/a.epub');
      expect(out({ outDir: 'dist/books' })).toBe('/p/dist/books/a.epub');
      expect(out({ outDir: '/tmp/x' })).toBe('/tmp/x/a.epub');
    });

    test('novel-pdf / epub / rtf / rtf-en の項目をフラグにする（epub は開かない）', () => {
      expect(argvOf({ format: 'novel-pdf', out: 'a.pdf', dark: true, size: 'b6' })).toEqual(
        expect.arrayContaining(['--b6', '--dark', '--open']),
      );
      expect(argvOf({ format: 'epub', out: 'a.epub' })).not.toContain('--open');
      expect(argvOf({ format: 'epub', out: 'a.epub', writingMode: 'horizontal' })).toContain('--horizontal');
      expect(argvOf({ format: 'rtf', out: 'a.rtf', rubyParens: true })).toEqual(
        expect.arrayContaining(['--ja', '--ruby-parens']),
      );
      expect(argvOf({ format: 'rtf-en', out: 'a.rtf', contact: ['Name', 'Mail'] })).toEqual(
        expect.arrayContaining(['--shunn', '--contact', 'Name;Mail']),
      );
    });

    test('場面区切りは出力ごとの指定、無ければ作品の sceneBreak（pdf-en は english、rtf-en は出力ごとだけ）を渡す', () => {
      const c = config({ sceneBreak: { ja: '＊＊＊', en: '~' } });
      const mark = (output, cfg = c) => {
        const a = argvOf(output, cfg);
        const i = a.indexOf('--scene-break');
        return i < 0 ? null : a[i + 1];
      };
      expect(mark({ format: 'pdf', out: 'a.pdf' })).toBe('＊＊＊');
      expect(mark({ format: 'pdf', out: 'a.pdf', sceneBreak: '◆' })).toBe('◆');
      expect(mark({ format: 'pdf-en', out: 'a.pdf' })).toBe('~');
      expect(mark({ format: 'rtf', out: 'a.rtf' })).toBe('＊＊＊');
      expect(mark({ format: 'rtf-en', out: 'a.rtf' })).toBeNull();
      expect(mark({ format: 'merge', out: 'a.txt' })).toBe('＊＊＊');
      expect(mark({ format: 'epub', out: 'a.epub' }, config())).toBeNull();
    });

    test('split / merge は ディレクトリ・出力先・作品名・ジャンルを順に渡す', () => {
      const c = config({ genre: 'SF', target: '読者', parts: ['070'] });
      expect(argvOf({ format: 'split', out: 'w-chapters' }, c)).toEqual([
        '/p/src/work/story',
        '/p/out/w-chapters',
        '作品',
        'SF',
        '--splits=070',
        '--target',
        '読者',
      ]);
      expect(argvOf({ format: 'merge', out: 'w-all.txt', rubyParens: true }, config(), { target: '別の読者' })).toEqual(
        ['/p/src/work/story', '/p/out/w-all.txt', '作品', '', '--target', '別の読者', '--ruby-parens'],
      );
      expect(argvOf({ format: 'merge', out: 'a.txt' }, config(), { rubyParens: true })).toContain('--ruby-parens');
      expect(argvOf({ format: 'split', out: 'a' }, config(), { rubyParens: true })).not.toContain('--ruby-parens');
    });
  });

  describe('出力の項目', () => {
    const TEXT_KEYS = ['format', 'out', 'title', 'input', 'parts', 'genre', 'target', 'sceneBreak'];
    const WORK_KEYS = ['format', 'out', 'title', 'author', 'input', 'sceneBreak'];
    const KEYS_BY_FORMAT = {
      pdf: [
        ...WORK_KEYS,
        'parts',
        'writingMode',
        'chars',
        'lines',
        'coverless',
        'chapterBreak',
        'pageBreak',
        'synopsis',
        'synopsisOnTitle',
        'blankAfterHeading',
        'review',
      ],
      'pdf-en': [...WORK_KEYS, 'parts', 'recto', 'smartQuotes'],
      'novel-pdf': [...WORK_KEYS, 'size', 'dark', 'blankAfterHeading'],
      epub: [...WORK_KEYS, 'writingMode', 'chars', 'lines'],
      rtf: [...WORK_KEYS, 'contact', 'rubyParens', 'chapterBreak'],
      'rtf-en': [...WORK_KEYS, 'contact', 'rubyParens', 'chapterBreak'],
      split: TEXT_KEYS,
      merge: [...TEXT_KEYS, 'rubyParens'],
    };

    const keysRead = (format) => {
      const keys = new Set();
      const output = new Proxy(
        { format, out: 'a' },
        {
          get(t, key) {
            if (typeof key === 'string') keys.add(key);
            return t[key];
          },
          has(t, key) {
            keys.add(key);
            return key in t;
          },
        },
      );
      argvOf(output);
      return keys;
    };

    test('format ごとに読む項目', () => {
      expect(Object.keys(KEYS_BY_FORMAT)).toEqual(Object.keys(FORMATS));
      for (const [format, keys] of Object.entries(KEYS_BY_FORMAT))
        expect([...keysRead(format)].sort(), format).toEqual([...new Set(keys)].sort());
    });

    test('VS Code 拡張の JSON スキーマの出力の項目・format と一致する', async () => {
      const { readFileSync } = await import('node:fs');
      const schema = JSON.parse(readFileSync(new URL('../vscode/schemas/novel.schema.json', import.meta.url), 'utf-8'));
      const outputSchema = schema.definitions.output;
      const read = new Set(Object.keys(FORMATS).flatMap((f) => [...keysRead(f)]));
      expect(Object.keys(outputSchema.properties).sort()).toEqual([...read].sort());
      expect(outputSchema.properties.format.enum).toEqual(Object.keys(FORMATS));
    });

    test('pdf / pdf-en / novel-pdf の真偽の項目をフラグにする', () => {
      expect(argvOf({ format: 'pdf', out: 'a.pdf', pageBreak: false, synopsisOnTitle: true })).toEqual(
        expect.arrayContaining(['--no-page-break', '--synopsis-on-title']),
      );
      expect(argvOf({ format: 'pdf-en', out: 'a.pdf', recto: true, smartQuotes: false })).toEqual(
        expect.arrayContaining(['--recto', '--no-smart-quotes']),
      );
      expect(argvOf({ format: 'pdf-en', out: 'a.pdf' })).not.toContain('--no-smart-quotes');
      expect(argvOf({ format: 'novel-pdf', out: 'a.pdf', blankAfterHeading: true })).toContain('--blank-after-heading');
    });

    test('その場の指定は --pages / --limit は pdf、--target は split / merge にだけ渡す', () => {
      const extra = { pages: '3', limit: '2', target: '読者', rubyParens: true };
      const pdf = argvOf({ format: 'pdf', out: 'a.pdf' }, config(), extra);
      expect(pdf).toEqual(expect.arrayContaining(['--pages', '3', '--limit', '2']));
      expect(pdf).not.toContain('--target');
      for (const format of ['pdf-en', 'novel-pdf', 'epub', 'rtf', 'rtf-en']) {
        const argv = argvOf({ format, out: 'a' }, config(), extra);
        expect(argv, format).not.toContain('--pages');
        expect(argv, format).not.toContain('--limit');
        expect(argv, format).not.toContain('--target');
        expect(argv, format).not.toContain('--ruby-parens');
      }
      expect(argvOf({ format: 'split', out: 'a' }, config(), extra)).toEqual(
        expect.arrayContaining(['--target', '読者']),
      );
    });
  });

  describe('normalizeOutputs', () => {
    test('format の既定は出力名、out の既定は id と format から', () => {
      expect(
        normalizeOutputs(
          {
            pdf: { coverless: true },
            review: { format: 'pdf', review: true },
            'pdf-en': true,
            'novel-pdf': true,
            epub: { out: '作品.epub' },
            rtf: true,
            'rtf-en': true,
            split: true,
            merge: true,
          },
          'w',
        ),
      ).toEqual({
        pdf: { format: 'pdf', out: 'w.pdf', coverless: true },
        review: { format: 'pdf', out: 'w-review.pdf', review: true },
        'pdf-en': { format: 'pdf-en', out: 'w-en.pdf' },
        'novel-pdf': { format: 'novel-pdf', out: 'w-novel.pdf' },
        epub: { format: 'epub', out: '作品.epub' },
        rtf: { format: 'rtf', out: 'w.rtf' },
        'rtf-en': { format: 'rtf-en', out: 'w-en.rtf' },
        split: { format: 'split', out: 'w-chapters' },
        merge: { format: 'merge', out: 'w-all.txt' },
      });
    });

    test('出力名の配列でも書ける', () => {
      expect(normalizeOutputs(['pdf', 'merge'], 'w')).toEqual({
        pdf: { format: 'pdf', out: 'w.pdf' },
        merge: { format: 'merge', out: 'w-all.txt' },
      });
    });

    test('format が分からない・out を決められないときは例外', () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('exit');
      });
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(() => normalizeOutputs({ review: { review: true } }, 'w')).toThrow('exit');
        expect(() => normalizeOutputs(['pdf'], null)).toThrow('exit');
        expect(normalizeOutputs({ pdf: { out: 'a.pdf' } }, null)).toEqual({ pdf: { format: 'pdf', out: 'a.pdf' } });
      } finally {
        exit.mockRestore();
        error.mockRestore();
      }
    });
  });

  describe('findProjectRoot', () => {
    test('上へたどって最初に package.json があるディレクトリ、無ければ元のディレクトリ', async () => {
      const { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'novel-build-')));
      const story = join(tmp, 'p', 'src', 'work', 'story');
      try {
        mkdirSync(story, { recursive: true });
        expect(findProjectRoot(story)).toBe(story);
        writeFileSync(join(tmp, 'p', 'package.json'), '{}');
        expect(findProjectRoot(story)).toBe(join(tmp, 'p'));
      } finally {
        rmSync(tmp, { recursive: true });
      }
    });
  });

  describe('passThroughArgs', () => {
    test('出力名とその場の指定を分ける', () => {
      expect(
        passThroughArgs(['pdf', '--pages', '3', '--limit=2', '--target', '読者', '--ruby-parens', '--out-dir', 'tmp']),
      ).toEqual({ pages: '3', limit: '2', target: '読者', rubyParens: true, outDir: 'tmp', names: ['pdf'] });
    });
  });
}
