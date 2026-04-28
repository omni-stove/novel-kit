/**
 * テキスト解析の共通ユーティリティ
 * txt-to-pdf.mjs, txt-to-novel-pdf.mjs, txt-to-epub.mjs で共有
 */

import { readFileSync, readdirSync } from 'fs';
import { basename, join } from 'path';

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
    if (vertical) {
      r = r.replace(/-/g, '\uFF0D');
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
        return phSpan(`<span class="upright">${converted}</span>`);
      });
      r = r.replace(/[a-zA-Z]+(?:\s[a-zA-Z]+)*/g, (match) => phSpan(`<span class="latin">${match}</span>`));
      r = r.replace(/[\u0370-\u03FF]+/g, (match) => phSpan(`<span class="upright">${match}</span>`));
      // ダッシュ等のspanタグを生成（この時点でラテン文字はもうプレースホルダーなので安全）
      if (separateSymbolClasses) {
        r = r.replace(/([—―\uFF0D]+)/g, '<span class="dash">$1</span>');
        r = r.replace(/([…‥]+)/g, '<span class="ellipsis">$1</span>');
        r = r.replace(/([～〜]+)/g, '<span class="wave-dash">$1</span>');
      } else {
        r = r.replace(/([—―\uFF0D]+)/g, '<span class="dash">$1</span>');
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
      let viewpointLine = line;
      if (sectionNumber !== null && /^【】/.test(line)) {
        viewpointLine = line.replace(/^【】/, `【${sectionNumber}】`);
      }
      const povHtml = pov ? `\n<p class="pov">POV：${escapeHtml(pov, escapeOpts)}</p>` : '';
      if (pendingEpigraphs) {
        const epigraphLines = [];
        for (const { quote, source } of pendingEpigraphs) {
          epigraphLines.push(`<p class="epigraph-quote">${escapeHtml(quote, escapeOpts)}</p>`);
          if (source) epigraphLines.push(`<p class="epigraph-source">${escapeHtml(`——${source}`, escapeOpts)}</p>`);
        }
        htmlParts.push(`<div class="epigraph-page">\n<p class="viewpoint">${escapeHtml(viewpointLine, escapeOpts)}</p>${povHtml}\n${epigraphLines.join('\n')}\n</div>`);
        pendingEpigraphs = null;
      } else {
        htmlParts.push(`<p class="viewpoint">${escapeHtml(viewpointLine, escapeOpts)}</p>${povHtml}`);
      }
      lastWasViewpoint = true;
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
    if (sectionNumber !== null && /^【】/.test(firstLine)) {
      firstLine = firstLine.replace(/^【】/, `【${sectionNumber}】`);
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
      let viewpointLine = line;
      if (sectionNumber !== null && /^【】/.test(line)) {
        viewpointLine = line.replace(/^【】/, `【${sectionNumber}】`);
      }
      xhtmlParts.push(`<p class="viewpoint">${escapeHtml(viewpointLine, escapeOpts)}</p>`);
      if (pov) {
        xhtmlParts.push(`<p class="pov">POV：${escapeHtml(pov, escapeOpts)}</p>`);
      }
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
 * split-chapters.mjs など、HTML変換せずに生テキスト行が必要な場合に使用
 * @param {string} filePath - テキストファイルのパス
 * @param {object} options
 * @param {boolean} options.keepEpigraphs - Epigraph行を残す（デフォルト: false）
 * @returns {{ lines: string[], hasViewpointStart: boolean, hasViewpointEnd: boolean }}
 */
export function getFilteredLines(filePath, { keepEpigraphs = false } = {}) {
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
    if (isPovLine(lines[i])) continue;
    if (i === endViewpointLineIndex) continue;
    filteredLines.push(lines[i]);
  }

  return { lines: filteredLines, hasViewpointStart, hasViewpointEnd, pov };
}

/**
 * 複数ファイルをセクション番号付きで一括解析
 * 空の【】に連番を自動採番する
 * @param {string[]} filePaths - テキストファイルパスの配列
 * @param {function} parseFn - parseTextFile または parseTextFileForEpub
 * @param {object} options - parseFn に渡すオプション（sectionNumber は自動設定）
 */
export function parseWithSectionNumbering(filePaths, parseFn, options = {}) {
  let sectionNumber = 1;
  return filePaths.map(filePath => {
    const result = parseFn(filePath, { ...options, sectionNumber });
    if (result.hasEmptyViewpointStart) sectionNumber++;
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
