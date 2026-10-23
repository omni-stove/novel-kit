import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import * as vscode from 'vscode';
import { findProjectRoot, formatTraits, normalizeOutputs, outputPath } from '../../src/build.mjs';
import {
  CONFIG_FILENAME,
  DEFAULT_VIEW,
  findConfigFile,
  readSettingsFile,
  readWorkConfig,
  writeSettingsFile,
} from '../../src/config.mjs';
import {
  BUILTIN_ENGLISH_PRESETS,
  BUILTIN_PRESETS,
  computeMetrics,
  describeLayout,
  enPdfPageSize,
  layoutsEqual,
  matchesPdfScriptPage,
  normalizeLayout,
} from '../../src/layout.mjs';
import { countTextChars, readLines, splitLines, stripInlineMarkup } from '../../src/lib/text-parser.mjs';
import { parsePageSpec } from '../../src/pdf.mjs';
import { buildDocument, buildOutline, computeStats, detectLanguageOfLines, listWorkFiles } from './document.mjs';
import { emphasisMarkup, kanjiRunAt, rubyMarkup } from './markup.mjs';
import { analyzeProse, createTokenizer, proseReport } from './prose.mjs';
import { createSettingsEditorProvider, createWorkSettingsController, SETTINGS_VIEW_TYPE } from './settings-editor.mjs';
import { renderPanelHtml, renderWebviewHtml } from './webview.mjs';

const RENDER_DELAY_MS = 250;
/** 同じ段落への入力がこの間隔以内に続けば、取り消しの1回分にまとめる */
const UNDO_GROUP_MS = 1500;
/** 小説プレビュー（カスタムエディタ）のID。workbench.editorAssociations で .txt の既定にできる */
// package.json の customEditors と同じIDでなければならない
const EDITOR_VIEW_TYPE = 'novelPreview.editor';
/** 小説パネル（セカンダリサイドバーの webview）のID */
// package.json の views と同じIDでなければならない
const PANEL_VIEW_ID = 'novelPreview.panel';

let context;
let statusBar;
let cliOutput = null;
/** 開いているプレビュー（.txt のタブとして開いたものと、横に出したもの） */
const sessions = new Set();
/** テキストエディタの横に出す、アクティブなエディタに追従するプレビュー（1つだけ） */
let sidePreview = null;
/** 「プレビューに切り替える」で開くタブに渡す、テキストエディタで見ていた位置（{ filePath, line }） */
let pendingReveal = null;

// .txt の言語IDは入っている拡張によって変わる（plaintext とは限らない）ので、拡張子だけで判定する
const isManuscript = (doc) => !!doc && doc.uri.scheme === 'file' && doc.uri.fsPath.endsWith('.txt');

const config = () => vscode.workspace.getConfiguration('novelPreview');

/** 利用者のプリセット（設定 novelPreview.presets）。english が true なら "english": true のものだけ、false ならそれ以外 */
function userPresets(english = false) {
  const raw = config().get('presets');
  const all = raw && typeof raw === 'object' ? raw : {};
  return Object.fromEntries(Object.entries(all).filter(([, layout]) => !!layout?.english === english));
}

/** 組み込みと利用者のプリセットを合わせ、正規化したもの（同じ名前は利用者のものが勝つ） */
function allPresets(english = false) {
  const merged = { ...(english ? BUILTIN_ENGLISH_PRESETS : BUILTIN_PRESETS), ...userPresets(english) };
  return Object.fromEntries(
    Object.entries(merged).map(([name, layout]) => [name, normalizeLayout(layout, { english })]),
  );
}

/** 原稿から一番近い設定ファイル（novel.json）のパス。ワークスペースの外までは探さない。無ければ null */
function layoutFileFor(doc) {
  const dir = dirname(doc.uri.fsPath);
  const root = vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath ?? dir;
  return findConfigFile(dir, root);
}

let warnedLayoutFile = null;

/**
 * 原稿に効いている設定 { layout, english, view, sceneBreak, sceneBreakIndent, parts }（日本語・英語のレイアウトと表示設定、場面区切りの記号と字下げ、部の境界）。
 * 設定ファイルが無い・読めないときは既定のプリセットと既定の表示設定（読めないときは1度だけ警告を出す）
 */
function settingsFor(doc) {
  const file = layoutFileFor(doc);
  if (file) {
    try {
      const settings = readSettingsFile(file);
      if (warnedLayoutFile === file) warnedLayoutFile = null;
      return settings;
    } catch (err) {
      if (warnedLayoutFile !== file) {
        warnedLayoutFile = file;
        vscode.window.showWarningMessage(
          `${vscode.workspace.asRelativePath(file)} を読めないため、既定の設定で表示します: ${err.message}`,
        );
      }
    }
  }
  return {
    layout: allPresets()[config().get('defaultPreset')] ?? normalizeLayout(null),
    english: normalizeLayout(null, { english: true }),
    view: { ...DEFAULT_VIEW },
    sceneBreak: { ja: null, en: null },
    sceneBreakIndent: null,
    parts: null,
  };
}

/** 原稿の文字がアルファベット中心なら英語の組版 */
const isEnglishManuscript = (doc) => detectLanguageOfLines(splitLines(doc.getText())) === 'en';

/**
 * 原稿に効く設定。原稿の言語に応じて日本語か英語のレイアウトを返す。
 * 返す値: { layout, view, english: 英語の原稿か, sceneBreak: 場面区切りの記号（null なら既定）,
 *   sceneBreakIndent: 区切りの字下げ（null なら中央。英語の原稿は常に null）, parts: 部の境界（null なら分けない） }
 */
function resolvedSettingsFor(doc) {
  const { layout, english, view, sceneBreak, sceneBreakIndent, parts } = settingsFor(doc);
  const en = isEnglishManuscript(doc);
  return {
    layout: en ? english : layout,
    view,
    english: en,
    sceneBreak: en ? sceneBreak.en : sceneBreak.ja,
    sceneBreakIndent: en ? null : sceneBreakIndent,
    parts,
  };
}

const layoutFor = (doc) => resolvedSettingsFor(doc).layout;

function metricsFor(doc) {
  const { layout, english } = resolvedSettingsFor(doc);
  return computeMetrics(layout, { english });
}

/**
 * 一番近い設定ファイルへ書き、すべてのプレビューを組み直す。まだ無ければ原稿と同じディレクトリに作る（壊れていれば書かずにエラーを出す）。
 * patch: { layout } で原稿の言語のレイアウト（日本語か英語）を差し替え、{ view } で表示設定の一部を上書きする
 */
function updateSettings(doc, patch) {
  const current = settingsFor(doc);
  const file = layoutFileFor(doc) ?? join(dirname(doc.uri.fsPath), CONFIG_FILENAME);
  if (file === warnedLayoutFile) {
    vscode.window.showErrorMessage(
      `${vscode.workspace.asRelativePath(file)} が壊れているため、設定を保存できません。ファイルを直すか削除してください。`,
    );
    return;
  }
  const english = isEnglishManuscript(doc);
  try {
    writeSettingsFile(file, {
      layout: !english && patch.layout ? patch.layout : current.layout,
      english: english && patch.layout ? patch.layout : current.english,
      view: { ...current.view, ...patch.view },
    });
  } catch (err) {
    vscode.window.showErrorMessage(`設定を保存できませんでした: ${err.message}`);
  }
  refreshLayout();
}

const setLayout = (doc, layout) => updateSettings(doc, { layout });

function refreshLayout() {
  for (const session of sessions) session.render();
  updateStatusBar();
}

/** ファイルの行列。エディタで開いていれば未保存の内容を返す */
function linesOf(filePath) {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === filePath);
  return open ? splitLines(open.getText()) : readLines(filePath);
}

/** いま操作しているプレビュー（タブが前面のもの。無ければ横のプレビュー） */
const activeSession = () => [...sessions].find((s) => s.panel.active) ?? sidePreview;

