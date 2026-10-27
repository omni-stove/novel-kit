// @ts-check

/**
 * 小説パネル（プレビューの右の #novel-panel。タブは文章の傾向・作品設定・ページ設定）を動かす。preview.js から1回だけ呼ぶ。
 * vscode: webview の API（acquireVsCodeApi は1つの webview で1回しか呼べないので、preview.js から受け取る）。
 * 拡張とのメッセージは { type: 'panel', msg } に包む。返す値の receive(msg) に、拡張から届いたパネル宛ての msg を渡す
 */
// biome-ignore lint/correctness/noUnusedVariables: 別の script（preview.js）から呼ぶ
function createNovelPanel(vscode) {
  const $ = (id) => /** @type {any} */ (document.getElementById(id));
  const root = $('novel-panel');
  const post = (msg) => vscode.postMessage({ type: 'panel', msg });

  const TABS = ['prose', 'work', 'page'];
  /** ドラッグで変えられる幅（px）の下限。上限はプレビューの幅の割合（panel.css の max-width） */
  const MIN_WIDTH_PX = 220;

  /** tag の要素を作る。props は要素のプロパティ（className・textContent・title など）、children は子 */
  function h(tag, props = {}, ...children) {
    const el = Object.assign(document.createElement(tag), props);
    el.append(...children.filter((c) => c !== null && c !== undefined));
    return el;
  }

  const formatNumber = (n, language) => n.toLocaleString(language === 'en' ? 'en-US' : 'ja-JP');
  const formatPages = (n) => (Math.round(n * 10) / 10).toLocaleString('ja-JP');

  let tab = TABS.includes(root.dataset.tab) ? root.dataset.tab : 'prose';

  /**
   * パネルの開け閉め・タブ・幅を拡張に伝える。拡張は見えているタブの中身だけを作り、次に開くプレビューもこの状態で始める。
   * type: 'ready' は最初の1回（拡張は前に送った中身を忘れて送り直す）
   */
  const postState = (type = 'state') =>
    post({ type, open: !root.hidden, tab, width: parseFloat(root.style.width) || null });

  /** パネルを開け閉めし、next のタブを見せる（next が無ければいまのタブのまま）。notify: false なら拡張に伝えない */
  function show(open, next = tab, { notify = true } = {}) {
    if (!TABS.includes(next)) return;
    tab = next;
    root.hidden = !open;
    for (const button of /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('#tabs [data-tab]'))) {
      button.setAttribute('aria-selected', String(button.dataset.tab === tab));
    }
    $('toggle-panel').setAttribute('aria-pressed', String(open));
    for (const name of TABS) $(`tab-${name}`).hidden = name !== tab;
    if (notify) postState();
  }

  $('tabs').addEventListener('click', (e) => {
    const next = e.target.closest?.('button')?.dataset.tab;
    if (next && next !== tab) show(true, next);
  });
  $('close-panel').addEventListener('click', () => show(false));
  $('toggle-panel').addEventListener('click', () => show(root.hidden));

  $('panel-resizer').addEventListener('pointerdown', (/** @type {PointerEvent} */ e) => {
    const resizer = $('panel-resizer');
    resizer.setPointerCapture(e.pointerId);
    const right = root.getBoundingClientRect().right;
    const move = (/** @type {PointerEvent} */ ev) => {
      root.style.width = `${Math.max(MIN_WIDTH_PX, right - ev.clientX)}px`;
    };
    const end = () => {
      resizer.removeEventListener('pointermove', move);
      postState();
    };
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('lostpointercapture', end, { once: true });
  });

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
          post({ type: 'reveal', line });
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
          ? t('{0} words · {1} chars', formatNumber(s.words, 'en'), formatNumber(s.chars))
          : t(
              '{0} chars · {1} sheets of 400 chars · {2}: {3} pages',
              formatNumber(s.chars),
              formatPages(s.genkoPages),
              stats.layout,
              formatPages(s.gridPages),
            );
      rows.push(h('dt', { textContent: label }), h('dd', { textContent: value }));
    };
    add(t('This file'), stats.file);
    add(t('Whole work'), stats.work);
    $('counts').replaceChildren(...rows);
    $('counts').title =
      stats.file?.language === 'en'
        ? t('Words and characters (excluding meta lines)')
        : t(
            'Characters (excluding ruby and meta lines), sheets of 400-character manuscript paper, and pages in the current layout',
          );
  }

  /** 文末の分布の棒 */
  const bar = (percent) => h('span', { className: 'bar' }, h('span', { style: `width: ${percent}%` }));

  function renderAnalysis(data) {
    const root = $('analysis');
    if (data.english) {
      root.replaceChildren(
        h('p', { className: 'note', textContent: t('Prose analysis is not available for English manuscripts.') }),
      );
      return;
    }
    if (!data.report) {
      const link = h('a', { href: '#', textContent: t('Open Settings') });
      link.addEventListener('click', (e) => {
        e.preventDefault();
        post({ type: 'openSettings' });
      });
      root.replaceChildren(
        h('p', { className: 'note' }, t('Prose analysis is turned off (setting novelPreview.prose). '), link),
      );
      return;
    }
    const r = data.report;
    root.replaceChildren(
      h(
        'dl',
        { className: 'summary' },
        h('dt', { textContent: t('Dialogue') }),
        h('dd', {
          textContent: `${r.dialogue.percent}%`,
          title: t(
            'Dialogue {0} chars / narration {1} chars',
            formatNumber(r.dialogue.dialogueChars),
            formatNumber(r.dialogue.narrationChars),
          ),
        }),
        h('dt', { textContent: t('Sentence length') }),
        h('dd', { textContent: t('Average {0} chars · longest {1} chars', r.average, r.longest) }),
      ),
      h('h3', { textContent: t('Sentence endings ({0} sentences of narration)', r.sentences) }),
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

  /**
   * ページ設定の欄を、届いた値で埋める。英語の原稿は横書き固定で、設定ファイルの "english" のレイアウトを見せる。
   * 章の欄は表示設定（view）で、英語の組版は章ヘッダの後に空きを取るので、見出しの後の空行は日本語の原稿にだけ出す
   */
  function fillPage(data) {
    const { layout, metrics, presets, presetName, userPresetNames, layoutFile, language, view } = data;
    const english = language === 'en';
    pageLayout = layout;

    const preset = $('page-preset');
    preset.replaceChildren();
    if (!presetName) preset.append(new Option(t('(Custom)'), ''));
    for (const name of presets) preset.append(new Option(name, name));
    preset.value = presetName ?? '';

    $('page-grid-fields').hidden = english;
    $('page-en-fields').hidden = !english;
    $('page-chars').value = layout.chars ?? '';
    $('page-lines').value = layout.lines ?? '';
    $('page-lines').placeholder = t('Auto ({0})', metrics.lines);
    $('page-font-size').value = english ? layout.fontSize : '';
    $('page-line-height').value = english ? layout.lineHeight : '';

    $('language-note').textContent = english ? t('English manuscript (always horizontal; saved under english)') : '';
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
    $('font-family').placeholder = english
      ? t('Default ({0})', 'EB Garamond / Georgia')
      : t('Default ({0})', 'Noto Serif JP / 游明朝');
    $('view-chapter-break').checked = view.chapterBreak;
    $('view-blank-after-heading').checked = view.blankAfterHeading;
    $('view-blank-after-heading-label').hidden = english;
    const pitch = Math.round(metrics.linePitchMm * 100) / 100;
    $('derived').textContent = english
      ? t(
          'Font size {0}pt · line pitch {1}mm (about {2} chars × {3} lines)',
          metrics.fontSizePt,
          pitch,
          metrics.charsApprox,
          metrics.lines,
        )
      : t(
          'Font size {0}pt · line pitch {1}mm ({2} chars × {3} lines)',
          metrics.fontSizePt,
          pitch,
          metrics.chars,
          metrics.lines,
        );
    $('layout-file').textContent = layoutFile
      ? t('Settings file: {0}', layoutFile)
      : t('Settings file: none (a change creates novel.json next to the manuscript)');
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
      chars: $('page-chars').value,
      lines: $('page-lines').value,
      fontSize: $('page-font-size').value,
      lineHeight: $('page-line-height').value,
      fontFamily: $('font-family').value,
    };
  }

  for (const el of document.querySelectorAll('[data-page-field]')) {
    el.addEventListener('change', () => pageLayout && post({ type: 'layout', layout: readPage() }));
  }
  $('view-chapter-break').addEventListener('change', (e) =>
    post({ type: 'view', view: { chapterBreak: e.target.checked } }),
  );
  $('view-blank-after-heading').addEventListener('change', (e) =>
    post({ type: 'view', view: { blankAfterHeading: e.target.checked } }),
  );
  $('page-preset').addEventListener('change', (e) => {
    if (e.target.value) post({ type: 'preset', name: e.target.value });
  });
  $('save-preset').addEventListener('click', () => post({ type: 'savePreset' }));
  $('delete-preset').addEventListener('click', () => post({ type: 'deletePreset', name: $('page-preset').value }));

  const workForm = createWorkSettingsForm($('tab-work'), (msg) => post({ type: 'work', msg }), {
    scroller: $('tab-work'),
  });

  /** 拡張から届いたパネル宛てのメッセージ。show でパネルを開いてタブを替える */
  function receive(data) {
    switch (data.type) {
      case 'show':
        return show(true, data.tab);
      case 'message':
        $('panel-message').textContent = data.text ?? '';
        $('panel-message').hidden = !data.text;
        root.classList.toggle('blank', !!data.text);
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
  }

  show(!root.hidden, tab, { notify: false });
  postState('ready');
  return { receive };
}
