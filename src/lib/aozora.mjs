/**
 * 青空文庫の注記（https://www.aozora.gr.jp/annotation/）を、この組版エンジンの記法に読み替える。
 *
 * 行の中の注記は normalizeAozoraInline で内部の記法にする:
 *   ｜親《るび》・漢字《かんじ》       → |親《るび》（縦棒なしは直前に続く漢字が親文字）
 *   X［＃「X」に傍点］・［＃傍点］X［＃傍点終わり］（白ゴマ・丸など傍点の種類は問わない） → 《《X》》
 *   X［＃「X」は太字］・［＃太字］X［＃太字終わり］       → BOLD_OPEN X BOLD_CLOSE
 *   X［＃「X」は縦中横］・［＃縦中横］X［＃縦中横終わり］ → TCY_OPEN X TCY_CLOSE
 *   X［＃「X」は大見出し］（中見出し・小見出し。行全体） → ［＃大見出し］X［＃大見出し終わり］
 *   それ以外の注記（傍線・左ルビ・斜体・外字の説明など）は出力しない（本文はそのまま残す）
 * 行の単位で効く注記は、そのまま残して parseAozoraLine で読む:
 *   ［＃改ページ］（改丁・改見開き・改段も同じ）、［＃ここからN字下げ］〜［＃ここで字下げ終わり］、
 *   行頭の［＃N字下げ］・［＃地付き］・［＃地からN字上げ］、見出し
 */

/** 太字・縦中横の内部の記法。原稿の文字と衝突しないよう、私用領域の文字で挟む */
export const BOLD_OPEN = '';
export const BOLD_CLOSE = '';
export const TCY_OPEN = '';
export const TCY_CLOSE = '';

const KANJI = '\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF々〆ヶ';
/**
 * ルビ。縦棒のないルビの親文字は直前に続く漢字（ほかの漢字の途中からは始めない）。
 * | の付いたルビは1つめの選択肢でそのまま読み飛ばす（その親文字の途中の漢字から縦棒なしのルビとして読み直さないため）。
 */
const RUBY_RE = new RegExp(`(\\|[^|《]*《[^《》]*》)|(?<![${KANJI}])([${KANJI}]+)《(?!《)([^《》]+)》`, 'g');

const NUM = '[0-9０-９]+';
const toNumber = (s) =>
  parseInt(
    s.replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 0xff10)),
    10,
  );

const PAGE_BREAK_RE = /^［＃改(ページ|丁|見開き|段)］$/;
const BLOCK_INDENT_START_RE = new RegExp(`^［＃ここから(${NUM})字下げ］$`);
const BLOCK_INDENT_END_RE = /^［＃ここで字下げ終わり］$/;
const LINE_PREFIX_RE = new RegExp(`^(［＃(?:${NUM}字下げ|地付き|地から${NUM}字上げ)］)+`);
const HEADING_LEVELS = { 大: 'large', 中: 'medium', 小: 'small' };
const HEADING_RE = /^［＃([大中小])見出し］(.*)［＃\1見出し終わり］$/;

const EMPHASIS_KINDS = /^(白ゴマ|丸|白丸|黒三角|白三角|二重丸|蛇の目|ばつ)?傍点$/;

/** 行の中の注記を内部の記法にする。行の単位の注記（改ページ・字下げ・見出し）は残す */
export function normalizeAozoraInline(line) {
  if (!line.includes('［＃') && !line.includes('《') && !line.includes('｜')) return line;
  const trimmed = line.trim();
  if (PAGE_BREAK_RE.test(trimmed) || BLOCK_INDENT_START_RE.test(trimmed) || BLOCK_INDENT_END_RE.test(trimmed))
    return trimmed;

  const prefix = line.match(LINE_PREFIX_RE)?.[0] ?? '';
  let text = line.slice(prefix.length);

  const headingRef = text.match(/^(.*)［＃「([^」]+)」は([大中小])見出し］$/);
  if (headingRef && headingRef[1] === headingRef[2]) {
    return `${prefix}［＃${headingRef[3]}見出し］${normalizeAozoraInline(headingRef[1])}［＃${headingRef[3]}見出し終わり］`;
  }
  const heading = text.match(HEADING_RE);
  if (heading)
    return `${prefix}［＃${heading[1]}見出し］${normalizeAozoraInline(heading[2])}［＃${heading[1]}見出し終わり］`;

  text = text.replace(/｜/g, '|').replace(RUBY_RE, (_m, explicit, base, ruby) => explicit ?? `|${base}《${ruby}》`);

  let out = '';
  let last = 0;
  for (const m of text.matchAll(/［＃「([^」]+)」[にはの]([^］]*)］/g)) {
    out += text.slice(last, m.index);
    last = m.index + m[0].length;
    const [, target, kind] = m;
    const wrap = EMPHASIS_KINDS.test(kind)
      ? ['《《', '》》']
      : kind === '太字'
        ? [BOLD_OPEN, BOLD_CLOSE]
        : kind === '縦中横'
          ? [TCY_OPEN, TCY_CLOSE]
          : null;
    if (wrap && out.endsWith(target)) out = out.slice(0, -target.length) + wrap[0] + target + wrap[1];
  }
  out += text.slice(last);

  out = out.replace(
    /［＃((?:白ゴマ|丸|白丸|黒三角|白三角|二重丸|蛇の目|ばつ)?傍点|太字|縦中横)］(.*?)［＃\1終わり］/g,
    (_, kind, inner) => {
      if (kind === '太字') return `${BOLD_OPEN}${inner}${BOLD_CLOSE}`;
      if (kind === '縦中横') return `${TCY_OPEN}${inner}${TCY_CLOSE}`;
      return `《《${inner}》》`;
    },
  );

  return prefix + out.replace(/［＃[^］]*］/g, '');
}

