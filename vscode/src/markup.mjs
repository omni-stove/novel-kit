/**
 * ルビ・傍点を書き込むコマンドの文字列操作（vscode API に依存しない）
 */

/** ルビの親文字として自動で選ぶ漢字（々〆ヶも漢字の続きとして扱う） */
const KANJI_RE = /[㐀-䶿一-鿿豈-﫿々〆ヶ]/;

/**
 * 選択範囲が無いときにルビを振る語。カーソルの前後に続く漢字の並びの範囲 { start, end } を返す。
 * 漢字に接していないとき、すでに |親《るび》 の親文字の中のとき（二重に振らない）は null
 */
export function kanjiRunAt(text, offset) {
  let start = offset;
  while (start > 0 && KANJI_RE.test(text[start - 1])) start--;
  let end = offset;
  while (end < text.length && KANJI_RE.test(text[end])) end++;
  if (start === end) return null;
  if (text[start - 1] === '|' || text[start - 1] === '｜' || text[end] === '《') return null;
  return { start, end };
}

// 親文字が漢字だけでも | を付ける（直前の語とつながって親文字の範囲が変わらないように）
export const rubyMarkup = (base, ruby) => `|${base}《${ruby}》`;

export const emphasisMarkup = (text) => `《《${text}》》`;

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest;

  describe('kanjiRunAt', () => {
    test('カーソルの前後に続く漢字の並び', () => {
      expect(kanjiRunAt('私は東京都に行く', 5)).toEqual({ start: 2, end: 5 });
      expect(kanjiRunAt('私は東京都に行く', 2)).toEqual({ start: 2, end: 5 });
      expect(kanjiRunAt('人々が', 2)).toEqual({ start: 0, end: 2 });
      expect(kanjiRunAt('三ヶ月と〆切', 0)).toEqual({ start: 0, end: 3 });
      expect(kanjiRunAt('三ヶ月と〆切', 6)).toEqual({ start: 4, end: 6 });
    });
    test('漢字に接していなければ null', () => {
      expect(kanjiRunAt('ひらがな', 2)).toBeNull();
      expect(kanjiRunAt('', 0)).toBeNull();
    });
    test('すでにルビが振ってある親文字なら null', () => {
      expect(kanjiRunAt('|東京《とうきょう》', 2)).toBeNull();
      expect(kanjiRunAt('東京《とうきょう》', 1)).toBeNull();
      expect(kanjiRunAt('｜東京《とうきょう》', 2)).toBeNull();
    });
  });

  describe('rubyMarkup / emphasisMarkup', () => {
    test('記法にする', () => {
      expect(rubyMarkup('東京', 'とうきょう')).toBe('|東京《とうきょう》');
      expect(emphasisMarkup('ここ')).toBe('《《ここ》》');
    });
  });
}
