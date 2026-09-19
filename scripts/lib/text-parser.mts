/**
 * 原稿テキスト（1ファイル分）の解釈。
 * 行の種別判定、インライン記法（ルビ・傍点・横倒し・イタリック）、
 * 縦書きHTMLへの変換、エピグラフの整形など、テキストそのものに関する処理を置く。
 * 複数ファイルの集合や採番・ディレクトリ走査は manuscript.mts。
 */

import { readFileSync } from 'fs';

export function isSeparator(line) {
  return /^[◇◆□■○●◎※＊*]+$/.test(line);
}

export function isMemoLine(line) {
  return line.startsWith('Memo:');
}

// /write が出力先の先頭に書く元ファイル（プロット等）への参照行
export function isSourceLine(line) {
  return line.startsWith('Source:');
}

export function isTitleLine(line) {
  return line.startsWith('Title:');
}

export function isGenreLine(line) {
  return line.startsWith('Genre:');
}

export function isEpigraphLine(line) {
  return line.startsWith('Epigraph:');
}

export function isPovLine(line) {
  return line.startsWith('POV:');
}

export function parsePovLine(line) {
  return line.replace(/^POV:\s*/, '').trim();
}

export function parseEpigraphLine(line) {
  const text = line.replace(/^Epigraph:\s*/, '');
  // 引用本文の中にもダッシュ（——）が使われうるため、最後の——を引用元との区切りとする
  const idx = text.lastIndexOf('——');
  if (idx === -1) return { quote: text.trim(), source: null };
  const source = text.slice(idx + 2).trim();
  // ——の後が空なら引用元なし（末尾のダッシュは引用本文の一部として残す）
  if (!source) return { quote: text.trim(), source: null };
  return { quote: text.slice(0, idx).trim(), source };
}

export function isViewpointLine(line) {
  return /^【.*】/.test(line);
}

export function applyViewpointLabel(line, label) {
  const match = line.match(/^【(.*)】/);
  const title = match ? match[1].trim() : '';
  return title
    ? line.replace(/^【.*】/, `【${label}　${title}】`)
    : line.replace(/^【】/, `【${label}】`);
}

// 本文として印刷・集計しない行（Memo: / Source: / Title: / Genre: / Epigraph: / POV:）。
// メタ行の種類を増やすときはここに足す（manuscript-count.sh の is_meta_line も揃える）
export function isMetaLine(line) {
  return isMemoLine(line) || isSourceLine(line) || isTitleLine(line) || isGenreLine(line) || isEpigraphLine(line) || isPovLine(line);
}

function analyzeLines(lines) {
  const contentLines = lines.filter(l => l.trim() !== '' && !isMetaLine(l));
  const hasViewpointStart = contentLines.length > 0 && isViewpointLine(contentLines[0]);
  const hasViewpointEnd = contentLines.length > 0 && isViewpointLine(contentLines[contentLines.length - 1]);

  // 末尾の視点行は次章のアンカーなので本文から除く。その位置を元のlines基準で特定する
  let endViewpointLineIndex = -1;
  if (hasViewpointEnd) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim() !== '' && !isMetaLine(lines[i])) {
        endViewpointLineIndex = i;
        break;
      }
    }
  }

  const povLine = lines.find(l => isPovLine(l));

  return {
    hasViewpointStart,
    hasViewpointEnd,
    hasEmptyViewpointStart: hasViewpointStart && /^【】/.test(contentLines[0]),
    endViewpointLineIndex,
    firstContentLine: contentLines.length > 0 ? contentLines[0] : null,
    epigraphs: lines.filter(l => isEpigraphLine(l)).map(l => parseEpigraphLine(l)),
    pov: povLine ? parsePovLine(povLine) : null,
  };
}

function selectBodyLines(lines, endViewpointLineIndex, { keepEpigraphs = false, keepPov = false } = {}) {
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    const kept = (keepEpigraphs && isEpigraphLine(lines[i])) || (keepPov && isPovLine(lines[i]));
    if (isMetaLine(lines[i]) && !kept) continue;
    if (i === endViewpointLineIndex) continue;
    result.push(lines[i]);
  }
  return result;
}

export function trimBlankEdges(lines) {
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines;
}

// 改行で分割する。CRLF の CR は落とす
export function splitLines(content) {
  return content.split('\n').map(l => l.replace(/\r$/, ''));
}

export function readLines(filePath) {
  return splitLines(readFileSync(filePath, 'utf-8'));
}

// 空白（改行・全角スペース含む）を除いた字数。記法の除去は呼び出し側で行う
export function countTextChars(text) {
  return [...text.replace(/\s/g, '')].length;
}

const INLINE_MARKUP_RE = /《《(.+?)》》|\|(.+?)《(.+?)》|<<(.+?)>>|\*([^*]+)\*/g;

/**
 * インライン記法をトークン列に分解する。
 *   { type: 'text', text }        通常テキスト
 *   { type: 'emphasis', text }    《《傍点》》
 *   { type: 'ruby', base, ruby }  |親文字《ルビ》
 *   { type: 'sideways', text }    <<横倒し>>（縦書き用。中身にルビ記法を含みうる）
 *   { type: 'italic', text }      *イタリック*（英語原稿用）
 */
export function tokenizeInlineMarkup(text) {
  const tokens = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_MARKUP_RE)) {
    if (m.index > last) tokens.push({ type: 'text', text: text.slice(last, m.index) });
    if (m[1] !== undefined) tokens.push({ type: 'emphasis', text: m[1] });
    else if (m[2] !== undefined) tokens.push({ type: 'ruby', base: m[2], ruby: m[3] });
    else if (m[4] !== undefined) tokens.push({ type: 'sideways', text: m[4] });
    else tokens.push({ type: 'italic', text: m[5] });
    last = m.index + m[0].length;
  }
  if (last < text.length) tokens.push({ type: 'text', text: text.slice(last) });
  return tokens;
}

// 記法を外して表示されるテキストだけにする（字数カウントや書式なし出力用）
export function stripInlineMarkup(text, { rubyParens = false } = {}) {
  return tokenizeInlineMarkup(text).map(t => {
    if (t.type === 'ruby') return rubyParens ? `${t.base}（${t.ruby}）` : t.base;
    if (t.type === 'sideways') return stripInlineMarkup(t.text, { rubyParens });
    return t.text;
  }).join('');
}

