/**
 * novel build: 作品の設定ファイル（novel.json）の "outputs" に書いた出力を作る。
 *
 * 使い方:
 *   novel build <作品のディレクトリ or novel.json> [出力名...] [--pages 42,50-53] [--limit n]
 *   出力名を省略すると、"outputs" のすべてを作る。
 *
 * 設定ファイル（パスはすべて設定ファイルのディレクトリから。"out" だけはプロジェクトのルートから）:
 *   {
 *     "title": "作品名", "author": "著者名",
 *     "input": ["."],                                  // 原稿のファイルかディレクトリ（並び順どおりに連結）
 *     "chars": 40, "lines": 40, ...                    // 日本語のレイアウト（プレビューと共通）
 *     "english": { "paper": "6x9in", ... },             // 英語のレイアウト（プレビューと共通）
 *     "outputs": {
 *       "pdf": { "format": "pdf", "out": "out/work.pdf", "coverless": true },
 *       "en":  { "format": "pdf-en", "out": "out/work-en.pdf", "input": ["en"], "title": "Title" }
 *     }
 *   }
 * プロジェクトのルートは、設定ファイルから上へたどって最初に package.json があるディレクトリ。
 * 出力ごとに "title" / "author" / "input" と、レイアウトの "writingMode" / "chars" / "lines" を上書きできる。
 *
 * format ごとの項目:
 *   pdf     coverless, chapterBreak（false で章ごとに改ページしない）, pageBreak（false でファイル間で改ページしない）,
 *           synopsis（false で梗概を入れない）, synopsisOnTitle, blankAfterHeading, parts（["070", "085"]）, review
 *   pdf-en  parts, recto, smartQuotes（false でカーリー引用符にしない）。判型は英語のレイアウトの用紙から選ぶ
 */

import { existsSync, statSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { CONFIG_FILENAME, findConfigFile, readWorkConfig } from './config.mjs';
import { computeMetrics, enPdfPageSize, matchesPdfScriptPage } from './layout.mjs';
import { fail } from './lib/cli.mjs';
import { main as pdfMain } from './pdf.mjs';
import { main as enPdfMain } from './en-pdf.mjs';

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

// 渡すパスは実行しているディレクトリからの相対にする（ログを読みやすくするため）
const cwdRelative = (path) => relative(process.cwd(), path) || '.';

const flag = (cond, name) => (cond ? [name] : []);
const option = (value, name) => (value == null ? [] : [name, String(value)]);

function pdfArgs(output, config, warn) {
  const layout = { ...config.layout };
  for (const key of LAYOUT_OVERRIDES) if (key in output) layout[key] = output[key];
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
    ...option(output.parts?.join(','), '--part'),
  ];
}

function enPdfArgs(output, config, warn) {
  const pageSize = enPdfPageSize(config.english);
  if (!pageSize) warn('英語の PDF は 6×9in / 5×8in / A5（縦）のどれかで組みます。英語のレイアウトの用紙がどれでもないため 6×9in にします');
  return [
    `--${pageSize ?? '6x9'}`,
    ...flag(output.recto, '--recto'),
    ...flag(output.smartQuotes === false, '--no-smart-quotes'),
    ...option(output.parts?.join(','), '--part'),
  ];
}

const FORMATS = {
  pdf: { main: pdfMain, args: pdfArgs },
  'pdf-en': { main: enPdfMain, args: enPdfArgs },
};

// --pages / --limit はその場かぎりの指定として、設定に書いた出力に足す
function passThroughArgs(argv) {
  const parsed = { pages: null, limit: null, names: [] };
  for (let i = 0; i < argv.length; i++) {
    const [name, inline] = argv[i].split(/=(.*)/s);
    if (name === '--pages' || name === '--limit') parsed[name.slice(2)] = inline ?? argv[++i];
    else if (argv[i].startsWith('-')) fail(`不明なオプション: ${argv[i]}`);
    else parsed.names.push(argv[i]);
  }
  return parsed;
}

