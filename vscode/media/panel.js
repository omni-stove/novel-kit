// @ts-check
// 小説パネル（セカンダリサイドバーの webview）。タブは文章の傾向・作品設定・ページ設定。作品設定のフォームは settings.js
(() => {
  /** @type {import('vscode-webview').WebviewApi<{ tab: string }>} */
  const vscode = acquireVsCodeApi();
  const $ = (id) => /** @type {any} */ (document.getElementById(id));

  const TABS = ['prose', 'work', 'page'];

  /** tag の要素を作る。props は要素のプロパティ（className・textContent・title など）、children は子 */
  function h(tag, props = {}, ...children) {
    const el = Object.assign(document.createElement(tag), props);
    el.append(...children.filter((c) => c !== null && c !== undefined));
    return el;
  }

  const formatNumber = (n, language) => n.toLocaleString(language === 'en' ? 'en-US' : 'ja-JP');
  const formatPages = (n) => (Math.round(n * 10) / 10).toLocaleString('ja-JP');

  let tab = vscode.getState()?.tab ?? 'prose';

  /** tab のタブを見せる。拡張にも伝え、見えているタブの中身だけを作ってもらう（notify: false なら伝えない） */
  function selectTab(next, { notify = true } = {}) {
    if (!TABS.includes(next)) return;
    tab = next;
    vscode.setState({ tab });
    for (const button of /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('#tabs button'))) {
      button.setAttribute('aria-selected', String(button.dataset.tab === tab));
    }
    for (const name of TABS) $(`tab-${name}`).hidden = name !== tab;
    if (notify) vscode.postMessage({ type: 'tab', tab });
  }

  $('tabs').addEventListener('click', (e) => {
    const next = e.target.closest?.('button')?.dataset.tab;
    if (next && next !== tab) selectTab(next);
  });

  // 文章の傾向

  /** 開いている一覧（title）。描き直しても開け閉めを保つ */
  const openLists = new Set();

  /** 原稿の line 行を開くボタン */
  function lineButton({ line, text, note }) {
    return h(
      'button',
      {
        className: 'line',
        title: text,
        onclick: (e) => {
          // 一覧の見出しの中にあるときも、開け閉めせずに行を開くだけにする
          e.preventDefault();
          vscode.postMessage({ type: 'reveal', line });
        },
      },
      h('span', { className: 'text', textContent: text }),
      h('span', { className: 'note', textContent: note }),
    );
  }

  /** 件数を見出しにして、中に行を開くボタンを並べる一覧。key で開け閉めを覚える */
  function list(key, summary, count, items) {
    const details = h(
      'details',
      { open: openLists.has(key) },
      h('summary', {}, summary, h('span', { className: 'count', textContent: String(count) })),
    );
    details.addEventListener('toggle', () => {
      if (details.open) openLists.add(key);
      else openLists.delete(key);
    });
    if (count === 0) details.classList.add('empty');
    details.append(
      h(
        'ul',
        {},
        ...items.map((item) =>
          h(
            'li',
            {},
            item.children
              ? list(`${key}/${item.line}/${item.text}`, lineButton(item), item.children.length, item.children)
              : lineButton(item),
          ),
        ),
      ),
    );
    return details;
  }

  /** 文字数（このファイル・作品全体）。英語は語数も出す。日本語は stats.layout（いまのレイアウト）での換算枚数も出す */
  function renderCounts(stats) {
    const rows = [];
    const add = (label, s) => {
      if (!s) return;
      const value =
        s.language === 'en'
          ? `${formatNumber(s.words, 'en')} words ・ ${formatNumber(s.chars)}字`
          : `${formatNumber(s.chars)}字 ・ 400字詰め ${formatPages(s.genkoPages)}枚 ・ ${stats.layout} ${formatPages(s.gridPages)}枚`;
      rows.push(h('dt', { textContent: label }), h('dd', { textContent: value }));
    };
    add('このファイル', stats.file);
    add('作品全体', stats.work);
    $('counts').replaceChildren(...rows);
    $('counts').title =
      stats.file?.language === 'en'
        ? '語数・文字数（メタ行を除く）'
        : '文字数（ルビ・メタ行を除く）・400字詰め原稿用紙換算・現在のレイアウトでの換算枚数';
  }

  /** 文末の分布の棒 */
  const bar = (percent) => h('span', { className: 'bar' }, h('span', { style: `width: ${percent}%` }));

  function renderAnalysis(data) {
    const root = $('analysis');
    if (data.english) {
      root.replaceChildren(h('p', { className: 'note', textContent: '英語の原稿は文章の傾向を数えません。' }));
      return;
    }
    if (!data.report) {
      const link = h('a', { href: '#', textContent: '設定を開く' });
      link.addEventListener('click', (e) => {
        e.preventDefault();
        vscode.postMessage({ type: 'openSettings' });
      });
      root.replaceChildren(
        h('p', { className: 'note' }, '文章の傾向の解析はオフです（設定 novelPreview.prose）。', link),
      );
      return;
    }
    const r = data.report;
    root.replaceChildren(
      h(
        'dl',
        { className: 'summary' },
        h('dt', { textContent: '台詞の割合' }),
        h('dd', {
          textContent: `${r.dialogue.percent}%`,
          title: `台詞 ${formatNumber(r.dialogue.dialogueChars)}字 / 地の文 ${formatNumber(r.dialogue.narrationChars)}字`,
        }),
        h('dt', { textContent: '文の長さ' }),
        h('dd', { textContent: `平均 ${r.average}字・最長 ${r.longest}字` }),
      ),
      h('h3', { textContent: `文末（地の文 ${r.sentences}文）` }),
      h(
        'table',
        { className: 'endings' },
        ...r.endings.map((e) =>
          h(
            'tr',
            {},
            h('th', { textContent: e.label }),
            h('td', {}, bar(e.percent)),
            h('td', { className: 'num', textContent: `${e.percent}%` }),
            h('td', { className: 'num', textContent: String(e.count) }),
          ),
        ),
      ),
      ...r.lists.map((l) => list(l.title, l.title, l.items.length, l.items)),
    );
  }

  // ページ設定

  /** ページ設定の欄を、届いた値で埋める。英語の原稿は横書き固定で、設定ファイルの "english" のレイアウトを見せる */
  function fillPage(data) {
    const { layout, metrics, presets, presetName, userPresetNames, layoutFile, language } = data;
    const english = language === 'en';
    pageLayout = layout;

    const preset = $('preset');
    preset.replaceChildren();
    if (!presetName) preset.append(new Option('（カスタム）', ''));
    for (const name of presets) preset.append(new Option(name, name));
    preset.value = presetName ?? '';

    $('grid-fields').hidden = english;
    $('en-fields').hidden = !english;
    $('chars').value = layout.chars ?? '';
    $('lines').value = layout.lines ?? '';
    $('lines').placeholder = `自動(${metrics.lines})`;
    $('font-size').value = english ? layout.fontSize : '';
    $('line-height').value = english ? layout.lineHeight : '';

    $('language-note').textContent = english ? '英語の原稿（横書き固定。設定は english に保存）' : '';
    $('language-note').hidden = !english;
    $('writing-mode-fields').hidden = english;
    for (const radio of /** @type {NodeListOf<HTMLInputElement>} */ (
      document.querySelectorAll('input[name="writing-mode"]')
    )) {
      radio.checked = radio.value === (layout.writingMode ?? 'horizontal');
    }
    $('paper').value = layout.paper;
    $('orientation').value = layout.orientation;
    for (const side of ['top', 'bottom', 'left', 'right']) $(`margin-${side}`).value = layout.margin[side];
    $('font-family').value = layout.fontFamily;
    $('font-family').placeholder = english ? '既定（EB Garamond / Georgia）' : '既定（Noto Serif JP / 游明朝）';
    const pitch = `行送り ${Math.round(metrics.linePitchMm * 100) / 100}mm`;
    $('derived').textContent = english
      ? `文字サイズ ${metrics.fontSizePt}pt ・ ${pitch}（約${metrics.charsApprox}字×${metrics.lines}行）`
      : `文字サイズ ${metrics.fontSizePt}pt ・ ${pitch}（${metrics.chars}字×${metrics.lines}行）`;
    $('layout-file').textContent = layoutFile
      ? `設定ファイル: ${layoutFile}`
      : '設定ファイル: なし（変更すると原稿と同じ場所に novel.json を作ります）';
    $('delete-preset').disabled = !userPresetNames.includes(presetName);
  }

  /** いま見せているレイアウト（届いた値） */
  let pageLayout = null;

  /** ページ設定の欄の値（レイアウト） */
  function readPage() {
    return {
      ...pageLayout,
      writingMode: /** @type {HTMLInputElement | null} */ (document.querySelector('input[name="writing-mode"]:checked'))
        ?.value,
      paper: $('paper').value,
      orientation: $('orientation').value,
      margin: {
        top: $('margin-top').value,
        right: $('margin-right').value,
        bottom: $('margin-bottom').value,
        left: $('margin-left').value,
      },
      chars: $('chars').value,
      lines: $('lines').value,
      fontSize: $('font-size').value,
      lineHeight: $('line-height').value,
      fontFamily: $('font-family').value,
    };
  }

  for (const el of document.querySelectorAll('[data-layout-field]')) {
    el.addEventListener('change', () => pageLayout && vscode.postMessage({ type: 'layout', layout: readPage() }));
  }
  $('preset').addEventListener('change', (e) => {
    if (e.target.value) vscode.postMessage({ type: 'preset', name: e.target.value });
  });
  $('save-preset').addEventListener('click', () => vscode.postMessage({ type: 'savePreset' }));
  $('delete-preset').addEventListener('click', () =>
    vscode.postMessage({ type: 'deletePreset', name: $('preset').value }),
  );

  // 作品設定

  const postWork = (msg) => vscode.postMessage({ type: 'work', msg });
  const workForm = createWorkSettingsForm($('tab-work'), postWork, { scroller: $('tab-work') });

  window.addEventListener('message', ({ data }) => {
    switch (data.type) {
      case 'tab':
        return selectTab(data.tab, { notify: false });
      case 'message':
        $('message').textContent = data.text ?? '';
        $('message').hidden = !data.text;
        document.body.classList.toggle('blank', !!data.text);
        return;
      case 'prose':
        $('prose-file').textContent = data.file;
        renderCounts(data.stats);
        return renderAnalysis(data);
      case 'page':
        $('page-file').textContent = data.file;
        return fillPage(data);
      case 'workSettings':
        return workForm.render(data.state);
    }
  });

  selectTab(tab, { notify: false });
  vscode.postMessage({ type: 'ready', tab });
})();
