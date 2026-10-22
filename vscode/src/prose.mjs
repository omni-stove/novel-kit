/**
 * 日本語の原稿の文章の傾向（文末の種類・文の長さ・台詞の割合など）を数える。
 * 直すための指摘ではなく、いまの原稿がどうなっているかを見るための集計（エクスプローラーの「文章の傾向」に出す）。
 * 文末の種類は lindera-wasm と IPA 辞書（ipadic.mjs が用意する）で形態素解析して決める。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initSync, loadDictionaryFromBytes, TokenizerBuilder } from 'lindera-wasm';
import { getBodyLines, isSeparator, isViewpointLine, stripInlineMarkup } from '../../src/lib/text-parser.mjs';

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

/** 文末の種類。表示の順に並べる */
export const ENDINGS = [
  { key: 'past', label: '〜た' },
  { key: 'present', label: '〜る・う・い' },
  { key: 'copula', label: '〜だ・である' },
  { key: 'negative', label: '〜ない' },
  { key: 'noun', label: '体言止め' },
  { key: 'other', label: 'その他' },
];

/** 長い文とみなす字数（ルビを除く） */
export const LONG_SENTENCE_CHARS = 80;

/** 同じ種類の文末がこの数以上続いたら「連続」として拾う */
export const RUN_MIN = 3;

/** 同じ語がこの文数の範囲に2回以上出たら「近くの繰り返し」として拾う */
export const REPEAT_WINDOW = 3;

/**
 * lindera-wasm の形態素解析器を作る。wasm: lindera_wasm_bg.wasm のパス、dictDir: IPA 辞書のディレクトリ。
 * 返す解析器の tokenize(text) は、各語の details に IPA 辞書の素性（品詞・細分類1〜3・活用型・活用形・基本形…）を持つ
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

const pos = (token) => token.details[0];
const conjugationType = (token) => token.details[4];
const conjugationForm = (token) => token.details[5];
const baseForm = (token) => token.details[6];

const isNegative = (token) =>
  (pos(token) === '助動詞' && ['ない', 'ぬ', 'ん'].includes(baseForm(token))) ||
  (pos(token) === '形容詞' && baseForm(token) === 'ない');

/** 文を形態素解析した語の列を返す */
function tokenizeSentence(text, tokenizer) {
  // IPA 辞書は ―― や ――。 を未知語の名詞として返すので、解析する前に文末の記号を外す
  const stem = text.replace(/[。、！？!?―…‥　\s]+$/u, '');
  return stem === '' ? [] : tokenizer.tokenize(stem);
}

/** tokenizeSentence の語の列から、文末の種類の key を返す */
function classifyEnding(tokens) {
  const words = [...tokens];
  while (words.length > 0 && pos(words.at(-1)) === '記号') words.pop();
  const last = words.at(-1);
  if (!last) return 'other';
  if (pos(last) === '名詞') return 'noun';

  let start = words.length;
  while (start > 0 && pos(words[start - 1]) === '助動詞') start--;
  const auxiliaries = words.slice(start);
  const head = words[start - 1];

  if (pos(last) === '助動詞' && ['う', 'まい'].includes(baseForm(last))) return 'other';
  if (auxiliaries.some(isNegative) || (head && auxiliaries.length === 0 && isNegative(head))) return 'negative';
  if (conjugationType(last) === '特殊・タ') return 'past';
  if (['特殊・ダ', '特殊・デス'].includes(conjugationType(last))) return 'copula';
  if (baseForm(last) === 'ある' && words.at(-2)?.surface === 'で') return 'copula';
  if (['動詞', '形容詞', '助動詞'].includes(pos(last)) && conjugationForm(last) === '基本形') return 'present';
  // IPA 辞書は文末の「という」を動詞を含まない連語の助詞として返す
  if (pos(last) === '助詞' && last.details[2] === '連語' && /いう$/.test(last.surface)) return 'present';
  return 'other';
}

// どの文にも出るので、繰り返しとして拾うと他が埋もれる語
const COMMON_WORDS = new Set([
  'する',
  'ある',
  'いる',
  'なる',
  'いう',
  'ない',
  'これ',
  'それ',
  'あれ',
  'どれ',
  'ここ',
  'そこ',
  'あそこ',
  'どこ',
]);
const CONTENT_POS = ['名詞', '動詞', '形容詞', '副詞'];
const FUNCTION_SUBTYPES = ['非自立', '接尾', '数', '特殊'];

/** 繰り返しを見る語（名詞・動詞・形容詞・副詞）なら、その基本形を返す。ほかは null */
function contentWord(token) {
  if (!CONTENT_POS.includes(pos(token)) || FUNCTION_SUBTYPES.includes(token.details[1])) return null;
  // 未知語は基本形が * になる
  const base = baseForm(token) && baseForm(token) !== '*' ? baseForm(token) : token.surface;
  if (!/\p{L}/u.test(base) || COMMON_WORDS.has(base)) return null;
  return base;
}

