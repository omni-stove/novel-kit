/**
 * 縦書きWordテンプレートへ本文を流し込むための共通処理
 * （応募用docx: ガガガ文庫テンプレート・日経「星新一賞」などで共有する）
 *
 * 段落・ルビ・傍点・縦中横の組み方と、テンプレートのw:bodyの差し替えを提供する。
 * 文字グリッド（cols/rows）は呼び出し側の応募規定に合わせて渡す。
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
  isEpigraphLine,
  isSeparator,
  isViewpointLine,
  parseEpigraphLine,
  SCENE_BREAK_MARK,
  separatorMark,
  stripInlineMarkup,
  tokenizeInlineMarkup,
} from './text-parser.mjs';

const DEFAULT_TEMPLATE_PATH = fileURLToPath(new URL('../templates/tategaki-a4-42x34.docx', import.meta.url));

export function resolveTemplatePath(override = null) {
  const templatePath = override || DEFAULT_TEMPLATE_PATH;
  if (!existsSync(templatePath)) fail(`テンプレートが見つかりません: ${templatePath}`);
  return templatePath;
}

const RPR = '<w:rPr><w:rFonts w:hint="eastAsia"/></w:rPr>';

function runXml(text, rPr = RPR) {
  return `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

function plainRunXml(text) {
  return runXml(toFullWidth(text));
}

/** 2桁数字を縦中横にしたランの XML を返す。隣接する縦中横同士が Word で結合しないよう、id は連番にする。 */
let tcyId = 1;
function tcyRunXml(digits) {
  return runXml(
    digits,
    `<w:rPr><w:rFonts w:hint="eastAsia"/><w:eastAsianLayout w:id="${tcyId++}" w:vert="1" w:vertCompress="1"/></w:rPr>`,
  );
}

// 数字の立て方は PDF 出力（text-parser の escapeHtml）と揃える
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

function rubyRunXml(base, ruby) {
  const rt = runXml(toVerticalText(ruby), '<w:rPr><w:rFonts w:hint="eastAsia"/><w:sz w:val="10"/></w:rPr>');
  const rb = runXml(toVerticalText(base));
  return (
    `<w:r>${RPR}<w:ruby>` +
    '<w:rubyPr><w:rubyAlign w:val="distributeSpace"/><w:hps w:val="10"/><w:hpsRaise w:val="18"/>' +
    '<w:hpsBaseText w:val="21"/><w:lid w:val="ja-JP"/></w:rubyPr>' +
    `<w:rt>${rt}</w:rt><w:rubyBase>${rb}</w:rubyBase></w:ruby></w:r>`
  );
}

function emphasisRunXml(text) {
  return runXml(toVerticalText(text), '<w:rPr><w:rFonts w:hint="eastAsia"/><w:em w:val="dot"/></w:rPr>');
}

function italicRunXml(text) {
  return runXml(toVerticalText(text), '<w:rPr><w:rFonts w:hint="eastAsia"/><w:i/></w:rPr>');
}

// Wordの縦書きでは半角英数がそのまま横倒しになるので、全角化せずに出す
function sidewaysRunXml(text) {
  return runXml(toVerticalBase(stripInlineMarkup(text)));
}

export function lineToRunsXml(line) {
  return tokenizeInlineMarkup(line)
    .map((token) => {
      switch (token.type) {
        case 'emphasis':
          return emphasisRunXml(token.text);
        case 'ruby':
          return rubyRunXml(token.base, token.ruby);
        case 'italic':
          return italicRunXml(token.text);
        case 'sideways':
          return sidewaysRunXml(token.text);
        default:
          return textRunXml(token.text);
      }
    })
    .join('');
}

export function paragraphXml(runsXml, { center = false, right = false, pageBreakBefore = false } = {}) {
  const jc = center ? 'center' : right ? 'right' : null;
  const pPr = jc ? `<w:pPr><w:jc w:val="${jc}"/></w:pPr>` : '';
  const br = pageBreakBefore ? '<w:r><w:br w:type="page"/></w:r>' : '';
  return `<w:p>${pPr}${br}${runsXml}</w:p>`;
}

