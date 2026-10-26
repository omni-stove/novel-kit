// @ts-check

/**
 * 作品の設定（novel.json）のフォームを root に作る。作品の設定の画面（settings-page.js）と、小説パネルの「作品設定」のタブ（panel.js）で使う。
 * post(msg): 拡張へメッセージ（update / build / openFile / openText / create）を送る。
 * scroller: 作り直したあとにスクロール位置を戻す要素（既定は文書全体）。
 * 返す値の render(state) で、拡張から届いた状態を画面にする
 */
// biome-ignore lint/correctness/noUnusedVariables: 別の script（settings-page.js / preview.js）から呼ぶ
function createWorkSettingsForm(root, post, { scroller = document.scrollingElement } = {}) {
  root.classList.add('work-settings');
  const fileLabel = h('span', { className: 'work-file' });
  const buildButton = h('button', {
    textContent: t('Build Outputs…'),
    title: t('Choose from the outputs in novel.json and make them (same as novel build)'),
    onclick: () => post({ type: 'build' }),
  });
  const openTextButton = h('button', {
    textContent: t('Open as Text'),
    title: t('Open novel.json in the text editor'),
    onclick: () => post({ type: 'openText' }),
  });
  const errorBox = h('p', { className: 'work-error', hidden: true });
  const form = h('div', { className: 'work-form' });
  root.replaceChildren(
    h(
      'header',
      { className: 'work-head' },
      h('strong', { textContent: t('Work Settings') }),
      fileLabel,
      buildButton,
      openTextButton,
    ),
    errorBox,
    form,
  );

  /**
   * 拡張から届いた状態。file: novel.json の表示名、error: 読めないときの理由、missing: novel.json が無いとき作る場所、
   * raw: novel.json の中身、fields: 入力欄の定義（work / english / output: format → 項目）、
   * formats: [{ format, description }]、work: 原稿ファイルの並び（describeWorkFiles）、dirs: 原稿の欄で選べるディレクトリ（manuscriptDirs）、outputs: { defaultOut, error }
   */
  let state = null;

  const clone = (v) => JSON.parse(JSON.stringify(v));

  /** raw の写しを mutate で変えて拡張に送る（拡張が novel.json に書き、組み直した状態を送り返す） */
  function commit(mutate) {
    const raw = clone(state.raw);
    mutate(raw);
    state.raw = raw;
    post({ type: 'update', raw });
  }

  /** obj の key に value を書く。undefined なら消す */
  function assign(obj, key, value) {
    if (value === undefined) delete obj[key];
    else obj[key] = value;
  }

  /** "english" の中の項目を書く。空になった english は消す */
  function assignEnglish(raw, key, value) {
    const english = raw.english && typeof raw.english === 'object' ? raw.english : {};
    assign(english, key, value);
    if (Object.keys(english).length > 0) raw.english = english;
    else delete raw.english;
  }

  /** 出力の定義を「出力名 → 項目」の形にする（配列で書いてあれば、各出力を true にする） */
  function outputsObject(raw) {
    if (Array.isArray(raw.outputs)) raw.outputs = Object.fromEntries(raw.outputs.map((name) => [name, true]));
    if (!raw.outputs || typeof raw.outputs !== 'object') raw.outputs = {};
    return raw.outputs;
  }

  /** 出力 name の項目を書く。項目が無くなれば true（novel build の「項目が無ければ true」） */
  function assignOutput(raw, name, key, value) {
    const outputs = outputsObject(raw);
    const output = outputs[name] && typeof outputs[name] === 'object' ? outputs[name] : {};
    assign(output, key, value);
    outputs[name] = Object.keys(output).length > 0 ? output : true;
  }

  /**
   * 要素を作る。props は要素のプロパティ（className / textContent / onclick など）か属性、dataset は data-* に入れる。
   * 値が undefined / null / false のものは付けない
   * @returns {any}
   */
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key in el && key !== 'list') el[key] = value;
      else el.setAttribute(key, value === true ? '' : String(value));
    }
    el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
    return el;
  }

  const listText = (value) => (Array.isArray(value) ? value.join('\n') : '');
  const parseList = (text) =>
    text
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

  /**
   * 項目1つの入力欄。field: 入力欄の定義、value: 今の値（undefined なら書いていない）、
   * write(value): 値を書く（undefined で消す）、id: フォーカスを戻すための識別子、placeholder: 書いていないときに効く値
   */
  function fieldInput(field, value, write, id, placeholder = '') {
    const isNull = value === null;
    const dataset = { field: id };
    const title = field.description;
    let input;
    if (field.kind === 'boolean') {
      input = h(
        'select',
        { dataset, title },
        h('option', { value: '', textContent: t('Default') }),
        h('option', { value: 'true', textContent: t('Yes') }),
        h('option', { value: 'false', textContent: t('No') }),
      );
      input.value = value === true ? 'true' : value === false ? 'false' : '';
      input.addEventListener('change', () => write(input.value === '' ? undefined : input.value === 'true'));
    } else if (field.kind === 'enum') {
      input = h(
        'select',
        { dataset, title },
        h('option', {
          value: '',
          textContent: field.trims ? t('Default ({0})', field.trims[field.default].label) : t('Default'),
        }),
        field.options.map((o) => h('option', { value: o, textContent: field.trims?.[o]?.label ?? o })),
      );
      input.value = typeof value === 'string' ? value : '';
      input.addEventListener('change', () => write(input.value || undefined));
    } else if (field.kind === 'integer' || field.kind === 'number') {
      input = h('input', {
        type: 'number',
        dataset,
        title,
        min: field.min,
        max: field.max,
        step: field.kind === 'integer' ? 1 : 'any',
        value: typeof value === 'number' ? String(value) : '',
        placeholder,
        disabled: isNull,
      });
      input.addEventListener('change', () => {
        const n = Number(input.value);
        write(input.value.trim() === '' || !Number.isFinite(n) ? undefined : n);
      });
    } else if (field.key === 'input') {
      // 複数やファイルを書いた原稿は選択肢に無いので、消さずにその値の選択肢として残す
      const current = Array.isArray(value) && value.length > 0 ? value.join(', ') : null;
      const custom = current !== null && !(value.length === 1 && state.dirs.includes(value[0]));
      input = h(
        'select',
        { dataset, title, disabled: isNull },
        h('option', { value: '', textContent: placeholder ? t('Default ({0})', placeholder) : t('Default') }),
        state.dirs.map((d) => h('option', { value: d, textContent: d })),
        custom && h('option', { value: '\0', textContent: current }),
      );
      input.value = custom ? '\0' : (current ?? '');
      input.addEventListener('change', () => {
        if (input.value !== '\0') write(input.value ? [input.value] : undefined);
      });
    } else if (field.kind === 'list') {
      input = h('textarea', {
        dataset,
        title,
        rows: Math.max(1, Array.isArray(value) ? value.length : 1),
        value: listText(value),
        placeholder: placeholder || t('One per line'),
        disabled: isNull,
      });
      input.addEventListener('change', () => {
        const list = parseList(input.value);
        write(list.length > 0 ? list : undefined);
      });
    } else {
      input = h('input', {
        type: 'text',
        dataset,
        title,
        value: typeof value === 'string' ? value : '',
        placeholder,
        disabled: isNull,
      });
      input.addEventListener('change', () => write(input.value.trim() === '' ? undefined : input.value));
    }

    const nullToggle =
      field.nullable &&
      h(
        'label',
        {
          className: 'null-toggle',
          title: t('Write null (not used in this output; for lines, the leading is automatic)'),
        },
        h('input', {
          type: 'checkbox',
          checked: isNull,
          dataset: { field: `${id}#null` },
          onchange: (e) => write(e.target.checked ? null : undefined),
        }),
        t('None'),
      );
    return h(
      'label',
      { className: `field field-${field.kind}${field.trims ? ' field-trim' : ''}` },
      h('span', { textContent: field.label, title }),
      input,
      nullToggle,
    );
  }

  /** SVG の要素を作る。attrs は属性 */
  function svg(tag, attrs = {}, ...children) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
    el.append(...children);
    return el;
  }

  /**
   * novel-pdf の判型 trim（work-settings.mjs の describeTrims）の見開きの図と寸法。
   * 用紙・版面と、行ごとに字数ぶんのマス目を mm の座標で描く。縦書きなので行は右のページの右端から並ぶ
   */
  function trimSpread(trim) {
    const { width, height, margin, chars, lines, fontSizePt, linePitchMm } = trim;
    const fontMm = (fontSizePt * 25.4) / 72;
    const page = (x0) => {
      const columns = Array.from(
        { length: lines },
        (_, i) => x0 + width - margin.side - (i + 1) * linePitchMm + (linePitchMm - fontMm) / 2,
      );
      const cells = columns
        .flatMap((x) => Array.from({ length: chars - 1 }, (_, j) => `M${x} ${margin.top + (j + 1) * fontMm}h${fontMm}`))
        .join('');
      return svg(
        'g',
        {},
        svg('rect', { class: 'trim-paper', x: x0, y: 0, width, height }),
        svg('path', { class: 'trim-cells', d: cells }),
        ...columns.map((x) =>
          svg('rect', { class: 'trim-line', x, y: margin.top, width: fontMm, height: chars * fontMm }),
        ),
      );
    };
    return h(
      'figure',
      { className: 'trim-spread' },
      svg(
        'svg',
        {
          viewBox: `-1 -1 ${width * 2 + 2} ${height + 2}`,
          role: 'img',
          'aria-label': t('Two-page spread of novel-pdf at this trim size'),
        },
        page(0),
        page(width),
      ),
      h('figcaption', {
        textContent: `${trim.caption}　${t(
          '{0}pt type, {1}mm leading, margins: top {2}, bottom {3}, sides {4}mm',
          fontSizePt,
          linePitchMm.toFixed(2),
          margin.top,
          margin.bottom,
          margin.side,
        )}`,
      }),
    );
  }

  function section(title, description, ...children) {
    return h(
      'section',
      { className: 'card' },
      h('h2', { textContent: title }),
      description && h('p', { className: 'note', textContent: description }),
      ...children,
    );
  }

  function workSection() {
    const { raw, fields } = state;
    return section(
      t('Work Information'),
      t(
        'Used for the PDF title page and running heads, and for output file names. Manuscript paths are relative to the directory of novel.json',
      ),
      h(
        'div',
        { className: 'grid' },
        fields.work.map((f) =>
          fieldInput(
            f,
            raw[f.key],
            (v) => commit((r) => assign(r, f.key, v)),
            `work.${f.key}`,
            { id: raw.title ?? '', input: '.', sceneBreak: '＊', sceneBreakIndent: t('Centered') }[f.key] ?? '',
          ),
        ),
      ),
    );
  }

  function englishSection() {
    const { raw, fields } = state;
    const english = raw.english && typeof raw.english === 'object' ? raw.english : {};
    const placeholders = { title: raw.title ?? '', author: raw.author ?? '', input: 'en', sceneBreak: '* * *' };
    return section(
      t('English Outputs'),
      t('Used for pdf-en / rtf-en'),
      h(
        'div',
        { className: 'grid' },
        fields.english.map((f) =>
          fieldInput(
            f,
            english[f.key],
            (v) => commit((r) => assignEnglish(r, f.key, v)),
            `english.${f.key}`,
            placeholders[f.key] ?? '',
          ),
        ),
      ),
    );
  }

  const partTokens = (raw) => (Array.isArray(raw.parts) ? raw.parts.map(String) : []);
  const byNumber = (a, b) => Number(a) - Number(b) || a.localeCompare(b);

  /** parts の指定が当たるファイルの添字（matchPartIndices と同じく、番号の一致を先に、無ければファイル順）。当たらなければ -1 */
  function indexOfPart(tok, files) {
    const byPrefix = files.findIndex((f) => f.token === tok);
    if (byPrefix >= 0) return byPrefix;
    const n = parseInt(tok, 10);
    return Number.isNaN(n) || n < 1 || n > files.length ? -1 : n - 1;
  }

  /** i 番目のファイルから新しい部にする / しない */
  function togglePart(i, on) {
    commit((r) => {
      const tokens = new Set(partTokens(r));
      if (on) tokens.add(state.work.files[i].token);
      else for (const tok of tokens) if (indexOfPart(tok, state.work.files) === i) tokens.delete(tok);
      r.parts = [...tokens].sort(byNumber);
    });
  }

  function partsSection() {
    const { raw, work } = state;
    // 境界をまだ選んでいなくても、"parts" があれば部に分ける指定をしたものとして表を出す
    const enabled = Array.isArray(raw.parts);
    const toggle = h(
      'label',
      {},
      h('input', {
        type: 'checkbox',
        checked: enabled,
        dataset: { field: 'parts#enabled' },
        onchange: (e) => commit((r) => assign(r, 'parts', e.target.checked ? [] : undefined)),
      }),
      t('Divide into parts'),
    );
    const description = t(
      'A new part starts at each checked file, and chapters are numbered "part-chapter" (just "part" when a part has one chapter). The PDF, the preview, the outline and split / merge use the same numbers',
    );
    if (!enabled) return section(t('Part Boundaries'), null, toggle);
    const tokens = partTokens(raw);
    const rows = [];
    let part = 1;
    work.files.forEach((file, i) => {
      if (file.startsPart) part++;
      if (tokens.length > 0 && (i === 0 || file.startsPart))
        rows.push(h('tr', { className: 'part-row' }, h('td', { colSpan: 4, textContent: t('Part {0}', part) })));
      rows.push(
        h(
          'tr',
          {},
          h(
            'td',
            {},
            h('input', {
              type: 'checkbox',
              checked: file.startsPart,
              disabled: i === 0 || file.token === null,
              title:
                i === 0
                  ? t('The first file always starts part 1')
                  : file.token === null
                    ? t('This file cannot start a part because its name does not begin with a number')
                    : t('Start a new part at this file'),
              dataset: { field: `part.${file.name}` },
              onchange: (e) => togglePart(i, e.target.checked),
            }),
          ),
          h('td', {}, h('a', { href: '#', textContent: file.name, onclick: (e) => openFile(e, file.name) })),
          h('td', { className: 'label', textContent: file.label === null ? t('(continued)') : `【${file.label}】` }),
          h('td', { className: 'heading', textContent: file.title || '' }),
        ),
      );
    });

    return section(
      t('Part Boundaries'),
      description,
      toggle,
      work.error && h('p', { className: 'warning', textContent: t('Cannot read the manuscript: {0}', work.error) }),
      work.missing.length > 0 &&
        h(
          'p',
          { className: 'warning' },
          t('Boundaries that match no file: {0} ', work.missing.join(', ')),
          h('button', {
            textContent: t('Remove'),
            onclick: () =>
              commit((r) => {
                r.parts = partTokens(r).filter((tok) => !work.missing.includes(tok));
              }),
          }),
        ),
      work.files.length > 0
        ? h(
            'table',
            { className: 'parts' },
            h(
              'thead',
              {},
              h(
                'tr',
                {},
                h('th', { textContent: t('Starts part') }),
                h('th', { textContent: t('File') }),
                h('th', { textContent: t('Chapter') }),
                h('th', { textContent: t('Heading') }),
              ),
            ),
            h('tbody', {}, rows),
          )
        : !work.error && h('p', { className: 'note', textContent: t('There is no manuscript (.txt).') }),
    );
  }

  function openFile(e, name) {
    e.preventDefault();
    post({ type: 'openFile', name });
  }

  const formatLabel = (f) => (f.description ? `${f.format}（${f.description}）` : f.format);

  const LANGUAGES = [
    ['ja', t('Japanese')],
    ['en', t('English')],
  ];

  /** format の言語ごとの形式 { ja, en }（英語の形式 <format>-en が無ければ ja だけ） */
  function languageVariants(format) {
    const ja = format.replace(/-en$/, '');
    const en = `${ja}-en`;
    return state.formats.some((f) => f.format === en) ? { ja, en } : { ja };
  }

  /** 出力 name の言語を変える。出力名が形式の名前なら、出力名も新しい形式にする（並びは保つ） */
  function setOutputLanguage(name, format, language) {
    const next = languageVariants(format)[language];
    commit((r) => {
      if (name !== format) return assignOutput(r, name, 'format', next);
      const entries = Object.entries(outputsObject(r)).map(([n, v]) => {
        if (n !== name) return [n, v];
        if (!v || typeof v !== 'object') return [next, v];
        const { format: _, ...rest } = v;
        return [next, Object.keys(rest).length > 0 ? rest : true];
      });
      r.outputs = Object.fromEntries(entries);
    });
  }

  /**
   * 出力 format の項目 key を書かなかったときに効く値（入力欄の placeholder にする）。
   * novel build と同じく、英語の出力（pdf-en / rtf-en）は english の項目を先に見る
   */
  function inheritedValue(format, key) {
    const { raw } = state;
    const english = raw.english && typeof raw.english === 'object' ? raw.english : {};
    const shown = (v) => (Array.isArray(v) ? v.join(', ') : typeof v === 'string' ? v : '');
    if (key === 'sceneBreak')
      return format === 'rtf-en'
        ? '#'
        : format === 'pdf-en'
          ? (english.sceneBreak ?? '* * *')
          : (raw.sceneBreak ?? '＊');
    if (key === 'sceneBreakIndent')
      return typeof raw.sceneBreakIndent === 'number'
        ? String(raw.sceneBreakIndent)
        : ['split', 'merge'].includes(format)
          ? t('Line start')
          : t('Centered');
    if (['title', 'author', 'input'].includes(key) && ['pdf-en', 'rtf-en'].includes(format))
      return shown(english[key] ?? (key === 'input' ? ['en'] : raw[key]));
    if (key === 'input') return shown(raw.input ?? ['.']);
    if (['title', 'author', 'parts', 'genre', 'target'].includes(key)) return shown(raw[key]);
    return '';
  }

  function outputCard(name, value) {
    const { fields, outputs } = state;
    const output = value && typeof value === 'object' ? value : {};
    const format = output.format ?? name;
    const known = fields.output[format];
    const variants = known ? languageVariants(format) : { ja: format };
    const language = variants.en === format ? 'en' : 'ja';
    const family = variants.ja;
    const nameLabel = h('span', {
      className: 'output-name',
      textContent: name === format ? family : `${name}（${family}）`,
      title: known ? t('Made by novel build <work> {0}', name) : t('{0} is not a supported format', format),
    });
    const taken = (f) => f !== format && name === format && f in outputsObject(clone(state.raw));
    const languageSelect =
      variants.en &&
      h(
        'select',
        { dataset: { field: `output.${name}.language` }, title: t('Language') },
        LANGUAGES.map(([lang, label]) =>
          h('option', { value: lang, textContent: label, disabled: taken(variants[lang]) }),
        ),
      );
    if (languageSelect) {
      languageSelect.value = language;
      languageSelect.addEventListener('change', () => setOutputLanguage(name, format, languageSelect.value));
    }

    const outField = {
      key: 'out',
      label: t('Output path'),
      kind: 'string',
      nullable: false,
      description: t('Relative to the output directory'),
    };
    const used = new Set(['format', 'out', ...(known ?? []).map((f) => f.key)]);
    const unused = Object.keys(output).filter((k) => !used.has(k));

    return h(
      'div',
      { className: 'output' },
      h(
        'div',
        { className: 'output-head' },
        nameLabel,
        languageSelect,
        h('button', {
          textContent: t('Build'),
          title: t('Make this output (same as novel build)'),
          onclick: () => post({ type: 'build', names: [name] }),
        }),
        h('button', {
          textContent: t('Delete'),
          className: 'danger',
          onclick: () =>
            commit((r) => {
              delete outputsObject(r)[name];
              if (Object.keys(r.outputs).length === 0) delete r.outputs;
            }),
        }),
      ),
      h(
        'div',
        { className: 'grid' },
        fieldInput(
          outField,
          output.out,
          (v) => commit((r) => assignOutput(r, name, 'out', v)),
          `output.${name}.out`,
          outputs.defaultOut[name] ?? t('(set by writing id or title)'),
        ),
        (known ?? []).flatMap((f) => [
          fieldInput(
            f,
            output[f.key],
            (v) => commit((r) => assignOutput(r, name, f.key, v)),
            `output.${name}.${f.key}`,
            inheritedValue(format, f.key),
          ),
          f.trims && trimSpread(f.trims[output[f.key]] ?? f.trims[f.default]),
        ]),
      ),
      unused.length > 0 &&
        h('p', {
          className: 'note',
          textContent: t('Fields this format does not use (kept as they are): {0}', unused.join(', ')),
        }),
    );
  }

  /** 出力を足す。出力名は形式の名前で、日本語の形式が既にあれば英語の形式にする */
  function addOutput(family, used) {
    const variants = languageVariants(family);
    const format = [variants.ja, variants.en].find((f) => f && !used.has(f));
    commit((r) => {
      const outputs = outputsObject(r);
      if (!(format in outputs)) {
        outputs[format] = true;
        return;
      }
      // 同じ名前の出力が別の形式で既にあるので、上書きせず別名で足す
      let n = 2;
      while (`${format}-${n}` in outputs) n++;
      outputs[`${format}-${n}`] = { format };
    });
  }

  function outputsSection() {
    const { raw, formats, outputs } = state;
    const entries = Array.isArray(raw.outputs)
      ? raw.outputs.map((name) => [name, true])
      : Object.entries(raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {});
    const used = new Set(entries.map(([name, value]) => value?.format ?? name));
    const addSelect = h(
      'select',
      { dataset: { field: 'output.add' } },
      h('option', { value: '', textContent: t('Add Output…') }),
      formats
        .filter((f) => !f.format.endsWith('-en'))
        .filter((f) => Object.values(languageVariants(f.format)).some((v) => !used.has(v)))
        .map((f) =>
          h('option', {
            value: f.format,
            textContent: languageVariants(f.format).en ? t('{0} (Japanese / English)', f.format) : formatLabel(f),
          }),
        ),
    );
    addSelect.addEventListener('change', () => {
      const family = addSelect.value;
      if (!family) return;
      // render() がフォーカス中の欄の値を復元するため、追加前に選択を戻す
      addSelect.value = '';
      addOutput(family, used);
    });
    return section(
      t('Outputs'),
      t('What "Build Outputs" and novel build make'),
      outputs.error && h('p', { className: 'warning', textContent: outputs.error }),
      entries.map(([name, value]) => outputCard(name, value)),
      h('div', { className: 'output-add' }, addSelect),
    );
  }

  // 打ちかけ（input 済みで change 前）の欄。確定済みの値を、外から変わった状態の上に戻さないために持つ
  let uncommittedField = null;
  form.addEventListener('input', (e) => {
    uncommittedField = /** @type {HTMLElement} */ (e.target).dataset?.field ?? null;
  });
  form.addEventListener('change', () => {
    uncommittedField = null;
  });

  /** novel.json が無いとき（小説パネルのタブだけ）。dir: 作る場所 */
  function missingSection(dir) {
    return section(
      t('No novel.json'),
      t('There are no work settings yet because there is no novel.json in {0} or above.', dir),
      h('button', { textContent: t('Create novel.json in {0}', dir), onclick: () => post({ type: 'create' }) }),
    );
  }

  /**
   * 状態から画面を作り直す。フォーカスのある欄は data-field で同じ欄に戻し、入力中の値と位置も戻す
   * （入力欄は change で書くので、打ちかけの値はまだ状態に入っていない）
   */
  function render() {
    const active = /** @type {HTMLInputElement | null} */ (document.activeElement);
    const focusId = form.contains(active) ? active?.dataset?.field : undefined;
    const typed = focusId && focusId === uncommittedField && active.type !== 'checkbox' ? active.value : null;
    const selection = focusId && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
    const scroll = scroller.scrollTop;

    fileLabel.textContent = state?.file ?? '';
    errorBox.hidden = !state?.error;
    errorBox.textContent = state?.error ?? '';
    buildButton.disabled = !state?.raw;
    openTextButton.disabled = !state?.file;
    form.replaceChildren(
      ...(state?.raw
        ? [workSection(), partsSection(), outputsSection(), englishSection()]
        : state?.missing
          ? [missingSection(state.missing)]
          : []),
    );

    scroller.scrollTop = scroll;
    if (!focusId) return;
    const target = /** @type {HTMLInputElement | null} */ (form.querySelector(`[data-field="${CSS.escape(focusId)}"]`));
    if (!target) return;
    if (typed !== null) target.value = typed;
    target.focus();
    try {
      if (selection) target.setSelectionRange(selection[0], selection[1]);
    } catch {
      // 数値の入力欄などは選択範囲を持たない
    }
  }

  return {
    /** 拡張から届いた状態を画面にする */
    render(next) {
      state = next;
      render();
    },
  };
}
