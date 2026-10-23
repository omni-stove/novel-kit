/**
 * webview の外枠。プレビュー（ツールバーと、用紙を並べる（スクロール表示では本文を流す）領域）と、
 * 小説パネル（文章の傾向・作品設定・ページ設定のタブ）。中身は拡張からのメッセージで後から埋める（media/preview.js・media/panel.js）
 */

import { PAPER_SIZES } from '../../src/layout.mjs';

const ZOOM_OPTIONS = [['fit', '画面に合わせる'], ...[50, 75, 100, 125, 150, 200].map((p) => [String(p), `${p}%`])];

const options = (pairs) => pairs.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');

const marginInput = (side, label) =>
  `<label>${label}<input id="margin-${side}" data-layout-field type="number" min="0" max="100" step="any">mm</label>`;

const PAPER_LABELS = { '6x9in': '6×9in', '5x8in': '5×8in' };

/** プレビューの外枠。本文とそのスタイルは render メッセージで後から差し込む */
export function renderWebviewHtml({ cssUri, jsUri, cspSource, nonce }) {
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
</head>
<body>
  <header id="toolbar">
    <label>レイアウト<select id="preset"></select></label>
    <label id="grid-fields"><input id="chars" data-layout-field type="number" min="5" max="100">字 ×
      <input id="lines" data-layout-field type="number" min="1" max="100">行</label>
    <label id="en-fields" hidden><input id="font-size" data-layout-field type="number" min="5" max="40" step="0.5">pt ×
      行送り<input id="line-height" data-layout-field type="number" min="1" max="3" step="0.05"></label>
    <button id="open-page-settings" title="用紙・余白・文字方向・フォントを、小説パネルの「ページ設定」で変える">ページ設定</button>
    <span id="scope" class="segmented">
      <button data-scope="file">このファイル</button><button data-scope="work">作品全体</button>
    </span>
    <button id="toggle-edit" aria-pressed="true" title="オン: 段落をクリックしてその場で編集（Cmd/Ctrl+クリックでエディタの該当行へ）&#10;オフ: ダブルクリックでエディタの該当行へ">編集</button>
    <button id="open-text" title="このタブをテキストエディタに切り替える（見ている位置の行で開く）">テキストで開く</button>
    <span id="mode" class="segmented" title="ページ: 用紙に組んで1ページずつ見せる&#10;スクロール: カクヨム・小説家になろうのように横書きでページを区切らず縦に流す">
      <button data-mode="page">ページ</button><button data-mode="scroll">スクロール</button>
    </span>
    <label>表示<select id="zoom">${options(ZOOM_OPTIONS)}</select></label>
    <button id="open-work-settings" title="novel.json の作品情報・部の境界・出力を、小説パネルの「作品設定」で編集する">作品設定</button>
    <span id="export-wrap">
      <button id="export" aria-haspopup="menu" aria-expanded="false" title="作るものをメニューから選ぶ（現在のレイアウトでPDF・novel.json の出力）">出力 ▾</button>
      <div id="export-menu" role="menu" hidden></div>
    </span>
    <span id="stats"></span>
  </header>
  <main id="viewport">
    <p id="message">原稿のテキストファイル（.txt）を開くとプレビューを表示します。</p>
    <div id="stage" hidden>
      <div id="sheets"></div>
      <div id="flow"></div>
    </div>
  </main>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}

/**
 * 小説パネルの外枠。タブは文章の傾向（#tab-prose）・作品設定（#tab-work。フォームは media/settings.js）・ページ設定（#tab-page）。
 * cssUris / jsUris は読み込む順に並べる
 */
export function renderPanelHtml({ cssUris, jsUris, cspSource, nonce }) {
  const csp = [
    "default-src 'none'",
    `style-src ${cspSource} 'unsafe-inline'`,
    `font-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${cssUris.map((uri) => `<link rel="stylesheet" href="${uri}">`).join('\n  ')}
</head>
<body>
  <nav id="tabs" role="tablist">
    <button role="tab" data-tab="prose" aria-selected="true">文章の傾向</button>
    <button role="tab" data-tab="work" aria-selected="false">作品設定</button>
    <button role="tab" data-tab="page" aria-selected="false">ページ設定</button>
  </nav>
  <p id="message" hidden></p>
  <section id="tab-prose" role="tabpanel">
    <p id="prose-file" class="file"></p>
    <dl id="counts"></dl>
    <div id="analysis"></div>
  </section>
  <section id="tab-work" role="tabpanel" hidden></section>
  <section id="tab-page" role="tabpanel" hidden>
    <p id="page-file" class="file"></p>
    <label>レイアウト<select id="preset"></select></label>
    <fieldset id="grid-fields">
      <legend>字数×行数</legend>
      <label><input id="chars" data-layout-field type="number" min="5" max="100">字</label>
      <label><input id="lines" data-layout-field type="number" min="1" max="100">行</label>
    </fieldset>
    <fieldset id="en-fields" hidden>
      <legend>文字</legend>
      <label><input id="font-size" data-layout-field type="number" min="5" max="40" step="0.5">pt</label>
      <label>行送り<input id="line-height" data-layout-field type="number" min="1" max="3" step="0.05"></label>
    </fieldset>
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
    <p id="language-note" class="note"></p>
    <p id="derived" class="note"></p>
    <p id="layout-file" class="note"></p>
    <div class="buttons">
      <button id="save-preset">プリセットとして保存…</button>
      <button id="delete-preset">プリセットを削除</button>
    </div>
  </section>
  ${jsUris.map((uri) => `<script nonce="${nonce}" src="${uri}"></script>`).join('\n  ')}
</body>
</html>`;
}
