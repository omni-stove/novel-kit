/**
 * 縦書き原稿の「N字×M行」グリッド換算に関する共通ロジック。
 * 原稿用紙換算（novel count / novel pdf --count-only）と縦書き docx の枚数見積もりが同じ規則で数える。
 */

/** ぶら下げ対象文字（行末に1字だけはみ出すなら前の行の最後のマスに追い込む） */
export const HANGING_CHARS = '。、，．」』）】〉》〕｝！？!?';

/**
 * 1論理行が cols 字幅で何行を占めるかを数える。空行は1行。
 * 行頭の全角スペースもマスとして数える。
 */
export function countWrappedRows(line, cols, { hanging = true } = {}) {
  const chars = [...line];
  if (chars.length === 0) return 1;

  let rows = 0;
  let pos = 0;
  while (pos < chars.length) {
    rows++;
    if (chars.length - pos <= cols) break;
    pos += hanging && HANGING_CHARS.includes(chars[pos + cols]) ? cols + 1 : cols;
  }
  return rows;
}

/**
 * 縦中横で1マスに収まる2桁の数字を1字（〇）に置き換え、マス数を数えられる形にする。
 * 1桁・3桁以上の数字は1字1マスのまま。
 * tategaki-docx の textRunXml が2桁の数字を縦中横で組むのと同じ規則で数える必要がある。
 */
export function normalizeTcy(text) {
  return text.replace(/(?<![0-9])[0-9]{2}(?![0-9])/g, '〇');
}

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest;

  describe('countWrappedRows', () => {
    test('空行は1行', () => {
      expect(countWrappedRows('', 42)).toBe(1);
      expect(countWrappedRows('', 20)).toBe(1);
    });
    test('cols字以下は1行', () => {
      expect(countWrappedRows('あ', 20)).toBe(1);
      expect(countWrappedRows('あ'.repeat(20), 20)).toBe(1);
      expect(countWrappedRows('あ'.repeat(42), 42)).toBe(1);
    });
    test('cols+1字目がぶら下げ対象なら1行に収まる', () => {
      expect(countWrappedRows(`${'あ'.repeat(20)}。`, 20)).toBe(1);
      expect(countWrappedRows(`${'あ'.repeat(42)}」`, 42)).toBe(1);
      for (const ch of '、」）』】〉》') {
        expect(countWrappedRows('あ'.repeat(20) + ch, 20)).toBe(1);
      }
    });
    test('cols+1字目が通常字なら2行', () => {
      expect(countWrappedRows('あ'.repeat(21), 20)).toBe(2);
      expect(countWrappedRows('あ'.repeat(43), 42)).toBe(2);
    });
    test('hanging=false ならぶら下げ対象でも2行', () => {
      expect(countWrappedRows(`${'あ'.repeat(42)}。`, 42, { hanging: false })).toBe(2);
    });
    test('途中の行末ぶら下げも効く', () => {
      expect(countWrappedRows(`${'あ'.repeat(20)}。${'あ'.repeat(20)}`, 20)).toBe(2);
      expect(countWrappedRows(`${'あ'.repeat(42)}。${'あ'.repeat(42)}`, 42)).toBe(2);
    });
    test('行頭の全角スペースもマスとして数える', () => {
      expect(countWrappedRows(`　${'あ'.repeat(19)}`, 20)).toBe(1);
      expect(countWrappedRows(`　${'あ'.repeat(20)}`, 20)).toBe(2);
    });
    test('複数行', () => {
      expect(countWrappedRows('あ'.repeat(40), 20)).toBe(2);
      expect(countWrappedRows('あ'.repeat(41), 20)).toBe(3);
      expect(countWrappedRows('あ'.repeat(85), 42)).toBe(3);
    });
  });

  describe('normalizeTcy', () => {
    test('2桁の数字は縦中横で1マス扱い', () => {
      expect(normalizeTcy('全12巻')).toBe('全〇巻');
      expect([...normalizeTcy('全12巻')].length).toBe(3);
    });
    test('1桁・3桁以上はそのまま（1字1マス）', () => {
      expect(normalizeTcy('全5巻')).toBe('全5巻');
      expect(normalizeTcy('全123巻')).toBe('全123巻');
    });
  });
}