/** コマンドやステータスバーが対象にする原稿（アクティブなテキストエディタの原稿、無ければいま操作しているプレビューの原稿） */
function activeManuscript() {
  const editorDoc = vscode.window.activeTextEditor?.document;
  if (isManuscript(editorDoc)) return editorDoc;
  return activeSession()?.doc ?? null;
}

/**
 * プレビュー1枚（webview）と、それが表示している原稿のセッションを作り、sessions に加えて返す。
 * doc: 表示する原稿。null なら「原稿を開いてください」の案内を出す
 * follow: アクティブなテキストエディタに追従して doc を差し替える（横のプレビュー）
 * initialLine: 最初の描画で表示する doc の行（開いたファイルの先頭か、テキストエディタから切り替えたときの見ていた位置）
 * session.applying はプレビュー自身の編集を反映している最中か（その変更通知は「外からの変更」に数えない）、
 * session.externalChange は取り消し・テキストエディタ・外部ツールなど、プレビュー以外が原稿を変えたか、
 * session.scope は表示範囲（描画のたびに設定ファイルの値で更新する。既定は作品全体）。
 * 取り消し履歴の要素は { filePath, startLine, before: 行の配列, after: 行の配列, time }
 */
function createSession(panel, { doc = null, follow = false, initialLine = null } = {}) {
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
  let renderTimer;
  /** @type {Promise<unknown>} */
  let editQueue = Promise.resolve();

  const session = {
    panel,
    doc,
    follow,
    files: [],
    applying: false,
    externalChange: false,
    scope: DEFAULT_VIEW.scope,
    // プレビューでの編集の取り消し・やり直し。カスタムエディタの Cmd+Z は開いたファイルにしか効かず、
    // 作品全体の表示で別のファイルを編集したときに無関係な変更を取り消してしまうので、自前で持つ
    undoStack: [],
    redoStack: [],
    // プレビューの外でファイルが変わったら、そのファイルの履歴は行位置が当てにならないので捨てる
    dropHistory(filePath) {
      session.undoStack = session.undoStack.filter((e) => e.filePath !== filePath);
      session.redoStack = session.redoStack.filter((e) => e.filePath !== filePath);
    },
    render,
    scheduleRender() {
      clearTimeout(renderTimer);
      renderTimer = setTimeout(render, RENDER_DELAY_MS);
    },
    postReveal() {
      panel.webview.postMessage({ type: 'reveal', target: revealTarget() });
    },
  };

  /** テキストエディタ側のカーソル位置 { fileIndex, line }（このプレビューが表示しているファイルにあるときだけ。無ければ null） */
  function revealTarget() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return null;
    const fileIndex = session.files.indexOf(editor.document.uri.fsPath);
    return fileIndex < 0 ? null : { fileIndex, line: editor.selection.active.line };
  }

  /** 最初の描画の1回だけ、開いたファイルの表示位置を返す（2回目以降は null） */
  function takeInitialReveal() {
    if (initialLine == null) return null;
    const target = { fileIndex: session.files.indexOf(session.doc.uri.fsPath), line: initialLine };
    initialLine = null;
    return target.fileIndex < 0 ? null : target;
  }

  /** 原稿を組んで webview に送る。focusEdit: 描画後にプレビュー側で編集を始める位置（{ fileIndex, line, offset }） */
  function render({ focusEdit = null } = {}) {
    clearTimeout(renderTimer);
    if (!session.doc) {
      panel.webview.postMessage({
        type: 'message',
        text: '原稿のテキストファイル（.txt）を開くとプレビューを表示します。',
      });
      return;
    }

    const filePath = session.doc.uri.fsPath;
    const { layout, view, english, sceneBreak, sceneBreakIndent, parts } = resolvedSettingsFor(session.doc);
    session.scope = view.scope;
    const metrics = computeMetrics(layout, { english });
    // スクロール表示はウェブ小説の読み味を見るためのもので、縦書きのレイアウトでも横書きに組む
    const flowMetrics =
      view.mode === 'scroll' && metrics.vertical
        ? computeMetrics({ ...layout, writingMode: 'horizontal' }, { english })
        : metrics;
    try {
      const built = buildDocument({
        filePath,
        scope: session.scope,
        metrics: flowMetrics,
        linesOf,
        sceneBreak,
        sceneBreakIndent,
        parts,
      });
      session.files = built.files;
      const presets = allPresets(english);
      const initialReveal = takeInitialReveal();
      const layoutFile = layoutFileFor(session.doc);
      if (follow)
        panel.title = `プレビュー: ${built.files.length > 1 ? basename(dirname(filePath)) : basename(filePath)}`;
      panel.webview.postMessage({
        type: 'render',
        css: built.css,
        body: built.body,
        metrics,
        language: metrics.language,
        layout: metrics.layout,
        presets,
        presetName: Object.keys(presets).find((name) => layoutsEqual(presets[name], layout, { english })) ?? null,
        layoutFile: layoutFile ? vscode.workspace.asRelativePath(layoutFile) : null,
        outputs: menuOutputs(layoutFile),
        userPresetNames: Object.keys(userPresets(english)),
        scope: session.scope,
        view,
        canShowWork: listWorkFiles(filePath).includes(filePath),
        reveal: initialReveal ?? revealTarget(),
        forceReveal: !!initialReveal,
        sources: built.sources,
        focusEdit,
        external: session.externalChange,
      });
      session.externalChange = false;
    } catch (err) {
      panel.webview.postMessage({ type: 'message', text: `プレビューを作れませんでした: ${err.message}` });
    }
  }

  /**
   * プレビューでの編集を原稿に反映し、取り消し履歴に積む。
   * edit: 1行を text で置き換える（text に改行があれば行が増える）。merge: 行頭での Backspace。前の行の末尾へつなげる
   */
  async function applyPreviewEdit(msg) {
    const filePath = session.files[msg.fileIndex];
    if (!filePath) return;
    const target = await vscode.workspace.openTextDocument(filePath);
    if (msg.line < 0 || msg.line >= target.lineCount) return;

    const edit = new vscode.WorkspaceEdit();
    let focusEdit = msg.focus ?? null;
    let change;
    if (msg.type === 'merge') {
      if (msg.line === 0) return;
      const prev = target.lineAt(msg.line - 1);
      const cur = target.lineAt(msg.line).text;
      edit.delete(target.uri, new vscode.Range(prev.range.end, new vscode.Position(msg.line, 0)));
      focusEdit = { fileIndex: msg.fileIndex, line: msg.line - 1, offset: prev.text.length };
      change = { startLine: msg.line - 1, before: [prev.text, cur], after: [prev.text + cur] };
    } else {
      const before = target.lineAt(msg.line).text;
      if (before === msg.text) return;
      edit.replace(target.uri, target.lineAt(msg.line).range, msg.text);
      change = { startLine: msg.line, before: [before], after: msg.text.split(/\r?\n/) };
    }
    if (!(await applyTracked(edit))) return;
    recordHistory({ filePath, ...change });

    // 行数が変わると行番号がずれるので、すぐ組み直して編集位置を渡す
    // （1行の中の変更はプレビュー側が自分で表示を保つので、通常の遅延描画に任せる）
    if (msg.type === 'merge' || msg.text.includes('\n')) render({ focusEdit });
  }

  async function applyTracked(edit) {
    session.applying = true;
    try {
      return await vscode.workspace.applyEdit(edit);
    } finally {
      session.applying = false;
    }
  }

  /** 取り消し履歴に積む（やり直し履歴は捨てる）。1つの段落の中で打ち続けている間は1回分にまとめる（行数が変わる編集はまとめない） */
  function recordHistory(entry) {
    session.redoStack = [];
    const now = Date.now();
    const last = session.undoStack.at(-1);
    const typing = (e) => e.before.length === 1 && e.after.length === 1;
    if (
      last &&
      typing(last) &&
      typing(entry) &&
      last.filePath === entry.filePath &&
      last.startLine === entry.startLine &&
      now - last.time < UNDO_GROUP_MS
    ) {
      last.after = entry.after;
      last.time = now;
      return;
    }
    session.undoStack.push({ ...entry, time: now });
  }

  /**
   * redo: false で取り消し、true でやり直し。プレビューの外で変わっていれば、そのファイルの履歴を捨てて警告する。
   * 反映後は変わった段落の末尾で編集を続ける（別のファイルなら、そこまで表示を動かす）
   */
  async function undoPreviewEdit(redo) {
    const from = redo ? session.redoStack : session.undoStack;
    const to = redo ? session.undoStack : session.redoStack;
    const entry = from.pop();
    if (!entry) return;
    const [current, restored] = redo ? [entry.before, entry.after] : [entry.after, entry.before];

    const target = await vscode.workspace.openTextDocument(entry.filePath);
    const endLine = entry.startLine + current.length - 1;
    const intact =
      endLine < target.lineCount && current.every((text, i) => target.lineAt(entry.startLine + i).text === text);
    if (!intact) {
      session.dropHistory(entry.filePath);
      vscode.window.showWarningMessage(
        `${basename(entry.filePath)} がプレビューの外で変更されているため、${redo ? 'やり直せません' : '取り消せません'}。`,
      );
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      target.uri,
      new vscode.Range(entry.startLine, 0, endLine, target.lineAt(endLine).text.length),
      restored.join('\n'),
    );
    if (!(await applyTracked(edit))) return;
    // まとめた入力の途中から打ち直しても、この取り消しとは別の1回にする
    entry.time = 0;
    to.push(entry);

    const fileIndex = session.files.indexOf(entry.filePath);
    const line = entry.startLine + restored.length - 1;
    render({ focusEdit: fileIndex < 0 ? null : { fileIndex, line, offset: restored.at(-1).length } });
  }

  /** このプレビューが表示しているファイルのうち、未保存のものを保存する */
  async function saveFiles() {
    const dirty = vscode.workspace.textDocuments.filter((d) => d.isDirty && session.files.includes(d.uri.fsPath));
    await Promise.all(dirty.map((d) => d.save()));
  }

  /**
   * webview からのメッセージ。openPanel は小説パネルを msg.tab のタブで開き、view は表示範囲・倍率・編集のオンオフ・表示の形（ページ・スクロール）を設定ファイルに書き、同じ設定を見ているプレビューすべてに反映する。
   * jump は見ている位置のファイル（作品全体の表示なら、開いたファイルとは限らない）をテキストエディタで開く
   */
  function onMessage(msg) {
    switch (msg.type) {
      case 'ready':
        return render();
      case 'layout':
        return session.doc && setLayout(session.doc, msg.layout);
      case 'preset': {
        const preset = session.doc && allPresets(isEnglishManuscript(session.doc))[msg.name];
        return preset && setLayout(session.doc, preset);
      }
      case 'view':
        return session.doc && updateSettings(session.doc, { view: msg.view });
      case 'jump':
        return openInTextEditor(session.files[msg.fileIndex], msg.line, panel);
      case 'openText':
        return replaceWithTextEditor(session, session.files[msg.fileIndex] ?? session.doc?.uri.fsPath, msg.line ?? 0);
      case 'refresh':
        return render({ focusEdit: msg.focusEdit ?? null });
      case 'edit':
      case 'merge':
        // 入力のたびに届くので、適用順が前後しないよう直列にする
        editQueue = editQueue
          .then(() => applyPreviewEdit(msg))
          .catch((err) => vscode.window.showErrorMessage(`プレビューでの編集を反映できませんでした: ${err.message}`));
        return editQueue;
      case 'undo':
      case 'redo':
        // 直前の入力の反映が終わってから取り消す
        editQueue = editQueue
          .then(() => undoPreviewEdit(msg.type === 'redo'))
          .catch((err) =>
            vscode.window.showErrorMessage(
              `プレビューでの編集を${msg.type === 'redo' ? 'やり直せ' : '取り消せ'}ませんでした: ${err.message}`,
            ),
          );
        return editQueue;
      case 'save':
        return saveFiles();
      case 'export':
        if (!msg.names) return exportPdf(session);
        return (
          session.doc && buildOutputs(vscode.Uri.file(layoutFileFor(session.doc) ?? session.doc.uri.fsPath), msg.names)
        );
      case 'openPanel':
        return showPanel(msg.tab);
    }
  }

  panel.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
  panel.webview.html = renderWebviewHtml({
    cssUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'preview.css')),
    jsUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'preview.js')),
    cspSource: panel.webview.cspSource,
    nonce: randomBytes(16).toString('hex'),
  });
  panel.webview.onDidReceiveMessage(onMessage);
  panel.onDidChangeViewState(updateStatusBar);
  panel.onDidDispose(() => {
    clearTimeout(renderTimer);
    sessions.delete(session);
    if (sidePreview === session) sidePreview = null;
    updateStatusBar();
  });

  sessions.add(session);
  return session;
}

