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
 *     "title": "作品名", "author": "著者名", "genre": "SF", "target": "想定読者",
 *     "input": ["."],                                  // 原稿のファイルかディレクトリ（並び順どおりに連結）
 *     "parts": ["070", "085"],                         // 部の境界になるファイル名の先頭の番号
 *     "chars": 40, "lines": 40, ...                    // 日本語のレイアウト（プレビューと共通）
 *     "english": { "paper": "6x9in", ... },             // 英語のレイアウト（プレビューと共通）
 *     "outputs": {
 *       "pdf": { "format": "pdf", "out": "work.pdf", "coverless": true },   // out は出力先ディレクトリから
 *       "en":  { "format": "pdf-en", "out": "work-en.pdf", "input": ["en"], "title": "Title" }
 *     }
 *   }
 * プロジェクトのルートは、設定ファイルから上へたどって最初に package.json があるディレクトリ。
 * 作品の項目（title / author / genre / target / input / parts）は出力ごとに上書きでき、null を書けばその出力では使わない。
 * レイアウトの "writingMode" / "chars" / "lines" も出力ごとに上書きできる。
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

import { existsSync, mkdirSync, statSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
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

// 渡すパスは実行しているディレクトリからの相対にする（ログを読みやすくするため）。外にあるものは絶対パスのまま
const cwdRelative = (path) => {
  const rel = relative(process.cwd(), path);
  return rel.startsWith('..') ? path : rel || '.';
};

const flag = (cond, name) => (cond ? [name] : []);
const option = (value, name) => (value == null ? [] : [name, String(value)]);

// 作品の項目を出力ごとに上書きする。出力に書いてあれば null でもそれを使う
const workValue = (output, config, key) => (key in output ? output[key] : config[key]);

function layoutOf(output, config) {
  const layout = { ...config.layout };
  for (const key of LAYOUT_OVERRIDES) if (key in output) layout[key] = output[key];
  return layout;
}

function pdfArgs(output, config, { warn, pages, limit }) {
  const layout = layoutOf(output, config);
  if (!matchesPdfScriptPage(layout)) warn('PDF は A4横・既定の余白で組みます（用紙・余白の設定はプレビューにだけ効きます）');

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
    ...option(pages, '--pages'),
    ...option(limit, '--limit'),
  ];
}

function enPdfArgs(output, config, { warn }) {
  const pageSize = enPdfPageSize(config.english);
  if (!pageSize) warn('英語の PDF は 6×9in / 5×8in / A5（縦）のどれかで組みます。英語のレイアウトの用紙がどれでもないため 6×9in にします');
  return [
    `--${pageSize ?? '6x9'}`,
    ...flag(output.recto, '--recto'),
    ...flag(output.smartQuotes === false, '--no-smart-quotes'),
    ...option(workValue(output, config, 'parts')?.join(','), '--part'),
  ];
}

const novelPdfArgs = (output) => [
  ...(output.size ? [`--${output.size}`] : []),
  ...flag(output.dark, '--dark'),
  ...flag(output.blankAfterHeading, '--blank-after-heading'),
];

const epubArgs = (output, config) => flag(layoutOf(output, config).writingMode === 'horizontal', '--horizontal');

const rtfArgs = (style) => (output) => [
  style,
  ...option(output.contact?.join(';'), '--contact'),
  ...flag(output.rubyParens, '--ruby-parens'),
  ...flag(output.chapterBreak === false, '--no-chapter-break'),
];

// split / merge は <原稿のディレクトリ> <出力先> <作品名> <ジャンル> を順に受け取る
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
  ];
}