// 1つの出力を、その format のコマンドに渡す引数にする
export function outputArgv(name, output, config, root, { pages = null, limit = null } = {}, warn = () => {}) {
  const format = FORMATS[output.format];
  if (!format) fail(`出力 "${name}" の format "${output.format}" には対応していません（${Object.keys(FORMATS).join(' / ')}）`);
  if (!output.out) fail(`出力 "${name}" に out がありません`);

  // --pages で抜き出すときは、全体版を上書きしないよう出力名に -p<指定> を付ける
  const out = pages ? output.out.replace(/(\.pdf)?$/, `-p${pages}.pdf`) : output.out;
  const title = output.title ?? config.title;
  const author = output.author ?? config.author;
  const input = output.input ?? config.input;
  return [
    ...option(title, '--title'),
    ...option(author, '--author'),
    ...format.args(output, config, (message) => warn(`${name}: ${message}`)),
    ...option(pages, '--pages'),
    ...option(limit, '--limit'),
    '-o', cwdRelative(join(root, out)),
    ...input.map(p => cwdRelative(join(config.dir, p))),
    '--open',
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
    console.log(`\n▶ ${name}: novel ${output.format} ${outArgv.join(' ')}`);
    await FORMATS[output.format].main(outArgv);
  }
}

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest;
  const { DEFAULT_LAYOUT, DEFAULT_ENGLISH_LAYOUT } = await import('./layout.mjs');

  const config = (overrides = {}) => ({
    dir: '/p/src/work/story',
    title: '作品',
    author: '著者',
    input: ['.'],
    layout: DEFAULT_LAYOUT,
    english: DEFAULT_ENGLISH_LAYOUT,
    view: {},
    outputs: {},
    ...overrides,
  });
  const argvOf = (output, c = config(), extra) =>
    outputArgv('x', output, c, '/p', extra).map(a => (a.startsWith('..') ? resolve(a) : a));

  describe('outputArgv', () => {
    test('既定のレイアウト（30字・行数自動）なら字詰めの指定を付けない', () => {
      const argv = outputArgv('pdf', { format: 'pdf', out: 'out/a.pdf' }, config(), process.cwd());
      expect(argv).toEqual(['--title', '作品', '--author', '著者', '-o', 'out/a.pdf', relative(process.cwd(), '/p/src/work/story'), '--open']);
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

    test('title / author / input は出力ごとに上書きでき、input は設定ファイルのディレクトリから並び順どおり', () => {
      const argv = argvOf({ format: 'pdf-en', out: 'a.pdf', title: 'Title', author: 'Author', input: ['intro.txt', 'en'] });
      expect(argv.slice(0, 4)).toEqual(['--title', 'Title', '--author', 'Author']);
      expect(argv.slice(-3, -1)).toEqual(['/p/src/work/story/intro.txt', '/p/src/work/story/en']);
    });

    test('pdf-en の判型は英語のレイアウトの用紙から選ぶ', () => {
      expect(argvOf({ format: 'pdf-en', out: 'a.pdf' })).toContain('--6x9');
      expect(argvOf({ format: 'pdf-en', out: 'a.pdf' }, config({ english: { ...DEFAULT_ENGLISH_LAYOUT, paper: '5x8in' } })))
        .toContain('--5x8');
    });

    test('--pages を付けると出力名に -p<指定> を足す', () => {
      const argv = argvOf({ format: 'pdf', out: 'out/a.pdf' }, config(), { pages: '3-4' });
      expect(argv).toEqual(expect.arrayContaining(['--pages', '3-4', '/p/out/a-p3-4.pdf']));
    });
  });

  describe('passThroughArgs', () => {
    test('出力名と --pages / --limit を分ける', () => {
      expect(passThroughArgs(['pdf', '--pages', '3', '--limit=2'])).toEqual({ pages: '3', limit: '2', names: ['pdf'] });
    });
  });
}