/**
 * .txt を「小説プレビュー」で開いたときのタブ（カスタムエディタ）。文書の保存・取り消しは VS Code が面倒を見る。
 * 作品全体の表示でも、開いたファイルの位置から見せる（テキストエディタから切り替えたときは、そこで見ていた行）
 */
const editorProvider = {
  resolveCustomTextEditor(document, panel) {
    const initialLine = pendingReveal?.filePath === document.uri.fsPath ? pendingReveal.line : 0;
    pendingReveal = null;
    createSession(panel, { doc: document, initialLine });
    updateStatusBar();
  },
};

/** テキストエディタの横にプレビューを出す（すでにあれば、アクティブな原稿に差し替えて前に出す） */
function openSidePreview() {
  const doc = vscode.window.activeTextEditor?.document;
  if (sidePreview) {
    if (isManuscript(doc)) sidePreview.doc = doc;
    sidePreview.panel.reveal(undefined, true);
    sidePreview.render();
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    'novelPreview',
    'プレビュー',
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    { retainContextWhenHidden: true, enableFindWidget: true },
  );
  sidePreview = createSession(panel, { doc: isManuscript(doc) ? doc : null, follow: true });
}

/** プレビューからテキストエディタの該当行へ。プレビューのタブは残し、すでに見えているエディタがあればそこへ、無ければ横に開く */
async function openInTextEditor(filePath, line, fromPanel) {
  if (!filePath) return;
  const visible = vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath === filePath);
  const anyEditor = vscode.window.visibleTextEditors.find(
    (e) => isManuscript(e.document) && e.viewColumn !== fromPanel.viewColumn,
  );
  const doc = await vscode.workspace.openTextDocument(filePath);
  const editor = await vscode.window.showTextDocument(doc, {
    viewColumn: visible?.viewColumn ?? anyEditor?.viewColumn ?? vscode.ViewColumn.Beside,
  });
  const pos = new vscode.Position(Math.min(line, doc.lineCount - 1), 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

/**
 * 「テキストで開く」。.txt のタブとして開いたプレビューは、同じ場所でテキストエディタに入れ替える。
 * 横に出したプレビューは隣にエディタがある前提なので、入れ替えずにそちらの該当行へ飛ぶ
 */
async function replaceWithTextEditor(session, filePath, line) {
  if (!filePath) return;
  if (session.follow) return openInTextEditor(filePath, line, session.panel);

  let editor;
  if (filePath === session.doc?.uri.fsPath) {
    // 同じグループでプレビューとして開いているファイルは、showTextDocument しても既存のプレビューのタブが前に出るだけで
    // テキストエディタにならない。「エディターを再度開く」でタブをその場で置き換える
    session.panel.reveal();
    await vscode.commands.executeCommand('reopenActiveEditorWith', 'default');
    editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.fsPath !== filePath) return;
  } else {
    const doc = await vscode.workspace.openTextDocument(filePath);
    editor = await vscode.window.showTextDocument(doc, { viewColumn: session.panel.viewColumn });
    // 文書はテキストエディタが引き継ぐので、未保存の変更があってもプレビューのタブを閉じて失うものはない
    session.panel.dispose();
  }
  const pos = new vscode.Position(Math.min(line, editor.document.lineCount - 1), 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
}

/** 「プレビューに切り替える」。テキストエディタのタブを、同じ場所で小説プレビューに入れ替える（「テキストで開く」の逆） */
async function replaceWithPreview() {
  const editor = vscode.window.activeTextEditor;
  if (!isManuscript(editor?.document)) return;
  const { uri } = editor.document;
  pendingReveal = { filePath: uri.fsPath, line: editor.visibleRanges[0]?.start.line ?? editor.selection.active.line };
  // 「エディターを再度開く」と同じ内部コマンド。タブをその場で置き換えるので、未保存の変更があっても保存確認は出ない
  // （開いてからテキストエディタのタブを閉じる方法だと、閉じるときに確認が出る）
  await vscode.commands.executeCommand('reopenActiveEditorWith', EDITOR_VIEW_TYPE);
  pendingReveal = null;
}

/** プリセットの保存先。ワークスペースを開いていればワークスペース設定、無ければユーザー設定 */
const presetTarget = () =>
  vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;

/** 原稿の今のレイアウトを名前を付けてプリセットに保存する。英語のレイアウトは "english": true を付けて保存し、英語の原稿のときだけ出す */
async function savePreset(doc) {
  const { layout, english } = resolvedSettingsFor(doc);
  const name = await vscode.window.showInputBox({
    title: `レイアウトをプリセットとして保存${english ? '（English）' : ''}`,
    prompt: 'プリセット名',
    value: describeLayout(layout, { english }),
    validateInput: (v) => (v.trim() ? null : '名前を入力してください'),
  });
  if (!name) return;
  const saved = english ? { ...layout, english: true } : layout;
  await config().update(
    'presets',
    { ...userPresets(false), ...userPresets(true), [name.trim()]: saved },
    presetTarget(),
  );
}

/** 利用者のプリセットを名前で消す */
async function deletePreset(name) {
  const presets = { ...userPresets(false), ...userPresets(true) };
  if (!(name in presets)) return;
  delete presets[name];
  await config().update('presets', presets, presetTarget());
}

/** レイアウトをプリセットから選ぶクイックピック。選んだものを原稿の設定ファイルに書く */
async function selectLayout() {
  const doc = activeManuscript();
  if (!doc) return;
  const { layout: current, english } = resolvedSettingsFor(doc);
  const presets = allPresets(english);
  const describePreset = (layout) => {
    const paper = `${layout.paper}${layout.orientation === 'landscape' ? '横' : '縦'}`;
    if (english) return `${paper}・${layout.fontSize}pt`;
    return `${paper}・${layout.writingMode === 'vertical' ? '縦書き' : '横書き'}`;
  };
  const picked = await vscode.window.showQuickPick(
    Object.entries(presets).map(([name, layout]) => ({
      label: name,
      description: describePreset(layout),
      picked: layoutsEqual(layout, current, { english }),
    })),
    {
      title: `レイアウト（${basename(dirname(doc.uri.fsPath))}${english ? '・English' : ''}）`,
      placeHolder: describeLayout(current, { english }),
    },
  );
  if (picked) setLayout(doc, presets[picked.label]);
}

/**
 * 拡張に同梱した novel CLI（dist/novel-cli.cjs）を VS Code の Node で動かし、ログを出力チャンネルに出しながら進捗を通知する。
 * 成功したら true、失敗したら「ログを見る」付きのエラー（failure）を出して false を返す
 */
function runNovelCli(args, { cwd, title, failure }) {
  cliOutput ??= vscode.window.createOutputChannel('小説の出力');
  cliOutput.clear();
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title },
    (progress) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [join(context.extensionPath, 'dist', 'novel-cli.cjs'), ...args], {
          cwd,
          // 作ったファイルは拡張が開く（shouldOpen）ので、CLI の --open では開かせない
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AUTO_OPEN: '0' },
        });
        // 初回は Chrome のダウンロードで時間がかかるので、CLI の最後の行を通知に出しておく
        const log = (chunk) => {
          const text = chunk.toString();
          cliOutput.append(text);
          const last = text
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .pop();
          if (last) progress.report({ message: last });
        };
        child.stdout.on('data', log);
        child.stderr.on('data', log);
        // 起動できなかったときは close が来ないことがあるので、error でも終える（両方来ても1回だけ）
        let finished = false;
        const finish = async (ok) => {
          if (finished) return;
          finished = true;
          resolve(ok);
          if (ok) return;
          const picked = await vscode.window.showErrorMessage(failure, 'ログを見る');
          if (picked) cliOutput.show(true);
        };
        child.on('error', (err) => {
          cliOutput.appendLine(err.message);
          finish(false);
        });
        child.on('close', (code) => finish(code === 0));
      }),
  );
}

