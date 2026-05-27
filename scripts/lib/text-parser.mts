/**
 * テキスト解析の共通ユーティリティ
 * txt-to-pdf.mts, txt-to-novel-pdf.mts, txt-to-epub.mts で共有
 */

import { readFileSync, readdirSync, writeFileSync, unlinkSync } from 'fs';
import { basename, join } from 'path';
import { tmpdir } from 'os';

// 区切り行かどうかを判定
export function isSeparator(line) {
  return /^[◇◆□■○●◎※＊*]+$/.test(line);
}


// Memo行かどうかを判定
export function isMemoLine(line) {
  return line.startsWith('Memo:');
}

// エピグラフ行かどうかを判定
export function isEpigraphLine(line) {
  return line.startsWith('Epigraph:');
}

// POV行かどうかを判定
export function isPovLine(line) {
  return line.startsWith('POV:');
}

// POV行から視点キャラクター名を抽出
export function parsePovLine(line) {
  return line.replace(/^POV:\s*/, '').trim();
}

// エピグラフ行からテキストを抽出（引用本文と引用元に分割）
export function parseEpigraphLine(line) {
  const text = line.replace(/^Epigraph:\s*/, '');
  const parts = text.split('——');
  const quote = parts[0].trim();
  const source = parts.length > 1 ? parts.slice(1).join('——').trim() : null;
  return { quote, source: source || null };
}

// 視点行かどうかを判定（【〇〇】形式、空の【】も含む）
export function isViewpointLine(line) {
  return /^【.*】/.test(line);
}

/**
 * 視点行に採番ラベルを適用する
 *   - 空の【】     → 【label】
 *   - 【title】    → 【label　title】（titleは全角space区切りで保持）
 * @param {string} line - 視点行
 * @param {string|number} label - 採番ラベル（例: "1-2" や 5）
 */
export function applyViewpointLabel(line, label) {
  const match = line.match(/^【(.*)】/);
  const title = match ? match[1].trim() : '';
  return title
    ? line.replace(/^【.*】/, `【${label}　${title}】`)
    : line.replace(/^【】/, `【${label}】`);
}


/**
 * HTMLエスケープ + ダッシュ処理 + ルビ・傍点処理
 * @param {string} text - エスケープ対象テキスト
 * @param {object} options
 * @param {boolean} options.vertical - 縦書きモード（デフォルト: true）
 * @param {boolean} options.separateSymbolClasses - ダッシュ/三点リーダ/波ダッシュを別クラスにする（EPUB用、デフォルト: false）
 */