const CLOSE = { '「': '」', '『': '』', '（': '）', '(': ')', '〈': '〉', '《': '》', '【': '】', '［': '］' };

/** 地の文の1行を文に分ける。括弧の中の 。 では分けない。返す各文は前後の空白を除いた文字列 */
function splitSentences(line) {
  const sentences = [];
  const stack = [];
  let start = 0;
  const chars = [...line];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (CLOSE[c]) stack.push(CLOSE[c]);
    else if (c === stack.at(-1)) stack.pop();
    else if (stack.length === 0 && /[。！？!?]/.test(c)) {
      while (i + 1 < chars.length && /[。！？!?]/.test(chars[i + 1])) i++;
      sentences.push(chars.slice(start, i + 1).join(''));
      start = i + 1;
    }
  }
  sentences.push(chars.slice(start).join(''));
  return sentences.map((s) => s.trim()).filter(Boolean);
}

const isDialogueLine = (line) => /^[「『]/.test(line);

/**
 * 原稿1ファイル分の行から、文章の傾向を数える。tokenizer は createTokenizer で作ったもの。
 * メタ行・視点行【】・区切りの行は数えない。
 * 返り値:
 *   sentences: 地の文の文 { line（元の行番号。0始まり）, text, length, ending（ENDINGS の key） }
 *   narrationChars / dialogueChars: 地の文・台詞の字数（台詞は 「 か 『 で始まる行）
 *   endings: 文末の種類ごとの文の数
 *   runs: 同じ種類の文末が RUN_MIN 文以上続いたところ { line, ending, count }。台詞と区切りで数え直す
 *   repeats: 同じ語（基本形）が、前に出た文から REPEAT_WINDOW 文の範囲に続けて出たところ
 *     { word, line（最初に出た行）, count（出た回数）, sentences（出た文） }。出た順。台詞と区切りで数え直す
 *   longSentences: LONG_SENTENCE_CHARS 字を超える文（長い順）
 *   datta: 「だった」で終わる文
 *   similes: 「ような・ように・みたい」を含む文
 */
export function analyzeProse(lines, tokenizer) {
  const { lines: body, indices } = getBodyLines(lines);
  const sentences = [];
  const runs = [];
  let narrationChars = 0;
  let dialogueChars = 0;
  let run = null;
  const repeats = [];
  /** 語ごとの、いま続いている繰り返し。first・last は最初と最後に出た文の番号 */
  let open = new Map();
  const closeRepeat = (repeat) => {
    if (repeat.count >= 2) repeats.push(repeat);
  };
  const endRun = () => {
    if (run && run.count >= RUN_MIN) runs.push(run);
    run = null;
  };
  const endRepeats = () => {
    for (const repeat of open.values()) closeRepeat(repeat);
    open = new Map();
  };

  body.forEach((raw, i) => {
    if (raw.trim() === '' || isViewpointLine(raw)) return;
    if (isSeparator(raw)) {
      endRun();
      endRepeats();
      return;
    }
    const text = stripInlineMarkup(raw).trim();
    if (text === '') return;
    if (isDialogueLine(text)) {
      dialogueChars += [...text].length;
      endRun();
      endRepeats();
      return;
    }
    narrationChars += [...text].length;
    for (const s of splitSentences(text)) {
      const tokens = tokenizeSentence(s, tokenizer);
      const ending = classifyEnding(tokens);
      const sentence = { line: indices[i], text: s, length: [...s].length, ending };
      const index = sentences.push(sentence) - 1;
      for (const word of tokens.map(contentWord).filter(Boolean)) {
        const repeat = open.get(word);
        if (repeat && index - repeat.last < REPEAT_WINDOW) {
          repeat.count++;
          if (repeat.last !== index) repeat.sentences.push(sentence);
          repeat.last = index;
          continue;
        }
        if (repeat) closeRepeat(repeat);
        open.set(word, { word, line: sentence.line, count: 1, sentences: [sentence], first: index, last: index });
      }
      if (run?.ending === ending) run.count++;
      else {
        endRun();
        run = { line: sentence.line, ending, count: 1 };
      }
    }
  });
  endRun();
  endRepeats();

  const endings = Object.fromEntries(ENDINGS.map(({ key }) => [key, 0]));
  for (const s of sentences) endings[s.ending]++;

  return {
    sentences,
    narrationChars,
    dialogueChars,
    endings,
    runs,
    repeats: repeats.sort((a, b) => a.first - b.first).map(({ first, last, ...repeat }) => repeat),
    longSentences: sentences.filter((s) => s.length > LONG_SENTENCE_CHARS).sort((a, b) => b.length - a.length),
    datta: sentences.filter((s) => /だった[。！？!?]*$/.test(s.text)),
    similes: sentences.filter((s) => /ような|ように|みたい/.test(s.text)),
  };
}