/** 作ったファイルを開くか。CLI の --open と同じく、環境変数 AUTO_OPEN=0 なら開かない */
const shouldOpen = () => config().get('openAfterExport') !== false && process.env.AUTO_OPEN !== '0';

/**
 * PDF出力（novel pdf / novel pdf-en）。session があればその表示範囲（このファイル / 作品全体）で、無ければ開いている原稿1ファイルを出力する。
 * 日本語は novel pdf、英語は novel pdf-en（判型は用紙から選ぶ）。出力先はワークスペース（無ければ原稿のディレクトリ）の out/preview/ で、終わったら開く（shouldOpen）
 */
function exportPdf(session = activeSession()) {
  const doc = session?.doc ?? activeManuscript();
  if (!doc) return;
  const filePath = doc.uri.fsPath;
  const dir = dirname(filePath);
  const root = vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath ?? dir;
  const { layout, english, sceneBreak, sceneBreakIndent } = resolvedSettingsFor(doc);
  const metrics = computeMetrics(layout, { english });
  const command = english ? 'pdf-en' : 'pdf';

  const whole = session?.doc === doc && session.scope === 'work' && session.files.length > 1;
  // 英訳は story/en/ に置くので、作品名は en の親から取る
  const workDir = basename(dir) === 'en' ? dirname(dir) : dir;
  const work = basename(workDir) === 'story' ? basename(dirname(workDir)) : basename(workDir);
  const name = whole ? work : `${work}-${basename(filePath, '.txt')}`;

  let out;
  let options;
  if (english) {
    const pageSize = enPdfPageSize(layout);
    if (!pageSize) {
      vscode.window.showWarningMessage(
        '英語のPDF出力は 6×9in / 5×8in / A5（縦）のどれかで組みます。今の用紙はどれでもないため 6×9in で出力します。',
      );
    }
    out = `${name}-en-${pageSize ?? '6x9'}.pdf`;
    options = [`--${pageSize ?? '6x9'}`];
  } else {
    if (!matchesPdfScriptPage(layout)) {
      vscode.window.showWarningMessage(
        'PDF出力は A4横・既定の余白で組みます。用紙・余白の設定はプレビューにだけ反映されます。',
      );
    }
    const size = `${metrics.chars}x${metrics.lines}`;
    out = `${name}-${metrics.vertical ? size : 'horizontal'}.pdf`;
    // 行数自動（既定の30字組）はスクリプトの既定そのものなので --size を付けない
    options = !metrics.vertical
      ? ['--horizontal']
      : layout.lines == null && layout.chars === 30
        ? []
        : ['--size', size];
  }
  if (sceneBreak) options.push('--scene-break', sceneBreak);
  if (sceneBreakIndent != null) options.push('--scene-break-indent', String(sceneBreakIndent));
  const outPath = join(root, 'out', 'preview', out);
  mkdirSync(dirname(outPath), { recursive: true });

  runNovelCli([command, ...options, '-o', outPath, whole ? dir : filePath], {
    cwd: root,
    title: `PDFを出力しています（${out}）`,
    failure: 'PDFを出力できませんでした。',
  }).then((ok) => ok && shouldOpen() && vscode.env.openExternal(vscode.Uri.file(outPath)));
}

/**
 * 出力を作る novel.json のパス（選ばなかったときは null）。uri（エクスプローラー・タイトルバーから）か、アクティブな
 * novel.json・原稿から一番近いもの。見つからなければワークスペースの novel.json から選ばせる
 */