export function escapeHtml(text, { vertical = true, separateSymbolClasses = false } = {}) {
  const rubyPlaceholders = [];
  const emphasisPlaceholders = [];

  // プレースホルダーにはUnicode Private Use Area文字を使用
  // （ASCII文字・数字を含まないため、後続の縦中横・ラテン文字処理で破壊されない）
  const phRuby = (i) => `\uE000${String.fromCharCode(0xE010 + i)}\uE000`;
  const phEmphasis = (i) => `\uE001${String.fromCharCode(0xE010 + i)}\uE001`;
  const sidewaysPlaceholders = [];
  const phSideways = (i) => `\uE003${String.fromCharCode(0xE010 + i)}\uE003`;

  // HTMLエスケープ＋縦書き変換の共通処理
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
      // ！？の連続を縦中横に（！？、？！、！！、？？）
      r = r.replace(/[！？]{2}/g, (match) => {
        const hw = match.replace(/！/g, '!').replace(/？/g, '?');
        return phSpan(`<span class="tcy">${hw}</span>`);
      });
      // ラテン文字・縦中横を先にプレースホルダーへ（まだHTMLタグを含まない段階）
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

  // 横倒し: <<テキスト>>
  let result = text.replace(/<<(.+?)>>/g, (_, content) => {
    const idx = sidewaysPlaceholders.length;
    sidewaysPlaceholders.push(content);
    return phSideways(idx);
  });

  // 傍点: 《《テキスト》》
  result = result.replace(/《《(.+?)》》/g, (_, content) => {
    const idx = emphasisPlaceholders.length;
    emphasisPlaceholders.push(content);
    return phEmphasis(idx);
  });

  // ルビ: |漢字《ルビ》
  result = result.replace(/\|(.+?)《(.+?)》/g, (_, base, ruby) => {
    const idx = rubyPlaceholders.length;
    rubyPlaceholders.push({ base, ruby });
    return phRuby(idx);
  });

  // 本文のHTMLエスケープ＋縦書き変換
  result = processInnerText(result);

  // プレースホルダーをHTMLに戻す（中身も同じ変換を適用）
  result = result.replace(/\uE000([\uE010-\uEFFF])\uE000/g, (_, ch) => {
    const { base, ruby } = rubyPlaceholders[ch.charCodeAt(0) - 0xE010];
    return `<ruby>${processInnerText(base)}<rt>${processInnerText(ruby)}</rt></ruby>`;
  });

  result = result.replace(/\uE001([\uE010-\uEFFF])\uE001/g, (_, ch) => {
    const content = emphasisPlaceholders[ch.charCodeAt(0) - 0xE010];
    return `<span class="emphasis">${processInnerText(content)}</span>`;
  });

  // 横倒しプレースホルダーをHTMLに展開（中身のルビ記法も処理）
  result = result.replace(/\uE003([\uE010-\uEFFF])\uE003/g, (_, ch) => {
    let content = sidewaysPlaceholders[ch.charCodeAt(0) - 0xE010];
    // 先にHTMLエスケープ（《》| はHTMLエンティティではないので残る）
    content = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    // エスケープ後にルビ記法を処理
    content = content.replace(/\|(.+?)《(.+?)》/g, (_, base, ruby) => `<ruby>${base}<rt>${ruby}</rt></ruby>`);
    return `<span class="sideways-latin">${content}</span>`;
  });

  // spanプレースホルダーをHTMLに展開（tcy, latin）
  result = result.replace(/\uE002([\uE010-\uEFFF])\uE002/g, (_, ch) => {
    return spanPlaceholders[ch.charCodeAt(0) - 0xE010];
  });

  return result;
}

/**
 * txtファイルを読み込んでHTML断片と視点情報を返す（PDF用）
 * @param {string} filePath - テキストファイルのパス
 * @param {object} options
 * @param {boolean} options.vertical - 縦書きモード（デフォルト: true）
 * @param {boolean} options.separateSymbolClasses - EPUB用シンボルクラス分離
 * @param {number|null} options.sectionNumber - 空の【】に振るセクション番号（内部用）
 */
export function parseTextFile(filePath, { vertical = true, separateSymbolClasses = false, sectionNumber = null, chars = null } = {}) {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const htmlParts = [];

  const contentLines = lines.filter(l => l.trim() !== '' && !isMemoLine(l) && !isEpigraphLine(l) && !isPovLine(l));
  const hasViewpointStart = contentLines.length > 0 && isViewpointLine(contentLines[0]);
  const hasViewpointEnd = contentLines.length > 0 && isViewpointLine(contentLines[contentLines.length - 1]);

  // 末尾の視点行（章区切りアンカー）の元のlines配列でのインデックスを特定
  let endViewpointLineIndex = -1;
  if (hasViewpointEnd) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim() !== '' && !isMemoLine(lines[i]) && !isEpigraphLine(lines[i]) && !isPovLine(lines[i])) {
        endViewpointLineIndex = i;
        break;
      }
    }
  }

  // エピグラフ行を収集
  const epigraphs = lines.filter(l => isEpigraphLine(l)).map(l => parseEpigraphLine(l));

  // POV行を収集（最初のもののみ採用）
  const povLine = lines.find(l => isPovLine(l));
  const pov = povLine ? parsePovLine(povLine) : null;

  let lastWasViewpoint = false;

  const processLines = [];
  for (let i = 0; i < lines.length; i++) {
    if (isMemoLine(lines[i])) continue;
    if (isEpigraphLine(lines[i])) continue;
    if (isPovLine(lines[i])) continue;
    if (i === endViewpointLineIndex) continue;
    processLines.push(lines[i]);
  }

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
        const epigraphLines = [];
        for (const { quote, source } of pendingEpigraphs) {
          epigraphLines.push(`<p class="epigraph-quote">${escapeHtml(quote, escapeOpts)}</p>`);
          if (source) epigraphLines.push(`<p class="epigraph-source">${escapeHtml(`——${source}`, escapeOpts)}</p>`);
        }
        htmlParts.push(`<div class="epigraph-page">\n<p class="viewpoint">${escapeHtml(viewpointLine, escapeOpts)}${povInline}</p>\n${epigraphLines.join('\n')}\n</div>`);
        pendingEpigraphs = null;
        // エピグラフページの直後には空行を入れず、本文をページ先頭から始める
        lastWasViewpoint = false;
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

    // 視点行がないファイルの場合、先頭の本文前にエピグラフを挿入
    if (pendingEpigraphs) {
      const epigraphLines = [];
      for (const { quote, source } of pendingEpigraphs) {
        epigraphLines.push(`<p class="epigraph-quote">${escapeHtml(quote, escapeOpts)}</p>`);
        if (source) epigraphLines.push(`<p class="epigraph-source">${escapeHtml(`——${source}`, escapeOpts)}</p>`);
      }
      htmlParts.push(`<div class="epigraph">\n${epigraphLines.join('\n')}\n</div>`);
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

  // 空の【】で始まるかどうか（セクション番号の採番に使用）
  const hasEmptyViewpointStart = hasViewpointStart && /^【】/.test(contentLines[0]);

  return { html: htmlParts.join('\n'), hasViewpointStart, hasViewpointEnd, hasEmptyViewpointStart, pov };
}

