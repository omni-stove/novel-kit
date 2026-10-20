/**
 * ページレイアウト定義（Word の「ページ設定 > 文字数と行数」に相当）と、そこから導く組版寸法。
 * 日本語は用紙・余白・字数・行数を決めると、文字サイズと行送りが決まる。
 * 既定値（A4横・余白 20/20/25/20mm）は scripts/txt-to-pdf.mts の calcVerticalLayout と同じ寸法になる。
 * 英語（原稿の文字で判定）は用紙・余白・文字サイズ・行送りを決め、横書き固定で、行数は版面から決まる。
 * 既定値（6×9in）は scripts/txt-to-en-pdf.mts の PAGE_SIZES と同じ。
 */

// 短辺 x 長辺（mm）。6x9in / 5x8in は英語ペーパーバックの判型（scripts/txt-to-en-pdf.mts の --6x9 / --5x8）
export const PAPER_SIZES = {
  A4: [210, 297],
  B5: [182, 257],
  A5: [148, 210],
  B6: [128, 182],
  A6: [105, 148],
  '6x9in': [152.4, 228.6],
  '5x8in': [127, 203.2],
};

const MM_PER_PT = 0.3528;
const MM_PER_IN = 25.4;
// 行数を指定しないときの行送り（txt-to-pdf の既定と同じ）
const AUTO_LINE_HEIGHT = { vertical: 1.125, horizontal: 1.8 };
// 英文の平均字幅の目安（em）。字数×行数の表示に使う
const EN_AVERAGE_CHAR_WIDTH = 0.5;

export const DEFAULT_LAYOUT = {
  writingMode: 'vertical',
  paper: 'A4',
  orientation: 'landscape',
  margin: { top: 20, right: 20, bottom: 25, left: 20 },
  chars: 30,
  // null は行送りを自動（字送りの 1.125 倍）にして、入るだけ行を入れる
  lines: null,
  fontFamily: '',
};

const inMm = (inch) => Math.round(inch * MM_PER_IN * 100) / 100;

// 英語の組版。見開きの内側の余白を左、外側を右に置く（プレビューは単ページ）
export const DEFAULT_ENGLISH_LAYOUT = {
  paper: '6x9in',
  orientation: 'portrait',
  margin: { top: inMm(0.7), right: inMm(0.6), bottom: inMm(0.6), left: inMm(0.8) },
  // 本文の文字サイズ（pt）と行送り（倍率）
  fontSize: 11,
  lineHeight: 1.4,
  fontFamily: '',
};

export const BUILTIN_PRESETS = {
  '標準（30字・行数自動）': DEFAULT_LAYOUT,
  '40字×40行': { ...DEFAULT_LAYOUT, chars: 40, lines: 40 },
  '40字×30行': { ...DEFAULT_LAYOUT, chars: 40, lines: 30 },
  '42字×34行': { ...DEFAULT_LAYOUT, chars: 42, lines: 34 },
  '原稿用紙（20字×20行）': { ...DEFAULT_LAYOUT, chars: 20, lines: 20 },
  '文庫（A6・40字×17行）': {
    ...DEFAULT_LAYOUT,
    paper: 'A6',
    orientation: 'portrait',
    margin: { top: 15, right: 12, bottom: 17, left: 12 },
    chars: 40,
    lines: 17,
  },
};

// 英語のプリセット（txt-to-en-pdf.mts の PAGE_SIZES と同じ判型・余白・文字サイズ）
export const BUILTIN_ENGLISH_PRESETS = {
  '6×9in（US Trade）': DEFAULT_ENGLISH_LAYOUT,
  '5×8in（Trade Paperback）': {
    ...DEFAULT_ENGLISH_LAYOUT,
    paper: '5x8in',
    margin: { top: inMm(0.6), right: inMm(0.5), bottom: inMm(0.55), left: inMm(0.7) },
    fontSize: 10.5,
    lineHeight: 1.35,
  },
  A5: {
    ...DEFAULT_ENGLISH_LAYOUT,
    paper: 'A5',
    margin: { top: 16, right: 15, bottom: 14, left: 18 },
  },
};

const clampInt = (v, min, max, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= min ? Math.min(n, max) : fallback;
};