// load: 実行するコマンドのモジュール。args: そのコマンドに渡すオプション（ファイルを作る形式）か、
// argv: 引数全体（split / merge）。open: 作ったファイルを --open で開くか
const FORMATS = {
  pdf: { load: () => import('./pdf.mjs'), args: pdfArgs, open: true },
  'pdf-en': { load: () => import('./en-pdf.mjs'), args: enPdfArgs, open: true },
  'novel-pdf': { load: () => import('./novel-pdf.mjs'), args: novelPdfArgs, open: true },
  epub: { load: () => import('./epub.mjs'), args: epubArgs, open: false },
  rtf: { load: () => import('./rtf.mjs'), args: rtfArgs('--ja'), open: true },
  'rtf-en': { load: () => import('./rtf.mjs'), args: rtfArgs('--shunn'), open: true },
  split: { load: () => import('./split.mjs'), argv: (...a) => textArgv(...a, { merge: false }) },
  merge: { load: () => import('./merge.mjs'), argv: (...a) => textArgv(...a, { merge: true }) },
};

// その場かぎりの指定として、設定に書いた出力に足すもの
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

// 出力先ディレクトリ（--out-dir）はプロジェクトのルートから（絶対パスも可）
const DEFAULT_OUT_DIR = 'out';

export function outputPath(output, root, { outDir = null, pages = null } = {}) {
  const dir = resolve(root, outDir ?? DEFAULT_OUT_DIR);
  // --pages で抜き出すときは、全体版を上書きしないよう出力名に -p<指定> を付ける
  const file = output.format === 'pdf' && pages ? output.out.replace(/(\.pdf)?$/, `-p${pages}.pdf`) : output.out;
  return resolve(dir, file);
}