/**
 * EPUB用テキスト解析（空行スキップ、チャプタータイトル抽出）
 * @param {string} filePath
 * @param {object} options
 * @param {number|null} options.sectionNumber - 空の【】に振るセクション番号（内部用）
 */
export function parseTextFileForEpub(filePath, { sectionNumber = null } = {}) {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const xhtmlParts = [];
  const escapeOpts = { vertical: true, separateSymbolClasses: true };

  const contentLines = lines.filter(l => l.trim() !== '' && !isMemoLine(l) && !isEpigraphLine(l) && !isPovLine(l));
  const hasViewpointStart = contentLines.length > 0 && isViewpointLine(contentLines[0]);
  const hasViewpointEnd = contentLines.length > 0 && isViewpointLine(contentLines[contentLines.length - 1]);

  // 末尾の視点行（章区切りアンカー）の元のlines配列でのインデックスを特定
  let endViewpointLineIndex = -1;
  if (hasViewpointEnd) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim() !== '' && !isMemoLine(lines[i]) && !isEpigraphLine(lines[i]) && !isPovLine(lines[i])) {
        endViewpointLineIndex = i;
        break;
      }
    }
  }

  // エピグラフ行を収集
  const epigraphs = lines.filter(l => isEpigraphLine(l)).map(l => parseEpigraphLine(l));

  // POV行を収集（最初のもののみ採用）
  const povLine = lines.find(l => isPovLine(l));
  const pov = povLine ? parsePovLine(povLine) : null;

  let chapterTitle = null;
  if (hasViewpointStart) {
    let firstLine = contentLines[0];
    if (sectionNumber !== null) {
      firstLine = applyViewpointLabel(firstLine, sectionNumber);
    }
    const match = firstLine.match(/^【(.+?)】/);
    if (match && match[1]) {
      chapterTitle = match[1];
    }
  }

  let processLines = [];
  for (let i = 0; i < lines.length; i++) {
    if (isMemoLine(lines[i])) continue;
    if (isEpigraphLine(lines[i])) continue;
    if (isPovLine(lines[i])) continue;
    if (i === endViewpointLineIndex) continue;
    processLines.push(lines[i]);
  }

  // 先頭・末尾の空行をトリム（セクション結合時の余分なスペースを防ぐ）
  while (processLines.length > 0 && processLines[0].trim() === '') processLines.shift();
  while (processLines.length > 0 && processLines[processLines.length - 1].trim() === '') processLines.pop();

  // エピグラフHTML（視点行の直後に挿入）
  let pendingEpigraph = null;
  if (epigraphs.length > 0) {
    const epigraphHtml = epigraphs.map(({ quote, source }) => {
      const parts = [`<p class="epigraph-quote">${escapeHtml(quote, escapeOpts)}</p>`];
      if (source) parts.push(`<p class="epigraph-source">${escapeHtml(`——${source}`, escapeOpts)}</p>`);
      return parts.join('\n');
    }).join('\n');
    pendingEpigraph = `<div class="epigraph">\n${epigraphHtml}\n</div>`;
  }

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

  // 空の【】で始まるかどうか（セクション番号の採番に使用）
  const hasEmptyViewpointStart = hasViewpointStart && /^【】/.test(contentLines[0]);

  return {
    xhtml: xhtmlParts.join('\n'),
    chapterTitle,
    hasViewpointStart,
    hasViewpointEnd,
    hasEmptyViewpointStart,
    pov,
  };
}