const clampMm = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 100) : fallback;
};

// 範囲に収めた数値（0.01 刻み）。範囲外・不正値は既定
const clampNumber = (v, min, max, fallback) => {
  const n = Math.round(Number(v) * 100) / 100;
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};

const normalizeMargin = (raw, d) => {
  const m = raw && typeof raw === 'object' ? raw : {};
  return {
    top: clampMm(m.top, d.top),
    right: clampMm(m.right, d.right),
    bottom: clampMm(m.bottom, d.bottom),
    left: clampMm(m.left, d.left),
  };
};

/**
 * 設定ファイルや webview から来た値を、欠けや不正値を既定で埋めたレイアウトにする。
 * english: true なら英語のレイアウト（用紙・余白・文字サイズ・行送り・フォント）
 */
export function normalizeLayout(raw, { english = false } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  if (english) {
    const d = DEFAULT_ENGLISH_LAYOUT;
    return {
      paper: r.paper in PAPER_SIZES ? r.paper : d.paper,
      orientation: r.orientation === 'landscape' ? 'landscape' : r.orientation === 'portrait' ? 'portrait' : d.orientation,
      margin: normalizeMargin(r.margin, d.margin),
      fontSize: clampNumber(r.fontSize, 5, 40, d.fontSize),
      lineHeight: clampNumber(r.lineHeight, 1, 3, d.lineHeight),
      fontFamily: typeof r.fontFamily === 'string' ? r.fontFamily.trim() : '',
    };
  }
  const d = DEFAULT_LAYOUT;
  return {
    writingMode: r.writingMode === 'horizontal' ? 'horizontal' : 'vertical',
    paper: r.paper in PAPER_SIZES ? r.paper : d.paper,
    orientation: r.orientation === 'portrait' ? 'portrait' : r.orientation === 'landscape' ? 'landscape' : d.orientation,
    margin: normalizeMargin(r.margin, d.margin),
    chars: clampInt(r.chars, 5, 100, d.chars),
    lines: r.lines == null || r.lines === '' ? null : clampInt(r.lines, 1, 100, null),
    fontFamily: typeof r.fontFamily === 'string' ? r.fontFamily.trim() : '',
  };
}

export function layoutsEqual(a, b, opts = {}) {
  return JSON.stringify(normalizeLayout(a, opts)) === JSON.stringify(normalizeLayout(b, opts));
}

// 原稿の文字から組版の言語を判定する。本文（メタ行を除く）のアルファベットが日本語の文字より多ければ英語
export function detectLanguage(lines, isMetaLine = () => false) {
  let latin = 0;
  let japanese = 0;
  for (const line of lines) {
    if (isMetaLine(line)) continue;
    latin += (line.match(/[A-Za-z]/g) ?? []).length;
    japanese += (line.match(/[\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Han}]/gu) ?? []).length;
  }
  return latin > japanese ? 'en' : 'ja';
}

/**
 * english: true なら英語のレイアウトとして組む（横書き固定。chars は版面幅を文字サイズで割った値）。
 * 日本語は字数から文字サイズが決まる
 */
