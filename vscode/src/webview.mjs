/**
 * プレビュー webview の外枠。ツールバーと、用紙を並べる（スクロール表示では本文を流す）領域と、その右の小説パネル（文章の傾向・作品設定・ページ設定のタブ）。
 * 中身は拡張からのメッセージで後から埋める（media/preview.js・media/panel.js）
 */

import { PAPER_SIZES } from '../../src/layout.mjs';
import { l10nScript, t } from './l10n.mjs';

const zoomOptions = () => [['fit', t('Fit')], ...[50, 75, 100, 125, 150, 200].map((p) => [String(p), `${p}%`])];

const options = (pairs) => pairs.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');

const marginInput = (side, label) =>
  `<label>${label}<input id="margin-${side}" data-page-field type="number" min="0" max="100" step="any">mm</label>`;

const PAPER_LABELS = { '6x9in': '6×9in', '5x8in': '5×8in' };

/** title などの属性値に入れる（改行は &#10; にして、ツールチップで改行する） */
const attr = (text) => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('\n', '&#10;');

/**
 * プレビューの外枠。本文とそのスタイルは render メッセージで後から差し込む。
 * 小説パネル（#novel-panel）はプレビューの右に出し、panel: { open, tab, width } で最初の開け閉め・タブ・幅（px）を決める。
 * cssUris / jsUris は読み込む順に並べる（jsUris の先頭は l10n.js）。language: 表示の言語（vscode.env.language）
 */
