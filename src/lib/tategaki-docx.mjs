/**
 * 縦書きWordテンプレートへ本文を流し込むための共通処理（novel docx が使う）
 *
 * 段落・ルビ・傍点・縦中横の組み方と、テンプレートのw:bodyの差し替え、用紙・余白・文字グリッドの組み替えを提供する。
 * 文字グリッド（cols/rows）は呼び出し側のレイアウトに合わせて渡す。
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseAozoraLine } from './aozora.mjs';
import { fail } from './cli.mjs';
import { toFullWidth, toVerticalBase, toVerticalText } from './docx.mjs';
import { countWrappedRows, normalizeTcy } from './grid.mjs';
import {
  countTextChars,
  epigraphDisplayLines,
  escapeXml,
  indentSeparator,
  isEpigraphLine,
  isSeparator,
  isViewpointLine,
  parseEpigraphLine,
  SCENE_BREAK_MARK,
  separatorMark,
  stripInlineMarkup,
  tokenizeInlineMarkup,
} from './text-parser.mjs';

/**
 * 流し込み先のテンプレートのパス。override が無ければ、環境変数 NOVEL_DOCX_TEMPLATE か同梱の A4横・縦書きのもの。
 * 見つからなければ終了する。
 */
// VS Code 拡張は CommonJS に bundle して import.meta.url が無くなるので、同梱先のパスを NOVEL_DOCX_TEMPLATE に渡してくる
export function resolveTemplatePath(override = null) {
  const templatePath =
    override ||
    process.env.NOVEL_DOCX_TEMPLATE ||
    fileURLToPath(new URL('../templates/tategaki-a4-42x34.docx', import.meta.url));
  if (!existsSync(templatePath)) fail(`テンプレートが見つかりません: ${templatePath}`);
  return templatePath;
}

/** 本文の文字サイズの既定（半ポイント単位。21 = 10.5pt） */
export const DEFAULT_FONT_HALF_PT = 21;

/** props はランの書式（w:rPr の中身。w:rFonts の後ろに置く。w:b → w:i → w:sz → w:u → w:em → w:eastAsianLayout の順に並べる） */
const rPr = (props = '') => `<w:rPr><w:rFonts w:hint="eastAsia"/>${props}</w:rPr>`;