export function computeMetrics(rawLayout, { english = false } = {}) {
  const layout = normalizeLayout(rawLayout, { english });
  const vertical = !english && layout.writingMode === 'vertical';
  const [short, long] = PAPER_SIZES[layout.paper];
  const paperW = layout.orientation === 'landscape' ? long : short;
  const paperH = layout.orientation === 'landscape' ? short : long;
  const areaW = paperW - layout.margin.left - layout.margin.right;
  const areaH = paperH - layout.margin.top - layout.margin.bottom;
  // 字を送る方向（縦書きなら天地）と行を送る方向の版面寸法
  const availInline = vertical ? areaH : areaW;
  const availBlock = vertical ? areaW : areaH;

  const base = {
    layout,
    language: english ? 'en' : 'ja',
    vertical,
    paperW,
    paperH,
    availInline,
    availBlock,
  };

  if (english) {
    const fontSizePt = layout.fontSize;
    const fontSizeMm = fontSizePt * MM_PER_PT;
    const lineHeight = layout.lineHeight;
    return {
      ...base,
      // 版面幅を em で表した値（プレビューが版面の幅を chars × 文字サイズで決めるため、整数にしない）
      chars: availInline / fontSizeMm,
      charsApprox: Math.max(1, Math.round(availInline / (fontSizeMm * EN_AVERAGE_CHAR_WIDTH))),
      lines: Math.max(1, Math.floor(availBlock / (fontSizeMm * lineHeight))),
      fontSizePt,
      fontSizeMm,
      lineHeight,
      linePitchMm: fontSizeMm * lineHeight,
    };
  }

  const cellMm = availInline / layout.chars;
  // txt-to-pdf と同じく 0.1pt 単位に切り捨てる（PDFと字面を揃えるため）
  const fontSizePt = Math.floor((cellMm / MM_PER_PT) * 10) / 10;
  const fontSizeMm = fontSizePt * MM_PER_PT;

  const lineHeight = layout.lines
    ? availBlock / layout.lines / cellMm
    : AUTO_LINE_HEIGHT[layout.writingMode];
  const lines = layout.lines ?? Math.max(1, Math.floor(availBlock / (fontSizeMm * lineHeight)));

  return {
    ...base,
    chars: layout.chars,
    lines,
    fontSizePt,
    fontSizeMm,
    lineHeight,
    linePitchMm: fontSizeMm * lineHeight,
  };
}

// scripts/txt-to-pdf.mts は A4横・余白固定で組むので、それと同じ版面かどうか
export function matchesPdfScriptPage(rawLayout) {
  const { paper, orientation, margin } = normalizeLayout(rawLayout);
  const d = DEFAULT_LAYOUT;
  return paper === d.paper && orientation === d.orientation
    && JSON.stringify(margin) === JSON.stringify(d.margin);
}

// scripts/txt-to-en-pdf.mts の判型（--5x8 / --6x9 / --a5）に対応する用紙かどうか。向きが縦でなければ null
export function enPdfPageSize(rawLayout) {
  const { paper, orientation } = normalizeLayout(rawLayout, { english: true });
  if (orientation !== 'portrait') return null;
  return { '5x8in': '5x8', '6x9in': '6x9', A5: 'a5' }[paper] ?? null;
}