/**
 * 行の単位の注記を読む（normalizeAozoraInline のあとの行）。
 *   { kind: 'pageBreak' } / { kind: 'indentStart', indent } / { kind: 'indentEnd' }
 *   { kind: 'text', text, indent, alignEnd, raise, heading } — text は注記を除いた本文。
 *   indent は字下げの字数、alignEnd は地付き（地から上げでも true）、raise は地からの字上げの字数、
 *   heading は 'large' / 'medium' / 'small'（見出しでなければ null）
 */
export function parseAozoraLine(line) {
  const trimmed = line.trim();
  if (PAGE_BREAK_RE.test(trimmed)) return { kind: 'pageBreak' };
  const start = trimmed.match(BLOCK_INDENT_START_RE);
  if (start) return { kind: 'indentStart', indent: toNumber(start[1]) };
  if (BLOCK_INDENT_END_RE.test(trimmed)) return { kind: 'indentEnd' };

  const result = { kind: 'text', text: line, indent: 0, alignEnd: false, raise: 0, heading: null };
  const prefix = line.match(LINE_PREFIX_RE)?.[0];
  if (prefix) {
    result.text = line.slice(prefix.length);
    for (const [, body] of prefix.matchAll(/［＃([^］]*)］/g)) {
      const indent = body.match(new RegExp(`^(${NUM})字下げ$`));
      const raise = body.match(new RegExp(`^地から(${NUM})字上げ$`));
      if (indent) result.indent = toNumber(indent[1]);
      else if (raise) {
        result.alignEnd = true;
        result.raise = toNumber(raise[1]);
      } else result.alignEnd = true;
    }
  }
  const heading = result.text.match(HEADING_RE);
  if (heading) {
    result.heading = HEADING_LEVELS[heading[1]];
    result.text = heading[2];
  }
  return result;
}

/**
 * 注記を除いた本文だけを返す（改ページ・字下げの範囲の行は null）。注記の行を本文の行と同じ扱いにできない出力
 * （字数の数え方・txt 以外の単純な出力）向け。
 */