/**
 * ファイルからフィルタ済みの行を取得（Memo行・Epigraph行・末尾視点行を除去）
 * split-chapters.mts など、HTML変換せずに生テキスト行が必要な場合に使用
 * @param {string} filePath - テキストファイルのパス
 * @param {object} options
 * @param {boolean} options.keepEpigraphs - Epigraph行を残す（デフォルト: false）
 * @param {boolean} options.keepPov - POV行を残す（デフォルト: false）
 * @returns {{ lines: string[], hasViewpointStart: boolean, hasViewpointEnd: boolean }}
 */
export function getFilteredLines(filePath, { keepEpigraphs = false, keepPov = false } = {}) {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  const contentLines = lines.filter(l => l.trim() !== '' && !isMemoLine(l) && !isEpigraphLine(l) && !isPovLine(l));
  const hasViewpointStart = contentLines.length > 0 && isViewpointLine(contentLines[0]);
  const hasViewpointEnd = contentLines.length > 0 && isViewpointLine(contentLines[contentLines.length - 1]);

  let endViewpointLineIndex = -1;
  if (hasViewpointEnd) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim() !== '' && !isMemoLine(lines[i]) && !isEpigraphLine(lines[i]) && !isPovLine(lines[i])) {
        endViewpointLineIndex = i;
        break;
      }
    }
  }

  const povLine = lines.find(l => isPovLine(l));
  const pov = povLine ? parsePovLine(povLine) : null;

  const filteredLines = [];
  for (let i = 0; i < lines.length; i++) {
    if (isMemoLine(lines[i])) continue;
    if (!keepEpigraphs && isEpigraphLine(lines[i])) continue;
    if (!keepPov && isPovLine(lines[i])) continue;
    if (i === endViewpointLineIndex) continue;
    filteredLines.push(lines[i]);
  }

  return { lines: filteredLines, hasViewpointStart, hasViewpointEnd, pov };
}

/**
 * 複数ファイルをセクション番号付きで一括解析
 * 空の【】に連番を自動採番する（「章-セクション」形式）
 * @param {string[]} filePaths - テキストファイルパスの配列
 * @param {function} parseFn - parseTextFile または parseTextFileForEpub
 * @param {object} options - parseFn に渡すオプション（sectionNumber は自動設定）
 */
export function parseWithSectionNumbering(filePaths, parseFn, options = {}) {
  const { partFirstIndices = null, ...restOptions } = options;
  const resetSet = partFirstIndices ? new Set(partFirstIndices) : null;
  let partNumber = 1;
  let sectionNumber = 1;
  return filePaths.map((filePath, idx) => {
    if (resetSet && idx > 0 && resetSet.has(idx)) {
      partNumber++;
      sectionNumber = 1;
    }
    const sectionLabel = resetSet ? `${partNumber}-${sectionNumber}` : String(sectionNumber);
    const result = parseFn(filePath, { ...restOptions, sectionNumber: sectionLabel });
    if (result.hasViewpointStart) sectionNumber++;
    return result;
  });
}

/**
 * ディレクトリ内のtxtファイルを番号順で取得
 * @param {string} dirPath - ディレクトリパス
 * @param {string[]} excludeFiles - 除外するファイル名のリスト
 */