function runXml(text, props = '') {
  return `<w:r>${rPr(props)}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

function plainRunXml(text, props = '') {
  return runXml(toFullWidth(text), props);
}

/** 縦中横にしたランの XML を返す。隣接する縦中横同士が Word で結合しないよう、id は連番にする。 */
let tcyId = 1;
function tcyRunXml(text, props = '') {
  return runXml(text, `${props}<w:eastAsianLayout w:id="${tcyId++}" w:vert="1" w:vertCompress="1"/>`);
}

// 数字の立て方は PDF 出力（text-parser の escapeHtml）と揃える
export function textRunXml(text, props = '') {
  if (!text) return '';
  const base = toVerticalBase(text);
  let out = '';
  let last = 0;
  for (const m of base.matchAll(/[0-9]+/g)) {
    if (m.index > last) out += plainRunXml(base.slice(last, m.index), props);
    out += m[0].length === 2 ? tcyRunXml(m[0], props) : plainRunXml(m[0], props);
    last = m.index + m[0].length;
  }
  if (last < base.length) out += plainRunXml(base.slice(last), props);
  return out;
}

/** ルビは親文字の半分の大きさにし、親文字との間隔は 10.5pt のときの値（9pt 上げる）を文字サイズに比例させる */
function rubyRunXml(base, ruby, fontHalfPt, props) {
  const rubyHalfPt = Math.round(fontHalfPt / 2);
  const raise = Math.round((fontHalfPt * 18) / DEFAULT_FONT_HALF_PT);
  const rt = runXml(toVerticalText(ruby), `${props}<w:sz w:val="${rubyHalfPt}"/>`);
  const rb = runXml(toVerticalText(base), props);
  return (
    `<w:r>${rPr(props)}<w:ruby>` +
    `<w:rubyPr><w:rubyAlign w:val="distributeSpace"/><w:hps w:val="${rubyHalfPt}"/><w:hpsRaise w:val="${raise}"/>` +
    `<w:hpsBaseText w:val="${fontHalfPt}"/><w:lid w:val="ja-JP"/></w:rubyPr>` +
    `<w:rt>${rt}</w:rt><w:rubyBase>${rb}</w:rubyBase></w:ruby></w:r>`
  );
}

/** 傍線の種類ごとの w:u の値。鎖線は Word の一点鎖線にする */
const SIDELINE_UNDERLINE = { solid: 'single', double: 'double', chain: 'dotDash', dashed: 'dash', wavy: 'wave' };

/**
 * 1行の記法（ルビ・傍点・イタリック・太字・縦中横・横倒し・傍線）をランの XML にする。
 * 縦書きの Word では下線が字の右に付くので、傍線は下線にする。
 * 左ルビは Word のルビを親文字の左に置けないため、親文字だけを組む。
 * fontHalfPt: 本文の文字サイズ（半ポイント単位。ルビの大きさを決める）、bold: 行全体を太字にする（青空文庫の見出し）
 */
export function lineToRunsXml(line, { fontHalfPt = DEFAULT_FONT_HALF_PT, bold = false } = {}) {
  const b = bold ? '<w:b/>' : '';
  return tokenizeInlineMarkup(line)
    .map((token) => {
      switch (token.type) {
        case 'emphasis':
          return runXml(toVerticalText(token.text), `${b}<w:em w:val="dot"/>`);
        case 'ruby':
          return rubyRunXml(token.base, token.ruby, fontHalfPt, b);
        case 'leftRuby':
          return textRunXml(token.base, b);
        case 'italic':
          return runXml(toVerticalText(stripInlineMarkup(token.text)), `${b}<w:i/>`);
        case 'bold':
          return textRunXml(stripInlineMarkup(token.text), '<w:b/>');
        case 'sideline':
          return textRunXml(stripInlineMarkup(token.text), `${b}<w:u w:val="${SIDELINE_UNDERLINE[token.style]}"/>`);
        case 'tcy':
          return tcyRunXml(toVerticalBase(token.text), b);
        // Wordの縦書きでは半角英数がそのまま横倒しになるので、全角化せずに出す
        case 'sideways':
          return runXml(toVerticalBase(stripInlineMarkup(token.text)), b);
        default:
          return textRunXml(token.text, b);
      }
    })
    .join('');
}

/**
 * 段落の XML。center / right（縦書きでは下揃え）で揃え、pageBreakBefore で前に改ページを入れる。
 * indent / raise は行頭・行末から下げる字数（青空文庫の字下げ・地から上げ）
 */
export function paragraphXml(
  runsXml,
  { center = false, right = false, pageBreakBefore = false, indent = 0, raise = 0 } = {},
) {
  const jc = center ? 'center' : right ? 'right' : null;
  const ind =
    indent || raise
      ? `<w:ind${indent ? ` w:leftChars="${indent * 100}"` : ''}${raise ? ` w:rightChars="${raise * 100}"` : ''}/>`
      : '';
  const props = `${ind}${jc ? `<w:jc w:val="${jc}"/>` : ''}`;
  const pPr = props ? `<w:pPr>${props}</w:pPr>` : '';
  const br = pageBreakBefore ? '<w:r><w:br w:type="page"/></w:r>' : '';
  return `<w:p>${pPr}${br}${runsXml}</w:p>`;
}

const PLAIN_LINE = { indent: 0, alignEnd: false, raise: 0, heading: null };

/**
 * 本文の行を走査し、出す行ごとに emit(line, { pageBreakBefore, epigraph, indent, alignEnd, raise, heading }) を呼ぶ。
 * 2つ目以降の視点行【】（chapterBreak が false なら改ページしない）と、pageBreakBeforeBody 指定時の最初の行は改ページ付きにする。
 * 青空文庫の改ページは次の行の前で改ページし、字下げ範囲の注記行は出さない。
 * 行頭の字下げ・地付き・地から上げ・見出しの注記は外し、indent（範囲の字下げを含む）/ alignEnd / raise / heading に渡す。
 * エピグラフは cols で折り返した表示行を epigraph に渡し、直後が空行でなければ空行を1つ補う。
 * 出力（buildBodyXml）とページ見積もり（estimateBodyPages）で改ページ位置がずれないよう、走査を共有する。
 */
export function walkBodyLines(lines, { cols, pageBreakBeforeBody = false, chapterBreak = true }, emit) {
  let isFirstViewpoint = true;
  let needBodyPageBreak = pageBreakBeforeBody;
  let blockIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const aozora = parseAozoraLine(lines[i]);
    if (aozora.kind === 'pageBreak') {
      needBodyPageBreak = true;
      continue;
    }
    if (aozora.kind !== 'text') {
      blockIndent = aozora.indent ?? 0;
      continue;
    }
    const line = aozora.text;

    if (isEpigraphLine(line)) {
      const { quote, source } = parseEpigraphLine(line);
      emit(line, {
        ...PLAIN_LINE,
        pageBreakBefore: needBodyPageBreak,
        epigraph: epigraphDisplayLines(quote, source, cols),
      });
      needBodyPageBreak = false;
      if (!(i + 1 < lines.length && lines[i + 1].trim() === ''))
        emit('', { ...PLAIN_LINE, pageBreakBefore: false, epigraph: null });
      continue;
    }

    const isViewpoint = isViewpointLine(line);
    const pageBreakBefore = needBodyPageBreak || (chapterBreak && isViewpoint && !isFirstViewpoint);
    if (isViewpoint) isFirstViewpoint = false;
    needBodyPageBreak = false;
    emit(line, {
      pageBreakBefore,
      epigraph: null,
      indent: aozora.indent || blockIndent,
      alignEnd: aozora.alignEnd,
      raise: aozora.raise,
      heading: aozora.heading,
    });
  }
}

export function countGridRows(line, cols) {
  return countWrappedRows(normalizeTcy(stripInlineMarkup(line)), Math.max(1, cols));
}

export function bodyDisplayText(lines) {
  return lines
    .map((l) => {
      if (isEpigraphLine(l)) {
        const { quote, source } = parseEpigraphLine(l);
        return stripInlineMarkup(epigraphDisplayLines(quote, source).join(''));
      }
      return stripInlineMarkup(l);
    })
    .join('');
}

export function countBodyChars(lines) {
  return countTextChars(bodyDisplayText(lines));
}

/**
 * docProps/core.xml のタイトル・作成者・最終更新者を差し替える。
 * テンプレート配布元の名前が作成者に残らないようにするためで、作者名を出さない応募先では author に空文字を渡す。
 */
export function updateCoreProps(coreXml, title, author) {
  return coreXml
    .replace(/<dc:title>.*?<\/dc:title>/s, `<dc:title>${escapeXml(title)}</dc:title>`)
    .replace(/<dc:creator>.*?<\/dc:creator>/s, `<dc:creator>${escapeXml(author)}</dc:creator>`)
    .replace(
      /<cp:lastModifiedBy>.*?<\/cp:lastModifiedBy>/s,
      `<cp:lastModifiedBy>${escapeXml(author)}</cp:lastModifiedBy>`,
    );
}

export function buildBodyXml(
  lines,
  {
    cols,
    headParagraphs = [],
    tailParagraphs = [],
    pageBreakBeforeBody = false,
    chapterBreak = true,
    sceneBreak = SCENE_BREAK_MARK,
    sceneBreakIndent = null,
    fontHalfPt = DEFAULT_FONT_HALF_PT,
  },
) {
  const paragraphs = [...headParagraphs];

  walkBodyLines(
    lines,
    { cols, pageBreakBeforeBody, chapterBreak },
    (line, { pageBreakBefore, epigraph, indent, alignEnd, raise, heading }) => {
      if (epigraph) {
        // PDF と同じく下揃えにする（縦書きでは right が下揃え）
        epigraph.forEach((text, i) => {
          paragraphs.push(
            paragraphXml(lineToRunsXml(text, { fontHalfPt }), {
              right: true,
              pageBreakBefore: i === 0 && pageBreakBefore,
            }),
          );
        });
      } else if (line.trim() === '') {
        paragraphs.push(paragraphXml('', { pageBreakBefore }));
      } else if (isSeparator(line)) {
        const mark = indentSeparator(separatorMark(line, sceneBreak), sceneBreakIndent);
        paragraphs.push(paragraphXml(textRunXml(mark), { center: sceneBreakIndent == null, pageBreakBefore }));
      } else {
        paragraphs.push(
          paragraphXml(lineToRunsXml(line, { fontHalfPt, bold: heading != null }), {
            pageBreakBefore,
            right: alignEnd,
            indent,
            raise,
          }),
        );
      }
    },
  );

  return [...paragraphs, ...tailParagraphs].join('');
}

export function estimateBodyPages(
  lines,
  { cols, rows, headLines = [], tailLines = [], pageBreakBeforeBody = false, chapterBreak = true },
) {
  let pages = 1;
  let pageRows = 0;

  const breakPage = () => {
    pages++;
    pageRows = 0;
  };
  const addLine = (line, indent = 0) => {
    for (let n = countGridRows(line, cols - indent); n > 0; n--) {
      if (pageRows >= rows) breakPage();
      pageRows++;
    }
  };

  headLines.forEach(addLine);

  walkBodyLines(
    lines,
    { cols, pageBreakBeforeBody, chapterBreak },
    (line, { pageBreakBefore, epigraph, indent, raise }) => {
      if (pageBreakBefore) breakPage();
      if (epigraph) {
        for (const text of epigraph) addLine(text);
      } else addLine(line, indent + raise);
    },
  );

  tailLines.forEach(addLine);

  return pages;
}

// 応募規定が「あらすじにはノンブルを振らず、本文1ページ目から番号を振る」ことを求めるため、
// あらすじがあるときはセクションを分ける
export function injectBody(documentXml, bodyXml, synopsisXml = null) {
  const sectPrMatch = documentXml.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/);
  if (!sectPrMatch || !documentXml.includes('<w:body>')) {
    throw new Error('テンプレートのw:body/w:sectPrが見つかりません');
  }
  const sectPr = sectPrMatch[0];

  let content;
  let finalSectPr = sectPr;
  if (synopsisXml != null) {
    const synopsisSectPr = sectPr.replace(/<w:footerReference[^>]*\/>/g, '').replace(/<w:type[^>]*\/>/, '');
    finalSectPr = sectPr.replace(/<w:type[^>]*\/>/, '').replace(/<w:cols/, '<w:pgNumType w:start="1"/><w:cols');
    content = `${synopsisXml}<w:p><w:pPr>${synopsisSectPr}</w:pPr></w:p>${bodyXml}`;
  } else {
    content = bodyXml;
  }

  return documentXml.replace(/<w:body>[\s\S]*<\/w:body>/, () => `<w:body>${content}${finalSectPr}</w:body>`);
}

/**
 * テンプレートの文字グリッド（w:docGrid）を指定の字詰めに組み替える。
 * 用紙サイズ・余白はテンプレートのものを使い、本文フォントサイズは fontPt（既定 10.5pt）で受け取って、
 * 縦書き（tbRl）として「紙の高さ方向＝1行の字数」「紙の幅方向＝行数」で刻み幅を出す。
 *
 * Word の docGrid の刻み幅:
 *   linePitch = 行の送り（twip）
 *   charSpace = （1字の送り − フォントサイズ）を 1/4096 pt 単位で表した値
 * 端数は切り捨て側（＝送りを詰める側）に寄せて、指定の字数・行数が必ず収まるようにする。
 * 全セクションの w:sectPr に適用し、w:docGrid がなければ追加する。
 */
export function applyDocGrid(documentXml, { cols, rows, fontPt = 10.5 }) {
  const sectPr = documentXml.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/)?.[0];
  if (!sectPr) throw new Error('テンプレートのw:sectPrが見つかりません');

  const attr = (tagRe, name) => {
    const tag = sectPr.match(tagRe)?.[0];
    const value = tag?.match(new RegExp(`w:${name}="(-?\\d+)"`))?.[1];
    if (value == null) throw new Error(`テンプレートのw:${name}が読めません`);
    return parseInt(value, 10);
  };
  const pgSz = /<w:pgSz[^>]*\/>/;
  const pgMar = /<w:pgMar[^>]*\/>/;

  const charAxis = attr(pgSz, 'h') - attr(pgMar, 'top') - attr(pgMar, 'bottom');
  const lineAxis = attr(pgSz, 'w') - attr(pgMar, 'left') - attr(pgMar, 'right');

  const linePitch = Math.floor(lineAxis / rows);
  const charSpace = Math.floor(((charAxis / cols - fontPt * 20) / 20) * 4096);
  const docGrid = `<w:docGrid w:type="linesAndChars" w:linePitch="${linePitch}" w:charSpace="${charSpace}"/>`;

  return documentXml.replace(/<w:sectPr[\s\S]*?<\/w:sectPr>/g, (section) =>
    /<w:docGrid[^>]*\/>/.test(section)
      ? section.replace(/<w:docGrid[^>]*\/>/, docGrid)
      : section.replace('</w:sectPr>', `${docGrid}</w:sectPr>`),
  );
}

const twip = (mm) => Math.round((mm * 1440) / 25.4);

/**
 * 全セクションの用紙（w:pgSz）と余白（w:pgMar の上下左右）を、プレビューのレイアウトと同じ寸法（mm）にする。
 * landscape なら横向き。ヘッダー・フッターの位置と綴じ代はテンプレートのまま。
 */
// w:code（用紙の番号）はテンプレートの A4 のものなので、別の用紙で残さないよう書き直す
export function applyPageSetup(documentXml, { paperW, paperH, margin, landscape }) {
  const pgSz = `<w:pgSz w:w="${twip(paperW)}" w:h="${twip(paperH)}"${landscape ? ' w:orient="landscape"' : ''}/>`;
  const setMargin = (tag) =>
    ['top', 'right', 'bottom', 'left'].reduce(
      (t, side) => t.replace(new RegExp(`w:${side}="-?\\d+"`), `w:${side}="${twip(margin[side])}"`),
      tag,
    );
  return documentXml.replace(/<w:sectPr[\s\S]*?<\/w:sectPr>/g, (section) =>
    section.replace(/<w:pgSz[^>]*\/>/, pgSz).replace(/<w:pgMar[^>]*\/>/, setMargin),
  );
}

/** styles.xml の既定の文字サイズ（w:docDefaults の w:sz / w:szCs）を halfPt（半ポイント単位）にする */
export function applyFontSize(stylesXml, halfPt) {
  return stylesXml.replace(/<w:rPrDefault>[\s\S]*?<\/w:rPrDefault>/, (rPrDefault) =>
    rPrDefault
      .replace(/<w:sz w:val="\d+"\/>/, `<w:sz w:val="${halfPt}"/>`)
      .replace(/<w:szCs w:val="\d+"\/>/, `<w:szCs w:val="${halfPt}"/>`),
  );
}

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest;
  const { normalizeAozoraInline } = await import('./aozora.mjs');

  const texts = (xml) => [...xml.matchAll(/<w:t [^>]*>(.*?)<\/w:t>/g)].map((m) => m[1]);

  describe('textRunXml', () => {
    test('2桁の数字だけ縦中横にし、1桁・3桁以上は全角化して1字ずつ立てる', () => {
      const xml = textRunXml('7月15日、123号');
      expect(texts(xml)).toEqual(['７', '月', '15', '日、', '１２３', '号']);
      expect(xml.match(/w:vertCompress="1"/g)).toHaveLength(1);
    });
    test('隣り合う縦中横には別々のidを振る', () => {
      const ids = [...textRunXml('10と20').matchAll(/w:eastAsianLayout w:id="(\d+)"/g)].map((m) => m[1]);
      expect(ids).toHaveLength(2);
      expect(ids[0]).not.toBe(ids[1]);
    });
    test('半角英字は全角化し、ダッシュと矢印は縦書き用に正規化する', () => {
      expect(texts(textRunXml('AI—→'))).toEqual(['ＡＩ―↓']);
    });
    test('空文字はrunを作らない', () => {
      expect(textRunXml('')).toBe('');
    });
  });

  describe('lineToRunsXml', () => {
    test('ルビはw:rubyになり、親文字とルビを別に持つ', () => {
      const xml = lineToRunsXml('|漢字《かんじ》を読む');
      expect(xml).toContain('<w:rt>');
      expect(texts(xml)).toEqual(['かんじ', '漢字', 'を読む']);
    });
    test('傍点はw:em、イタリックはw:i', () => {
      expect(lineToRunsXml('《《強調》》')).toContain('<w:em w:val="dot"/>');
      expect(lineToRunsXml('*word*')).toContain('<w:i/>');
    });
    test('青空文庫の傍線は種類ごとの w:u、斜体は w:i、左ルビは親文字だけにする', () => {
      const runs = (s) => lineToRunsXml(normalizeAozoraInline(s));
      expect(runs('運命［＃「運命」に傍線］')).toContain('<w:u w:val="single"/>');
      expect(runs('運命［＃「運命」に二重傍線］')).toContain('<w:u w:val="double"/>');
      expect(runs('運命［＃「運命」に鎖線］')).toContain('<w:u w:val="dotDash"/>');
      expect(runs('運命［＃「運命」に破線］')).toContain('<w:u w:val="dash"/>');
      expect(runs('運命［＃「運命」に波線］')).toContain('<w:u w:val="wave"/>');
      expect(texts(runs('［＃傍線］|運命《さだめ》［＃傍線終わり］'))).toEqual(['運命']);
      expect(runs('ここ［＃「ここ」は斜体］')).toContain('<w:i/>');
      const leftRuby = runs('英雄［＃「英雄」の左に「ヒーロー」のルビ］');
      expect(leftRuby).not.toContain('<w:ruby>');
      expect(texts(leftRuby)).toEqual(['英雄']);
    });
    test('見出しの太字の中の傍線は w:b を w:u の前に置く', () => {
      expect(lineToRunsXml(normalizeAozoraInline('［＃傍線］運命［＃傍線終わり］'), { bold: true })).toContain(
        '<w:b/><w:u w:val="single"/>',
      );
    });
    test('横倒しは半角のまま出す', () => {
      expect(texts(lineToRunsXml('<<ABC>>'))).toEqual(['ABC']);
    });
    test('XML特殊文字をエスケープする', () => {
      expect(texts(lineToRunsXml('＜&＞'))).toEqual(['＜&amp;＞']);
    });
  });

  describe('paragraphXml', () => {
    test('揃えと改ページを段落に付ける', () => {
      expect(paragraphXml('R')).toBe('<w:p>R</w:p>');
      expect(paragraphXml('R', { center: true })).toContain('<w:jc w:val="center"/>');
      expect(paragraphXml('R', { right: true })).toContain('<w:jc w:val="right"/>');
      expect(paragraphXml('R', { pageBreakBefore: true })).toBe('<w:p><w:r><w:br w:type="page"/></w:r>R</w:p>');
    });
  });

  describe('walkBodyLines', () => {
    const walk = (lines, opts = {}) => {
      const out = [];
      walkBodyLines(lines, { cols: 40, ...opts }, (line, { pageBreakBefore, epigraph }) => {
        out.push({ line, pageBreakBefore, epigraph });
      });
      return out;
    };

    test('2つ目以降の視点行で改ページする（冒頭の視点行はしない）', () => {
      const out = walk(['【1】', '本文', '【2】', '本文']);
      expect(out.map((o) => o.pageBreakBefore)).toEqual([false, false, true, false]);
    });
    test('pageBreakBeforeBodyなら本文の先頭で改ページする', () => {
      const out = walk(['【1】', '本文'], { pageBreakBeforeBody: true });
      expect(out.map((o) => o.pageBreakBefore)).toEqual([true, false]);
    });
    test('エピグラフは表示行に展開して渡し、直後に空行がなければ1行補う', () => {
      const out = walk(['【1】', 'Lead: 引用\uF120出典', '本文']);
      expect(out[1].epigraph).toEqual(['引用——出典']);
      expect(out[2]).toEqual({ line: '', pageBreakBefore: false, epigraph: null });
      expect(out[3].line).toBe('本文');
    });
    test('青空文庫の改ページは次の行の前で改ページし、字下げ範囲の注記行は出さず、行頭の注記は外す', () => {
      const out = walk([
        '【1】',
        '［＃改ページ］',
        '本文',
        '［＃ここから２字下げ］',
        '中',
        '［＃ここで字下げ終わり］',
        '［＃３字下げ］行',
      ]);
      expect(out.map((o) => o.line)).toEqual(['【1】', '本文', '中', '行']);
      expect(out.map((o) => o.pageBreakBefore)).toEqual([false, true, false, false]);
    });
    test('エピグラフの直後に空行があれば補わない', () => {
      expect(walk(['Lead: 引用', '', '本文']).map((o) => o.line)).toEqual(['Lead: 引用', '', '本文']);
    });
    test('1行に収まらないエピグラフは引用行と出典行に分ける', () => {
      const out = walk([`Lead: ${'あ'.repeat(10)}\uF120出典`], { cols: 10 });
      expect(out[0].epigraph).toEqual(['あ'.repeat(10), '——出典']);
    });
  });

  describe('countGridRows / countBodyChars', () => {
    test('記法を除き、2桁数字を1マスとして行数を数える', () => {
      expect(countGridRows('|漢字《かんじ》12', 3)).toBe(1);
      expect(countGridRows('|漢字《かんじ》123', 3)).toBe(2);
    });
    test('字数は空白・ふりがな・Lead: プレフィックスを含まない', () => {
      expect(countBodyChars(['　|漢字《かんじ》', 'Lead: 引用\uF120出典'])).toBe(8);
    });
  });

  describe('buildBodyXml', () => {
    test('空行・区切り・エピグラフ・本文を段落にし、前後に扉と終了記号を置く', () => {
      const xml = buildBodyXml(['【1】', 'Lead: 引用', '', '本文', '◇◇◇'], {
        cols: 40,
        headParagraphs: ['<HEAD/>'],
        tailParagraphs: ['<TAIL/>'],
      });
      const paragraphs = xml.match(/<w:p>.*?<\/w:p>/g);
      expect(xml.startsWith('<HEAD/>')).toBe(true);
      expect(xml.endsWith('<TAIL/>')).toBe(true);
      expect(paragraphs).toHaveLength(5);
      expect(paragraphs[1]).toContain('<w:jc w:val="right"/>');
      expect(paragraphs[2]).toBe('<w:p></w:p>');
      expect(paragraphs[4]).toContain('<w:jc w:val="center"/>');
    });
    test('sceneBreakIndent があれば区切りを中央寄せにせず、全角空白で字下げする', () => {
      const xml = buildBodyXml(['本文', '*'], { cols: 40, sceneBreakIndent: 2 });
      const separator = xml.match(/<w:p>.*?<\/w:p>/g)[1];
      expect(separator).not.toContain('<w:jc');
      expect(separator).toContain('　　＊');
    });
  });

  describe('estimateBodyPages', () => {
    test('行数がrowsを超えたら次のページへ送る', () => {
      expect(estimateBodyPages(['一', '二'], { cols: 10, rows: 2 })).toBe(1);
      expect(estimateBodyPages(['一', '二', '三'], { cols: 10, rows: 2 })).toBe(2);
    });
    test('折り返した行も1行ずつ数える', () => {
      expect(estimateBodyPages(['あ'.repeat(25)], { cols: 10, rows: 2 })).toBe(2);
    });
    test('章ごとの改ページで余白が出てもページを進める', () => {
      expect(estimateBodyPages(['【1】', '本文', '【2】', '本文'], { cols: 10, rows: 10 })).toBe(2);
    });
    test('扉と終了記号の行も数え、pageBreakBeforeBodyなら扉で1ページ使う', () => {
      expect(estimateBodyPages(['本文'], { cols: 10, rows: 2, headLines: ['題', ''], tailLines: ['終'] })).toBe(2);
      expect(estimateBodyPages(['本文'], { cols: 10, rows: 10, headLines: ['題'], pageBreakBeforeBody: true })).toBe(2);
    });
  });

  describe('updateCoreProps', () => {
    test('タイトル・作成者・最終更新者を差し替え、空文字なら作者名を消す', () => {
      const core =
        '<dc:title>雛形</dc:title><dc:creator>配布元</dc:creator><cp:lastModifiedBy>配布元</cp:lastModifiedBy>';
      expect(updateCoreProps(core, 'A&B', '')).toBe(
        '<dc:title>A&amp;B</dc:title><dc:creator></dc:creator><cp:lastModifiedBy></cp:lastModifiedBy>',
      );
    });
  });

  const SECT_PR =
    '<w:sectPr><w:footerReference w:type="default" r:id="rId1"/><w:type w:val="continuous"/>' +
    '<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1080" w:bottom="1440" w:left="1080"/>' +
    '<w:cols w:space="425"/><w:docGrid w:type="lines" w:linePitch="386"/></w:sectPr>';
  const TEMPLATE = `<w:document><w:body><w:p/>${SECT_PR}</w:body></w:document>`;

  describe('injectBody', () => {
    test('あらすじなしなら本文を差し替え、セクション書式はテンプレートのまま', () => {
      expect(injectBody(TEMPLATE, '<BODY/>')).toBe(`<w:document><w:body><BODY/>${SECT_PR}</w:body></w:document>`);
    });
    test('あらすじありならノンブルなしのセクションを前に置き、本文のページ番号を1から振り直す', () => {
      const xml = injectBody(TEMPLATE, '<BODY/>', '<SYN/>');
      const [synopsisSect, bodySect] = xml.match(/<w:sectPr>.*?<\/w:sectPr>/g);
      expect(xml.indexOf('<SYN/>')).toBeLessThan(xml.indexOf('<BODY/>'));
      expect(synopsisSect).not.toContain('w:footerReference');
      expect(bodySect).toContain('w:footerReference');
      expect(bodySect).toContain('<w:pgNumType w:start="1"/>');
      expect(xml).not.toContain('continuous');
    });
    test('本文中の $ を置換パターンとして解釈しない', () => {
      expect(injectBody(TEMPLATE, "<w:t>$&amp;$'</w:t>")).toContain("<w:t>$&amp;$'</w:t>");
    });
    test('w:bodyやw:sectPrのないテンプレートはエラー', () => {
      expect(() => injectBody('<w:document/>', '')).toThrow('テンプレート');
    });
  });

  describe('applyDocGrid', () => {
    test('用紙と余白から指定の字詰めが収まる刻み幅を切り捨てで出す', () => {
      // 行方向: (11906-1080*2)/40=243.65→243、字方向: ((16838-1440*2)/40-210)/20*4096=28456.9→28456
      expect(applyDocGrid(TEMPLATE, { cols: 40, rows: 40 })).toContain(
        '<w:docGrid w:type="linesAndChars" w:linePitch="243" w:charSpace="28456"/>',
      );
    });
    test('あらすじと本文の両方のセクションに適用する', () => {
      const xml = applyDocGrid(injectBody(TEMPLATE, '<BODY/>', '<SYN/>'), { cols: 40, rows: 40 });
      expect(xml.match(/w:type="linesAndChars"/g)).toHaveLength(2);
    });
    test('docGridのないセクションには追加する', () => {
      const noGrid = TEMPLATE.replace(/<w:docGrid[^>]*\/>/, '');
      expect(applyDocGrid(noGrid, { cols: 40, rows: 40 })).toContain('w:charSpace="28456"/></w:sectPr>');
    });
    test('用紙サイズの読めないテンプレートはエラー', () => {
      expect(() => applyDocGrid(TEMPLATE.replace(/<w:pgSz[^>]*\/>/, ''), { cols: 40, rows: 40 })).toThrow('w:h');
    });
  });
}
