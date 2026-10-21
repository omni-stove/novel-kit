// @ts-check
(() => {
  /** @type {import('vscode-webview').WebviewApi<{ scrollPages: number }>} */
  const vscode = acquireVsCodeApi();
  const $ = (id) => /** @type {any} */ (document.getElementById(id));

  /** 用紙と用紙の間隔（mm） */
  const SHEET_GAP_MM = 2;
  /** 表示領域の縁の余白（px） */
  // preview.css の #stage の margin と揃える
  const STAGE_MARGIN_PX = 24;
  const PX_PER_MM = 96 / 25.4;

  const viewport = $('viewport');
  const stage = $('stage');
  const sheets = $('sheets');
  const flow = $('flow');

  let model = null;
  let geometry = null;
  let lastReveal = null;
  /**
   * 表示倍率の値を select の値にする。数値（%）でなければ「画面に合わせる」（'fit'）。旧い値（fit-width / fit-page）もここに寄せる。
   * 表示倍率と編集のオンオフは設定ファイル（render で届く view）の値に従う
   */
  const normalizeZoom = (value) => (Number(value) > 0 ? String(value) : 'fit');
  let zoom = 'fit';
  $('zoom').value = zoom;

  const formatNumber = (n) => n.toLocaleString('ja-JP');
  const formatPages = (n) => (Math.round(n * 10) / 10).toLocaleString('ja-JP');
  const isEnglish = () => model?.language === 'en';

  /** 左右の余白（px）。「画面に合わせる」では取らず、幅が決め手になるときは用紙を表示領域の幅いっぱいに広げる */
  const sideMarginPx = () => (zoom === 'fit' ? 0 : STAGE_MARGIN_PX);
  /**
   * 用紙の並びの先頭の余白（px）。横書きの「画面に合わせる」では用紙を高さに合わせ、1ページずつ表示領域の中央に置く
   * （ペーパーバックを1ページずつめくる見え方）ので、先頭のページが中央に来るぶんの余白を取る
   */
  const leadPx = () => geometry?.lead ?? sideMarginPx();

  /**
   * 横書きで縦長の用紙（英語のペーパーバックなど）なら true。幅が狭くても高さに合わせて1ページを丸ごと見せる
   * （幅が足りないぶんは左右の余白が切れるだけで、本文は見える）。上下の余白は取らず、表示領域の高さいっぱいに使う
   */
  const fitsHeight = (metrics) => !metrics.vertical && metrics.paperH > metrics.paperW;

  function pxPerMm(metrics) {
    viewport.classList.toggle('fit', zoom === 'fit');
    const fitWidth = (viewport.clientWidth - sideMarginPx() * 2) / metrics.paperW;
    const fitHeight = (viewport.clientHeight - STAGE_MARGIN_PX * 2) / metrics.paperH;
    if (zoom === 'fit')
      return Math.max(
        fitsHeight(metrics) ? viewport.clientHeight / metrics.paperH : Math.min(fitWidth, fitHeight),
        0.5,
      );
    return (PX_PER_MM * Number(zoom)) / 100;
  }

  function layoutStage() {
    if (!model) return;
    const m = model.metrics;
    const u = pxPerMm(m);
    const fontPx = m.fontSizeMm * u;
    const inlinePx = m.chars * fontPx;
    const blockPx = m.availBlock * u;
    // あふれた段は字を送る方向に並ぶため、縦書きはページを下へ、横書きは右へ並べる
    const period = ((m.vertical ? m.paperH : m.paperW) + SHEET_GAP_MM) * u;

    const s = flow.style;
    s.writingMode = m.vertical ? 'vertical-rl' : 'horizontal-tb';
    s.fontSize = `${fontPx}px`;
    s.lineHeight = String(m.lineHeight);
    s.fontFamily = m.layout.fontFamily || '';
    s.top = `${m.layout.margin.top * u}px`;
    s.left = `${m.layout.margin.left * u}px`;
    s.width = `${m.vertical ? blockPx : inlinePx}px`;
    s.height = `${m.vertical ? inlinePx : blockPx}px`;
    s.columnGap = `${period - inlinePx}px`;

    const extent = m.vertical ? flow.scrollHeight : flow.scrollWidth;
    const pages = Math.max(1, Math.ceil((extent - 1) / period));
    const sheetW = m.paperW * u;
    const sheetH = m.paperH * u;
    const gap = SHEET_GAP_MM * u;
    const centered = !m.vertical && zoom === 'fit';
    const lead = centered ? Math.max(0, (viewport.clientWidth - sheetW) / 2) : sideMarginPx();
    // 先頭と末尾のページも中央に置けるよう、並びの両側に同じ余白を取る
    stage.style.margin = centered ? `${fitsHeight(m) ? 0 : STAGE_MARGIN_PX}px ${lead}px` : '';

    while (sheets.children.length > pages) sheets.lastChild.remove();
    while (sheets.children.length < pages) {
      const sheet = document.createElement('div');
      sheet.className = 'sheet';
      const nombre = document.createElement('span');
      nombre.className = 'nombre';
      nombre.textContent = String(sheets.children.length + 1);
      sheet.append(nombre);
      sheets.append(sheet);
    }
    [...sheets.children].forEach((sheet, k) => {
      sheet.style.top = `${m.vertical ? k * period : 0}px`;
      sheet.style.left = `${m.vertical ? 0 : k * period}px`;
      sheet.style.width = `${sheetW}px`;
      sheet.style.height = `${sheetH}px`;
      const nombre = sheet.firstChild;
      nombre.style.bottom = `${(m.layout.margin.bottom * u) / 2 - 5 * u * 0.3528}px`;
      nombre.style.fontSize = `${10 * 0.3528 * u}px`;
    });
    stage.style.width = `${m.vertical ? sheetW : pages * period - gap}px`;
    stage.style.height = `${m.vertical ? pages * period - gap : sheetH}px`;

    const first = !geometry;
    geometry = { vertical: m.vertical, period, pages, sheet: m.vertical ? sheetH : sheetW, lead, centered };
    // 用紙が表示領域より広いと先頭ページの端しか見えないので、最初の表示で真ん中（本文）を見せる
    if (first && centered && sheetW > viewport.clientWidth) scrollToPage(1);
    updateStats();
  }

  function currentPage() {
    if (!geometry) return 1;
    const offset = geometry.vertical
      ? viewport.scrollTop + viewport.clientHeight / 2
      : viewport.scrollLeft + viewport.clientWidth / 2;
    const page = Math.floor((offset - (geometry.vertical ? STAGE_MARGIN_PX : leadPx())) / geometry.period) + 1;
    return Math.min(Math.max(page, 1), geometry.pages);
  }

  function updateStats() {
    if (!model || !geometry) return;
    if (isEnglish()) {
      const { words, chars } = model.stats;
      $('stats').textContent =
        `${words.toLocaleString('en-US')} words ・ ${formatNumber(chars)}字 ・ ${currentPage()} / ${geometry.pages}頁`;
      return;
    }
    const { chars, genkoPages } = model.stats;
    $('stats').textContent =
      `${formatNumber(chars)}字 ・ 400字詰め ${formatPages(genkoPages)}枚 ・ ${currentPage()} / ${geometry.pages}頁`;
  }

  /**
   * fileIndex 番目のファイルの、行番号（data-line）を持つ要素。
   * 日本語組版はファイルごとに #flow 直下の .section になる。英語組版はファイルが章にまとめられて
   * .section がファイルに対応しないので、段落の data-file でファイルを指す
   */
  function lineElementsOf(fileIndex) {
    const section = flow.querySelectorAll(':scope > .section')[fileIndex];
    if (section) return [...section.querySelectorAll('[data-line]')];
    return [...flow.querySelectorAll(`[data-file="${fileIndex}"][data-line]`)];
  }

  /** fileIndex のファイルで、行番号が line 以下で一番近い要素（無ければそのファイルの先頭の要素、それも無ければ null） */
  function findLineElement(fileIndex, line) {
    const elements = lineElementsOf(fileIndex);
    let found = null;
    for (const el of elements) {
      if (Number(el.dataset.line) > line) break;
      found = el;
    }
    return found ?? elements[0] ?? null;
  }

  /** エディタのカーソル行 target（{ fileIndex, line }）の段落に印を付け、見えていなければそのページへスクロールする */
  function reveal(target) {
    lastReveal = target;
    flow.querySelector('.cursor-line')?.classList.remove('cursor-line');
    if (!target || !geometry) return;
    const el = findLineElement(target.fileIndex, target.line);
    if (!el) return;
    el.classList.add('cursor-line');

    // 段落がページをまたぐと矩形が複数になる。先頭の断片を基準にする
    const rect = el.getClientRects()[0];
    if (!rect) return;
    const view = viewport.getBoundingClientRect();
    const visible =
      rect.bottom > view.top && rect.top < view.bottom && rect.right > view.left && rect.left < view.right;
    if (visible) return;

    const stageRect = stage.getBoundingClientRect();
    if (geometry.vertical) {
      const page = Math.floor((rect.top - stageRect.top) / geometry.period);
      viewport.scrollTop = STAGE_MARGIN_PX + page * geometry.period - 12;
      if (rect.right > view.right || rect.left < view.left) {
        viewport.scrollLeft += (rect.left + rect.right) / 2 - (view.left + view.right) / 2;
      }
    } else {
      const page = Math.floor((rect.left - stageRect.left) / geometry.period);
      if (geometry.centered) scrollToPage(page + 1);
      else viewport.scrollLeft = leadPx() + page * geometry.period - 12;
      if (rect.bottom > view.bottom || rect.top < view.top) {
        viewport.scrollTop += (rect.top + rect.bottom) / 2 - (view.top + view.bottom) / 2;
      }
    }
  }

  /** 要素が属するファイルの番号 */
  const sectionIndexOf = (el) =>
    el.dataset.file !== undefined
      ? Number(el.dataset.file)
      : [...flow.querySelectorAll(':scope > .section')].indexOf(el.closest('#flow > .section'));

  /** 要素の行をテキストエディタで開いてもらう */
  function jumpToEditor(el) {
    vscode.postMessage({ type: 'jump', fileIndex: sectionIndexOf(el), line: Number(el.dataset.line) });
  }

  /**
   * ルビ・傍点などの記法。プレビュー上での編集は、クリックした段落を元テキスト（記法つき）に戻してその場で編集し、
   * 1行ぶんの変更としてエディタへ送る。編集中は拡張機能から届く再描画を保留し、編集を終えたときに組み直してもらう
   */
  // src/lib/text-parser.mjs の INLINE_MARKUP_RE と同じ記法
  const INLINE_MARKUP_RE = /《《(.+?)》》|\|(.+?)《(.+?)》|<<(.+?)>>|\*([^*]+)\*/g;

  let editEnabled = true;
  let editing = null;
  /** 元テキストに戻した段落が残っている（＝組み直しが要る） */
  let staleDom = false;
  let refreshTimer = 0;

  /** 表示上の文字位置 visible（ルビを除く）を元テキスト raw の位置に直す */
  function rawOffsetFromVisible(raw, visible) {
    let pos = 0;
    let seen = 0;
    for (const m of raw.matchAll(INLINE_MARKUP_RE)) {
      const plain = m.index - pos;
      if (visible <= seen + plain) return pos + (visible - seen);
      seen += plain;
      const inner = m[1] ?? m[2] ?? m[4] ?? m[5];
      const innerStart = m.index + m[0].indexOf(inner);
      if (visible < seen + inner.length) return innerStart + (visible - seen);
      seen += inner.length;
      pos = m.index + m[0].length;
    }
    return Math.min(raw.length, pos + (visible - seen));
  }

  /** 画面上の点 (x, y) が段落 el の表示上の何文字目か（ルビを除く）。el の外なら null */
  function visibleOffsetAt(el, x, y) {
    let node;
    let offset;
    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      node = pos?.offsetNode;
      offset = pos?.offset;
    } else {
      const range = document.caretRangeFromPoint?.(x, y);
      node = range?.startContainer;
      offset = range?.startOffset;
    }
    if (!node || !el.contains(node)) return null;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.setEnd(node, offset);
    const fragment = range.cloneContents();
    for (const n of fragment.querySelectorAll('rt, rp')) n.remove();
    return fragment.textContent.length;
  }

  /** 段落 el の中の選択範囲の { start, end }（文字位置）。el の中に無ければ null */
  function selectionOffsets(el) {
    const sel = getSelection();
    if (!sel.rangeCount || !el.contains(sel.anchorNode)) return null;
    const range = sel.getRangeAt(0);
    const before = document.createRange();
    before.selectNodeContents(el);
    before.setEnd(range.startContainer, range.startOffset);
    const start = before.toString().length;
    return { start, end: start + range.toString().length };
  }

  /** 段落 el を元テキストに戻して編集を始め、offset の位置（省略時は末尾）にカーソルを置く */
  function beginEdit(el, offset) {
    const fileIndex = sectionIndexOf(el);
    const line = Number(el.dataset.line);
    const raw = model.sources[fileIndex]?.[line];
    if (raw === undefined) return;

    clearTimeout(refreshTimer);
    // 何も変えずに抜けたときは組み直しを頼まずその場で戻せるよう、組版ずみの html を取っておく
    editing = { el, fileIndex, line, text: raw, original: raw, html: el.innerHTML };
    el.textContent = raw;
    el.contentEditable = 'plaintext-only';
    el.classList.add('editing');
    el.focus({ preventScroll: true });
    const sel = getSelection();
    if (el.firstChild) sel.collapse(el.firstChild, Math.min(offset ?? raw.length, raw.length));
    else sel.collapse(el, 0);
    layoutStage();
  }

  /** 編集を終える。何も変えていなければ組版ずみの表示に戻し、変えていれば元テキストのまま残して組み直しを待つ */
  function endEdit() {
    if (!editing) return;
    // contenteditable を外すとその場で focusout が走るので、先に編集状態を畳んでおく
    const { el, html, original } = editing;
    editing = null;
    el.removeAttribute('contenteditable');
    el.classList.remove('editing');
    if (el.textContent === original) {
      el.innerHTML = html;
    } else {
      el.classList.add('stale-raw');
      staleDom = true;
    }
  }

  /** 段落 el の表示上の行ごとの矩形 */
  function lineRects(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    return rects.length > 0 ? rects : [el.getBoundingClientRect()];
  }

  const rectsOverlap = (a, b) =>
    Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;

  /** カーソルが段落の先頭行・最終行・文頭・文末のどこにあるかと、行の中での位置 inline（字を送る方向のpx）。範囲を選択中・el の外なら null */
  function caretPosition(el) {
    const sel = getSelection();
    if (!sel.isCollapsed || !el.contains(sel.anchorNode)) return null;
    const text = el.firstChild;
    if (!text || text.length === 0) return { first: true, last: true, atStart: true, atEnd: true, inline: 0 };

    const offset = sel.anchorNode === text ? sel.anchorOffset : sel.anchorOffset === 0 ? 0 : text.length;
    const charRect = (from, to) => {
      const range = document.createRange();
      range.setStart(text, from);
      range.setEnd(text, to);
      return range.getClientRects()[0];
    };
    // 折り返し位置では行末と次行頭が同じオフセットになる。表示は次行頭なので後ろの文字を優先する
    const after = offset < text.length ? charRect(offset, offset + 1) : null;
    const rect = after ?? charRect(offset - 1, offset);
    const lines = lineRects(el);
    const current = rect && lines.find((l) => rectsOverlap(l, rect));
    if (!current) return null;

    const vertical = geometry.vertical;
    const caretEdge = after ? (vertical ? rect.top : rect.left) : vertical ? rect.bottom : rect.right;
    return {
      first: current === lines[0],
      last: current === lines[lines.length - 1],
      atStart: offset === 0,
      atEnd: offset === text.length,
      inline: caretEdge - (vertical ? current.top : current.left),
    };
  }

  /** rect が表示領域の縁から 24px 以内に入るようスクロールする */
  function scrollRectIntoView(rect) {
    const view = viewport.getBoundingClientRect();
    const margin = 24;
    if (rect.top < view.top + margin) viewport.scrollTop -= view.top + margin - rect.top;
    else if (rect.bottom > view.bottom - margin) viewport.scrollTop += rect.bottom - (view.bottom - margin);
    if (rect.left < view.left + margin) viewport.scrollLeft -= view.left + margin - rect.left;
    else if (rect.right > view.right - margin) viewport.scrollLeft += rect.right - (view.right - margin);
  }

  /** 隣の段落へ編集を移す。inline があれば、行の中での位置を保って先頭行（dir > 0）／最終行（dir < 0）に入る */
  function moveEditTo(target, dir, inline) {
    endEdit();
    beginEdit(target, dir > 0 ? 0 : undefined);
    if (!editing) return;

    const pick = (lines) => (dir > 0 ? lines[0] : lines[lines.length - 1]);
    scrollRectIntoView(pick(lineRects(target)));
    if (inline == null) return;

    const line = pick(lineRects(target));
    const clamp = (v, min, max) => Math.min(Math.max(v, min + 1), max - 1);
    const x = geometry.vertical ? line.left + line.width / 2 : clamp(line.left + inline, line.left, line.right);
    const y = geometry.vertical ? clamp(line.top + inline, line.top, line.bottom) : line.top + line.height / 2;
    const pos = document.caretPositionFromPoint?.(x, y);
    const range = pos ? null : document.caretRangeFromPoint?.(x, y);
    const node = pos?.offsetNode ?? range?.startContainer;
    if (node && target.contains(node)) getSelection().collapse(node, pos?.offset ?? range.startOffset);
  }

  /** 編集中のカーソルキー。段落の端から外へ出る向きなら、隣の段落へ編集を移す */
  function handleArrowKey(e) {
    const vertical = geometry.vertical;
    const keys = vertical
      ? { ArrowLeft: [1, true], ArrowRight: [-1, true], ArrowDown: [1, false], ArrowUp: [-1, false] }
      : { ArrowDown: [1, true], ArrowUp: [-1, true], ArrowRight: [1, false], ArrowLeft: [-1, false] };
    const move = keys[e.key];
    if (!move || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
    const [dir, byLine] = move;

    const pos = caretPosition(editing.el);
    if (!pos) return;
    const leaving = byLine ? (dir > 0 ? pos.last : pos.first) : dir > 0 ? pos.atEnd : pos.atStart;
    if (!leaving) return;

    const editable = [...flow.querySelectorAll('[data-line]')];
    const target = editable[editable.indexOf(editing.el) + dir];
    if (!target) return;
    e.preventDefault();
    moveEditTo(target, dir, byLine ? pos.inline : null);
  }

  /** 元テキストに戻した段落を組み直してもらう。focusEdit があれば描画後にそこで編集を始める */
  function requestRefresh(focusEdit = null) {
    clearTimeout(refreshTimer);
    endEdit();
    vscode.postMessage({ type: 'refresh', focusEdit });
  }

  /** 編集中の段落のテキストが変わっていれば、1行の置き換えとして拡張機能へ送る */
  function sendLineEdit() {
    const { el, fileIndex, line } = editing;
    const text = el.textContent;
    if (text === editing.text) return;
    editing.text = text;
    if (text.includes('\n')) {
      // 複数行の貼り付け。行番号がずれるので編集を終えて組み直してもらう
      endEdit();
      vscode.postMessage({ type: 'edit', fileIndex, line, text });
      return;
    }
    model.sources[fileIndex][line] = text;
    vscode.postMessage({ type: 'edit', fileIndex, line, text });
    layoutStage();
  }

  /** プレビュー上での編集のオンオフ。オフにしたとき元テキストのままの段落があれば組み直してもらう */
  function setEditEnabled(enabled) {
    editEnabled = enabled;
    $('toggle-edit').setAttribute('aria-pressed', String(enabled));
    flow.classList.toggle('editable', enabled);
    if (!enabled && staleDom) requestRefresh();
  }

  flow.addEventListener('click', (e) => {
    const el = e.target.closest?.('[data-line]');
    if (!el || !model) return;
    if (e.metaKey || e.ctrlKey) return jumpToEditor(el);
    if (!editEnabled || el === editing?.el) return;

    // 見出しは表示（章番号つき・【】や Subhead: なし）と元テキストが一致しないので、行末にカーソルを置く
    const heading = ['viewpoint', 'empty', 'chapter-title', 'chapter-subhead'].some((c) => el.classList.contains(c));
    const visible = heading ? null : visibleOffsetAt(el, e.clientX, e.clientY);
    const raw = model.sources[sectionIndexOf(el)]?.[Number(el.dataset.line)] ?? '';
    // 変更ずみで元テキストのまま表示している段落は、表示位置がそのまま元テキストの位置
    const offset =
      visible == null ? raw.length : el.classList.contains('stale-raw') ? visible : rawOffsetFromVisible(raw, visible);
    beginEdit(el, offset);
  });

  flow.addEventListener('dblclick', (e) => {
    const el = e.target.closest?.('[data-line]');
    if (el && !editEnabled) jumpToEditor(el);
  });

  flow.addEventListener('input', (e) => {
    if (editing && !e.isComposing) sendLineEdit();
  });
  flow.addEventListener('compositionend', () => {
    if (editing) sendLineEdit();
  });

  flow.addEventListener('keydown', (e) => {
    if (!editing || e.isComposing || e.keyCode === 229) return;
    const { el, fileIndex, line } = editing;

    if (e.key.startsWith('Arrow')) {
      handleArrowKey(e);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      requestRefresh();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const text = el.textContent;
      const { start, end } = selectionOffsets(el) ?? { start: text.length, end: text.length };
      endEdit();
      vscode.postMessage({
        type: 'edit',
        fileIndex,
        line,
        text: `${text.slice(0, start)}\n${text.slice(end)}`,
        focus: { fileIndex, line: line + 1, offset: 0 },
      });
    } else if (e.key === 'Backspace' && line > 0) {
      const offsets = selectionOffsets(el);
      if (offsets?.start !== 0 || offsets.end !== 0) return;
      e.preventDefault();
      endEdit();
      vscode.postMessage({ type: 'merge', fileIndex, line });
    }
  });

  flow.addEventListener('focusout', (e) => {
    if (!editing || e.target !== editing.el) return;
    endEdit();
    // 別の段落をクリックした場合はそちらの処理が組み直しを頼むので、少し待つ
    refreshTimer = setTimeout(() => {
      if (!editing && staleDom) vscode.postMessage({ type: 'refresh' });
    }, 150);
  });

  // 取り消し・やり直しは VS Code に渡さず拡張機能に頼む。カスタムエディタのタブでは VS Code の取り消しが
  // 開いたファイルにしか効かず、作品全体の表示で別のファイルを編集したあとに無関係な変更を取り消してしまうため。
  // VS Code が webview のキー入力を拾うのは window のバブリング段階なので、キャプチャ段階で止める
  window.addEventListener(
    'keydown',
    (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.isComposing) return;
      const key = e.key.toLowerCase();
      if (key !== 'z' && key !== 'y') return;
      e.preventDefault();
      e.stopPropagation();
      vscode.postMessage({ type: key === 'y' || e.shiftKey ? 'redo' : 'undo' });
    },
    true,
  );

  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      vscode.postMessage({ type: 'save' });
    }
  });

  /** ツールバーとページ設定の欄を、render で届いた値で埋める。英語の原稿は横書き固定で、設定ファイルの "english" のレイアウトを見せる */
  function fillForm() {
    const { layout, metrics, presets, presetName, scope, canShowWork, userPresetNames, layoutFile, language } = model;
    const english = language === 'en';

    const preset = $('preset');
    preset.replaceChildren();
    if (!presetName) preset.append(new Option('（カスタム）', ''));
    for (const name of Object.keys(presets)) preset.append(new Option(name, name));
    preset.value = presetName ?? '';

    $('grid-fields').hidden = english;
    $('en-fields').hidden = !english;
    $('chars').value = layout.chars ?? '';
    $('lines').value = layout.lines ?? '';
    $('lines').placeholder = `自動(${metrics.lines})`;
    $('font-size').value = english ? layout.fontSize : '';
    $('line-height').value = english ? layout.lineHeight : '';

    $('language-note').textContent = english ? '英語の原稿（横書き固定。設定は english に保存）' : '';
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

    for (const button of /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('#scope button'))) {
      button.setAttribute('aria-pressed', String(button.dataset.scope === scope));
      if (button.dataset.scope === 'work') button.disabled = !canShowWork;
    }
  }

  /** ページ設定の欄の値（レイアウト） */
  function readForm() {
    return {
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
    el.addEventListener('change', () => vscode.postMessage({ type: 'layout', layout: readForm() }));
  }
  $('preset').addEventListener('change', (e) => {
    if (e.target.value) vscode.postMessage({ type: 'preset', name: e.target.value });
  });
  $('scope').addEventListener('click', (e) => {
    const scope = e.target.dataset?.scope;
    if (scope) vscode.postMessage({ type: 'view', view: { scope } });
  });
  $('toggle-setup').addEventListener('click', () => {
    const setup = $('setup');
    setup.hidden = !setup.hidden;
    $('toggle-setup').setAttribute('aria-pressed', String(!setup.hidden));
    layoutStage();
  });
  $('toggle-edit').addEventListener('click', () => {
    setEditEnabled(!editEnabled);
    vscode.postMessage({ type: 'view', view: { edit: editEnabled } });
  });
  $('open-text').addEventListener('click', () => {
    const view = viewport.getBoundingClientRect();
    const isVisible = (el) =>
      [...el.getClientRects()].some(
        (r) => r.bottom > view.top && r.top < view.bottom && r.right > view.left && r.left < view.right,
      );
    const el = editing?.el ?? [...flow.querySelectorAll('[data-line]')].find(isVisible);
    vscode.postMessage(
      el ? { type: 'openText', fileIndex: sectionIndexOf(el), line: Number(el.dataset.line) } : { type: 'openText' },
    );
  });
  $('zoom').addEventListener('change', (e) => {
    zoom = normalizeZoom(e.target.value);
    vscode.postMessage({ type: 'view', view: { zoom: zoom === 'fit' ? zoom : Number(zoom) } });
    layoutStage();
    reveal(lastReveal);
  });
  $('save-preset').addEventListener('click', () => vscode.postMessage({ type: 'savePreset' }));
  $('delete-preset').addEventListener('click', () =>
    vscode.postMessage({ type: 'deletePreset', name: $('preset').value }),
  );
  $('export-pdf').addEventListener('click', () => vscode.postMessage({ type: 'exportPdf' }));

  // PDF 用 CSS の hanging-punctuation: allow-end last は Chromium では効かないので、Vivliostyle と同じ方法で再現する。
  // 句読点を文字送り 0（letter-spacing: -1em）にし、直後に 1 字ぶんの隠しスペースを置く（preview.css の .hang）。
  // 行の途中ではスペースが句読点のマスを埋めて見た目が変わらず、行末に来たときだけスペースが行末の空白として消え、
  // 句読点が版面の外にぶら下がる。段落末の閉じ括弧は常に文字送り 0 にして、最後のマスからはみ出せるようにする
  const HANG_RE = /[、。，．]/;
  // Vivliostyle と同じく、直後が閉じ括弧・句読点などの行頭禁則文字ならぶら下げない（括弧だけが次行へ逃げるため）
  const NO_HANG_BEFORE_RE = /^[\p{Pe}\p{Pf}·‧・　：；、。，．]/u;
  const HANG_LAST_RE = /[\p{Pe}\p{Pf}\p{Pi}'"]$/u;

  /** テキストノード node の index 文字目を className の span で包む */
  function wrapChar(node, index, className) {
    const target = index > 0 ? node.splitText(index) : node;
    if (target.length > 1) target.splitText(1);
    const span = document.createElement('span');
    span.className = className;
    target.replaceWith(span);
    span.append(target);
  }

  /** root の段落の、ぶら下げる句読点を .hang、段落末の括弧・引用符を .hang-last で包む */
  function wrapHangingPunctuation(root) {
    for (const p of root.querySelectorAll('p')) {
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement.closest('rt, rp') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      if (nodes.length === 0) continue;
      const text = nodes.map((n) => n.data).join('');
      const targets = [];
      let base = 0;
      for (const node of nodes) {
        for (const m of node.data.matchAll(new RegExp(HANG_RE, 'g'))) {
          const next = text.slice(base + m.index + 1, base + m.index + 2);
          if (!NO_HANG_BEFORE_RE.test(next)) targets.push([node, m.index, 'hang']);
        }
        base += node.length;
      }
      const last = nodes[nodes.length - 1];
      if (HANG_LAST_RE.test(last.data)) targets.push([last, last.length - 1, 'hang-last']);
      // 後ろから包めば、splitText で前の位置がずれない
      for (const [node, i, cls] of targets.reverse()) wrapChar(node, i, cls);
    }
  }

  window.addEventListener('message', ({ data }) => {
    if (data.type === 'render') {
      if (editing && !data.focusEdit && !data.external) {
        // 編集中の段落を壊さないよう、自分の入力の反映による組み直しは編集を終えるまで保留する
        model.stats = data.stats;
        updateStats();
        return;
      }
      if (editing && !data.focusEdit) {
        const { fileIndex, line } = editing;
        // 外からの変更（取り消しなど）は編集中の段落も組み直すので、同じ行・同じ位置で編集を続けられるようにする
        data.focusEdit = { fileIndex, line, offset: selectionOffsets(editing.el)?.start ?? 0 };
      }
      endEdit();
      clearTimeout(refreshTimer);
      model = data;
      staleDom = false;
      zoom = normalizeZoom(data.view.zoom);
      $('zoom').value = zoom;
      if (data.view.edit !== editEnabled) setEditEnabled(data.view.edit);
      $('message').hidden = true;
      stage.hidden = false;
      $('doc-style').textContent = data.css;
      // lang で hyphens: auto（英語の分綴）が効く
      flow.lang = data.language;
      flow.classList.toggle('en', isEnglish());
      flow.innerHTML = data.body;
      if (!isEnglish()) wrapHangingPunctuation(flow);
      // ルビは検索（Cmd+F）の対象から外す。親文字の間に読みが挟まると「鯨渕」のような語が見つからなくなるため
      for (const rt of flow.querySelectorAll('rt')) rt.inert = true;
      fillForm();
      layoutStage();
      const restored = !scrollRestored && restoreScroll();
      const focus = data.focusEdit;
      const target =
        focus &&
        flow.querySelectorAll(':scope > .section')[focus.fileIndex]?.querySelector(`[data-line="${focus.line}"]`);
      if (target && editEnabled) {
        beginEdit(target, focus.offset);
        target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      } else if (restored) {
        // 再読み込み前の位置に戻したので、エディタのカーソル位置へは動かさない（行の色付けだけ）
        lastReveal = data.reveal ?? lastReveal;
      } else if (data.forceReveal) {
        reveal(data.reveal);
      } else if (!document.hasFocus() || !editEnabled) {
        // プレビュー側で作業している間は、エディタのカーソル位置へ引き戻さない
        reveal(data.reveal ?? lastReveal);
      }
    } else if (data.type === 'reveal') {
      reveal(data.target);
    } else if (data.type === 'message') {
      $('message').textContent = data.text;
      $('message').hidden = false;
      stage.hidden = true;
    }
  });

  // 倍率が変わっても同じ位置に戻せるよう、スクロール位置はページ単位で覚える
  let scrollRestored = false;
  let saveScrollFrame = 0;

  /** スクロール位置をページ単位で webview の state に覚える（ウィンドウの再読み込み後に戻すため） */
  function saveScroll() {
    if (!geometry || !scrollRestored) return;
    const offset = geometry.vertical ? viewport.scrollTop : viewport.scrollLeft;
    vscode.setState({ scrollPages: offset / geometry.period });
  }

  /** 覚えたスクロール位置に戻す。再読み込み後の最初の描画でだけ呼ぶ。戻す位置があれば true */
  function restoreScroll() {
    scrollRestored = true;
    const pages = vscode.getState()?.scrollPages;
    if (!geometry || !(pages > 0)) return false;
    if (geometry.vertical) viewport.scrollTop = pages * geometry.period;
    else viewport.scrollLeft = pages * geometry.period;
    return true;
  }

  viewport.addEventListener(
    'scroll',
    () => {
      updateStats();
      cancelAnimationFrame(saveScrollFrame);
      saveScrollFrame = requestAnimationFrame(saveScroll);
    },
    { passive: true },
  );

  const WHEEL_THRESHOLD_PX = 8;
  const WHEEL_QUIET_MS = 150;
  const WHEEL_MIN_INTERVAL_MS = 250;
  /**
   * ホイールでのページ送りの状態。ひと払い（トラックパッドなら慣性まで含めたひと続き）で1ページだけ送り、
   * 送ったあとの入力は、途切れる・向きが変わる・慣性で弱まったあとに強まる（＝次を払った）まで捨てる
   */
  const wheel = { armed: true, accum: 0, lastAt: 0, lastAbs: 0, lastSign: 0, peak: 0, decaying: false, turnedAt: 0 };

  /**
   * page ページ目（1始まり）へスクロールする。用紙が表示領域に収まるなら真ん中に、収まらなければ用紙の頭を表示領域の頭に合わせる
   * （横書きで1ページずつ中央に出す表示では、収まらなくても真ん中を見せる＝左右の余白だけが切れる）
   */
  function scrollToPage(page) {
    if (!geometry) return;
    const index = Math.min(Math.max(page, 1), geometry.pages) - 1;
    const start = (geometry.vertical ? STAGE_MARGIN_PX : leadPx()) + index * geometry.period;
    const client = geometry.vertical ? viewport.clientHeight : viewport.clientWidth;
    const slack = (client - geometry.sheet) / 2;
    const offset = start - (geometry.centered ? slack : Math.max(0, slack));
    if (geometry.vertical) viewport.scrollTop = offset;
    else viewport.scrollLeft = offset;
  }

  /** 送ったあとの入力が次のひと払いか（途切れた・向きが変わった・慣性で弱まったあとに強まった） */
  function isNewWheelGesture(now, abs, sign) {
    if (now - wheel.lastAt > WHEEL_QUIET_MS) return true;
    if (sign !== wheel.lastSign) return true;
    if (now - wheel.turnedAt < WHEEL_MIN_INTERVAL_MS) return false;
    return wheel.decaying && abs > wheel.lastAbs * 1.5 + 2;
  }

  viewport.addEventListener(
    'wheel',
    (e) => {
      // ピンチ（Ctrl+ホイール）は VS Code の拡大縮小に任せる
      if (!geometry || e.ctrlKey) return;
      // 縦書きの横方向はページ内の左右の移動なので、通常のスクロールに任せる
      if (geometry.vertical && Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (delta === 0) return;
      const now = e.timeStamp;
      const abs = Math.abs(delta);
      const sign = Math.sign(delta);
      if (!wheel.armed && isNewWheelGesture(now, abs, sign)) {
        wheel.armed = true;
        wheel.accum = 0;
      }
      wheel.lastAt = now;
      wheel.lastAbs = abs;
      wheel.lastSign = sign;
      wheel.peak = Math.max(wheel.peak, abs);
      if (abs < wheel.peak * 0.5) wheel.decaying = true;
      if (!wheel.armed) return;
      wheel.accum += delta;
      if (Math.abs(wheel.accum) < WHEEL_THRESHOLD_PX) return;
      wheel.armed = false;
      wheel.turnedAt = now;
      wheel.peak = abs;
      wheel.decaying = false;
      scrollToPage(currentPage() + Math.sign(wheel.accum));
    },
    { passive: false },
  );

  /**
   * キーでのページ送り（キー → 送るページ数）。段落を編集していないとき（入力欄にもいないとき）に使う
   */
  // 縦書きは左へ読み進めるので ← を次のページにする
  const PAGE_KEYS_VERTICAL = {
    ArrowDown: 1,
    ArrowLeft: 1,
    PageDown: 1,
    ' ': 1,
    ArrowUp: -1,
    ArrowRight: -1,
    PageUp: -1,
  };
  const PAGE_KEYS_HORIZONTAL = {
    ArrowDown: 1,
    ArrowRight: 1,
    PageDown: 1,
    ' ': 1,
    ArrowUp: -1,
    ArrowLeft: -1,
    PageUp: -1,
  };

  window.addEventListener('keydown', (e) => {
    if (!geometry || editing || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = /** @type {HTMLElement} */ (e.target);
    if (target.isContentEditable || target.closest('input, select, textarea, #setup')) return;
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      scrollToPage(e.key === 'Home' ? 1 : geometry.pages);
      return;
    }
    const step = (geometry.vertical ? PAGE_KEYS_VERTICAL : PAGE_KEYS_HORIZONTAL)[e.key];
    if (!step) return;
    e.preventDefault();
    scrollToPage(currentPage() + (e.key === ' ' && e.shiftKey ? -step : step));
  });

  let resizeFrame = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(layoutStage);
  }).observe(viewport);

  // Webフォントが届くと字幅が変わりうるので割り直す
  document.fonts?.addEventListener?.('loadingdone', layoutStage);

  setEditEnabled(editEnabled);
  vscode.postMessage({ type: 'ready' });
})();