/**
 * 本文の行を走査し、出す行ごとに emit(line, { pageBreakBefore, epigraph }) を呼ぶ。
 * 2つ目以降の視点行【】と、pageBreakBeforeBody 指定時の最初の行は改ページ付きにする。
 * 青空文庫の改ページは次の行の前で改ページし、字下げ範囲の注記行は出さず、行頭の字下げなどの注記は外す。
 * エピグラフは cols で折り返した表示行を epigraph に渡し、直後が空行でなければ空行を1つ補う。
 * 出力（buildBodyXml）とページ見積もり（estimateBodyPages）で改ページ位置がずれないよう、走査を共有する。
 */
export function walkBodyLines(lines, { cols, pageBreakBeforeBody = false }, emit) {
  let isFirstViewpoint = true;
  let needBodyPageBreak = pageBreakBeforeBody;

  for (let i = 0; i < lines.length; i++) {
    const aozora = parseAozoraLine(lines[i]);
    if (aozora.kind === 'pageBreak') {
      needBodyPageBreak = true;
      continue;
    }
    if (aozora.kind !== 'text') continue;
    const line = aozora.text;

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

export function countGridRows(line, cols) {
  return countWrappedRows(normalizeTcy(stripInlineMarkup(line)), cols);
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
  { cols, headParagraphs = [], tailParagraphs = [], pageBreakBeforeBody = false, sceneBreak = SCENE_BREAK_MARK },
) {
  const paragraphs = [...headParagraphs];

  walkBodyLines(lines, { cols, pageBreakBeforeBody }, (line, { pageBreakBefore, epigraph }) => {
    if (epigraph) {
      // PDF と同じく下揃えにする（縦書きでは right が下揃え）
      epigraph.forEach((text, i) => {
        paragraphs.push(
          paragraphXml(lineToRunsXml(text), { right: true, pageBreakBefore: i === 0 && pageBreakBefore }),
        );
      });
    } else if (line.trim() === '') {
      paragraphs.push(paragraphXml('', { pageBreakBefore }));
    } else if (isSeparator(line)) {
      paragraphs.push(paragraphXml(textRunXml(separatorMark(line, sceneBreak)), { center: true, pageBreakBefore }));
    } else {
      paragraphs.push(paragraphXml(lineToRunsXml(line), { pageBreakBefore }));
    }
  });

  return [...paragraphs, ...tailParagraphs].join('');
}

export function estimateBodyPages(lines, { cols, rows, headLines = [], tailLines = [], pageBreakBeforeBody = false }) {
  let pages = 1;
  let pageRows = 0;

  const breakPage = () => {
    pages++;
    pageRows = 0;
  };
  const addLine = (line) => {
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

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest;

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
      const out = walk(['【1】', 'Epigraph: 引用——出典', '本文']);
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
      expect(walk(['Epigraph: 引用', '', '本文']).map((o) => o.line)).toEqual(['Epigraph: 引用', '', '本文']);
    });
    test('1行に収まらないエピグラフは引用行と出典行に分ける', () => {
      const out = walk([`Epigraph: ${'あ'.repeat(10)}——出典`], { cols: 10 });
      expect(out[0].epigraph).toEqual(['あ'.repeat(10), '——出典']);
    });
  });

  describe('countGridRows / countBodyChars', () => {
    test('記法を除き、2桁数字を1マスとして行数を数える', () => {
      expect(countGridRows('|漢字《かんじ》12', 3)).toBe(1);
      expect(countGridRows('|漢字《かんじ》123', 3)).toBe(2);
    });
    test('字数は空白・ふりがな・Epigraph: プレフィックスを含まない', () => {
      expect(countBodyChars(['　|漢字《かんじ》', 'Epigraph: 引用——出典'])).toBe(8);
    });
  });

  describe('buildBodyXml', () => {
    test('空行・区切り・エピグラフ・本文を段落にし、前後に扉と終了記号を置く', () => {
      const xml = buildBodyXml(['【1】', 'Epigraph: 引用', '', '本文', '◇◇◇'], {
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
