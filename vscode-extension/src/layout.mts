/**
 * ページレイアウト定義（Word の「ページ設定 > 文字数と行数」に相当）と、そこから導く組版寸法。
 * 用紙・余白・字数・行数を決めると、文字サイズと行送りが決まる。
 * 既定値（A4横・余白 20/20/25/20mm）は scripts/txt-to-pdf.mts の calcVerticalLayout と同じ寸法になる。
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
// 英語組版で文字サイズ・行送りを指定しないときの値（txt-to-en-pdf の 6×9in と同じ）
export const EN_DEFAULT_FONT_SIZE = 11;
export const EN_DEFAULT_LINE_HEIGHT = 1.4;
// 英文の平均字幅の目安（em）。字数×行数の表示に使う
const EN_AVERAGE_CHAR_WIDTH = 0.5;

export const DEFAULT_LAYOUT = {
  // 組版の言語。'auto' は原稿の文字で判定（アルファベットが多ければ英語）、'ja' / 'en' は固定
  language: 'auto',
  writingMode: 'vertical',
  paper: 'A4',
  orientation: 'landscape',
  margin: { top: 20, right: 20, bottom: 25, left: 20 },
  chars: 30,
  // null は行送りを自動（字送りの 1.125 倍）にして、入るだけ行を入れる
  lines: null,
  // 英語組版の本文の文字サイズ（pt）と行送り（倍率）。null は既定（11pt / 1.4）。日本語組版では字数から決まるので使わない
  fontSize: null,
  lineHeight: null,
  fontFamily: '',
};

const inMm = (inch) => Math.round(inch * MM_PER_IN * 100) / 100;

// 英語ペーパーバック（txt-to-en-pdf.mts の PAGE_SIZES と同じ判型・余白。見開きの内側の余白を左に置く）
const EN_LAYOUT = { ...DEFAULT_LAYOUT, language: 'en', writingMode: 'horizontal', orientation: 'portrait' };

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
  'English 6×9in（US Trade）': {
    ...EN_LAYOUT,
    paper: '6x9in',
    margin: { top: inMm(0.7), right: inMm(0.6), bottom: inMm(0.6), left: inMm(0.8) },
    fontSize: 11,
    lineHeight: 1.4,
  },
  'English 5×8in（Trade Paperback）': {
    ...EN_LAYOUT,
    paper: '5x8in',
    margin: { top: inMm(0.6), right: inMm(0.5), bottom: inMm(0.55), left: inMm(0.7) },
    fontSize: 10.5,
    lineHeight: 1.35,
  },
  'English A5': {
    ...EN_LAYOUT,
    paper: 'A5',
    margin: { top: 16, right: 15, bottom: 14, left: 18 },
    fontSize: 11,
    lineHeight: 1.4,
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

// 空・null は「既定」。それ以外は範囲に収めた数値（0.01 刻み）
const optionalNumber = (v, min, max) => {
  if (v == null || v === '') return null;
  const n = Math.round(Number(v) * 100) / 100;
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

// 設定ファイルや webview から来た値を、欠けや不正値を既定で埋めたレイアウトにする
export function normalizeLayout(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const m = r.margin && typeof r.margin === 'object' ? r.margin : {};
  const d = DEFAULT_LAYOUT;
  return {
    language: r.language === 'en' || r.language === 'ja' ? r.language : d.language,
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
    fontSize: optionalNumber(r.fontSize, 5, 40),
    lineHeight: optionalNumber(r.lineHeight, 1, 3),
    fontFamily: typeof r.fontFamily === 'string' ? r.fontFamily.trim() : '',
  };
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

// 原稿に効く言語。自動判定で英語ならそれを優先し、そうでなければ設定ファイルの language に従う
export function resolveLanguage(rawLayout, detected) {
  if (detected === 'en') return 'en';
  const { language } = normalizeLayout(rawLayout);
  return language === 'en' ? 'en' : 'ja';
}

export function layoutsEqual(a, b) {
  return JSON.stringify(normalizeLayout(a)) === JSON.stringify(normalizeLayout(b));
}

/**
 * language: 'ja' | 'en'（省略時は layout.language。'auto' は日本語扱い。原稿から判定した値は resolveLanguage で決めて渡す）
 * 日本語は字数から文字サイズが決まる。英語は文字サイズ・行送りを直接指定し、横書き固定で、chars は版面幅を字面の大きさで割った値になる
 */
export function computeMetrics(rawLayout, { language = null } = {}) {
  const layout = normalizeLayout(rawLayout);
  const english = (language ?? layout.language) === 'en';
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
    const fontSizePt = layout.fontSize ?? EN_DEFAULT_FONT_SIZE;
    const fontSizeMm = fontSizePt * MM_PER_PT;
    const lineHeight = layout.lineHeight ?? EN_DEFAULT_LINE_HEIGHT;
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
  const { paper, orientation } = normalizeLayout(rawLayout);
  if (orientation !== 'portrait') return null;
  return { '5x8in': '5x8', '6x9in': '6x9', A5: 'a5' }[paper] ?? null;
}

