/**
 * 「文章の傾向」の形態素解析（lindera-wasm）に使う IPA 辞書を用意する。
 * 辞書は npm に無く Lindera の GitHub Releases に zip で置かれているので、初回に取ってきて node_modules/.cache に置く。
 *
 *   node src/ipadic.mjs <dir>   辞書を <dir> にコピーする（拡張のビルドで dist/ipadic に置く）
 */

import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IPADIC_FILES } from './prose.mjs';

/** lindera-wasm と辞書の形式は版ごとに変わるので、package.json の lindera-wasm と同じ版にする */
export const IPADIC_VERSION = '6.2.0';

// IPA 辞書の使用許諾で、辞書と一緒に配る
const FILES = [...IPADIC_FILES, 'NOTICE.txt'];

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const IPADIC_CACHE_DIR = join(ROOT, 'node_modules', '.cache', `lindera-ipadic-${IPADIC_VERSION}`);

/** 辞書が IPADIC_CACHE_DIR に無ければ取ってきて展開する。返り値は辞書のディレクトリ */
export async function ensureIpadic() {
  if (FILES.every((f) => existsSync(join(IPADIC_CACHE_DIR, f)))) return IPADIC_CACHE_DIR;
  const url = `https://github.com/lindera/lindera/releases/download/v${IPADIC_VERSION}/lindera-ipadic-${IPADIC_VERSION}.zip`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`IPA 辞書を取得できません（${res.status}）: ${url}`);
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(await res.arrayBuffer());
  // 途中で失敗したときに、欠けた辞書を揃ったものと見なさないよう、一時ディレクトリに書いてから置き換える
  const tmp = `${IPADIC_CACHE_DIR}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  for (const name of FILES) {
    const entry = zip.file(`lindera-ipadic/${name}`);
    if (!entry) throw new Error(`IPA 辞書の zip に ${name} がありません: ${url}`);
    writeFileSync(join(tmp, name), await entry.async('uint8array'));
  }
  rmSync(IPADIC_CACHE_DIR, { recursive: true, force: true });
  renameSync(tmp, IPADIC_CACHE_DIR);
  return IPADIC_CACHE_DIR;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) {
    console.error('使い方: node src/ipadic.mjs <dir>');
    process.exit(1);
  }
  rmSync(out, { recursive: true, force: true });
  cpSync(await ensureIpadic(), out, { recursive: true });
}

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;
  const { readFileSync } = await import('node:fs');

  test('IPADIC_VERSION は入っている lindera-wasm と同じ版', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'node_modules', 'lindera-wasm', 'package.json'), 'utf-8'));
    expect(IPADIC_VERSION).toBe(pkg.version);
  });
}