export function getTextFilesFromDir(dirPath, excludeFiles = ['synopsis.txt']) {
  return readdirSync(dirPath)
    .filter(f => f.endsWith('.txt') && !excludeFiles.includes(f))
    .sort((a, b) => {
      const numA = parseInt(a.match(/\d+/)?.[0] || '0', 10);
      const numB = parseInt(b.match(/\d+/)?.[0] || '0', 10);
      return numA - numB;
    })
    .map(f => join(dirPath, f));
}

/**
 * 本文の文字数カウント（HTML断片から）
 */
// セクションごとの処理ログを出力し、合計文字数を返す
export function logSections(sections, inputFiles) {
  let totalChars = 0;
  let sectionChars = 0;
  for (let i = 0; i < inputFiles.length; i++) {
    const content = sections[i].html || sections[i].xhtml;
    const chars = countChars(content);
    totalChars += chars;
    sectionChars += chars;
    const startMarker = sections[i].hasViewpointStart ? '\u{1F4D6}' : '  ';
    const endMarker = sections[i].hasViewpointEnd ? '\u{1F4D5}' : '  ';
    const sectionTotal = sections[i].hasViewpointEnd ? `  計${sectionChars.toLocaleString()}字` : '';
    console.log(`${startMarker}${endMarker} 処理中: ${basename(inputFiles[i])} (${chars.toLocaleString()}字)${sectionTotal}`);
    if (sections[i].hasViewpointEnd) sectionChars = 0;
  }
  return totalChars;
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
    .replace(/[\s\u00A0]/g, '');
  return [...text].length;
}

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest;

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
      expect(isEpigraphLine('Epigraph: \u5F15\u7528')).toBe(true);
      expect(isPovLine('POV: \u4E3B\u4EBA\u516C')).toBe(true);
    });
    test('\u30D7\u30EC\u30D5\u30A3\u30C3\u30AF\u30B9\u304C\u306A\u3051\u308C\u3070false', () => {
      expect(isMemoLine('memo: \u5C0F\u6587\u5B57')).toBe(false);
      expect(isEpigraphLine(' Epigraph: \u5148\u982D\u7A7A\u767D')).toBe(false);
      expect(isPovLine('\u672C\u6587')).toBe(false);
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
    test('\u2014\u2014\u304C\u8907\u6570\u3042\u308C\u3070\u6700\u521D\u306E\u2014\u2014\u3067\u5206\u5272\u3057\u6B8B\u308A\u3092\u7D50\u5408', () => {
      expect(parseEpigraphLine('Epigraph: \u5F15\u7528\u2014\u2014\u51FA\u51781\u2014\u2014\u51FA\u51782')).toEqual({
        quote: '\u5F15\u7528',
        source: '\u51FA\u51781\u2014\u2014\u51FA\u51782',
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
    test('視点行＋エピグラフの直後には空行を入れない', () => {
      const tmp = join(tmpdir(), `epi-vp-${Date.now()}.txt`);
      writeFileSync(tmp, 'Epigraph: 引用——出典\n【】\n本文1行目\n');
      try {
        const { html } = parseTextFile(tmp, { vertical: false });
        expect(html).toContain('epigraph-page');
        // エピグラフページdivの直後に本文が来る（空行<p class="empty">を挟まない）
        expect(html).toMatch(/<\/div>\n<p[^>]*>本文1行目<\/p>/);
        expect(html).not.toMatch(/<\/div>\n<p class="empty">/);
      } finally {
        unlinkSync(tmp);
      }
    });

    test('視点行なしでもエピグラフの直後には空行を入れない', () => {
      const tmp = join(tmpdir(), `epi-novp-${Date.now()}.txt`);
      writeFileSync(tmp, 'Epigraph: 引用——出典\n本文1行目\n');
      try {
        const { html } = parseTextFile(tmp, { vertical: false });
        expect(html).toMatch(/<div class="epigraph">[\s\S]*?<\/div>\n<p[^>]*>本文1行目<\/p>/);
        expect(html).not.toMatch(/<\/div>\n<p class="empty">/);
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
    test('\u7A7A\u767D\u30FB\u5168\u89D2\u7A7A\u767D\u306F\u9664\u5916', () => {
      expect(countChars('<p>\u3042 \u3044\u3000\u3046</p>')).toBe(3);
    });
  });
}