export function describeLayout(rawLayout, { language = null } = {}) {
  const m = computeMetrics(rawLayout, { language });
  if (m.language === 'en') return `${m.fontSizePt}pt・行送り${m.lineHeight}（約${m.charsApprox}字×${m.lines}行）`;
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
    test('言語・文字サイズ・行送りは不正値を既定に戻す', () => {
      expect(normalizeLayout({ language: 'en', fontSize: '10.5', lineHeight: 1.35 })).toMatchObject({ language: 'en', fontSize: 10.5, lineHeight: 1.35 });
      expect(normalizeLayout({ language: 'fr', fontSize: 'big', lineHeight: 9 })).toMatchObject({ language: 'auto', fontSize: null, lineHeight: null });
    });
  });

  describe('英語組版', () => {
    test('文字サイズと行送りを直接指定し、横書き固定で、行数は版面から決まる', () => {
      const m = computeMetrics(BUILTIN_PRESETS['English 6×9in（US Trade）']);
      expect(m.language).toBe('en');
      expect(m.vertical).toBe(false);
      expect(m.fontSizePt).toBe(11);
      expect(m.lineHeight).toBe(1.4);
      expect(m.paperW).toBe(152.4);
      // 版面幅 = 152.4 - 20.32 - 15.24
      expect(m.chars * m.fontSizeMm).toBeCloseTo(116.84, 6);
      expect(m.lines).toBe(Math.floor((228.6 - 17.78 - 15.24) / (11 * 0.3528 * 1.4)));
    });
    test('language を渡すと設定ファイルの値より優先し、既定の文字サイズ・行送りを使う', () => {
      const m = computeMetrics(DEFAULT_LAYOUT, { language: 'en' });
      expect(m.language).toBe('en');
      expect(m.vertical).toBe(false);
      expect(m.fontSizePt).toBe(EN_DEFAULT_FONT_SIZE);
      expect(m.lineHeight).toBe(EN_DEFAULT_LINE_HEIGHT);
      expect(computeMetrics(DEFAULT_LAYOUT, { language: 'ja' }).vertical).toBe(true);
    });
    test('detectLanguage は本文のアルファベットが日本語の文字より多ければ英語', () => {
      expect(detectLanguage(['As a child, I could go anywhere.', '【-21Y】'])).toBe('en');
      expect(detectLanguage(['子どものころ、私はどこへでも行けた。', 'POV: Nadia'])).toBe('ja');
      expect(detectLanguage(['POV: Nadia Solis', '私'], l => l.startsWith('POV:'))).toBe('ja');
      expect(detectLanguage([])).toBe('ja');
    });
    test('resolveLanguage は判定が英語ならそれを優先し、そうでなければ設定の language に従う', () => {
      expect(resolveLanguage({ language: 'ja' }, 'en')).toBe('en');
      expect(resolveLanguage({ language: 'en' }, 'ja')).toBe('en');
      expect(resolveLanguage({ language: 'auto' }, 'ja')).toBe('ja');
      expect(resolveLanguage(null, 'ja')).toBe('ja');
    });
    test('enPdfPageSize は英語PDFスクリプトの判型に対応する用紙を返す', () => {
      expect(enPdfPageSize(BUILTIN_PRESETS['English 6×9in（US Trade）'])).toBe('6x9');
      expect(enPdfPageSize(BUILTIN_PRESETS['English 5×8in（Trade Paperback）'])).toBe('5x8');
      expect(enPdfPageSize(BUILTIN_PRESETS['English A5'])).toBe('a5');
      expect(enPdfPageSize({ paper: 'A5', orientation: 'landscape' })).toBeNull();
      expect(enPdfPageSize(DEFAULT_LAYOUT)).toBeNull();
    });
    test('describeLayout は英語では文字サイズと行送りを出す', () => {
      expect(describeLayout(DEFAULT_LAYOUT)).toBe('30字×41行');
      expect(describeLayout(BUILTIN_PRESETS['English A5'])).toMatch(/^11pt・行送り1\.4（約\d+字×\d+行）$/);
    });
  });

  describe('matchesPdfScriptPage', () => {
    test('字数・行数だけ違うなら一致、用紙や余白が違えば不一致', () => {
      expect(matchesPdfScriptPage(BUILTIN_PRESETS['40字×40行'])).toBe(true);
      expect(matchesPdfScriptPage(BUILTIN_PRESETS['文庫（A6・40字×17行）'])).toBe(false);
    });
  });
}