async function workConfigFileFor(uri) {
  const editorDoc = vscode.window.activeTextEditor?.document;
  const target =
    uri instanceof vscode.Uri
      ? uri
      : editorDoc && basename(editorDoc.uri.fsPath) === CONFIG_FILENAME
        ? editorDoc.uri
        : activeManuscript()?.uri;
  if (target?.scheme === 'file') {
    if (basename(target.fsPath) === CONFIG_FILENAME) return target.fsPath;
    const dir = statSync(target.fsPath).isDirectory() ? target.fsPath : dirname(target.fsPath);
    const found = findConfigFile(dir, vscode.workspace.getWorkspaceFolder(target)?.uri.fsPath ?? dir);
    if (found) return found;
  }
  const files = await vscode.workspace.findFiles(`**/${CONFIG_FILENAME}`, '**/node_modules/**');
  if (files.length <= 1) {
    if (files.length === 0) vscode.window.showInformationMessage(`${CONFIG_FILENAME} が見つかりません。`);
    return files[0]?.fsPath ?? null;
  }
  const picked = await vscode.window.showQuickPick(
    files
      .map((f) => ({ label: vscode.workspace.asRelativePath(dirname(f.fsPath)), file: f.fsPath }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    { title: '出力する作品' },
  );
  return picked?.file ?? null;
}

/**
 * その場の指定（novel build の --pages / --limit / --target / --ruby-parens）を、選んだ出力に効くものだけ聞く。
 * 空欄なら付けない。取りやめたら null。返す値: { args: CLI に足す引数, pages }
 */
async function askBuildOptions(outputs, work) {
  const keys = new Set(outputs.flatMap((o) => formatTraits(o.format).extra));
  const args = [];
  const ask = async (key, flag, options) => {
    if (!keys.has(key)) return '';
    const value = await vscode.window.showInputBox({ ignoreFocusOut: true, ...options });
    if (value === undefined) return null;
    if (value.trim()) args.push(flag, value.trim());
    return value.trim();
  };

  const pages = await ask('pages', '--pages', {
    title: '抜き出す本文ページ（pdf）',
    prompt: '例: 42,50-53',
    validateInput: (v) => (!v.trim() || parsePageSpec(v) ? null : '42 / 42-45 / 42,50,60-62 の形で書いてください'),
  });
  if (pages === null) return null;
  const limit = await ask('limit', '--limit', {
    title: '先頭から組むファイル数（pdf）',
    validateInput: (v) => (!v.trim() || /^[1-9]\d*$/.test(v.trim()) ? null : '1 以上の整数を書いてください'),
  });
  if (limit === null) return null;
  const target = await ask('target', '--target', {
    title: '想定読者（split / merge）',
    placeHolder: work.target ?? undefined,
  });
  if (target === null) return null;

  if (keys.has('rubyParens') && outputs.some((o) => o.format === 'merge' && !o.rubyParens)) {
    const picked = await vscode.window.showQuickPick(
      [
        { label: 'そのまま', parens: false },
        { label: '括弧表記にする', description: '漢字（かんじ）', parens: true },
      ],
      { title: 'ルビ（merge）', ignoreFocusOut: true },
    );
    if (!picked) return null;
    if (picked.parens) args.push('--ruby-parens');
  }
  return { args, pages: pages || null };
}

/** 出力の説明（QuickPick・プレビューの「出力」のメニューに出す）。出力名が形式の名前なら出力先だけ */
const describeOutput = (name, output) => (name === output.format ? output.out : `${output.format} → ${output.out}`);

/** プレビューの「出力」のメニューに出す novel.json（file）の出力 [{ name, description }]。無い・読めなければ空 */
function menuOutputs(file) {
  if (!file) return [];
  try {
    const work = readWorkConfig(file);
    const outputs = normalizeOutputs(work.outputs, work.id);
    return Object.entries(outputs).map(([name, output]) => ({ name, description: describeOutput(name, output) }));
  } catch {
    return [];
  }
}

/**
 * novel.json の outputs から選んだ出力を、novel build と同じ処理（同梱の CLI の build）で作る。
 * names: 作る出力名（null なら選ばせる）。
 * 出力先は設定 novelPreview.outDir（ワークスペースのフォルダから。既定は out）。
 * PDF・RTF は終わったら開き（shouldOpen）、それ以外は出力先を知らせる
 */
async function buildOutputs(uri, names = null) {
  const file = await workConfigFileFor(uri);
  if (!file) return;
  const label = vscode.workspace.asRelativePath(file);
  let work;
  let outputs;
  try {
    work = readWorkConfig(file);
    outputs = normalizeOutputs(work.outputs, work.id);
  } catch (err) {
    vscode.window.showErrorMessage(`${label} を読めません: ${err.message}`);
    return;
  }
  const available = Object.keys(outputs);
  if (available.length === 0) {
    vscode.window.showInformationMessage(`${label} に outputs がありません。`);
    return;
  }

  const missing = Array.isArray(names) ? names.filter((name) => !available.includes(name)) : [];
  if (missing.length > 0)
    vscode.window.showWarningMessage(`${label} の outputs に ${missing.join(', ')} がありません。`);
  const picked = Array.isArray(names)
    ? { names: names.filter((name) => available.includes(name)) }
    : await vscode.window.showQuickPick(
        [
          ...available.map((name) => ({
            label: name,
            description: describeOutput(name, outputs[name]),
            names: [name],
          })),
          ...(available.length > 1
            ? [
                { label: '', kind: vscode.QuickPickItemKind.Separator, names: [] },
                { label: 'すべての出力', description: available.join(', '), names: available },
              ]
            : []),
        ],
        { title: `出力（${label}）` },
      );
  if (!picked?.names.length) return;
  const selected = picked.names.map((name) => outputs[name]);
  const options = await askBuildOptions(selected, work);
  if (!options) return;

  const base = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file))?.uri.fsPath ?? findProjectRoot(work.dir);
  const outDir = resolve(base, config().get('outDir') || 'out');
  const ok = await runNovelCli(['build', file, ...picked.names, '--out-dir', outDir, ...options.args], {
    cwd: base,
    title: `出力しています（${picked.names.join(', ')}）`,
    failure: `${picked.names.join(', ')} を出力できませんでした。`,
  });
  if (!ok) return;

  const paths = selected.map((o) => ({
    path: outputPath(o, base, { outDir, pages: options.pages }),
    ...formatTraits(o.format),
  }));
  const opened = shouldOpen() ? paths.filter((p) => p.open) : [];
  for (const { path } of opened) vscode.env.openExternal(vscode.Uri.file(path));
  const rest = paths.filter((p) => !opened.includes(p));
  if (rest.length === 0) return;
  const action = await vscode.window.showInformationMessage(
    `出力しました: ${rest.map((p) => vscode.workspace.asRelativePath(p.path)).join(', ')}`,
    'フォルダを開く',
  );
  if (action) vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(rest[0].path));
}

/**
 * 作品の設定（novel.json の画面）を開く。uri（エクスプローラー・プレビューから）か、アクティブな原稿から一番近い novel.json。
 * 原稿から上に無ければ、原稿と同じディレクトリに作るか聞く
 */
async function openWorkSettings(uri) {
  const target = uri instanceof vscode.Uri ? uri : activeManuscript()?.uri;
  let file =
    target && basename(target.fsPath) !== CONFIG_FILENAME && target.fsPath.endsWith('.txt')
      ? layoutFileFor({ uri: target })
      : null;
  if (!file && target?.fsPath.endsWith('.txt')) {
    const created = join(dirname(target.fsPath), CONFIG_FILENAME);
    const picked = await vscode.window.showInformationMessage(
      `${vscode.workspace.asRelativePath(dirname(target.fsPath))} から上に ${CONFIG_FILENAME} がありません。作りますか？`,
      '作る',
    );
    if (!picked) return;
    writeFileSync(created, '{}\n');
    file = created;
  }
  file ??= await workConfigFileFor(uri);
  if (file) await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(file), SETTINGS_VIEW_TYPE);
}

