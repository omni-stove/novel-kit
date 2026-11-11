#!/usr/bin/env node

/**
 * 原稿を形態素解析して、語ごとの品詞・活用・読みを出すスクリプト（lindera-wasm と IPA 辞書）
 *
 * 使い方:
 *   novel tokenize [--json] [<file-or-dir>...]
 *   echo 吾輩は猫である。 | novel tokenize
 *
 * ファイルもディレクトリも渡さなければ、標準入力を原稿として読む。
 * 本文の行を段落ごとに解析する。メタ行・空行・区切りの行は飛ばし、ルビや傍点などの記法は外して親文字だけを解析する。
 * IPA 辞書は初回に Lindera の GitHub Releases から取ってくる（node_modules/.cache に置く）。
 *
 * 出力:
 *   既定     MeCab と同じ形。1語1行の「表層形 TAB 品詞,細分類1,細分類2,細分類3,活用型,活用形,基本形,読み,発音」で、
 *            段落の終わりに EOS の行（辞書に無い語は読みと発音が無い）
 *   --json   1段落1行の JSON
 *            { file（標準入力なら null）, line（1始まりの行番号）, text, tokens: [{ surface, pos, conjugationType,
 *              conjugationForm, baseForm, reading, pronunciation }] }。pos は品詞と細分類の配列で、* の値は null にする
 */

import { readFileSync } from 'node:fs';
import { parseCliArgs, runMain } from './lib/cli.mjs';
import { createIpadicTokenizer } from './lib/ipadic.mjs';
import { collectInputFiles } from './lib/manuscript.mjs';
import { getBodyLines, isSeparator, splitLines, stripInlineMarkup } from './lib/text-parser.mjs';

/**
 * 原稿の行から、解析する段落 { line（1始まりの元の行番号）, text（記法を外した本文） } の列を返す。
 * メタ行・空行・区切りの行は返さない
 */
export function paragraphsOf(lines) {
  const { lines: body, indices } = getBodyLines(lines);
  return body.flatMap((raw, i) => {
    if (isSeparator(raw)) return [];
    const text = stripInlineMarkup(raw).trim();
    return text === '' ? [] : [{ line: indices[i] + 1, text }];
  });
}

const orNull = (value) => (value === undefined || value === '*' ? null : value);

/** lindera の語を、--json に出す形にする */
export function tokenToJson({ surface, details }) {
  const [pos, sub1, sub2, sub3, conjugationType, conjugationForm, baseForm, reading, pronunciation] = details;
  return {
    surface,
    pos: [pos, sub1, sub2, sub3].map(orNull).filter((p) => p !== null),
    conjugationType: orNull(conjugationType),
    conjugationForm: orNull(conjugationForm),
    baseForm: orNull(baseForm),
    reading: orNull(reading),
    pronunciation: orNull(pronunciation),
  };
}

/** 1段落の解析結果を、出力する文字列（末尾の改行なし）にする */
export function formatParagraph({ file, line, text }, tokens, { json = false } = {}) {
  if (json) return JSON.stringify({ file, line, text, tokens: tokens.map(tokenToJson) });
  return [...tokens.map((t) => `${t.surface}\t${t.details.join(',')}`), 'EOS'].join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv, [{ key: 'json', flags: ['--json'] }]);
  const sources =
    args.files.length === 0
      ? [{ file: null, content: readFileSync(0, 'utf-8') }]
      : collectInputFiles(args.files).map((file) => ({ file, content: readFileSync(file, 'utf-8') }));
  const tokenizer = await createIpadicTokenizer();
  try {
    for (const { file, content } of sources) {
      for (const paragraph of paragraphsOf(splitLines(content))) {
        const tokens = tokenizer.tokenize(paragraph.text);
        console.log(formatParagraph({ file, ...paragraph }, tokens, { json: args.json }));
      }
    }
  } finally {
    tokenizer.free();
  }
}

runMain(import.meta.url, main);

if (import.meta.vitest) {
  const { describe, test, expect, vi, afterEach } = import.meta.vitest;
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  describe('paragraphsOf', () => {
    test('メタ行・空行・区切りの行を飛ばし、ルビは親文字だけにして、元の行番号を付ける', () => {
      const lines = ['Memo: 下書き', '　|朔《さく》は立った。', '', '*', '「行くぞ」'];
      expect(paragraphsOf(lines)).toEqual([
        { line: 2, text: '朔は立った。' },
        { line: 5, text: '「行くぞ」' },
      ]);
    });
  });

  describe('main', () => {
    let dir;
    let logs;

    afterEach(() => {
      vi.restoreAllMocks();
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = null;
    });

    const run = async (text, argv = []) => {
      dir = mkdtempSync(join(tmpdir(), 'novel-tokenize-test-'));
      const file = join(dir, '01.txt');
      writeFileSync(file, text);
      logs = [];
      vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
      await main([...argv, file]);
      return file;
    };

    test('既定は MeCab の形で、段落ごとに EOS で区切る', async () => {
      await run('　猫が鳴く。\n\n　雨。\n');
      expect(logs.join('\n').split('\n')).toEqual([
        '猫\t名詞,一般,*,*,*,*,猫,ネコ,ネコ',
        'が\t助詞,格助詞,一般,*,*,*,が,ガ,ガ',
        '鳴く\t動詞,自立,*,*,五段・カ行イ音便,基本形,鳴く,ナク,ナク',
        '。\t記号,句点,*,*,*,*,。,。,。',
        'EOS',
        '雨\t名詞,一般,*,*,*,*,雨,アメ,アメ',
        '。\t記号,句点,*,*,*,*,。,。,。',
        'EOS',
      ]);
    }, 120_000);

    test('--json は段落ごとに1行の JSON で、* の値は null にする', async () => {
      const file = await run('Memo: x\n　|猫《ねこ》が鳴いた\n', ['--json']);
      expect(logs.map((l) => JSON.parse(l))).toEqual([
        {
          file,
          line: 2,
          text: '猫が鳴いた',
          tokens: [
            {
              surface: '猫',
              pos: ['名詞', '一般'],
              conjugationType: null,
              conjugationForm: null,
              baseForm: '猫',
              reading: 'ネコ',
              pronunciation: 'ネコ',
            },
            {
              surface: 'が',
              pos: ['助詞', '格助詞', '一般'],
              conjugationType: null,
              conjugationForm: null,
              baseForm: 'が',
              reading: 'ガ',
              pronunciation: 'ガ',
            },
            {
              surface: '鳴い',
              pos: ['動詞', '自立'],
              conjugationType: '五段・カ行イ音便',
              conjugationForm: '連用タ接続',
              baseForm: '鳴く',
              reading: 'ナイ',
              pronunciation: 'ナイ',
            },
            {
              surface: 'た',
              pos: ['助動詞'],
              conjugationType: '特殊・タ',
              conjugationForm: '基本形',
              baseForm: 'た',
              reading: 'タ',
              pronunciation: 'タ',
            },
          ],
        },
      ]);
    }, 120_000);
  });
}
