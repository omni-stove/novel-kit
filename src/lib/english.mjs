/**
 * 英語原稿の組版で共通に使う小道具
 */

const NUMBER_WORDS = [
  'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen',
  'Eighteen', 'Nineteen', 'Twenty', 'Twenty-One', 'Twenty-Two', 'Twenty-Three',
  'Twenty-Four', 'Twenty-Five', 'Twenty-Six', 'Twenty-Seven', 'Twenty-Eight',
  'Twenty-Nine', 'Thirty', 'Thirty-One', 'Thirty-Two', 'Thirty-Three',
  'Thirty-Four', 'Thirty-Five', 'Thirty-Six', 'Thirty-Seven', 'Thirty-Eight',
  'Thirty-Nine', 'Forty',
];

// 章番号を英語の数詞にする（Chapter One / Part Two ...）。範囲外は数字のまま
export function chapterNumberWord(n) {
  return NUMBER_WORDS[n - 1] ?? String(n);
}

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;
  test('chapterNumberWord', () => {
    expect(chapterNumberWord(1)).toBe('One');
    expect(chapterNumberWord(21)).toBe('Twenty-One');
    expect(chapterNumberWord(40)).toBe('Forty');
    expect(chapterNumberWord(41)).toBe('41');
  });
}