/** 選択範囲に |親《るび》 を振る。選択が無ければカーソルの前後に続く漢字に振る */
async function insertRuby() {
  const editor = vscode.window.activeTextEditor;
  if (!isManuscript(editor?.document)) return;
  const { document, selection } = editor;
  /** @type {vscode.Range} */
  let range = selection;
  if (selection.isEmpty) {
    const { line, character } = selection.active;
    const run = kanjiRunAt(document.lineAt(line).text, character);
    if (run) range = new vscode.Range(line, run.start, line, run.end);
  }
  const base = document.getText(range);
  if (!base || base.includes('\n')) {
    vscode.window.showInformationMessage(
      base ? 'ルビは1行の中の語に振ってください。' : 'ルビを振る語を選んでください。',
    );
    return;
  }
  const ruby = await vscode.window.showInputBox({
    title: `ルビを振る（${base}）`,
    prompt: '読み',
    validateInput: (v) => (v.trim() ? null : '読みを入力してください'),
  });
  if (!ruby) return;
  await editor.edit((b) => b.replace(range, rubyMarkup(base, ruby.trim())));
}

/** 選択範囲を 《《》》 で囲む。選択が無ければ 《《》》 を入れて、その中にカーソルを置く */
async function insertEmphasis() {
  const editor = vscode.window.activeTextEditor;
  if (!isManuscript(editor?.document)) return;
  const selections = editor.selections;
  await editor.edit((b) => {
    for (const sel of selections) b.replace(sel, emphasisMarkup(editor.document.getText(sel)));
  });
  if (selections.every((sel) => sel.isEmpty)) {
    editor.selections = editor.selections.map((sel) => {
      const pos = sel.active.translate(0, -2);
      return new vscode.Selection(pos, pos);
    });
  }
}

/** @type {vscode.EventEmitter<void>} */
const outlineChanged = new vscode.EventEmitter();
let outlineView;
/** 目次を出している作品のファイル（原稿から離れても、最後に見ていた作品の目次を残す） */
let outlineFile = null;

const formatCount = (n, language) =>
  language === 'en' ? `${n.toLocaleString('en-US')} words` : `${n.toLocaleString('ja-JP')}字`;

/** エクスプローラーの目次。章ごとの項目と、複数ファイルの章はその下にファイルを並べる（数は日本語は文字数、英語は語数） */
const outlineProvider = {
  onDidChangeTreeData: outlineChanged.event,
  getTreeItem: (item) => item,
  getChildren(parent) {
    if (parent) return parent.children;
    if (!outlineFile) return [];
    const { parts } = settingsFor({ uri: vscode.Uri.file(outlineFile) });
    const { language, chapters } = buildOutline(outlineFile, { linesOf, parts });
    const current = activeManuscript()?.uri.fsPath;
    const fileItem = ({ file, count }) => {
      const item = new vscode.TreeItem(basename(file));
      item.description = formatCount(count, language);
      item.resourceUri = vscode.Uri.file(file);
      item.iconPath = new vscode.ThemeIcon(file === current ? 'edit' : 'file');
      item.command = { command: 'novelPreview.openFromOutline', title: '開く', arguments: [file] };
      return item;
    };
    return chapters.map((ch) => {
      const single = ch.files.length === 1;
      const label = ch.title ? `${ch.label}${language === 'en' ? '. ' : '　'}${ch.title}` : ch.label;
      /** @type {vscode.TreeItem & { children?: vscode.TreeItem[] }} */
      const item = new vscode.TreeItem(
        label,
        single ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Expanded,
      );
      item.description = single
        ? `${basename(ch.file)}・${formatCount(ch.count, language)}`
        : formatCount(ch.count, language);
      item.tooltip = ch.files.map((f) => basename(f.file)).join('\n');
      item.iconPath = new vscode.ThemeIcon(single && ch.file === current ? 'edit' : 'book');
      item.command = { command: 'novelPreview.openFromOutline', title: '開く', arguments: [ch.file] };
      item.children = single ? [] : ch.files.map(fileItem);
      return item;
    });
  },
};

/** 目次を作り直す。原稿を一度でも開いたら、エクスプローラーに目次を出す */
function refreshOutline() {
  const doc = activeManuscript();
  if (doc) {
    if (!outlineFile) vscode.commands.executeCommand('setContext', 'novelPreview.hasManuscript', true);
    outlineFile = doc.uri.fsPath;
  }
  if (!outlineView?.visible) return;
  outlineView.message = outlineFile ? undefined : '原稿（.txt）を開くと、その作品の目次を出します。';
  outlineView.title = outlineFile ? `目次: ${basename(dirname(outlineFile))}` : '小説の目次';
  outlineChanged.fire();
}

/** 小説パネルの webview（初めて開くまでは null） */
let panelView = null;
/** 小説パネルで見せているタブ（prose: 文章の傾向 / work: 作品設定 / page: ページ設定） */
let panelTab = 'prose';
/** パネルを開く前に頼まれたタブ。開いたときは、webview が覚えていたタブよりこちらを見せる */
let pendingPanelTab = null;
/** パネルが対象にしている原稿（原稿から離れても、最後に見ていた原稿を残す） */
let panelFile = null;
/** 最後にパネルへ送った中身（種類ごとの JSON）。同じなら送り直さない */
let panelPosted = {};
let tokenizer = null;

/** 形態素解析器。辞書の読み込みに数百 MB のメモリを使うので、「文章の傾向」を初めて見せるときに作る */
function proseTokenizer() {
  const dist = join(context.extensionPath, 'dist');
  tokenizer ??= createTokenizer({ wasm: join(dist, 'lindera_wasm_bg.wasm'), dictDir: join(dist, 'ipadic') });
  return tokenizer;
}

/** 原稿 file を、設定を読む関数に渡す文書の代わりにする。タブを閉じた原稿でも使えるよう、中身は linesOf で読む */
const manuscriptAt = (file) => ({ uri: vscode.Uri.file(file), getText: () => linesOf(file).join('\n') });

/** 原稿の版（ファイルと、開いていれば document.version、開いていなければ mtime） */
function fileStampOf(filePath) {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === filePath);
  if (open) return `${filePath}:v${open.version}`;
  try {
    return `${filePath}:m${statSync(filePath).mtimeMs}`;
  } catch {
    return `${filePath}:missing`;
  }
}

/** 形態素解析をしたときの、原稿の版・言語・設定と、解析結果 */
let proseCache = { stamp: null, report: null };

/**
 * 「文章の傾向」のタブに送る中身。{ file, stats: { file: このファイル, work: 作品全体（1ファイルなら null）（computeStats）, layout: レイアウトの表記 },
 * english, report: 文章の傾向（proseReport。英語の原稿か、設定 novelPreview.prose がオフなら null） }
 */
function proseState(file) {
  const { layout, english } = resolvedSettingsFor(manuscriptAt(file));
  const files = listWorkFiles(file);
  const work = files.length > 1 && files.includes(file) ? files : null;
  const enabled = config().get('prose') !== false;
  const metrics = computeMetrics(layout, { english });
  const lines = linesOf(file);
  // 形態素解析の結果は原稿1ファイルにしか左右されない。他のファイルの編集やレイアウトの変更のたびに解析し直さないため、キーはその原稿の版だけにする
  const stamp = [english, enabled, fileStampOf(file)].join('\n');
  if (stamp !== proseCache.stamp) {
    proseCache = {
      stamp,
      report: english || !enabled ? null : proseReport(analyzeProse(lines, proseTokenizer())),
    };
  }
  return {
    file: basename(file),
    stats: {
      file: computeStats([lines], metrics),
      work: work && computeStats(work.map(linesOf), metrics),
      layout: describeLayout(layout, { english }),
    },
    english,
    report: proseCache.report,
  };
}

