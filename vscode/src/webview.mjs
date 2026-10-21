/**
 * プレビュー webview の外枠（ツールバー・ページ設定・用紙を並べる領域・作品設定の欄）。
 * 本文とそのスタイルは render メッセージで後から差し込む（media/preview.js）。作品設定の欄のフォームは media/settings.js
 */

import { PAPER_SIZES } from '../../src/layout.mjs';

const ZOOM_OPTIONS = [['fit', '画面に合わせる'], ...[50, 75, 100, 125, 150, 200].map((p) => [String(p), `${p}%`])];

const options = (pairs) => pairs.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');

const marginInput = (side, label) =>
  `<label>${label}<input id="margin-${side}" data-layout-field type="number" min="0" max="100" step="any">mm</label>`;

const PAPER_LABELS = { '6x9in': '6×9in', '5x8in': '5×8in' };

export function renderWebviewHtml({ cssUri, jsUri, formCssUri, formJsUri, cspSource, nonce }) {
  const csp = [
    "default-src 'none'",
    `style-src ${cspSource} 'unsafe-inline' https://fonts.googleapis.com`,
    `font-src ${cspSource} https://fonts.gstatic.com`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="https://fonts.googleapis.com/css2?family=Noto+Serif+JP:wght@400&display=swap" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet">
  <style id="doc-style"></style>
  <link rel="stylesheet" href="${cssUri}">
  <link rel="stylesheet" href="${formCssUri}">
</head>
<body>
  <header id="toolbar">
    <label>レイアウト<select id="preset"></select></label>
    <label id="grid-fields"><input id="chars" data-layout-field type="number" min="5" max="100">字 ×
      <input id="lines" data-layout-field type="number" min="1" max="100">行</label>
    <label id="en-fields" hidden><input id="font-size" data-layout-field type="number" min="5" max="40" step="0.5">pt ×
      行送り<input id="line-height" data-layout-field type="number" min="1" max="3" step="0.05"></label>
    <button id="toggle-setup" aria-pressed="false">ページ設定</button>
    <span id="scope" class="segmented">
      <button data-scope="file">このファイル</button><button data-scope="work">作品全体</button>
    </span>
    <button id="toggle-edit" aria-pressed="true" title="オン: 段落をクリックしてその場で編集（Cmd/Ctrl+クリックでエディタの該当行へ）&#10;オフ: ダブルクリックでエディタの該当行へ">編集</button>
    <button id="open-text" title="このタブをテキストエディタに切り替える（見ている位置の行で開く）">テキストで開く</button>
    <label>表示<select id="zoom">${options(ZOOM_OPTIONS)}</select></label>
    <button id="work-settings" aria-pressed="false" title="novel.json の作品情報・部の境界・出力を、プレビューの横で編集する">作品設定</button>
    <button id="export-pdf" title="日本語: novel pdf でこの字数×行数のPDFを出力&#10;English: novel pdf-en でこの判型のPDFを出力">PDF出力</button>
    <span id="stats"></span>
  </header>
  <section id="setup" hidden>
    <fieldset id="writing-mode-fields">
      <legend>文字方向</legend>
      <label><input type="radio" name="writing-mode" value="vertical" data-layout-field>縦書き</label>
      <label><input type="radio" name="writing-mode" value="horizontal" data-layout-field>横書き</label>
    </fieldset>
    <fieldset>
      <legend>用紙</legend>
      <label>サイズ<select id="paper" data-layout-field>${options(Object.keys(PAPER_SIZES).map((p) => [p, PAPER_LABELS[p] ?? p]))}</select></label>
      <label>向き<select id="orientation" data-layout-field>${options([
        ['landscape', '横'],
        ['portrait', '縦'],
      ])}</select></label>
    </fieldset>
    <fieldset>
      <legend>余白</legend>
      ${marginInput('top', '上')}
      ${marginInput('bottom', '下')}
      ${marginInput('left', '左')}
      ${marginInput('right', '右')}
    </fieldset>
    <fieldset>
      <legend>フォント</legend>
      <input id="font-family" data-layout-field type="text">
    </fieldset>
    <span id="language-note"></span>
    <span id="derived"></span>
    <span id="layout-file"></span>
    <button id="save-preset">プリセットとして保存…</button>
    <button id="delete-preset">プリセットを削除</button>
  </section>
  <div id="workspace">
    <main id="viewport">
      <p id="message">原稿のテキストファイル（.txt）を開くとプレビューを表示します。</p>
      <div id="stage" hidden>
        <div id="sheets"></div>
        <div id="flow"></div>
      </div>
    </main>
    <aside id="work-panel" hidden></aside>
  </div>
  <script nonce="${nonce}" src="${formJsUri}"></script>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}
