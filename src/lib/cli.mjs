import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';

export function parseCliArgs(argv, defs, defaults = {}) {
  const result = { files: [] };
  for (const def of defs) {
    if (def.key in result) continue;
    if (def.takesValue) result[def.key] = null;
    else if (!('value' in def)) result[def.key] = false;
  }
  Object.assign(result, defaults);

  const byFlag = new Map();
  for (const def of defs) {
    for (const flag of def.flags) byFlag.set(flag, def);
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const def = byFlag.get(eq > 0 ? arg.slice(0, eq) : arg);
    if (!def) {
      if (!arg.startsWith('-')) result.files.push(arg);
      continue;
    }
    if (!def.takesValue) {
      result[def.key] = 'value' in def ? def.value : true;
      continue;
    }
    const raw = eq > 0 ? arg.slice(eq + 1) : argv[++i];
    result[def.key] = def.parse ? def.parse(raw) : raw;
  }

  return result;
}

export function parseList(value) {
  return value.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

export function parseGridSize(value) {
  const [cols, rows] = value.split('x').map(Number);
  if (!cols || !rows) fail('--size は 40x40 の形式（字数x行数）で指定してください');
  return { cols, rows };
}

export const ARG = {
  output: { key: 'output', flags: ['-o', '--output'], takesValue: true },
  title: { key: 'title', flags: ['--title'], takesValue: true },
  author: { key: 'author', flags: ['--author'], takesValue: true },
  open: { key: 'open', flags: ['--open'] },
  size: { key: 'size', flags: ['--size'], takesValue: true, parse: parseGridSize },
  // 部の境界となるファイル名プレフィックス（co-split の --splits と同形式）
  parts: { key: 'parts', flags: ['--part', '--parts'], takesValue: true, parse: parseList },
};

export function fail(message) {
  console.error(`エラー: ${message}`);
  process.exit(1);
}

export function requireOutput(args, example) {
  if (!args.output) fail(`出力ファイルを指定してください (-o ${example})`);
}

/**
 * スクリプトとして直接実行されたときだけ main を走らせる（vitest から import されたときは走らせない）。
 * main が投げた例外は「エラー: message」を出して終了コード1にする。
 */
export function runMain(importMetaUrl, main) {
  if (!process.argv[1] || importMetaUrl !== pathToFileURL(process.argv[1]).href) return;
  Promise.resolve().then(main).catch(err => {
    console.error('エラー:', err.message);
    process.exit(1);
  });
}

export function vivliostyleBuild(htmlPath, outputPath, { quiet = false } = {}) {
  execSync(`./node_modules/.bin/vivliostyle build "${htmlPath}" -o "${outputPath}"`, { stdio: quiet ? 'pipe' : 'inherit' });
}

// 組版の崩れを調べられるよう、PDFの隣にHTMLも書き出す（不要なら呼び出し側で消す）
export function buildPdfFromHtml(html, outputPath, opts) {
  const htmlPath = outputPath.replace(/\.pdf$/, '.html');
  writeFileSync(htmlPath, html);
  vivliostyleBuild(htmlPath, outputPath, opts);
  return htmlPath;
}

export function openFile(path) {
  // AUTO_OPEN=0 のときは --open 指定があっても開かない
  if (process.env.AUTO_OPEN === '0') return;
  // openコマンドが使えない環境（CI等）では黙って無視する
  try {
    execSync(`open "${resolve(path)}"`);
  } catch { /* ignore */ }
}

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest;

  describe('parseCliArgs', () => {
    const defs = [
      ARG.output,
      ARG.open,
      { key: 'vertical', flags: ['--horizontal'], value: false },
      { key: 'limit', flags: ['--limit'], takesValue: true, parse: v => parseInt(v, 10) },
      ARG.parts,
    ];

    test('値付きフラグと真偽フラグとpositionalを振り分ける', () => {
      const args = parseCliArgs(['-o', 'out.pdf', '--open', 'a.txt', 'b.txt'], defs, { vertical: true });
      expect(args.output).toBe('out.pdf');
      expect(args.open).toBe(true);
      expect(args.vertical).toBe(true);
      expect(args.files).toEqual(['a.txt', 'b.txt']);
    });

    test('value指定の真偽フラグは指定値をセットする', () => {
      expect(parseCliArgs(['--horizontal'], defs, { vertical: true }).vertical).toBe(false);
    });

    test('--flag=value 形式も受け付ける', () => {
      const args = parseCliArgs(['--output=out.pdf', '--parts=060, 085'], defs);
      expect(args.output).toBe('out.pdf');
      expect(args.parts).toEqual(['060', '085']);
    });

    test('parse指定があれば変換して格納する', () => {
      expect(parseCliArgs(['--limit', '5'], defs).limit).toBe(5);
    });

    test('未知のフラグは無視し、defaultsが残る', () => {
      const args = parseCliArgs(['--unknown', 'a.txt'], defs, { limit: null });
      expect(args.limit).toBeNull();
      expect(args.files).toEqual(['a.txt']);
    });

    test('defaults省略時は値付きフラグがnull、真偽フラグがfalseで初期化される', () => {
      const args = parseCliArgs([], defs);
      expect(args.output).toBeNull();
      expect(args.limit).toBeNull();
      expect(args.parts).toBeNull();
      expect(args.open).toBe(false);
      expect(args.vertical).toBeUndefined();
    });
  });

  describe('parseGridSize', () => {
    test('字数x行数を { cols, rows } にする', () => {
      expect(parseGridSize('42x34')).toEqual({ cols: 42, rows: 34 });
      expect(parseCliArgs(['--size', '20x20'], [ARG.size]).size).toEqual({ cols: 20, rows: 20 });
    });
  });

  describe('parseList', () => {
    test('カンマ区切りを空白除去つきで分割し、空要素は捨てる', () => {
      expect(parseList('a, b,,c ')).toEqual(['a', 'b', 'c']);
    });
  });

  describe('runMain', () => {
    test('別モジュールから import されたときは main を実行しない', () => {
      let ran = false;
      runMain('file:///not/the/entry.mts', () => { ran = true; });
      expect(ran).toBe(false);
    });
  });
}