/** 「ページ設定」のタブに送る中身（原稿の言語のレイアウトと、そこから決まる字数×行数・文字サイズ） */
function pageState(file) {
  const doc = manuscriptAt(file);
  const { layout, english } = resolvedSettingsFor(doc);
  const metrics = computeMetrics(layout, { english });
  const presets = allPresets(english);
  const layoutFile = layoutFileFor(doc);
  return {
    file: basename(file),
    layout: metrics.layout,
    metrics,
    language: metrics.language,
    presets: Object.keys(presets),
    presetName: Object.keys(presets).find((name) => layoutsEqual(presets[name], layout, { english })) ?? null,
    userPresetNames: Object.keys(userPresets(english)),
    layoutFile: layoutFile ? vscode.workspace.asRelativePath(layoutFile) : null,
  };
}

/** パネルへ type の中身を送る（前に送ったものと同じなら送らない） */
function postPanel(type, state) {
  const json = JSON.stringify(state);
  if (panelPosted[type] === json) return;
  panelPosted[type] = json;
  panelView.webview.postMessage({ type, ...state });
}

/** パネルの中身を作り直す。見えているタブの分だけ作る */
function refreshPanel() {
  const doc = activeManuscript();
  if (doc) panelFile = doc.uri.fsPath;
  if (!panelView?.visible) return;
  postPanel('message', {
    text: panelFile ? '' : '原稿（.txt）を開くと、その文章の傾向・作品設定・ページ設定を出します。',
  });
  if (!panelFile) return;
  if (panelTab !== 'work') closePanelWork();
  try {
    if (panelTab === 'prose') postPanel('prose', proseState(panelFile));
    else if (panelTab === 'page') postPanel('page', pageState(panelFile));
    else syncPanelWork();
  } catch (err) {
    postPanel('message', {
      text: `${basename(panelFile)} の${panelTab === 'prose' ? '文章の傾向' : '設定'}を出せませんでした: ${err.message}`,
    });
  }
}

/**
 * 作品設定のタブのフォーム（タブを見せている間だけ）。{ file: 原稿から一番近い novel.json（無ければ null）, controller }。
 * 別の作品の原稿に移ったり novel.json ができたりしたら、syncPanelWork で付け替える
 */
let panelWork = null;
const postPanelWork = (state) => panelView?.webview.postMessage({ type: 'workSettings', state });

async function syncPanelWork() {
  const file = layoutFileFor(manuscriptAt(panelFile));
  if (panelWork?.file === file) return;
  panelWork?.controller?.dispose();
  const current = { file, controller: null };
  panelWork = current;
  if (!file) {
    postPanelWork({ file: null, missing: vscode.workspace.asRelativePath(dirname(panelFile)) });
    return;
  }
  const document = await vscode.workspace.openTextDocument(file);
  // 待つ間にタブを替えられたり付け替えられたりしていれば、もう要らない
  if (panelWork !== current) return;
  current.controller = createWorkSettingsController(document, {
    post: postPanelWork,
    build: buildOutputs,
    linesOf,
    openText: () => vscode.commands.executeCommand('vscode.openWith', document.uri, 'default'),
    // novel.json はタブに無いことが多く、保存しないと見えないところに未保存の変更が残る。
    // プレビューも設定ファイルをディスクから読むので、保存して初めて部の境界などが表示に効く
    save: true,
  });
  current.controller.render();
}

function closePanelWork() {
  panelWork?.controller?.dispose();
  panelWork = null;
}

/**
 * パネルからのメッセージ。ready・tab でタブを決めて中身を作り、reveal で原稿の行を開き、layout・preset でレイアウトを変え、
 * work は作品設定のフォームのメッセージ（create で novel.json を作る）
 */
function onPanelMessage(msg) {
  const doc = panelFile ? manuscriptAt(panelFile) : null;
  switch (msg.type) {
    case 'ready':
      panelTab = pendingPanelTab ?? msg.tab;
      pendingPanelTab = null;
      panelPosted = {};
      closePanelWork();
      panelView.webview.postMessage({ type: 'tab', tab: panelTab });
      return refreshPanel();
    case 'tab':
      panelTab = msg.tab;
      return refreshPanel();
    case 'reveal':
      return panelFile && revealLine(panelFile, msg.line);
    case 'layout':
      // 範囲外の値は丸めて保存するので、レイアウトが変わらなくても入力欄を保存した値に戻す
      panelPosted.page = null;
      return doc && setLayout(doc, msg.layout);
    case 'preset': {
      const preset = doc && allPresets(isEnglishManuscript(doc))[msg.name];
      return preset && setLayout(doc, preset);
    }
    case 'savePreset':
      return doc && savePreset(doc);
    case 'deletePreset':
      return deletePreset(msg.name);
    case 'openSettings':
      return vscode.commands.executeCommand('workbench.action.openSettings', 'novelPreview.prose');
    case 'work':
      if (msg.msg.type !== 'create') return panelWork?.controller?.onMessage(msg.msg);
      if (doc && !layoutFileFor(doc)) writeFileSync(join(dirname(panelFile), CONFIG_FILENAME), '{}\n');
      return syncPanelWork();
  }
}

/** セカンダリサイドバーの「小説」に出す小説パネル */
const panelProvider = {
  resolveWebviewView(view) {
    panelView = view;
    const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
    const uri = (name) => view.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, name));
    view.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    view.webview.html = renderPanelHtml({
      cssUris: [uri('panel.css'), uri('work-settings.css')],
      jsUris: [uri('settings.js'), uri('panel.js')],
      cspSource: view.webview.cspSource,
      nonce: randomBytes(16).toString('hex'),
    });
    view.webview.onDidReceiveMessage(onPanelMessage);
    // 隠れている間は novel.json と原稿を見張らなくてよいので、作品設定のフォームを閉じる
    view.onDidChangeVisibility(() => (view.visible ? refreshPanel() : closePanelWork()));
    view.onDidDispose(() => {
      closePanelWork();
      panelView = null;
    });
  },
};

/** 小説パネルを開く。tab があればそのタブにする */
async function showPanel(tab) {
  if (tab && panelView) {
    panelTab = tab;
    panelView.webview.postMessage({ type: 'tab', tab });
    refreshPanel();
  } else if (tab) {
    pendingPanelTab = tab;
  }
  await vscode.commands.executeCommand(`${PANEL_VIEW_ID}.focus`);
}

async function revealLine(file, line) {
  const position = new vscode.Position(line, 0);
  await vscode.window.showTextDocument(vscode.Uri.file(file), { selection: new vscode.Range(position, position) });
}

/** 作品全体を表示している小説プレビューが見えていれば、その中で該当ファイルの頭へ動かす。無ければファイルを開く */
async function openFromOutline(file) {
  const session = [...sessions].find((s) => !s.follow && s.panel.visible && s.files.includes(file));
  if (session) {
    session.panel.reveal(undefined, false);
    session.panel.webview.postMessage({ type: 'reveal', target: { fileIndex: session.files.indexOf(file), line: 0 } });
    return;
  }
  await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
}

/** step: 1 で次のファイル、-1 で前のファイル（PDF出力と同じ並び）を開く */
async function openNeighborFile(step) {
  const doc = activeManuscript();
  if (!doc) return;
  const files = listWorkFiles(doc.uri.fsPath);
  const target = files[files.indexOf(doc.uri.fsPath) + step];
  if (!target) {
    vscode.window.showInformationMessage(step > 0 ? '最後のファイルです。' : '最初のファイルです。');
    return;
  }
  await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target));
}

const formatPages = (n) => (Math.round(n * 10) / 10).toLocaleString('ja-JP');

/**
 * ステータスバーに文字数（英語は語数）・換算枚数・レイアウトを出す（目次と小説パネルも作り直す）。
 * 横のプレビューだけが残っていて、前面が原稿でもプレビューでもないときは出さない
 */
