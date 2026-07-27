import { execSync } from 'child_process';
import { resolve } from 'path';

export function parseCliArgs(argv, defs, defaults = {}) {
  const result = { files: [], ...defaults };
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

export function fail(message) {
  console.error(`エラー: ${message}`);
  process.exit(1);
}

export function vivliostyleBuild(htmlPath, outputPath, { quiet = false } = {}) {
  execSync(`./node_modules/.bin/vivliostyle build "${htmlPath}" -o "${outputPath}"`, { stdio: quiet ? 'pipe' : 'inherit' });
}

export function openFile(path) {
  // openコマンドが使えない環境（CI等）では黙って無視する
  try {
    execSync(`open "${resolve(path)}"`);
  } catch { /* ignore */ }
}

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest;

  describe('parseCliArgs', () => {
    const defs = [
      { key: 'output', flags: ['-o', '--output'], takesValue: true },
      { key: 'open', flags: ['--open'] },
      { key: 'vertical', flags: ['--horizontal'], value: false },
      { key: 'limit', flags: ['--limit'], takesValue: true, parse: v => parseInt(v, 10) },
      { key: 'parts', flags: ['--part', '--parts'], takesValue: true, parse: parseList },
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
  });

  describe('parseList', () => {
    test('カンマ区切りを空白除去つきで分割し、空要素は捨てる', () => {
      expect(parseList('a, b,,c ')).toEqual(['a', 'b', 'c']);
    });
  });
}