if (import.meta.vitest) {
  const { describe, test, expect, beforeAll } = import.meta.vitest;
  const { dirname, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { ensureIpadic } = await import('./ipadic.mjs');

  let tokenizer;
  beforeAll(async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const wasm = join(root, 'node_modules', 'lindera-wasm', 'lindera_wasm_bg.wasm');
    tokenizer = createTokenizer({ wasm, dictDir: await ensureIpadic() });
  }, 120_000);

  describe('classifyEnding', () => {
    test.each([
      ['男はそこに立っていた。', 'past'],
      ['彼は本を読んだ。', 'past'],
      ['海で泳いだ。', 'past'],
      ['それは手紙だった。', 'past'],
      ['朝が来る。', 'present'],
      ['風が冷たい。', 'present'],
      ['残りは少ない。', 'present'],
      ['小さな船の灯りがひとつ揺れている。', 'present'],
      ['男の名は朔という。', 'present'],
      ['これは罠だ。', 'copula'],
      ['あの男が嫌いだ。', 'copula'],
      ['それが答えである。', 'copula'],
      ['誰も来なかった。', 'negative'],
      ['返事はない。', 'negative'],
      ['何も言いませんでした。', 'negative'],
      ['静かな夜。', 'noun'],
      ['遠いサイレン――', 'noun'],
      ['それだけのこと。', 'noun'],
      ['どうしてだろう。', 'other'],
      ['来ないだろう。', 'other'],
      ['――ありがとう。', 'other'],
      ['今夜、灯を三度瞬かせてください。', 'other'],
      ['――。', 'other'],
    ])('%s は %s', (text, key) => {
      expect(classifyEnding(tokenizeSentence(text, tokenizer))).toBe(key);
    });
  });

  describe('splitSentences', () => {
    test('。！？で分け、続く記号はまとめる', () => {
      expect(splitSentences('雨だ。止まない！？　まだ降る')).toEqual(['雨だ。', '止まない！？', 'まだ降る']);
    });

    test('括弧の中の 。 では分けない', () => {
      expect(splitSentences('彼は「行く。すぐ行く。」と言った。外は暗い。')).toEqual([
        '彼は「行く。すぐ行く。」と言った。',
        '外は暗い。',
      ]);
    });
  });

  describe('analyzeProse', () => {
    test('地の文の文末を数え、台詞は字数だけ数える。メタ行・視点行は数えない', () => {
      const r = analyzeProse(
        ['【一】', 'Memo: メモ。', '', '　雨が降った。風が吹く。', '「寒いね」', '　静かな夜。'],
        tokenizer,
      );
      expect(r.sentences.map((s) => [s.line, s.ending])).toEqual([
        [3, 'past'],
        [3, 'present'],
        [5, 'noun'],
      ]);
      expect(r.endings).toMatchObject({ past: 1, present: 1, noun: 1, negative: 0 });
      expect(r.dialogueChars).toBe(5);
      expect(r.narrationChars).toBe(16);
    });

    test('ルビは親文字だけを数える', () => {
      const r = analyzeProse(['　|朔《さく》は立った。'], tokenizer);
      expect(r.sentences[0]).toMatchObject({ text: '朔は立った。', length: 6, ending: 'past' });
    });

    test('同じ文末の連続は台詞と区切りで数え直す', () => {
      const r = analyzeProse(
        ['　来た。見た。勝った。', '　また来た。', '「よし」', '　行った。戻った。', '', '*', '', '　寝た。'],
        tokenizer,
      );
      expect(r.runs).toEqual([{ line: 0, ending: 'past', count: 4 }]);
    });

    test('同じ語が REPEAT_WINDOW 文の範囲に続けて出たところを、基本形でまとめて拾う。離れて出た語は拾わない', () => {
      const r = analyzeProse(
        ['　彼は扉を見た。窓は暗い。', '　空は青い。扉を見ている。', '　海を見る。山を見る。'],
        tokenizer,
      );
      expect(r.repeats.map(({ word, line, count, sentences }) => [word, line, count, sentences.length])).toEqual([
        ['見る', 1, 3, 3],
      ]);
    });

    test('同じ文の中の繰り返しも拾い、する・いる・こと などの語は拾わない', () => {
      const r = analyzeProse(['　音がしていることにした。', '　雨の音、雨の匂い。'], tokenizer);
      expect(r.repeats.map(({ word, count, sentences }) => [word, count, sentences.length])).toEqual([
        ['音', 2, 2],
        ['雨', 2, 1],
      ]);
    });

    test('近くの繰り返しは台詞と区切りで数え直す', () => {
      const r = analyzeProse(['　扉が開く。', '「誰だ」', '　扉が閉じる。', '', '*', '', '　扉が鳴る。'], tokenizer);
      expect(r.repeats).toEqual([]);
    });

    test('長い文・だった・ような を拾う', () => {
      const long = `　${'あ'.repeat(LONG_SENTENCE_CHARS)}た。`;
      const r = analyzeProse([long, '　それは手紙だった。', '　夢のような話だ。'], tokenizer);
      expect(r.longSentences.map((s) => s.line)).toEqual([0]);
      expect(r.datta.map((s) => s.line)).toEqual([1]);
      expect(r.similes.map((s) => s.line)).toEqual([2]);
    });
  });
}