function updateStatusBar() {
  refreshOutline();
  refreshPanel();
  const doc = activeManuscript();
  const showing =
    doc && (isManuscript(vscode.window.activeTextEditor?.document) || [...sessions].some((s) => s.panel.active));
  if (!showing) {
    statusBar.hide();
    return;
  }
  const layout = layoutFor(doc);
  const metrics = metricsFor(doc);
  const stats = computeStats([splitLines(doc.getText())], metrics);

  const editor = vscode.window.activeTextEditor;
  const selectedText = editor?.document === doc ? editor.selections.map((sel) => doc.getText(sel)).join('\n') : '';

  if (metrics.language === 'en') {
    const selectedWords = selectedText.split(/\s+/).filter(Boolean).length;
    const parts = [
      selectedWords > 0
        ? `選択 ${selectedWords.toLocaleString('en-US')} / ${stats.words.toLocaleString('en-US')} words`
        : `${stats.words.toLocaleString('en-US')} words`,
      describeLayout(layout, { english: true }),
    ];
    statusBar.text = `$(book) ${parts.join(' ・ ')}`;
    statusBar.tooltip = '語数（メタ行を除く）・現在のレイアウト（English）\nクリックでレイアウトを選ぶ';
    statusBar.show();
    return;
  }

  const selected = countTextChars(stripInlineMarkup(selectedText));
  const parts = [
    selected > 0
      ? `選択 ${selected.toLocaleString('ja-JP')}字 / ${stats.chars.toLocaleString('ja-JP')}字`
      : `${stats.chars.toLocaleString('ja-JP')}字`,
    `400字詰め ${formatPages(stats.genkoPages)}枚`,
    `${describeLayout(layout)} ${formatPages(stats.gridPages)}枚`,
  ];
  statusBar.text = `$(book) ${parts.join(' ・ ')}`;
  statusBar.tooltip =
    '文字数（ルビ・メタ行を除く）・400字詰め原稿用紙換算・現在のレイアウトでの換算枚数\nクリックでレイアウトを選ぶ';
  statusBar.show();
}

/**
 * 拡張の開発中（Extension Development Host）だけ、ビルドした拡張（dist）か webview の media が書き換わったら
 * ウィンドウを再読み込みする。開いている原稿のプレビューは最新のソースで開き直る
 */
function reloadOnRebuild(ctx) {
  if (ctx.extensionMode !== vscode.ExtensionMode.Development) return;
  const digest = (file) => {
    try {
      return createHash('sha1').update(readFileSync(file)).digest('hex');
    } catch {
      return null;
    }
  };
  let timer;
  for (const dir of ['dist', 'media']) {
    const root = join(ctx.extensionPath, dir);
    const watched = (name) => (dir === 'dist' ? name.endsWith('.cjs') : true);
    // 起動直後の watch の初回ビルドは同じ中身を書き直すだけなので、中身が変わったときだけ再読み込みする
    const digests = new Map(
      readdirSync(root)
        .filter(watched)
        .map((name) => [name, digest(join(root, name))]),
    );
    const watcher = watch(root, (_event, name) => {
      if (!name || !watched(name)) return;
      const next = digest(join(root, name));
      if (next === digests.get(name)) return;
      digests.set(name, next);
      // esbuild は出力ファイルを1つずつ書くので、書き終わるまで待ってから1回だけ再読み込みする
      clearTimeout(timer);
      timer = setTimeout(() => vscode.commands.executeCommand('workbench.action.reloadWindow'), 300);
    });
    ctx.subscriptions.push({ dispose: () => watcher.close() });
  }
}

export function activate(ctx) {
  context = ctx;
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 200);
  statusBar.command = 'novelPreview.selectLayout';
  outlineView = vscode.window.createTreeView('novelPreview.outline', { treeDataProvider: outlineProvider });
  reloadOnRebuild(ctx);

  // 設定ファイルを手で書き換えたとき・置き場所を変えたときにも追従する
  const layoutWatcher = vscode.workspace.createFileSystemWatcher(`**/${CONFIG_FILENAME}`);

  // エディタで開いていない原稿の追加・削除・外部からの書き換え（Claude Code など）は onDidChangeTextDocument に来ない。
  // 同じディレクトリの原稿は作品全体の表示にも単独表示の章番号にも効くので、そのディレクトリを見ているプレビューを組み直す
  const manuscriptWatcher = vscode.workspace.createFileSystemWatcher('**/*.txt');
  const onManuscriptFileEvent = (uri) => {
    const dir = dirname(uri.fsPath);
    for (const session of sessions) {
      if (session.doc && dirname(session.doc.uri.fsPath) === dir) session.scheduleRender();
    }
    if (outlineFile && dirname(outlineFile) === dir) scheduleStatusBar();
  };

  let statusTimer;
  const scheduleStatusBar = () => {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(updateStatusBar, RENDER_DELAY_MS);
  };

  ctx.subscriptions.push(
    statusBar,
    vscode.window.registerCustomEditorProvider(EDITOR_VIEW_TYPE, editorProvider, {
      webviewOptions: { retainContextWhenHidden: true, enableFindWidget: true },
    }),
    vscode.commands.registerCommand('novelPreview.open', openSidePreview),
    vscode.commands.registerCommand('novelPreview.reopenAsPreview', replaceWithPreview),
    vscode.commands.registerCommand('novelPreview.selectLayout', selectLayout),
    vscode.commands.registerCommand('novelPreview.exportPdf', () => exportPdf()),
    vscode.window.registerCustomEditorProvider(
      SETTINGS_VIEW_TYPE,
      createSettingsEditorProvider(ctx, { build: buildOutputs, linesOf }),
    ),
    vscode.commands.registerCommand('novelPreview.build', (uri) => buildOutputs(uri)),
    vscode.commands.registerCommand('novelPreview.openWorkSettings', openWorkSettings),
    vscode.commands.registerCommand('novelPreview.insertRuby', insertRuby),
    vscode.commands.registerCommand('novelPreview.insertEmphasis', insertEmphasis),
    vscode.commands.registerCommand('novelPreview.openFromOutline', openFromOutline),
    vscode.commands.registerCommand('novelPreview.nextFile', () => openNeighborFile(1)),
    vscode.commands.registerCommand('novelPreview.previousFile', () => openNeighborFile(-1)),
    outlineChanged,
    outlineView,
    outlineView.onDidChangeVisibility(refreshOutline),
    vscode.commands.registerCommand('novelPreview.revealLine', revealLine),
    vscode.window.registerWebviewViewProvider(PANEL_VIEW_ID, panelProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('novelPreview.showPanel', () => showPanel()),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      updateStatusBar();
      if (!isManuscript(editor?.document)) return;
      const filePath = editor.document.uri.fsPath;
      for (const session of sessions) {
        const changed = session.follow && session.doc?.uri.fsPath !== filePath;
        if (session.follow) session.doc = editor.document;
        if (changed && !(session.scope === 'work' && session.files.includes(filePath))) session.render();
        else session.postReveal();
      }
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length === 0) return;
      scheduleStatusBar();
      const undoRedo =
        e.reason === vscode.TextDocumentChangeReason.Undo || e.reason === vscode.TextDocumentChangeReason.Redo;
      for (const session of sessions) {
        if (!session.files.includes(e.document.uri.fsPath)) continue;
        if (undoRedo || !session.applying) session.externalChange = true;
        if (!session.applying) session.dropHistory(e.document.uri.fsPath);
        if (undoRedo) session.render();
        else session.scheduleRender();
      }
    }),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (!isManuscript(e.textEditor.document)) return;
      scheduleStatusBar();
      if (e.textEditor !== vscode.window.activeTextEditor) return;
      for (const session of sessions) session.postReveal();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('novelPreview')) refreshLayout();
      // wasm のメモリは縮まないので、解析器を捨ててもプロセスのメモリは再読み込みまで戻らない
      if (e.affectsConfiguration('novelPreview.prose') && !config().get('prose')) {
        tokenizer?.free();
        tokenizer = null;
      }
    }),
    manuscriptWatcher,
    manuscriptWatcher.onDidCreate(onManuscriptFileEvent),
    manuscriptWatcher.onDidChange(onManuscriptFileEvent),
    manuscriptWatcher.onDidDelete(onManuscriptFileEvent),
    layoutWatcher,
    layoutWatcher.onDidChange(refreshLayout),
    layoutWatcher.onDidCreate(refreshLayout),
    layoutWatcher.onDidDelete(refreshLayout),
    { dispose: () => sidePreview?.panel.dispose() },
  );

  updateStatusBar();
}

export function deactivate() {}