// XML/HTML のテキストノード用エスケープ
export function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function escapeHtml(text, { vertical = true, separateSymbolClasses = false } = {}) {
  const rubyPlaceholders = [];
  const emphasisPlaceholders = [];

  // プレースホルダーにはUnicode Private Use Area文字を使用
  // （ASCII文字・数字を含まないため、後続の縦中横・ラテン文字処理で破壊されない）
  const phRuby = (i) => `\uE000${String.fromCharCode(0xE010 + i)}\uE000`;
  const phEmphasis = (i) => `\uE001${String.fromCharCode(0xE010 + i)}\uE001`;
  const sidewaysPlaceholders = [];
  const phSideways = (i) => `\uE003${String.fromCharCode(0xE010 + i)}\uE003`;

  // ラテン文字・縦中横を先にプレースホルダー化してからダッシュ等のspanタグを生成し、
  // 最後にプレースホルダーをHTMLに展開する（spanタグ内の英字を二重処理しないため）
  const spanPlaceholders = [];
  const phSpan = (html) => {
    const idx = spanPlaceholders.length;
    spanPlaceholders.push(html);
    return `\uE002${String.fromCharCode(0xE010 + idx)}\uE002`;
  };

  function processInnerText(t) {
    let r = t
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    // 半角スペースを全角スペース(U+3000)に変換し、半角・全角どちらも一文字分の幅で保持する。
    // U+3000 はHTMLの連続空白コラプス対象外なので、複数スペースや行頭・行末でも潰れない
    // （CSSの text-spacing-trim: space-all により全角スペースは行頭でもトリムされない）。
    r = r.replace(/ /g, '　');
    if (vertical) {
      // ASCII\u30ED\u30FC\u30DE\u6570\u5B57\uFF08II\u301CXII\uFF09\u306FUnicode\u306E\u5358\u4E00\u30B3\u30FC\u30C9\u30DD\u30A4\u30F3\u30C8\u306B\u6B63\u898F\u5316\u3057\u3066upright\u3067\u7ACB\u3066\u308B\u3002
      // text-combine-upright: all \u306FChromium/Vivliostyle\u3067\u5B57\u5E45\u5DEE\u306E\u3042\u308B\u7D44\uFF08IV\u7B49\uFF09\u304C\u53F3\u306B\u5BC4\u308B\u305F\u3081\u4F7F\u308F\u306A\u3044\u3002
      const asciiRomanMap = {
        'II': '\u2161', 'III': '\u2162', 'IV': '\u2163', 'VI': '\u2165',
        'VII': '\u2166', 'VIII': '\u2167', 'IX': '\u2168', 'XI': '\u216A', 'XII': '\u216B',
      };
      r = r.replace(/\b(XII|XI|VIII|VII|VI|IX|IV|III|II)\b/g, (match) => phSpan(`<span class="upright">${asciiRomanMap[match]}</span>`));
      r = r.replace(/[\u2160-\u216B\u2170-\u217B]+/g, (match) => {
        return [...match].map(c => phSpan(`<span class="upright">${c}</span>`)).join('');
      });
      r = r.replace(/\+[-\u2212]/g, '\u00B1');
      r = r.replace(/-/g, '\uFF0D');
      r = r.replace(/\+/g, '\uFF0B');
      r = r.replace(/!/g, '！');
      r = r.replace(/\?/g, '？');
      r = r.replace(/@/g, '＠');
      r = r.replace(/\//g, '／');
      r = r.replace(/[！？]{2}/g, (match) => {
        const hw = match.replace(/！/g, '!').replace(/？/g, '?');
        return phSpan(`<span class="tcy">${hw}</span>`);
      });
      r = r.replace(/\.?\d[\d,.]*\d|\d/g, (match) => {
        const converted = match.replace(/\./g, '．').replace(/,/g, '，');
        if (/^\d{1,2}$/.test(match)) return phSpan(`<span class="tcy">${match}</span>`);
        // 3桁以上の数字も1文字ずつ独立した正方セルへ（text-combine-upright: all で中央寄せ）
        return [...converted].map(c => phSpan(`<span class="upright">${c}</span>`)).join('');
      });
      // 拡張ラテン文字（À–ɏ, Ḁ–1EFF）も含めて upright 化。
      // U+00D7（×）と U+00F7（÷）は数学記号なので除外。
      const latinChar = 'a-zA-Z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u024F\\u1E00-\\u1EFF';
      const latinRe = new RegExp(`[${latinChar}]+(?:\\s[${latinChar}]+)*`, 'g');
      // 1\u6587\u5B57\u305A\u3064\u72EC\u7ACB\u3057\u305F\u6B63\u65B9\u30BB\u30EB\u306B\u53CE\u3081\u308B\u3053\u3068\u3067\u3001y/g/p/j \u306E\u30C7\u30A3\u30BB\u30F3\u30C0\u304C\u30D9\u30FC\u30B9\u30E9\u30A4\u30F3\u3067
      // \u4E0B\u306B\u305A\u308C\u306A\u3044\u3088\u3046\u306B\u3059\u308B\uFF08CSS .latin \u5074\u3067 text-combine-upright: all \u3092\u9069\u7528\uFF09\u3002
      r = r.replace(latinRe, (match) => {
        return [...match].map(c => /\s/.test(c) ? c : phSpan(`<span class="latin">${c}</span>`)).join('');
      });
      r = r.replace(/[\u0370-\u03FF]+/g, (match) => {
        return [...match].map(c => phSpan(`<span class="upright">${c}</span>`)).join('');
      });
      // 単独のASCIIピリオド（略語 O.M. / U.S.A. 等の区切り）。mixed のままだと
      // グリフがセルの左下へ寄り列の中央からずれるため、hyphen と同様に 1em の
      // 正方セル中央へ実描画する。数字内の小数点は既に全角「．」へ変換済みで対象外。
      r = r.replace(/\./g, () => phSpan('<span class="dot">.</span>'));
      // ダッシュ等のspanタグを生成（この時点でラテン文字はもうプレースホルダーなので安全）
      // ＝（全角イコール＝外国人名の二重ハイフン）もダッシュ扱いで横倒しし、縦書きでは
      // 中央寄せの縦二重線にする。未指定だと mixed のまま横倒しの二本線が左へズレる。
      if (separateSymbolClasses) {
        r = r.replace(/([—―\uFF0D\uFF1D]+)/g, '<span class="dash">$1</span>');
        r = r.replace(/([…‥]+)/g, '<span class="ellipsis">$1</span>');
        r = r.replace(/([～〜]+)/g, '<span class="wave-dash">$1</span>');
      } else {
        // 単独の全角ハイフンマイナス（章番号「1-1」の区切り等）は sideways 回転だと
        // グリフが列の中央より左へずれるため、tcy方式（1emボックス＋rotate）で中央寄せする。
        // 連続ダッシュ（——）や全角イコール（＝）は縦長の線として dash のまま縦倒しにする。
        r = r.replace(/([—―－＝]+)/g, (m) =>
          m === '－' ? `<span class="hyphen">${m}</span>` : `<span class="dash">${m}</span>`);
        r = r.replace(/([…‥]+)/g, '<span class="dash">$1</span>');
        r = r.replace(/([～〜]+)/g, '<span class="dash">$1</span>');
      }
    }
    return r;
  }

  let result = text.replace(/<<(.+?)>>/g, (_, content) => {
    const idx = sidewaysPlaceholders.length;
    sidewaysPlaceholders.push(content);
    return phSideways(idx);
  });

  result = result.replace(/《《(.+?)》》/g, (_, content) => {
    const idx = emphasisPlaceholders.length;
    emphasisPlaceholders.push(content);
    return phEmphasis(idx);
  });

  result = result.replace(/\|(.+?)《(.+?)》/g, (_, base, ruby) => {
    const idx = rubyPlaceholders.length;
    rubyPlaceholders.push({ base, ruby });
    return phRuby(idx);
  });

  result = processInnerText(result);

  result = result.replace(/\uE000([\uE010-\uEFFF])\uE000/g, (_, ch) => {
    const { base, ruby } = rubyPlaceholders[ch.charCodeAt(0) - 0xE010];
    return `<ruby>${processInnerText(base)}<rt>${processInnerText(ruby)}</rt></ruby>`;
  });

  result = result.replace(/\uE001([\uE010-\uEFFF])\uE001/g, (_, ch) => {
    const content = emphasisPlaceholders[ch.charCodeAt(0) - 0xE010];
    return `<span class="emphasis">${processInnerText(content)}</span>`;
  });

  result = result.replace(/\uE003([\uE010-\uEFFF])\uE003/g, (_, ch) => {
    let content = sidewaysPlaceholders[ch.charCodeAt(0) - 0xE010];
    // 先にHTMLエスケープ（《》| はHTMLエンティティではないので残る）
    content = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    content = content.replace(/\|(.+?)《(.+?)》/g, (_, base, ruby) => `<ruby>${base}<rt>${ruby}</rt></ruby>`);
    return `<span class="sideways-latin">${content}</span>`;
  });

  result = result.replace(/\uE002([\uE010-\uEFFF])\uE002/g, (_, ch) => {
    return spanPlaceholders[ch.charCodeAt(0) - 0xE010];
  });

  return result;
}

// エピグラフ行の表示幅（em換算）。縦書きでは半角英字も.latin（縦中横）で
// 全角1文字幅になるため、縦中横になる1〜2桁の数字列を1文字幅、
// それ以外は1文字=1文字幅として数える
function epigraphSourceLength(text) {
  let len = 0;
  const rest = stripInlineMarkup(text).replace(/\d{1,2}/g, () => {
    len += 1;
    return '';
  });
  len += [...rest].length;
  return len;
}

// 本文＋引用元が一字下げを保ったまま1行（1列）に収まるか
export function epigraphFitsOneLine(quote, source, chars) {
  if (!source || !chars) return false;
  return epigraphSourceLength(quote) + epigraphSourceLength(`——${source}`) <= chars - 1;
}

// エピグラフを表示行に分ける。1行に収まるなら「引用——出典」の1行、
// 収まらなければ引用行と「——出典」行（出典がなければ引用行のみ）
export function epigraphDisplayLines(quote, source, chars = null) {
  if (epigraphFitsOneLine(quote, source, chars)) return [`${quote}——${source}`];
  return source ? [quote, `——${source}`] : [quote];
}

function epigraphsToHtml(epigraphs, escapeOpts, chars = null) {
  return epigraphs.map(({ quote, source }) => {
    // 本文＋引用元が1行に収まる場合はまとめて1行で出す
    if (epigraphFitsOneLine(quote, source, chars)) {
      return `<p class="epigraph-line">${escapeHtml(`${quote}——${source}`, escapeOpts)}</p>`;
    }
    // 引用元・本文の長さをCSS変数で渡し、本文の行末を引用元の先頭位置まで押し上げる
    // （本文の先頭が一字下げ位置より上に突き抜けないよう、CSS側で本文長からクランプする）
    const quoteStyle = source
      ? ` style="--epigraph-quote-len: ${epigraphSourceLength(quote)}; --epigraph-source-len: ${epigraphSourceLength(`——${source}`)}"`
      : '';
    const parts = [`<p class="epigraph-quote"${quoteStyle}>${escapeHtml(quote, escapeOpts)}</p>`];
    if (source) parts.push(`<p class="epigraph-source">${escapeHtml(`——${source}`, escapeOpts)}</p>`);
    return parts.join('\n');
  }).join('\n');
}

export function parseTextFile(filePath, { vertical = true, separateSymbolClasses = false, sectionNumber = null, chars = null } = {}) {
  const lines = readLines(filePath);
  const htmlParts = [];

  const { hasViewpointStart, hasViewpointEnd, hasEmptyViewpointStart, endViewpointLineIndex, epigraphs, pov } = analyzeLines(lines);
  const processLines = selectBodyLines(lines, endViewpointLineIndex);

  let lastWasViewpoint = false;

  const escapeOpts = { vertical, separateSymbolClasses };

  // エピグラフをプレーンな段落として挿入（PDF公募用：装飾なし）
  let pendingEpigraphs = epigraphs.length > 0 ? [...epigraphs] : null;

  for (let i = 0; i < processLines.length; i++) {
    const line = processLines[i];

    if (isSeparator(line)) {
      const prevLine = i > 0 ? processLines[i - 1] : null;
      const nextLine = i < processLines.length - 1 ? processLines[i + 1] : null;
      const hasPrevEmpty = prevLine !== null && prevLine.trim() === '';
      const hasNextEmpty = nextLine !== null && nextLine.trim() === '';

      if (hasPrevEmpty && hasNextEmpty) {
        if (htmlParts.length > 0 && htmlParts[htmlParts.length - 1] === '<p class="empty">&nbsp;</p>') {
          htmlParts.pop();
        }
        htmlParts.push(`<div class="separator-block"><p class="separator">${escapeHtml(line, escapeOpts)}</p></div>`);
        i++;
        lastWasViewpoint = false;
        continue;
      }

      htmlParts.push(`<p class="separator">${escapeHtml(line, escapeOpts)}</p>`);
      lastWasViewpoint = false;
      continue;
    }

    if (line.trim() === '') {
      htmlParts.push('<p class="empty">&nbsp;</p>');
      lastWasViewpoint = false;
      continue;
    }

    if (isViewpointLine(line)) {
      const viewpointLine = sectionNumber !== null ? applyViewpointLabel(line, sectionNumber) : line;
      const povInline = pov ? `<span class="pov">　${escapeHtml(pov, escapeOpts)}</span>` : '';
      if (pendingEpigraphs) {
        htmlParts.push(`<div class="epigraph-page">\n<p class="viewpoint">${escapeHtml(viewpointLine, escapeOpts)}${povInline}</p>\n${epigraphsToHtml(pendingEpigraphs, escapeOpts, chars)}\n</div>`);
        pendingEpigraphs = null;
        // エピグラフの直後には空行を1つ挟んでから本文を始める
        // （視点行と同じ扱いにすることで、原稿側に空行があっても二重にならない）
        lastWasViewpoint = true;
      } else {
        htmlParts.push(`<p class="viewpoint">${escapeHtml(viewpointLine, escapeOpts)}${povInline}</p>`);
        lastWasViewpoint = true;
      }
      continue;
    }

    if (lastWasViewpoint) {
      htmlParts.push('<p class="empty">&nbsp;</p>');
      lastWasViewpoint = false;
    }

    // 視点行がないファイルの場合、先頭の本文前にエピグラフを挿入し、空行を1つ挟む
    if (pendingEpigraphs) {
      htmlParts.push(`<div class="epigraph">\n${epigraphsToHtml(pendingEpigraphs, escapeOpts, chars)}\n</div>`);
      htmlParts.push('<p class="empty">&nbsp;</p>');
      pendingEpigraphs = null;
    }

    // ページ跨ぎ制御: 推定3行以下はbreak-inside:avoid、4行以上はorphans/widows緩和
    const charsPerLine = chars || 30;
    const estimatedLines = Math.ceil([...line].length / charsPerLine);
    if (estimatedLines <= 3) {
      const cls = line.startsWith('「') ? 'dialogue-short' : 'paragraph-short';
      htmlParts.push(`<p class="${cls}">${escapeHtml(line, escapeOpts)}</p>`);
    } else {
      const cls = line.startsWith('「') ? 'dialogue-long' : 'paragraph-long';
      htmlParts.push(`<p class="${cls}">${escapeHtml(line, escapeOpts)}</p>`);
    }
  }

  return { html: htmlParts.join('\n'), hasViewpointStart, hasViewpointEnd, hasEmptyViewpointStart, pov };
}

export function parseTextFileForEpub(filePath, { sectionNumber = null } = {}) {
  const lines = readLines(filePath);
  const xhtmlParts = [];
  const escapeOpts = { vertical: true, separateSymbolClasses: true };

  const { hasViewpointStart, hasViewpointEnd, hasEmptyViewpointStart, endViewpointLineIndex, firstContentLine, epigraphs, pov } = analyzeLines(lines);

  let chapterTitle = null;
  if (hasViewpointStart) {
    const firstLine = sectionNumber !== null ? applyViewpointLabel(firstContentLine, sectionNumber) : firstContentLine;
    const match = firstLine.match(/^【(.+?)】/);
    if (match && match[1]) {
      chapterTitle = match[1];
    }
  }

  // 先頭・末尾の空行をトリム（セクション結合時の余分なスペースを防ぐ）
  const processLines = trimBlankEdges(selectBodyLines(lines, endViewpointLineIndex));

  let pendingEpigraph = epigraphs.length > 0
    ? `<div class="epigraph">\n${epigraphsToHtml(epigraphs, escapeOpts)}\n</div>`
    : null;

  for (let i = 0; i < processLines.length; i++) {
    const line = processLines[i];

    if (line.trim() === '') {
      // 区切り記号や視点行に隣接する空行はスキップ（separator/viewpointのmarginで間隔を確保）
      const prevLine = i > 0 ? processLines[i - 1] : null;
      const nextLine = i < processLines.length - 1 ? processLines[i + 1] : null;
      const adjacentToSpecial =
        (prevLine !== null && (isSeparator(prevLine) || isViewpointLine(prevLine))) ||
        (nextLine !== null && (isSeparator(nextLine) || isViewpointLine(nextLine)));
      if (!adjacentToSpecial) {
        xhtmlParts.push('<p><br /></p>');
      }
      continue;
    }

    if (isSeparator(line)) {
      xhtmlParts.push(`<p class="separator">${escapeHtml(line, escapeOpts)}</p>`);
      continue;
    }

    if (isViewpointLine(line)) {
      const viewpointLine = sectionNumber !== null ? applyViewpointLabel(line, sectionNumber) : line;
      const povInline = pov ? `<span class="pov">　${escapeHtml(pov, escapeOpts)}</span>` : '';
      xhtmlParts.push(`<p class="viewpoint">${escapeHtml(viewpointLine, escapeOpts)}${povInline}</p>`);
      if (pendingEpigraph) {
        xhtmlParts.push(pendingEpigraph);
        pendingEpigraph = null;
      }
      continue;
    }

    // 視点行がないファイルの場合、先頭の本文前にエピグラフを挿入
    if (pendingEpigraph) {
      xhtmlParts.push(pendingEpigraph);
      pendingEpigraph = null;
    }

    xhtmlParts.push(`<p>${escapeHtml(line, escapeOpts)}</p>`);
  }

  return {
    xhtml: xhtmlParts.join('\n'),
    chapterTitle,
    hasViewpointStart,
    hasViewpointEnd,
    hasEmptyViewpointStart,
    pov,
  };
}

export function getBodyLinesFromContent(content, { keepEpigraphs = false, keepPov = false } = {}) {
  const lines = splitLines(content);
  const { hasViewpointStart, hasViewpointEnd, endViewpointLineIndex, pov } = analyzeLines(lines);
  return {
    lines: selectBodyLines(lines, endViewpointLineIndex, { keepEpigraphs, keepPov }),
    hasViewpointStart,
    hasViewpointEnd,
    pov,
  };
}

export function getFilteredLines(filePath, opts = {}) {
  return getBodyLinesFromContent(readFileSync(filePath, 'utf-8'), opts);
}

// parseTextFile の hasViewpointStart と同じ条件で、パースせずに事前判定する
export function fileHasViewpointStart(filePath) {
  for (const line of readLines(filePath)) {
    if (line.trim() === '' || isMetaLine(line)) continue;
    return isViewpointLine(line);
  }
  return false;
}

export function countChars(html) {
  const text = html
    .replace(/<div class="separator-block">.*?<\/div>/gs, '')
    .replace(/<p class="separator">.*?<\/p>/g, '')
    .replace(/<rt>.*?<\/rt>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, '')
    .replace(/&#160;/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    // \u6539\u884C\u30FB\u30BF\u30D6\u30FB&nbsp;\uFF08\u7A7A\u884C\u30D7\u30EC\u30FC\u30B9\u30DB\u30EB\u30C0\uFF09\u306E\u307F\u9664\u5916\u3002
    // \u5B57\u4E0B\u3052\u306E\u5168\u89D2\u30B9\u30DA\u30FC\u30B9\u7B49\u306F\u539F\u7A3F\u306E\u30DE\u30B9\u3068\u3057\u3066\u6570\u3048\u308B\uFF08\u898F\u5B9A\u30C1\u30A7\u30C3\u30AF\u3068\u540C\u3058\u57FA\u6E96\uFF09
    .replace(/[\r\n\t\u00A0]/g, '');
  return [...text].length;
}

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest;
  const { writeFileSync, unlinkSync } = await import('fs');
  const { join } = await import('path');
  const { tmpdir } = await import('os');

  describe('splitLines / countTextChars', () => {
    test('CRLF の CR を落とす', () => {
      expect(splitLines('a\r\nb\n')).toEqual(['a', 'b', '']);
    });
    test('空白・改行・全角スペースを除いてコードポイントで数える', () => {
      expect(countTextChars('あ い\n　う\t')).toBe(3);
      expect(countTextChars('𠮟る')).toBe(2);
    });
  });

  describe('tokenizeInlineMarkup', () => {
    test('記法のないテキストは1トークン', () => {
      expect(tokenizeInlineMarkup('本文')).toEqual([{ type: 'text', text: '本文' }]);
      expect(tokenizeInlineMarkup('')).toEqual([]);
    });
    test('ルビ・傍点・横倒し・イタリックを出現順に切り出す', () => {
      expect(tokenizeInlineMarkup('a|漢字《かんじ》b《《強》》c<<AB>>d*it*e')).toEqual([
        { type: 'text', text: 'a' },
        { type: 'ruby', base: '漢字', ruby: 'かんじ' },
        { type: 'text', text: 'b' },
        { type: 'emphasis', text: '強' },
        { type: 'text', text: 'c' },
        { type: 'sideways', text: 'AB' },
        { type: 'text', text: 'd' },
        { type: 'italic', text: 'it' },
        { type: 'text', text: 'e' },
      ]);
    });
  });

  describe('escapeXml', () => {
    test('& < > " をエスケープする', () => {
      expect(escapeXml('a<b>&"c"')).toBe('a&lt;b&gt;&amp;&quot;c&quot;');
    });
  });

  describe('epigraphDisplayLines', () => {
    test('幅指定なしは引用行と出典行に分ける', () => {
      expect(epigraphDisplayLines('引用文', '出典')).toEqual(['引用文', '——出典']);
      expect(epigraphDisplayLines('引用文', null)).toEqual(['引用文']);
    });
    test('一字下げを保って幅に収まるなら1行にまとめる', () => {
      expect(epigraphDisplayLines('引用文', '出典', 8)).toEqual(['引用文——出典']);
      expect(epigraphDisplayLines('引用文', '出典', 7)).toEqual(['引用文', '——出典']);
    });
  });

  describe('isSeparator', () => {
    test('\u25C7\u306E\u307F\u3067\u69CB\u6210\u3055\u308C\u308B\u884C\u306Ftrue', () => {
      expect(isSeparator('\u25C7')).toBe(true);
      expect(isSeparator('\u25C7\u25C7\u25C7')).toBe(true);
    });
    test('\u591A\u69D8\u306A\u533A\u5207\u308A\u8A18\u53F7\u3082true', () => {
      expect(isSeparator('\u25C6\u25C6')).toBe(true);
      expect(isSeparator('\u25A1')).toBe(true);
      expect(isSeparator('\u25A0\u25A0\u25A0')).toBe(true);
      expect(isSeparator('\u25CB\u25CF\u25CE')).toBe(true);
      expect(isSeparator('\u203B\u203B')).toBe(true);
      expect(isSeparator('\uFF0A')).toBe(true);
      expect(isSeparator('***')).toBe(true);
    });
    test('\u6587\u5B57\u304C\u6DF7\u3056\u308B\u3068false', () => {
      expect(isSeparator('\u25C7\u3042')).toBe(false);
      expect(isSeparator('\u3042\u25C7')).toBe(false);
      expect(isSeparator('')).toBe(false);
      expect(isSeparator('\u672C\u6587')).toBe(false);
    });
  });

  describe('isMemoLine / isEpigraphLine / isPovLine', () => {
    test('\u30D7\u30EC\u30D5\u30A3\u30C3\u30AF\u30B9\u4E00\u81F4\u3067true', () => {
      expect(isMemoLine('Memo: \u306A\u306B\u304B')).toBe(true);
      expect(isSourceLine('Source: src/x/plot/000.md')).toBe(true);
      expect(isTitleLine('Title: \u984C\u540D')).toBe(true);
      expect(isGenreLine('Genre: SF')).toBe(true);
      expect(isEpigraphLine('Epigraph: \u5F15\u7528')).toBe(true);
      expect(isPovLine('POV: \u4E3B\u4EBA\u516C')).toBe(true);
    });
    test('\u30D7\u30EC\u30D5\u30A3\u30C3\u30AF\u30B9\u304C\u306A\u3051\u308C\u3070false', () => {
      expect(isMemoLine('memo: \u5C0F\u6587\u5B57')).toBe(false);
      expect(isSourceLine('source: \u5C0F\u6587\u5B57')).toBe(false);
      expect(isEpigraphLine(' Epigraph: \u5148\u982D\u7A7A\u767D')).toBe(false);
      expect(isPovLine('\u672C\u6587')).toBe(false);
    });
  });

  describe('getBodyLinesFromContent', () => {
    test('Memo/Source/Title/Genre\u884C\u306F\u672C\u6587\u304B\u3089\u9664\u304F', () => {
      const { lines } = getBodyLinesFromContent('Memo: plot.md\nSource: plot/000.md\nTitle: T\nGenre: SF\n\n\u672C\u6587\u3002\n');
      expect(lines).toEqual(['', '\u672C\u6587\u3002', '']);
    });
  });

  describe('parsePovLine', () => {
    test('POV: \u306E\u5F8C\u306E\u540D\u524D\u3092\u8FD4\u3059', () => {
      expect(parsePovLine('POV: \u4E3B\u4EBA\u516C')).toBe('\u4E3B\u4EBA\u516C');
      expect(parsePovLine('POV:\u4E3B\u4EBA\u516C')).toBe('\u4E3B\u4EBA\u516C');
      expect(parsePovLine('POV:   \u592A\u90CE  ')).toBe('\u592A\u90CE');
    });
  });

  describe('parseEpigraphLine', () => {
    test('\u5F15\u7528\u672C\u6587\u3068\u5F15\u7528\u5143\u3092 \u2014\u2014\u3067\u5206\u5272', () => {
      expect(parseEpigraphLine('Epigraph: \u6211\u601D\u3046\u3001\u3086\u3048\u306B\u6211\u3042\u308A\u2014\u2014\u30C7\u30AB\u30EB\u30C8')).toEqual({
        quote: '\u6211\u601D\u3046\u3001\u3086\u3048\u306B\u6211\u3042\u308A',
        source: '\u30C7\u30AB\u30EB\u30C8',
      });
    });
    test('\u5F15\u7528\u5143\u304C\u306A\u3051\u308C\u3070source\u306Fnull', () => {
      expect(parseEpigraphLine('Epigraph: \u5F15\u7528\u306E\u307F')).toEqual({
        quote: '\u5F15\u7528\u306E\u307F',
        source: null,
      });
    });
    test('\u2014\u2014\u304C\u8907\u6570\u3042\u308C\u3070\u6700\u5F8C\u306E\u2014\u2014\u3067\u5206\u5272\u3059\u308B\uFF08\u5F15\u7528\u672C\u6587\u4E2D\u306E\u30C0\u30C3\u30B7\u30E5\u3092\u4FDD\u3064\uFF09', () => {
      expect(parseEpigraphLine('Epigraph: \u300C\u3060\u3068\u3057\u305F\u3089\u2014\u2014\u300D\u2014\u2014\u30C9\u30B9\u30C8\u30A8\u30D5\u30B9\u30AD\u30FC')).toEqual({
        quote: '\u300C\u3060\u3068\u3057\u305F\u3089\u2014\u2014\u300D',
        source: '\u30C9\u30B9\u30C8\u30A8\u30D5\u30B9\u30AD\u30FC',
      });
    });
    test('\u672B\u5C3E\u306E\u2014\u2014\u306F\u5F15\u7528\u672C\u6587\u306E\u4E00\u90E8\u3068\u3057\u3066\u6B8B\u3057source\u306Fnull', () => {
      expect(parseEpigraphLine('Epigraph: \u8A00\u3044\u304B\u3051\u3066\u2014\u2014')).toEqual({
        quote: '\u8A00\u3044\u304B\u3051\u3066\u2014\u2014',
        source: null,
      });
    });
  });

  describe('isViewpointLine', () => {
    test('\u3010name\u3011\u5F62\u5F0F\u306Ftrue', () => {
      expect(isViewpointLine('\u3010\u592A\u90CE\u3011')).toBe(true);
      expect(isViewpointLine('\u3010\u3011')).toBe(true);
      expect(isViewpointLine('\u3010\u592A\u90CE\u3011\u5F8C\u7D9A\u30C6\u30AD\u30B9\u30C8')).toBe(true);
    });
    test('\u3010\u3011\u304C\u5148\u982D\u3067\u306A\u3051\u308C\u3070false', () => {
      expect(isViewpointLine(' \u3010\u592A\u90CE\u3011')).toBe(false);
      expect(isViewpointLine('\u672C\u6587\u3010\u592A\u90CE\u3011')).toBe(false);
      expect(isViewpointLine('\u300C\u30BB\u30EA\u30D5\u300D')).toBe(false);
    });
  });

  describe('applyViewpointLabel', () => {
    test('\u7A7A\u306E\u3010\u3011\u306F\u30E9\u30D9\u30EB\u3060\u3051\u304C\u5165\u308B', () => {
      expect(applyViewpointLabel('\u3010\u3011', '1-2')).toBe('\u30101-2\u3011');
      expect(applyViewpointLabel('\u3010\u3011', 5)).toBe('\u30105\u3011');
    });
    test('\u3010title\u3011\u306F\u30E9\u30D9\u30EB\u3068title\u304C\u5168\u89D2space\u533A\u5207\u308A', () => {
      expect(applyViewpointLabel('\u3010\u592A\u90CE\u3011', '1-2')).toBe('\u30101-2\u3000\u592A\u90CE\u3011');
      expect(applyViewpointLabel('\u3010\u592A\u90CE\u3011 \u30BB\u30EA\u30D5', '3')).toBe('\u30103\u3000\u592A\u90CE\u3011 \u30BB\u30EA\u30D5');
    });
  });

  describe('stripInlineMarkup', () => {
    test('ルビは親文字のみ残す', () => {
      expect(stripInlineMarkup('|漢字《かんじ》')).toBe('漢字');
    });
    test('rubyParens指定でルビを括弧表記にする', () => {
      expect(stripInlineMarkup('|漢字《かんじ》', { rubyParens: true })).toBe('漢字（かんじ）');
    });
    test('傍点・横倒しは中身だけ残す', () => {
      expect(stripInlineMarkup('《《強調》》')).toBe('強調');
      expect(stripInlineMarkup('<<ABC>>')).toBe('ABC');
    });
    test('複数記法が混在しても全部解除', () => {
      expect(stripInlineMarkup('|漢字《かんじ》と《《強調》》と<<X>>')).toBe('漢字と強調とX');
    });
    test('特別な記法がなければそのまま返す', () => {
      expect(stripInlineMarkup('普通の本文')).toBe('普通の本文');
    });
  });

  describe('escapeHtml', () => {
    test('HTML\u7279\u6B8A\u6587\u5B57\u3092\u30A8\u30B9\u30B1\u30FC\u30D7\uFF08\u6A2A\u66F8\u304D\u30E2\u30FC\u30C9\uFF09', () => {
      expect(escapeHtml('<p>"a & b"</p>', { vertical: false })).toBe('&lt;p&gt;&quot;a　&amp;　b&quot;&lt;/p&gt;');
    });
    test('\u7E26\u66F8\u304D\u30E2\u30FC\u30C9\u3067\u306F\u6570\u5B57\u3092\u7E26\u4E2D\u6A2A/upright\u306B\u3001\u30CF\u30A4\u30D5\u30F3\u3092\u5168\u89D2\u5316', () => {
      expect(escapeHtml('5', { vertical: true })).toBe('<span class="tcy">5</span>');
      expect(escapeHtml('99', { vertical: true })).toBe('<span class="tcy">99</span>');
      expect(escapeHtml('100', { vertical: true })).toBe('<span class="upright">1</span><span class="upright">0</span><span class="upright">0</span>');
      expect(escapeHtml('1,234', { vertical: true })).toBe('<span class="upright">1</span><span class="upright">\uFF0C</span><span class="upright">2</span><span class="upright">3</span><span class="upright">4</span>');
      expect(escapeHtml('a-b', { vertical: true })).toBe('<span class="latin">a</span><span class="hyphen">\uFF0D</span><span class="latin">b</span>');
      expect(escapeHtml('ab', { vertical: true })).toBe('<span class="latin">a</span><span class="latin">b</span>');
    });
    test('単独の全角ハイフンは hyphen クラス、連続ダッシュ・全角イコールは dash クラス', () => {
      // 章番号「1-1」の区切り等。sideways だと左へずれるため tcy 方式で中央寄せする
      expect(escapeHtml('1-1', { vertical: true })).toBe('<span class="tcy">1</span><span class="hyphen">\uFF0D</span><span class="tcy">1</span>');
      // 連続ダッシュ（——）は縦長の線なので dash のまま
      expect(escapeHtml('\u2014\u2014', { vertical: true })).toBe('<span class="dash">\u2014\u2014</span>');
      // ハイフン2つ並びも dash（単独ではない）
      expect(escapeHtml('1--2', { vertical: true })).toBe('<span class="tcy">1</span><span class="dash">\uFF0D\uFF0D</span><span class="tcy">2</span>');
      // EPUB（separateSymbolClasses=true）では従来どおり dash のまま
      expect(escapeHtml('1-1', { vertical: true, separateSymbolClasses: true })).toBe('<span class="tcy">1</span><span class="dash">\uFF0D</span><span class="tcy">1</span>');
    });
    test('\u7E26\u66F8\u304D\u3067\u30A2\u30AF\u30BB\u30F3\u30C8\u4ED8\u304D\u30E9\u30C6\u30F3\u6587\u5B57\u3082 latin \u30AF\u30E9\u30B9\u3067\u7ACB\u3066\u308B', () => {
      // 1\u6587\u5B57\u305A\u3064\u72EC\u7ACB\u3057\u305F span \u306B\u5206\u3051\u3066\u3001\u5404\u6587\u5B57\u3092 text-combine-upright \u3067\u6B63\u65B9\u30BB\u30EB\u306B\u53CE\u3081\u308B
      expect(escapeHtml('ab', { vertical: true })).toBe('<span class="latin">a</span><span class="latin">b</span>');
      expect(escapeHtml('C\u00F4te', { vertical: true })).toBe('<span class="latin">C</span><span class="latin">\u00F4</span><span class="latin">t</span><span class="latin">e</span>');
      expect(escapeHtml('\u00DCber', { vertical: true })).toBe('<span class="latin">\u00DC</span><span class="latin">b</span><span class="latin">e</span><span class="latin">r</span>');
      expect(escapeHtml('\u0110\u00E0', { vertical: true })).toBe('<span class="latin">\u0110</span><span class="latin">\u00E0</span>');
    });
    test('\u7E26\u66F8\u304D\u3067 !? \u3092\u5168\u89D2\u306B\u3001!? \u306E\u9023\u7D9A\u306F\u7E26\u4E2D\u6A2A\u306B\u307E\u3068\u3081\u308B', () => {
      expect(escapeHtml('\u3042!', { vertical: true })).toBe('\u3042\uFF01');
      expect(escapeHtml('\u3042?', { vertical: true })).toBe('\u3042\uFF1F');
      expect(escapeHtml('!?', { vertical: true })).toBe('<span class="tcy">!?</span>');
      expect(escapeHtml('\uFF01\uFF01', { vertical: true })).toBe('<span class="tcy">!!</span>');
    });
    test('\u30EB\u30D3 |\u89AA\u300A\u3075\u308A\u300B \u3092 <ruby> \u306B\u5909\u63DB', () => {
      expect(escapeHtml('|\u6F22\u5B57\u300A\u304B\u3093\u3058\u300B', { vertical: false })).toBe('<ruby>\u6F22\u5B57<rt>\u304B\u3093\u3058</rt></ruby>');
    });
    test('\u508D\u70B9 \u300A\u300Atext\u300B\u300B \u3092 span.emphasis \u306B\u5909\u63DB', () => {
      expect(escapeHtml('\u300A\u300A\u5F37\u8ABF\u300B\u300B', { vertical: false })).toBe('<span class="emphasis">\u5F37\u8ABF</span>');
    });
    test('\u6A2A\u5012\u3057 <<text>> \u3092 span.sideways-latin \u306B\u5909\u63DB', () => {
      expect(escapeHtml('<<ABC>>', { vertical: false })).toBe('<span class="sideways-latin">ABC</span>');
    });
    test('separateSymbolClasses=true \u3067\u30C0\u30C3\u30B7\u30E5/\u4E09\u70B9/\u6CE2\u30C0\u30C3\u30B7\u30E5\u304C\u5225\u30AF\u30E9\u30B9\u306B', () => {
      expect(escapeHtml('\u2014', { vertical: true, separateSymbolClasses: true })).toBe('<span class="dash">\u2014</span>');
      expect(escapeHtml('\u2026', { vertical: true, separateSymbolClasses: true })).toBe('<span class="ellipsis">\u2026</span>');
      expect(escapeHtml('\uFF5E', { vertical: true, separateSymbolClasses: true })).toBe('<span class="wave-dash">\uFF5E</span>');
    });
    test('\u65E2\u5B9A (separateSymbolClasses=false) \u3067\u306F\u5168\u90E8 dash \u30AF\u30E9\u30B9', () => {
      expect(escapeHtml('\u2026', { vertical: true })).toBe('<span class="dash">\u2026</span>');
      expect(escapeHtml('\uFF5E', { vertical: true })).toBe('<span class="dash">\uFF5E</span>');
    });
    test('\u534A\u89D2\u30B9\u30DA\u30FC\u30B9\u306F\u5168\u89D2\u30B9\u30DA\u30FC\u30B9(U+3000)\u306B\u5909\u63DB\u3055\u308C\u3001\u4E00\u6587\u5B57\u5206\u306E\u5E45\u3092\u4FDD\u3064', () => {
      expect(escapeHtml('\u3042 \u3044', { vertical: true })).toBe('\u3042\u3000\u3044');
      expect(escapeHtml('\u3042 \u3044', { vertical: false })).toBe('\u3042\u3000\u3044');
      // \u9023\u7D9A\u3059\u308B\u534A\u89D2\u30B9\u30DA\u30FC\u30B9\u3082\u305D\u308C\u305E\u308C\u4E00\u6587\u5B57\u5206\u306B\uFF08\u30B3\u30E9\u30D7\u30B9\u3057\u306A\u3044\uFF09
      expect(escapeHtml('\u3042  \u3044', { vertical: true })).toBe('\u3042\u3000\u3000\u3044');
      // \u65E2\u5B58\u306E\u5168\u89D2\u30B9\u30DA\u30FC\u30B9\u306F\u305D\u306E\u307E\u307E
      expect(escapeHtml('\u3042\u3000\u3044', { vertical: true })).toBe('\u3042\u3000\u3044');
    });
    test('\u30E9\u30C6\u30F3\u8A9E\u9593\u306E\u534A\u89D2\u30B9\u30DA\u30FC\u30B9\u3082\u5168\u89D2\u5316\u3055\u308C\u5358\u8A9E\u9023\u7D50\u306F\u7DAD\u6301\u3055\u308C\u308B', () => {
      expect(escapeHtml('ab cd', { vertical: true })).toBe('<span class="latin">a</span><span class="latin">b</span>\u3000<span class="latin">c</span><span class="latin">d</span>');
    });
  });

  describe('parseTextFile epigraph', () => {
    test('視点行＋エピグラフの直後には空行を1つ挟む', () => {
      const tmp = join(tmpdir(), `epi-vp-${Date.now()}.txt`);
      writeFileSync(tmp, 'Epigraph: 引用——出典\n【】\n本文1行目\n');
      try {
        const { html } = parseTextFile(tmp, { vertical: false });
        expect(html).toContain('epigraph-page');
        // エピグラフページdivと本文の間に空行<p class="empty">を1つだけ挟む
        expect(html).toMatch(/<\/div>\n<p class="empty">&nbsp;<\/p>\n<p[^>]*>本文1行目<\/p>/);
      } finally {
        unlinkSync(tmp);
      }
    });

    test('視点行＋エピグラフの後に原稿側の空行があっても空行は二重にならない', () => {
      const tmp = join(tmpdir(), `epi-vp-blank-${Date.now()}.txt`);
      writeFileSync(tmp, 'Epigraph: 引用——出典\n【】\n\n本文1行目\n');
      try {
        const { html } = parseTextFile(tmp, { vertical: false });
        expect(html).toMatch(/<\/div>\n<p class="empty">&nbsp;<\/p>\n<p[^>]*>本文1行目<\/p>/);
      } finally {
        unlinkSync(tmp);
      }
    });

    test('本文＋引用元が1行に収まるエピグラフは1行にまとめる', () => {
      const tmp = join(tmpdir(), `epi-oneline-${Date.now()}.txt`);
      writeFileSync(tmp, 'Epigraph: 引用文——出典\n【】\n本文1行目\n');
      try {
        const { html } = parseTextFile(tmp, { vertical: false, chars: 30 });
        expect(html).toContain('<p class="epigraph-line">引用文——出典</p>');
        expect(html).not.toContain('epigraph-quote');
      } finally {
        unlinkSync(tmp);
      }
    });

    test('1行に収まらないエピグラフは従来どおり2行に分ける', () => {
      const tmp = join(tmpdir(), `epi-twoline-${Date.now()}.txt`);
      writeFileSync(tmp, 'Epigraph: 引用文——出典\n【】\n本文1行目\n');
      try {
        const { html } = parseTextFile(tmp, { vertical: false, chars: 7 });
        expect(html).toContain('epigraph-quote');
        expect(html).toContain('epigraph-source');
        expect(html).not.toContain('epigraph-line');
      } finally {
        unlinkSync(tmp);
      }
    });

    test('視点行なしでもエピグラフの直後には空行を1つ挟む', () => {
      const tmp = join(tmpdir(), `epi-novp-${Date.now()}.txt`);
      writeFileSync(tmp, 'Epigraph: 引用——出典\n本文1行目\n');
      try {
        const { html } = parseTextFile(tmp, { vertical: false });
        expect(html).toMatch(/<div class="epigraph">[\s\S]*?<\/div>\n<p class="empty">&nbsp;<\/p>\n<p[^>]*>本文1行目<\/p>/);
      } finally {
        unlinkSync(tmp);
      }
    });
  });

  describe('countChars', () => {
    test('HTML\u30BF\u30B0\u3092\u9664\u53BB\u3057\u3066\u6587\u5B57\u6570\u3092\u6570\u3048\u308B', () => {
      expect(countChars('<p>\u672C\u6587</p>')).toBe(2);
    });
    test('\u30EB\u30D3\u306E rt \u306F\u9664\u5916', () => {
      expect(countChars('<p><ruby>\u6F22\u5B57<rt>\u304B\u3093\u3058</rt></ruby></p>')).toBe(2);
    });
    test('separator-block \u3068 p.separator \u306F\u9664\u5916', () => {
      expect(countChars('<p>\u672C\u6587</p>\n<p class="separator">\u25C7\u25C7\u25C7</p>')).toBe(2);
      expect(countChars('<p>\u672C\u6587</p>\n<div class="separator-block"><p class="separator">\u25C7</p></div>')).toBe(2);
    });
    test('&nbsp; \u3084 &amp; \u306A\u3069\u306E\u30A8\u30F3\u30C6\u30A3\u30C6\u30A3\u306F\u4E2D\u8EAB\u306B\u5C55\u958B\u305B\u305A\u7A7A\u767D\u6271\u3044', () => {
      expect(countChars('<p>&nbsp;</p>')).toBe(0);
      expect(countChars('<p>a&amp;b</p>')).toBe(3);
    });
    test('\u7A7A\u767D\u30FB\u5168\u89D2\u7A7A\u767D\u306F\u30DE\u30B9\u3068\u3057\u3066\u6570\u3048\u308B\uFF08\u6539\u884C\u30FB\u30BF\u30D6\u306F\u9664\u5916\uFF09', () => {
      expect(countChars('<p>\u3042 \u3044\u3000\u3046</p>')).toBe(5);
      expect(countChars('<p>\u3042</p>\n<p>\u3044</p>')).toBe(2);
    });
  });
}