// 1つの出力を、その format のコマンドに渡す引数にする
export function outputArgv(name, output, config, root, extra = {}, warn = () => {}) {
  const format = FORMATS[output.format];
  if (!format) fail(`出力 "${name}" の format "${output.format}" には対応していません（${Object.keys(FORMATS).join(' / ')}）`);
  if (!output.out) fail(`出力 "${name}" に out がありません`);
  const out = cwdRelative(outputPath(output, root, extra));
  if (format.argv) return format.argv(output, config, out, extra);

  return [
    ...option(workValue(output, config, 'title'), '--title'),
    ...option(workValue(output, config, 'author'), '--author'),
    ...format.args(output, config, { ...extra, warn: (message) => warn(`${name}: ${message}`) }),
    '-o', out,
    ...workValue(output, config, 'input').map(p => cwdRelative(join(config.dir, p))),
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

  const available = Object.keys(config.outputs);
  if (available.length === 0) fail(`${cwdRelative(file)} に outputs がありません`);
  const missing = names.filter(n => !available.includes(n));
  if (missing.length > 0) fail(`${cwdRelative(file)} に出力 ${missing.join(', ')} がありません（あるのは ${available.join(', ')}）`);

  for (const name of names.length > 0 ? names : available) {
    const output = config.outputs[name];
    const outArgv = outputArgv(name, output, config, root, extra, (message) => console.warn(`警告: ${message}`));
    mkdirSync(dirname(outputPath(output, root, extra)), { recursive: true });
    console.log(`\n▶ ${name}: novel ${output.format} ${outArgv.join(' ')}`);
    await (await FORMATS[output.format].load()).main(outArgv);
  }
}

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest;
  const { DEFAULT_LAYOUT, DEFAULT_ENGLISH_LAYOUT } = await import('./layout.mjs');

  const config = (overrides = {}) => ({
    dir: '/p/src/work/story',
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
      expect(argvOf({ format: 'pdf', out: 'a.pdf' }, config({ layout: { ...DEFAULT_LAYOUT, chars: 42, lines: 34 } })))
        .toContain('42x34');
      expect(argvOf({ format: 'pdf', out: 'a.pdf', chars: 30, lines: null }, config({ layout: { ...DEFAULT_LAYOUT, chars: 40, lines: 40 } })))
        .not.toContain('--size');
      expect(argvOf({ format: 'pdf', out: 'a.pdf', chars: 40 })).toEqual(expect.arrayContaining(['--chars', '40']));
      expect(argvOf({ format: 'pdf', out: 'a.pdf', writingMode: 'horizontal' })).toContain('--horizontal');
    });

    test('pdf の項目をフラグにする', () => {
      const argv = argvOf({
        format: 'pdf', out: 'a.pdf', coverless: true, chapterBreak: false, synopsis: false,
        blankAfterHeading: true, parts: ['070', '085'], review: true,
      });
      expect(argv).toEqual(expect.arrayContaining([
        '--coverless', '--no-chapter-break', '--no-synopsis', '--blank-after-heading', '--review', '--part', '070,085',
      ]));
      expect(argv).not.toContain('--no-page-break');
    });

    test('作品の項目は出力ごとに上書きでき、null ならその出力では使わない', () => {
      const argv = argvOf({ format: 'pdf-en', out: 'a.pdf', title: 'Title', author: 'Author', input: ['intro.txt', 'en'] });
      expect(argv.slice(0, 4)).toEqual(['--title', 'Title', '--author', 'Author']);
      expect(argv.slice(-3, -1)).toEqual(['/p/src/work/story/intro.txt', '/p/src/work/story/en']);
      expect(argvOf({ format: 'pdf', out: 'a.pdf', title: null })).not.toContain('--title');
      expect(argvOf({ format: 'pdf', out: 'a.pdf' }, config({ parts: ['050'] }))).toEqual(expect.arrayContaining(['--part', '050']));
      expect(argvOf({ format: 'pdf', out: 'a.pdf', parts: null }, config({ parts: ['050'] }))).not.toContain('--part');
    });

    test('pdf-en の判型は英語のレイアウトの用紙から選ぶ', () => {
      expect(argvOf({ format: 'pdf-en', out: 'a.pdf' })).toContain('--6x9');
      expect(argvOf({ format: 'pdf-en', out: 'a.pdf' }, config({ english: { ...DEFAULT_ENGLISH_LAYOUT, paper: '5x8in' } })))
        .toContain('--5x8');
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
      expect(argvOf({ format: 'novel-pdf', out: 'a.pdf', dark: true, size: 'b6' })).toEqual(expect.arrayContaining(['--b6', '--dark', '--open']));
      expect(argvOf({ format: 'epub', out: 'a.epub' })).not.toContain('--open');
      expect(argvOf({ format: 'epub', out: 'a.epub', writingMode: 'horizontal' })).toContain('--horizontal');
      expect(argvOf({ format: 'rtf', out: 'a.rtf', rubyParens: true })).toEqual(expect.arrayContaining(['--ja', '--ruby-parens']));
      expect(argvOf({ format: 'rtf-en', out: 'a.rtf', contact: ['Name', 'Mail'] }))
        .toEqual(expect.arrayContaining(['--shunn', '--contact', 'Name;Mail']));
    });

    test('split / merge は ディレクトリ・出力先・作品名・ジャンルを順に渡す', () => {
      const c = config({ genre: 'SF', target: '読者', parts: ['070'] });
      expect(argvOf({ format: 'split', out: 'w-chapters' }, c))
        .toEqual(['/p/src/work/story', '/p/out/w-chapters', '作品', 'SF', '--splits=070', '--target', '読者']);
      expect(argvOf({ format: 'merge', out: 'w-all.txt', rubyParens: true }, config(), { target: '別の読者' }))
        .toEqual(['/p/src/work/story', '/p/out/w-all.txt', '作品', '', '--target', '別の読者', '--ruby-parens']);
      expect(argvOf({ format: 'merge', out: 'a.txt' }, config(), { rubyParens: true })).toContain('--ruby-parens');
      expect(argvOf({ format: 'split', out: 'a' }, config(), { rubyParens: true })).not.toContain('--ruby-parens');
    });
  });

  describe('passThroughArgs', () => {
    test('出力名とその場の指定を分ける', () => {
      expect(passThroughArgs(['pdf', '--pages', '3', '--limit=2', '--target', '読者', '--ruby-parens', '--out-dir', 'tmp']))
        .toEqual({ pages: '3', limit: '2', target: '読者', rubyParens: true, outDir: 'tmp', names: ['pdf'] });
    });
  });
}