export function describeLayout(rawLayout, { english = false } = {}) {
  const m = computeMetrics(rawLayout, { english });
  if (english) return `${m.fontSizePt}pt・行送り${m.lineHeight}（約${m.charsApprox}字×${m.lines}行）`;
  return `${m.chars}字×${m.lines}行`;
}

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest;

  describe('computeMetrics', () => {
    test('既定は txt-to-pdf の calcVerticalLayout（30字・行送り1.125）と同じ寸法', () => {
      const m = computeMetrics(DEFAULT_LAYOUT);
      expect(m.availInline).toBe(165);
      expect(m.availBlock).toBe(257);
      expect(m.fontSizePt).toBe(Math.floor((165 / 30 / 0.3528) * 10) / 10);
      expect(m.lineHeight).toBe(1.125);
      expect(m.lines).toBe(41);
    });
    test('行数を指定すると版面幅を行数で割った行送りになる（--size 40x40 相当）', () => {
      const m = computeMetrics({ ...DEFAULT_LAYOUT, chars: 40, lines: 40 });
      expect(m.lineHeight).toBeCloseTo(257 / 40 / (165 / 40), 10);
      expect(m.lines).toBe(40);
    });
    test('横書きは字を左右に、行を天地に送る', () => {
      const m = computeMetrics({ ...DEFAULT_LAYOUT, writingMode: 'horizontal', orientation: 'portrait', chars: 40, lines: 30 });
      expect(m.paperW).toBe(210);
      expect(m.availInline).toBe(170);
      expect(m.availBlock).toBe(252);
    });
  });

  describe('英語の組版', () => {
    test('文字サイズと行送りを直接指定し、横書き固定で、行数は版面から決まる', () => {
      const m = computeMetrics(DEFAULT_ENGLISH_LAYOUT, { english: true });
      expect(m.language).toBe('en');
      expect(m.vertical).toBe(false);
      expect(m.fontSizePt).toBe(11);
      expect(m.lineHeight).toBe(1.4);
      expect(m.paperW).toBe(152.4);
      // 版面幅 = 152.4 - 20.32 - 15.24
      expect(m.chars * m.fontSizeMm).toBeCloseTo(116.84, 6);
      expect(m.lines).toBe(Math.floor((228.6 - 17.78 - 15.24) / (11 * 0.3528 * 1.4)));
    });
    test('英語のレイアウトは欠けを 6×9in の既定で埋め、writingMode を持たない', () => {
      expect(normalizeLayout(null, { english: true })).toEqual(DEFAULT_ENGLISH_LAYOUT);
      const l = normalizeLayout({ paper: 'A5', fontSize: '10.5', lineHeight: 9, writingMode: 'vertical' }, { english: true });
      expect(l).toMatchObject({ paper: 'A5', fontSize: 10.5, lineHeight: 1.4 });
      expect(l).not.toHaveProperty('writingMode');
      expect(computeMetrics({ writingMode: 'vertical' }, { english: true }).vertical).toBe(false);
    });
    test('detectLanguage は本文のアルファベットが日本語の文字より多ければ英語', () => {
      expect(detectLanguage(['As a child, I could go anywhere.', '【-21Y】'])).toBe('en');
      expect(detectLanguage(['子どものころ、私はどこへでも行けた。', 'POV: Nadia'])).toBe('ja');
      expect(detectLanguage(['POV: Nadia Solis', '私'], l => l.startsWith('POV:'))).toBe('ja');
      expect(detectLanguage([])).toBe('ja');
    });
    test('enPdfPageSize は英語PDFスクリプトの判型に対応する用紙を返す', () => {
      expect(enPdfPageSize(BUILTIN_ENGLISH_PRESETS['6×9in（US Trade）'])).toBe('6x9');
      expect(enPdfPageSize(BUILTIN_ENGLISH_PRESETS['5×8in（Trade Paperback）'])).toBe('5x8');
      expect(enPdfPageSize(BUILTIN_ENGLISH_PRESETS.A5)).toBe('a5');
      expect(enPdfPageSize({ paper: 'A5', orientation: 'landscape' })).toBeNull();
      expect(enPdfPageSize({ paper: 'A4' })).toBeNull();
    });
    test('describeLayout は英語では文字サイズと行送りを出す', () => {
      expect(describeLayout(DEFAULT_LAYOUT)).toBe('30字×41行');
      expect(describeLayout(BUILTIN_ENGLISH_PRESETS.A5, { english: true })).toMatch(/^11pt・行送り1\.4（約\d+字×\d+行）$/);
    });
    test('layoutsEqual は英語のレイアウトも比べられる', () => {
      expect(layoutsEqual({ paper: '6x9in' }, DEFAULT_ENGLISH_LAYOUT, { english: true })).toBe(true);
      expect(layoutsEqual({ paper: 'A5' }, DEFAULT_ENGLISH_LAYOUT, { english: true })).toBe(false);
    });
  });

  describe('normalizeLayout', () => {
    test('欠けた値・不正値は既定で埋める', () => {
      expect(normalizeLayout(null)).toEqual(DEFAULT_LAYOUT);
      expect(normalizeLayout({ chars: 'x', lines: '', paper: 'Z9', margin: { top: -1 } })).toEqual(DEFAULT_LAYOUT);
    });
    test('指定値は丸めて採用する', () => {
      const l = normalizeLayout({ chars: '40', lines: 34.4, paper: 'B5', orientation: 'portrait', margin: { top: 10 } });
      expect(l).toMatchObject({ chars: 40, lines: 34, paper: 'B5', orientation: 'portrait' });
      expect(l.margin).toEqual({ top: 10, right: 20, bottom: 25, left: 20 });
    });
  });

  describe('matchesPdfScriptPage', () => {
    test('字数・行数だけ違うなら一致、用紙や余白が違えば不一致', () => {
      expect(matchesPdfScriptPage(BUILTIN_PRESETS['40字×40行'])).toBe(true);
      expect(matchesPdfScriptPage(BUILTIN_PRESETS['文庫（A6・40字×17行）'])).toBe(false);
    });
  });
}
