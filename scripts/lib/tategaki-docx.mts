/**
 * 縦書きWordテンプレートへ本文を流し込むための共通処理
 * （応募用docx: ガガガ文庫テンプレート・日経「星新一賞」などで共有する）
 *
 * 段落・ルビ・傍点・縦中横の組み方と、テンプレートのw:bodyの差し替えを提供する。
 * 文字グリッド（cols/rows）は呼び出し側の応募規定に合わせて渡す。
 */

import {
  escapeXml,
  epigraphDisplayLines,
  isEpigraphLine,
  isSeparator,
  isViewpointLine,
  parseEpigraphLine,
  stripInlineMarkup,
  tokenizeInlineMarkup,
  countTextChars,
} from './text-parser.mts';
import { countWrappedRows, normalizeTcy } from './grid.mts';
import { toFullWidth, toVerticalBase, toVerticalText } from './docx.mts';

const RPR = '<w:rPr><w:rFonts w:hint="eastAsia"/></w:rPr>';

function runXml(text, rPr = RPR) {
  return `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

function plainRunXml(text) {
  return runXml(toFullWidth(text));
}

// 2桁数字の縦中横。idは隣接する縦中横同士が結合しないよう連番にする
let tcyId = 1;
function tcyRunXml(digits) {
  return runXml(digits, `<w:rPr><w:rFonts w:hint="eastAsia"/><w:eastAsianLayout w:id="${tcyId++}" w:vert="1" w:vertCompress="1"/></w:rPr>`);
}

// PDF出力と同じ規則: 2桁の数字は縦中横で1マスに収め、
// 1桁・3桁以上は全角化して1字ずつ立てる
export function textRunXml(text) {
  if (!text) return '';
  const base = toVerticalBase(text);
  let out = '';
  let last = 0;
  for (const m of base.matchAll(/[0-9]+/g)) {
    if (m.index > last) out += plainRunXml(base.slice(last, m.index));
    out += m[0].length === 2 ? tcyRunXml(m[0]) : plainRunXml(m[0]);
    last = m.index + m[0].length;
  }
  if (last < base.length) out += plainRunXml(base.slice(last));
  return out;
}

// |漢字《かんじ》 → Wordの本物のルビ
function rubyRunXml(base, ruby) {
  const rt = runXml(toVerticalText(ruby), '<w:rPr><w:rFonts w:hint="eastAsia"/><w:sz w:val="10"/></w:rPr>');
  const rb = runXml(toVerticalText(base));
  return `<w:r>${RPR}<w:ruby>` +
    '<w:rubyPr><w:rubyAlign w:val="distributeSpace"/><w:hps w:val="10"/><w:hpsRaise w:val="18"/>' +
    '<w:hpsBaseText w:val="21"/><w:lid w:val="ja-JP"/></w:rubyPr>' +
    `<w:rt>${rt}</w:rt><w:rubyBase>${rb}</w:rubyBase></w:ruby></w:r>`;
}

// 《《強調》》 → 傍点
function emphasisRunXml(text) {
  return runXml(toVerticalText(text), '<w:rPr><w:rFonts w:hint="eastAsia"/><w:em w:val="dot"/></w:rPr>');
}

// *text* → イタリック
function italicRunXml(text) {
  return runXml(toVerticalText(text), '<w:rPr><w:rFonts w:hint="eastAsia"/><w:i/></w:rPr>');
}

// <<横倒し>> → 半角のまま出す（Wordの縦書きでは半角英数がそのまま横倒しになる）
function sidewaysRunXml(text) {
  return runXml(toVerticalBase(stripInlineMarkup(text)));
}

export function lineToRunsXml(line) {
  return tokenizeInlineMarkup(line).map(token => {
    switch (token.type) {
      case 'emphasis': return emphasisRunXml(token.text);
      case 'ruby': return rubyRunXml(token.base, token.ruby);
      case 'italic': return italicRunXml(token.text);
      case 'sideways': return sidewaysRunXml(token.text);
      default: return textRunXml(token.text);
    }
  }).join('');
}

export function paragraphXml(runsXml, { center = false, right = false, pageBreakBefore = false } = {}) {
  const jc = center ? 'center' : right ? 'right' : null;
  const pPr = jc ? `<w:pPr><w:jc w:val="${jc}"/></w:pPr>` : '';
  const br = pageBreakBefore ? '<w:r><w:br w:type="page"/></w:r>' : '';
  return `<w:p>${pPr}${br}${runsXml}</w:p>`;
}

/**
 * 本文行を流し込む共通の走査。エピグラフ行・通常行ごとに emit を呼ぶ。
 *   emit(line, { pageBreakBefore, epigraph })
 *     epigraph: エピグラフ行なら表示行の配列（1行に収まれば1要素）、通常行なら null
 * 視点行（章の頭）ごとに改ページする（冒頭の視点行は改ページ不要）。
 * エピグラフの直後には空行を1行保証する。
 */
export function walkBodyLines(lines, { cols, pageBreakBeforeBody = false }, emit) {
  let isFirstViewpoint = true;
  let needBodyPageBreak = pageBreakBeforeBody;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (isEpigraphLine(line)) {
      const { quote, source } = parseEpigraphLine(line);
      emit(line, { pageBreakBefore: needBodyPageBreak, epigraph: epigraphDisplayLines(quote, source, cols) });
      needBodyPageBreak = false;
      if (!(i + 1 < lines.length && lines[i + 1].trim() === '')) emit('', { pageBreakBefore: false, epigraph: null });
      continue;
    }

    const isViewpoint = isViewpointLine(line);
    const pageBreakBefore = needBodyPageBreak || (isViewpoint && !isFirstViewpoint);
    if (isViewpoint) isFirstViewpoint = false;
    needBodyPageBreak = false;
    emit(line, { pageBreakBefore, epigraph: null });
  }
}

// グリッドの字数で何行になるか（ルビ・傍点記法を除去、2桁半角数字は縦中横で1マス、ぶら下げ考慮）
export function countGridRows(line, cols) {
  return countWrappedRows(normalizeTcy(stripInlineMarkup(line)), cols);
}

// ルビ・傍点の記法を除いた、実際に紙面に出るテキスト（エピグラフ含む）
export function bodyDisplayText(lines) {
  return lines.map(l => {
    if (isEpigraphLine(l)) {
      const { quote, source } = parseEpigraphLine(l);
      return stripInlineMarkup(epigraphDisplayLines(quote, source).join(''));
    }
    return stripInlineMarkup(l);
  }).join('');
}

// 実際に表示される本文の字数（空白・ふりがなを含まない）
export function countBodyChars(lines) {
  return countTextChars(bodyDisplayText(lines));
}

// docPropsのタイトル・作成者をテンプレート作成者から差し替える（作者名を出さない応募先では author に空文字を渡す）
export function updateCoreProps(coreXml, title, author) {
  return coreXml
    .replace(/<dc:title>.*?<\/dc:title>/s, `<dc:title>${escapeXml(title)}</dc:title>`)
    .replace(/<dc:creator>.*?<\/dc:creator>/s, `<dc:creator>${escapeXml(author)}</dc:creator>`)
    .replace(/<cp:lastModifiedBy>.*?<\/cp:lastModifiedBy>/s, `<cp:lastModifiedBy>${escapeXml(author)}</cp:lastModifiedBy>`);
}

/**
 * 本文のXMLを組む。
 *   headParagraphs / tailParagraphs: 本文の前後に置く段落XML（扉・＜終＞など）
 *   pageBreakBeforeBody: 本文の先頭で改ページする（扉を1ページ独立させるとき）
 */
export function buildBodyXml(lines, { cols, headParagraphs = [], tailParagraphs = [], pageBreakBeforeBody = false }) {
  const paragraphs = [...headParagraphs];

  walkBodyLines(lines, { cols, pageBreakBeforeBody }, (line, { pageBreakBefore, epigraph }) => {
    if (epigraph) {
      // エピグラフ: PDFと同じく下揃え（縦書きのright）
      epigraph.forEach((text, i) => {
        paragraphs.push(paragraphXml(lineToRunsXml(text), { right: true, pageBreakBefore: i === 0 && pageBreakBefore }));
      });
    } else if (line.trim() === '') {
      paragraphs.push(paragraphXml('', { pageBreakBefore }));
    } else if (isSeparator(line)) {
      paragraphs.push(paragraphXml(textRunXml(line), { center: true, pageBreakBefore }));
    } else {
      paragraphs.push(paragraphXml(lineToRunsXml(line), { pageBreakBefore }));
    }
  });

  return [...paragraphs, ...tailParagraphs].join('');
}

// buildBodyXmlと同じ流し込み規則で、本文が何ページになるかを見積もる
export function estimateBodyPages(lines, { cols, rows, headLines = [], tailLines = [], pageBreakBeforeBody = false }) {
  let pages = 1;
  let pageRows = 0;

  const breakPage = () => {
    pages++;
    pageRows = 0;
  };
  const addLine = line => {
    for (let n = countGridRows(line, cols); n > 0; n--) {
      if (pageRows >= rows) breakPage();
      pageRows++;
    }
  };

  headLines.forEach(addLine);

  walkBodyLines(lines, { cols, pageBreakBeforeBody }, (line, { pageBreakBefore, epigraph }) => {
    if (pageBreakBefore) breakPage();
    if (epigraph) epigraph.forEach(addLine);
    else addLine(line);
  });

  tailLines.forEach(addLine);

  return pages;
}

/**
 * テンプレートの本文（空の1段落）を差し替える。
 * あらすじがある場合は2セクション構成にする:
 *   セクション1 = あらすじ（フッター参照を外してノンブルなし）
 *   セクション2 = 本文（ページ番号を1から振り直す）
 */
export function injectBody(documentXml, bodyXml, synopsisXml = null) {
  const sectPrMatch = documentXml.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/);
  if (!sectPrMatch || !documentXml.includes('<w:body>')) {
    throw new Error('テンプレートのw:body/w:sectPrが見つかりません');
  }
  const sectPr = sectPrMatch[0];

  let content;
  let finalSectPr = sectPr;
  if (synopsisXml != null) {
    // セクション1（あらすじ）: フッターなし。区切りは改ページ
    const synopsisSectPr = sectPr
      .replace(/<w:footerReference[^>]*\/>/g, '')
      .replace(/<w:type[^>]*\/>/, '');
    // セクション2（本文）: 改ページ開始（continuousを外す）＋ページ番号を1から
    finalSectPr = sectPr
      .replace(/<w:type[^>]*\/>/, '')
      .replace(/<w:cols/, '<w:pgNumType w:start="1"/><w:cols');
    content = `${synopsisXml}<w:p><w:pPr>${synopsisSectPr}</w:pPr></w:p>${bodyXml}`;
  } else {
    content = bodyXml;
  }

  return documentXml.replace(
    /<w:body>[\s\S]*<\/w:body>/,
    () => `<w:body>${content}${finalSectPr}</w:body>`,
  );
}

/**
 * テンプレートの文字グリッド（w:docGrid）を指定の字詰めに組み替える。
 * 用紙サイズ・余白・本文フォントサイズはテンプレートのものを使い、
 * 縦書き（tbRl）として「紙の高さ方向＝1行の字数」「紙の幅方向＝行数」で刻み幅を出す。
 *
 * Word の docGrid の刻み幅:
 *   linePitch = 行の送り（twip）
 *   charSpace = （1字の送り − フォントサイズ）を 1/4096 pt 単位で表した値
 * 端数は切り捨て側（＝送りを詰める側）に寄せて、指定の字数・行数が必ず収まるようにする。
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

  // 縦書き: 字は紙の高さ方向に並び、行は紙の幅方向に並ぶ
  const charAxis = attr(pgSz, 'h') - attr(pgMar, 'top') - attr(pgMar, 'bottom');
  const lineAxis = attr(pgSz, 'w') - attr(pgMar, 'left') - attr(pgMar, 'right');

  const linePitch = Math.floor(lineAxis / rows);
  const charSpace = Math.floor((charAxis / cols - fontPt * 20) / 20 * 4096);
  const docGrid = `<w:docGrid w:type="linesAndChars" w:linePitch="${linePitch}" w:charSpace="${charSpace}"/>`;

  return documentXml.replace(
    /<w:sectPr[\s\S]*?<\/w:sectPr>/g,
    section => (/<w:docGrid[^>]*\/>/.test(section)
      ? section.replace(/<w:docGrid[^>]*\/>/, docGrid)
      : section.replace('</w:sectPr>', `${docGrid}</w:sectPr>`)),
  );
}
