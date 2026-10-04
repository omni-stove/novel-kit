/**
 * ページレイアウト定義（Word の「ページ設定 > 文字数と行数」に相当）と、そこから導く組版寸法。
 * 用紙・余白・字数・行数を決めると、文字サイズと行送りが決まる。
 * 既定値（A4横・余白 20/20/25/20mm）は scripts/txt-to-pdf.mts の calcVerticalLayout と同じ寸法になる。
 */

// 短辺 x 長辺（mm）
export const PAPER_SIZES = {
  A4: [210, 297],
  B5: [182, 257],
  A5: [148, 210],
  B6: [128, 182],
  A6: [105, 148],
};

const MM_PER_PT = 0.3528;
// 行数を指定しないときの行送り（txt-to-pdf の既定と同じ）
const AUTO_LINE_HEIGHT = { vertical: 1.125, horizontal: 1.8 };

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

const clampInt = (v, min, max, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= min ? Math.min(n, max) : fallback;
};

const clampMm = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 100) : fallback;
};

// 設定ファイルや webview から来た値を、欠けや不正値を既定で埋めたレイアウトにする
export function normalizeLayout(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const m = r.margin && typeof r.margin === 'object' ? r.margin : {};
  const d = DEFAULT_LAYOUT;
  return {
    writingMode: r.writingMode === 'horizontal' ? 'horizontal' : 'vertical',
    paper: r.paper in PAPER_SIZES ? r.paper : d.paper,
    orientation: r.orientation === 'portrait' ? 'portrait' : r.orientation === 'landscape' ? 'landscape' : d.orientation,
    margin: {
      top: clampMm(m.top, d.margin.top),
      right: clampMm(m.right, d.margin.right),
      bottom: clampMm(m.bottom, d.margin.bottom),
      left: clampMm(m.left, d.margin.left),
    },
    chars: clampInt(r.chars, 5, 100, d.chars),
    lines: r.lines == null || r.lines === '' ? null : clampInt(r.lines, 1, 100, null),
    fontFamily: typeof r.fontFamily === 'string' ? r.fontFamily.trim() : '',
  };
}

export function layoutsEqual(a, b) {
  return JSON.stringify(normalizeLayout(a)) === JSON.stringify(normalizeLayout(b));
}

export function computeMetrics(rawLayout) {
  const layout = normalizeLayout(rawLayout);
  const vertical = layout.writingMode === 'vertical';
  const [short, long] = PAPER_SIZES[layout.paper];
  const paperW = layout.orientation === 'landscape' ? long : short;
  const paperH = layout.orientation === 'landscape' ? short : long;
  const areaW = paperW - layout.margin.left - layout.margin.right;
  const areaH = paperH - layout.margin.top - layout.margin.bottom;
  // 字を送る方向（縦書きなら天地）と行を送る方向の版面寸法
  const availInline = vertical ? areaH : areaW;
  const availBlock = vertical ? areaW : areaH;

  const cellMm = availInline / layout.chars;
  // txt-to-pdf と同じく 0.1pt 単位に切り捨てる（PDFと字面を揃えるため）
  const fontSizePt = Math.floor((cellMm / MM_PER_PT) * 10) / 10;
  const fontSizeMm = fontSizePt * MM_PER_PT;

  const lineHeight = layout.lines
    ? availBlock / layout.lines / cellMm
    : AUTO_LINE_HEIGHT[layout.writingMode];
  const lines = layout.lines ?? Math.max(1, Math.floor(availBlock / (fontSizeMm * lineHeight)));

  return {
    layout,
    vertical,
    paperW,
    paperH,
    availInline,
    availBlock,
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

export function describeLayout(rawLayout) {
  const m = computeMetrics(rawLayout);
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
