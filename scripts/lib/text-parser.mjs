/**
 * テキスト解析の共通ユーティリティ
 * txt-to-pdf.mjs, txt-to-novel-pdf.mjs, txt-to-epub.mjs で共有
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// 区切り行かどうかを判定
export function isSeparator(line) {
  return /^[◇◆□■○●◎※＊*]+$/.test(line);
}

// Memo行かどうかを判定
export function isMemoLine(line) {
  return line.startsWith('Memo:');
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

  // 傍点: 《《テキスト》》
  let result = text.replace(/《《(.+?)》》/g, (_, content) => {
    const idx = emphasisPlaceholders.length;
    emphasisPlaceholders.push(content);
    return `\x00EMPHASIS${idx}\x00`;
  });

  // ルビ: |漢字《ルビ》
  result = result.replace(/\|(.+?)《(.+?)》/g, (_, base, ruby) => {
    const idx = rubyPlaceholders.length;
    rubyPlaceholders.push({ base, ruby });
    return `\x00RUBY${idx}\x00`;
  });

  // HTMLエスケープ
  result = result
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // 縦書き時はダッシュ・三点リーダ・波ダッシュをspanで囲んで回転
  if (vertical) {
    result = result.replace(/-/g, '\uFF0D');
    if (separateSymbolClasses) {
      result = result.replace(/([—―\uFF0D]+)/g, '<span class="dash">$1</span>');
      result = result.replace(/([…‥]+)/g, '<span class="ellipsis">$1</span>');
      result = result.replace(/([～〜]+)/g, '<span class="wave-dash">$1</span>');
    } else {
      result = result.replace(/([—―\uFF0D]+)/g, '<span class="dash">$1</span>');
      result = result.replace(/([…‥]+)/g, '<span class="dash">$1</span>');
      result = result.replace(/([～〜]+)/g, '<span class="dash">$1</span>');
    }
    // 2桁の半角数字を縦中横にする
    result = result.replace(/(\d{2})/g, '<span class="tcy">$1</span>');
  }

  // プレースホルダーをHTMLに戻す
  result = result.replace(/\x00RUBY(\d+)\x00/g, (_, idx) => {
    const { base, ruby } = rubyPlaceholders[parseInt(idx, 10)];
    return `<ruby>${base}<rt>${ruby}</rt></ruby>`;
  });

  result = result.replace(/\x00EMPHASIS(\d+)\x00/g, (_, idx) => {
    const content = emphasisPlaceholders[parseInt(idx, 10)];
    return `<span class="emphasis">${content}</span>`;
  });

  return result;
}

/**
 * txtファイルを読み込んでHTML断片と視点情報を返す（PDF用）
 * @param {string} filePath - テキストファイルのパス
 * @param {object} options
 * @param {boolean} options.vertical - 縦書きモード（デフォルト: true）
 * @param {number|null} options.sectionNumber - 空の【】に振るセクション番号
 * @param {boolean} options.separateSymbolClasses - EPUB用シンボルクラス分離
 */
export function parseTextFile(filePath, { vertical = true, sectionNumber = null, separateSymbolClasses = false } = {}) {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const htmlParts = [];

  const contentLines = lines.filter(l => l.trim() !== '' && !isMemoLine(l));
  const hasViewpointStart = contentLines.length > 0 && isViewpointLine(contentLines[0]);
  const hasViewpointEnd = contentLines.length > 0 && isViewpointLine(contentLines[contentLines.length - 1]);
  const endViewpointLine = hasViewpointEnd ? contentLines[contentLines.length - 1] : null;

  let lastWasViewpoint = false;

  const processLines = lines.filter(line => {
    if (isMemoLine(line)) return false;
    if (endViewpointLine && line === endViewpointLine) return false;
    return true;
  });

  const escapeOpts = { vertical, separateSymbolClasses };

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
        htmlParts.push(`<div class="separator-block"><p class="empty">&nbsp;</p>\n<p class="separator">${escapeHtml(line, escapeOpts)}</p>\n<p class="empty">&nbsp;</p></div>`);
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
      htmlParts.push(`<p class="viewpoint">${escapeHtml(viewpointLine, escapeOpts)}</p>`);
      lastWasViewpoint = true;
      continue;
    }

    if (lastWasViewpoint) {
      htmlParts.push('<p class="empty">&nbsp;</p>');
      lastWasViewpoint = false;
    }

    htmlParts.push(`<p>${escapeHtml(line, escapeOpts)}</p>`);
  }

  return { html: htmlParts.join('\n'), hasViewpointStart, hasViewpointEnd };
}

/**
 * EPUB用テキスト解析（空行スキップ、チャプタータイトル抽出）
 */
export function parseTextFileForEpub(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const xhtmlParts = [];
  const escapeOpts = { vertical: true, separateSymbolClasses: true };

  const contentLines = lines.filter(l => l.trim() !== '' && !isMemoLine(l));
  const hasViewpointStart = contentLines.length > 0 && isViewpointLine(contentLines[0]);
  const hasViewpointEnd = contentLines.length > 0 && isViewpointLine(contentLines[contentLines.length - 1]);
  const endViewpointLine = hasViewpointEnd ? contentLines[contentLines.length - 1] : null;

  let chapterTitle = null;
  if (hasViewpointStart) {
    const match = contentLines[0].match(/^【(.+?)】/);
    if (match && match[1]) {
      chapterTitle = match[1];
    }
  }

  const processLines = lines.filter(line => {
    if (isMemoLine(line)) return false;
    if (endViewpointLine && line === endViewpointLine) return false;
    return true;
  });

  for (let i = 0; i < processLines.length; i++) {
    const line = processLines[i];

    if (line.trim() === '') {
      continue;
    }

    if (isSeparator(line)) {
      xhtmlParts.push(`<p class="separator">${escapeHtml(line, escapeOpts)}</p>`);
      continue;
    }

    if (isViewpointLine(line)) {
      xhtmlParts.push(`<p class="viewpoint">${escapeHtml(line, escapeOpts)}</p>`);
      continue;
    }

    xhtmlParts.push(`<p>${escapeHtml(line, escapeOpts)}</p>`);
  }

  return {
    xhtml: xhtmlParts.join('\n'),
    chapterTitle,
    hasViewpointStart,
    hasViewpointEnd,
  };
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
export function countChars(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, '')
    .replace(/&#160;/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s/g, '')
    .length;
}
