import { execSync } from 'child_process';
import { resolve } from 'path';
import { pathToFileURL } from 'url';

/**
 * コマンドライン引数を解釈する。
 *   defs: [{ key, flags, takesValue?, parse?, value? }]
 *     takesValue: 次の引数（または --flag=value）を値として受け取る
 *     parse:      受け取った値を変換する
 *     value:      真偽フラグにセットする値（省略時 true）
 *   defaults: 各キーの初期値。省略したキーは takesValue なら null、
 *             value 指定のない真偽フラグなら false で初期化する
 *             （value 指定つきのフラグは defaults で初期値を与えること）。
 *   フラグでない引数は files に積む。
 */
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

// 複数スクリプトで共通のフラグ定義
export const ARG = {
  output: { key: 'output', flags: ['-o', '--output'], takesValue: true },
  title: { key: 'title', flags: ['--title'], takesValue: true },
  author: { key: 'author', flags: ['--author'], takesValue: true },
  open: { key: 'open', flags: ['--open'] },
  // 部の境界となるファイル名プレフィックス（co-split の --splits と同形式）
  parts: { key: 'parts', flags: ['--part', '--parts'], takesValue: true, parse: parseList },
};

export function fail(message) {
  console.error(`エラー: ${message}`);
  process.exit(1);
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