export function renderWebviewHtml({ cssUris, jsUris, cspSource, nonce, panel, language }) {
  const csp = [
    "default-src 'none'",
    `style-src ${cspSource} 'unsafe-inline' https://fonts.googleapis.com`,
    `font-src ${cspSource} https://fonts.gstatic.com`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="${language}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="https://fonts.googleapis.com/css2?family=Noto+Serif+JP:wght@400&display=swap" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet">
  <style id="doc-style"></style>
  ${cssUris.map((uri) => `<link rel="stylesheet" href="${uri}">`).join('\n  ')}
</head>
<body>
  <header id="toolbar">
    <span id="scope" class="segmented">
      <button data-scope="file">${t('This file')}</button><button data-scope="work">${t('Whole work')}</button>
    </span>
    <button id="toggle-edit" aria-pressed="true" title="${attr(t('On: click a paragraph to edit it in place (Cmd/Ctrl+click opens the line in the editor)\nOff: double-click opens the line in the editor'))}">${t('Edit')}</button>
    <button id="open-text" title="${attr(t('Switch this tab to the text editor (at the line you are looking at)'))}">${t('Open as Text')}</button>
    <span id="mode" class="segmented" title="${attr(t('Page: typeset on paper, one page at a time\nScroll: horizontal text flowing down without page breaks, as on Kakuyomu or Shōsetsuka ni Narō'))}">
      <button data-mode="page">${t('Page')}</button><button data-mode="scroll">${t('Scroll')}</button>
    </span>
    <label>${t('Zoom')}<select id="zoom">${options(zoomOptions())}</select></label>
    <span id="export-wrap">
      <button id="export" aria-haspopup="menu" aria-expanded="false" title="${attr(t('Choose what to make from a menu (a PDF in the current layout, or the outputs in novel.json)'))}">${t('Export')} ▾</button>
      <div id="export-menu" role="menu" hidden></div>
    </span>
    <button id="backup" hidden title="${attr(t('Save the manuscripts, record every change in the folder of the work with Git and send it to the remote repository'))}">☁ ${t('Backup')}</button>
    <span id="stats"></span>
    <span id="panel-toggles" class="segmented" title="${attr(t('Show in the panel on the right (press the selected one again to close it)'))}">
      <button data-panel-tab="prose" title="${attr(t('Show the character count and the distribution of sentence endings in the narration in the panel on the right'))}">${t('Prose')}</button><button data-panel-tab="work" title="${attr(t('Edit the work information, part boundaries and outputs of novel.json in the panel on the right'))}">${t('Work')}</button><button data-panel-tab="page" title="${attr(t('Change the paper, margins, writing direction and font in the panel on the right'))}">${t('Page Setup')}</button>
    </span>
  </header>
  <div id="workspace">
    <main id="viewport">
      <p id="message">${t('Open a manuscript text file (.txt) to show the preview.')}</p>
      <div id="stage" hidden>
        <div id="sheets"></div>
        <div id="flow"></div>
      </div>
    </main>
    ${renderPanel(panel)}
  </div>
  ${l10nScript()}
  ${jsUris.map((uri) => `<script nonce="${nonce}" src="${uri}"></script>`).join('\n  ')}
</body>
</html>`;
}

/**
 * 小説パネル。タブは文章の傾向（#tab-prose）・作品設定（#tab-work。フォームは media/settings.js）・ページ設定（#tab-page）。
 * ツールバーと同じ文書に入るので、id はツールバーと重ならないようにする
 */
function renderPanel({ open, tab, width }) {
  const tabButton = (name, label) =>
    `<button role="tab" data-tab="${name}" aria-selected="${name === tab}">${label}</button>`;
  return `<aside id="novel-panel" data-tab="${tab}"${open ? '' : ' hidden'}${width ? ` style="width: ${Number(width)}px"` : ''}>
      <div id="panel-resizer" title="${attr(t('Drag to change the width'))}"></div>
      <nav id="tabs" role="tablist">
        ${tabButton('prose', t('Prose'))}${tabButton('work', t('Work'))}${tabButton('page', t('Page Setup'))}
        <button id="close-panel" title="${attr(t('Close the panel'))}" aria-label="${attr(t('Close the panel'))}">×</button>
      </nav>
      <p id="panel-message" hidden></p>
      <section id="tab-prose" role="tabpanel">
        <p id="prose-file" class="file"></p>
        <dl id="counts"></dl>
        <div id="analysis"></div>
      </section>
      <section id="tab-work" role="tabpanel" hidden></section>
      <section id="tab-page" role="tabpanel" hidden>
        <p id="page-file" class="file"></p>
        <label>${t('Layout')}<select id="page-preset"></select></label>
        <fieldset id="page-grid-fields">
          <legend>${t('Characters × lines')}</legend>
          <label>${t('{0} chars', '<input id="page-chars" data-page-field type="number" min="5" max="100">')}</label>
          <label>${t('{0} lines', '<input id="page-lines" data-page-field type="number" min="1" max="100">')}</label>
        </fieldset>
        <fieldset id="page-en-fields" hidden>
          <legend>${t('Type')}</legend>
          <label><input id="page-font-size" data-page-field type="number" min="5" max="40" step="0.5">pt</label>
          <label>${t('Leading')}<input id="page-line-height" data-page-field type="number" min="1" max="3" step="0.05"></label>
        </fieldset>
        <fieldset id="writing-mode-fields">
          <legend>${t('Writing direction')}</legend>
          <label><input type="radio" name="writing-mode" value="vertical" data-page-field>${t('Vertical')}</label>
          <label><input type="radio" name="writing-mode" value="horizontal" data-page-field>${t('Horizontal')}</label>
        </fieldset>
        <fieldset>
          <legend>${t('Paper')}</legend>
          <label>${t('Size')}<select id="paper" data-page-field>${options(Object.keys(PAPER_SIZES).map((p) => [p, PAPER_LABELS[p] ?? p]))}</select></label>
          <label>${t('Orientation')}<select id="orientation" data-page-field>${options([
            ['landscape', t('Landscape')],
            ['portrait', t('Portrait')],
          ])}</select></label>
        </fieldset>
        <fieldset>
          <legend>${t('Margins')}</legend>
          ${marginInput('top', t('Top'))}
          ${marginInput('bottom', t('Bottom'))}
          ${marginInput('left', t('Left'))}
          ${marginInput('right', t('Right'))}
        </fieldset>
        <fieldset>
          <legend>${t('Font')}</legend>
          <input id="font-family" data-page-field type="text">
        </fieldset>
        <p id="language-note" class="note"></p>
        <p id="derived" class="note"></p>
        <p id="layout-file" class="note"></p>
        <div class="buttons">
          <button id="save-preset">${t('Save as Preset…')}</button>
          <button id="delete-preset">${t('Delete Preset')}</button>
        </div>
      </section>
    </aside>`;
}