export function aozoraBodyText(line) {
  const parsed = parseAozoraLine(normalizeAozoraInline(line));
  return parsed.kind === 'text' ? parsed.text : null;
}

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest;
  const B = (s) => `${BOLD_OPEN}${s}${BOLD_CLOSE}`;
  const T = (s) => `${TCY_OPEN}${s}${TCY_CLOSE}`;

  describe('normalizeAozoraInline', () => {
    test('ルビ: ｜ と縦棒なし（直前に続く漢字）', () => {
      expect(normalizeAozoraInline('｜お茶の間《おちゃのま》へ')).toBe('|お茶の間《おちゃのま》へ');
      expect(normalizeAozoraInline('私は東京都《とうきょうと》へ')).toBe('私は|東京都《とうきょうと》へ');
      expect(normalizeAozoraInline('|東京都《とうきょうと》')).toBe('|東京都《とうきょうと》');
      expect(normalizeAozoraInline('ここ《《強調》》')).toBe('ここ《《強調》》');
      expect(normalizeAozoraInline('漢字《《強調》》')).toBe('漢字《《強調》》');
    });
    test('前方参照の傍点・太字・縦中横', () => {
      expect(normalizeAozoraInline('覚悟［＃「覚悟」に傍点］を決めた')).toBe('《《覚悟》》を決めた');
      expect(normalizeAozoraInline('覚悟［＃「覚悟」に白ゴマ傍点］')).toBe('《《覚悟》》');
      expect(normalizeAozoraInline('ここぞ［＃「ここぞ」は太字］')).toBe(B('ここぞ'));
      expect(normalizeAozoraInline('第42［＃「42」は縦中横］話')).toBe(`第${T('42')}話`);
    });
    test('直前が対象の文字列で終わっていなければ、注記だけを捨てる', () => {
      expect(normalizeAozoraInline('覚悟を［＃「覚悟」に傍点］決めた')).toBe('覚悟を決めた');
    });
    test('範囲の注記', () => {
      expect(normalizeAozoraInline('［＃傍点］嬉しい［＃傍点終わり］')).toBe('《《嬉しい》》');
      expect(normalizeAozoraInline('［＃太字］ここ［＃太字終わり］と［＃縦中横］12［＃縦中横終わり］')).toBe(
        `${B('ここ')}と${T('12')}`,
      );
    });
    test('範囲の傍点は種類を問わない', () => {
      expect(normalizeAozoraInline('［＃白丸傍点］嬉しい［＃白丸傍点終わり］')).toBe('《《嬉しい》》');
    });
    test('行全体の見出しの中の注記も読み替える', () => {
      expect(normalizeAozoraInline('［＃中見出し］東京《とうきょう》［＃中見出し終わり］')).toBe(
        '［＃中見出し］|東京《とうきょう》［＃中見出し終わり］',
      );
    });
    test('対応していない注記は捨てる', () => {
      expect(normalizeAozoraInline('運命［＃「運命」に波線］が動く')).toBe('運命が動く');
      expect(normalizeAozoraInline('英雄［＃「英雄」の左に「ヒーロー」のルビ］')).toBe('英雄');
    });
    test('行の単位の注記は残す', () => {
      expect(normalizeAozoraInline('［＃改ページ］')).toBe('［＃改ページ］');
      expect(normalizeAozoraInline('［＃ここから２字下げ］')).toBe('［＃ここから２字下げ］');
      expect(normalizeAozoraInline('［＃３字下げ］覚悟［＃「覚悟」に傍点］')).toBe('［＃３字下げ］《《覚悟》》');
      expect(normalizeAozoraInline('第一章［＃「第一章」は大見出し］')).toBe(
        '［＃大見出し］第一章［＃大見出し終わり］',
      );
    });
  });

  describe('parseAozoraLine', () => {
    test('改ページ・字下げの範囲', () => {
      expect(parseAozoraLine('［＃改ページ］')).toEqual({ kind: 'pageBreak' });
      expect(parseAozoraLine('［＃改丁］')).toEqual({ kind: 'pageBreak' });
      expect(parseAozoraLine('［＃改見開き］')).toEqual({ kind: 'pageBreak' });
      expect(parseAozoraLine('［＃改段］')).toEqual({ kind: 'pageBreak' });
      expect(parseAozoraLine('［＃ここから2字下げ］')).toEqual({ kind: 'indentStart', indent: 2 });
      expect(parseAozoraLine('［＃ここから２字下げ］')).toEqual({ kind: 'indentStart', indent: 2 });
      expect(parseAozoraLine('［＃ここで字下げ終わり］')).toEqual({ kind: 'indentEnd' });
    });
    test('行頭の字下げ・地付き・地から上げ、見出し', () => {
      expect(parseAozoraLine('［＃３字下げ］本文')).toMatchObject({
        kind: 'text',
        text: '本文',
        indent: 3,
        alignEnd: false,
      });
      expect(parseAozoraLine('［＃地付き］署名')).toMatchObject({ text: '署名', alignEnd: true, raise: 0 });
      expect(parseAozoraLine('［＃地から２字上げ］署名')).toMatchObject({ text: '署名', alignEnd: true, raise: 2 });
      expect(parseAozoraLine('［＃中見出し］夜［＃中見出し終わり］')).toMatchObject({ text: '夜', heading: 'medium' });
      expect(parseAozoraLine('本文')).toEqual({
        kind: 'text',
        text: '本文',
        indent: 0,
        alignEnd: false,
        raise: 0,
        heading: null,
      });
    });
  });

  describe('aozoraBodyText', () => {
    test('本文だけを返し、改ページなどの行は null', () => {
      expect(aozoraBodyText('［＃２字下げ］覚悟［＃「覚悟」に傍点］')).toBe('《《覚悟》》');
      expect(aozoraBodyText('［＃改ページ］')).toBeNull();
    });
  });
}
