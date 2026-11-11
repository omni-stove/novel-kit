/**
 * lindera-wasm と IPA 辞書による形態素解析器。
 * 辞書の置き場所は呼び出し側が渡す（CLI は src/lib/ipadic.mjs が取ってくる辞書、VS Code 拡張は同梱した dist/ipadic）。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initSync, loadDictionaryFromBytes, TokenizerBuilder } from 'lindera-wasm';

/** loadDictionaryFromBytes に渡す順の、辞書のファイル */
export const IPADIC_FILES = [
  'metadata.json',
  'dict.trie',
  'dict.valsidx',
  'dict.vals',
  'dict.wordsidx',
  'dict.words',
  'matrix.mtx',
  'char_def.bin',
  'unk.bin',
];

/**
 * lindera-wasm の形態素解析器を作る。wasm: lindera_wasm_bg.wasm のパス、dictDir: IPA 辞書のディレクトリ。
 * 返す解析器の tokenize(text) は、各語の surface に表層形、details に IPA 辞書の素性
 * （品詞・細分類1〜3・活用型・活用形・基本形・読み・発音。辞書に無い語は読みと発音が無い）を持つ
 */
export function createTokenizer({ wasm, dictDir }) {
  initSync({ module: readFileSync(wasm) });
  const [metadata, trie, valsIdx, vals, wordsIdx, words, matrix, charDef, unk] = IPADIC_FILES.map((f) =>
    readFileSync(join(dictDir, f)),
  );
  const dictionary = loadDictionaryFromBytes(metadata, trie, valsIdx, vals, wordsIdx, words, matrix, charDef, unk);
  const builder = new TokenizerBuilder();
  builder.setDictionaryInstance(dictionary);
  builder.setMode('normal');
  return builder.build();
}
