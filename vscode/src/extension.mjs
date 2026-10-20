import * as vscode from 'vscode';
import { existsSync } from 'fs';
import { basename, dirname, join, relative } from 'path';
import { randomBytes } from 'crypto';
import { countTextChars, readLines, splitLines, stripInlineMarkup } from '../../scripts/lib/text-parser.mts';
import {
  BUILTIN_ENGLISH_PRESETS, BUILTIN_PRESETS, computeMetrics, describeLayout, enPdfPageSize, layoutsEqual,
  matchesPdfScriptPage, normalizeLayout,
} from './layout.mts';
import { buildDocument, computeStats, detectLanguageOfLines, listWorkFiles } from './document.mts';
import { DEFAULT_VIEW, LAYOUT_FILENAME, findLayoutFile, readSettingsFile, writeSettingsFile } from './layout-file.mts';
import { renderWebviewHtml } from './webview.mts';

const PDF_SCRIPT = 'scripts/txt-to-pdf.mts';
const EN_PDF_SCRIPT = 'scripts/txt-to-en-pdf.mts';
const RENDER_DELAY_MS = 250;
// 同じ段落への入力がこの間隔以内に続けば、取り消しの1回分にまとめる
const UNDO_GROUP_MS = 1500;
// package.json の customEditors と同じID。workbench.editorAssociations で .txt の既定にできる
const EDITOR_VIEW_TYPE = 'novelPreview.editor';

let context;
let statusBar;
let pdfTerminal = null;
// 開いているプレビュー（.txt のタブとして開いたものと、横に出したもの）
const sessions = new Set();
// テキストエディタの横に出す、アクティブなエディタに追従するプレビュー（1つだけ）
let sidePreview = null;
// 「プレビューに切り替える」で開くタブに渡す、テキストエディタで見ていた位置（{ filePath, line }）
let pendingReveal = null;

// .txt の言語IDは入っている拡張によって変わる（plaintext とは限らない）ので、拡張子だけで判定する
const isManuscript = (doc) =>
  !!doc && doc.uri.scheme === 'file' && doc.uri.fsPath.endsWith('.txt');

const config = () => vscode.workspace.getConfiguration('novelPreview');

// 利用者のプリセット。"english": true のものは英語用
function userPresets(english = false) {
  const raw = config().get('presets');
  const all = raw && typeof raw === 'object' ? raw : {};
  return Object.fromEntries(Object.entries(all).filter(([, layout]) => !!layout?.english === english));
}

function allPresets(english = false) {
  const merged = { ...(english ? BUILTIN_ENGLISH_PRESETS : BUILTIN_PRESETS), ...userPresets(english) };
  return Object.fromEntries(Object.entries(merged).map(([name, layout]) => [name, normalizeLayout(layout, { english })]));
}

// レイアウトは原稿から一番近い novel-layout.json に持つ（ワークスペースの外までは探さない）
function layoutFileFor(doc) {
  const dir = dirname(doc.uri.fsPath);
  const root = vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath ?? dir;
  return findLayoutFile(dir, root);
}

let warnedLayoutFile = null;

// 原稿に効いている設定（日本語・英語のレイアウトと表示設定）。設定ファイルが無い・読めないときは既定のプリセットと既定の表示設定
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
        vscode.window.showWarningMessage(`${vscode.workspace.asRelativePath(file)} を読めないため、既定の設定で表示します: ${err.message}`);
      }
    }
  }
  return {
    layout: allPresets()[config().get('defaultPreset')] ?? normalizeLayout(null),
    english: normalizeLayout(null, { english: true }),
    view: { ...DEFAULT_VIEW },
  };
}

// 原稿の文字がアルファベット中心なら英語の組版
const isEnglishManuscript = (doc) => detectLanguageOfLines(splitLines(doc.getText())) === 'en';

// 原稿に効く設定。原稿の言語に応じて日本語か英語のレイアウトを layout として返す
function resolvedSettingsFor(doc) {
  const { layout, english, view } = settingsFor(doc);
  const en = isEnglishManuscript(doc);
  return { layout: en ? english : layout, view, english: en };
}

const layoutFor = (doc) => resolvedSettingsFor(doc).layout;

function metricsFor(doc) {
  const { layout, english } = resolvedSettingsFor(doc);
  return computeMetrics(layout, { english });
}

// 一番近い設定ファイルへ書く。まだ無ければ原稿と同じディレクトリに作る
// patch: { layout } で原稿の言語のレイアウト（日本語か英語）を差し替え、{ view } で表示設定の一部を上書きする
function updateSettings(doc, patch) {
  const current = settingsFor(doc);
  const file = layoutFileFor(doc) ?? join(dirname(doc.uri.fsPath), LAYOUT_FILENAME);
  if (file === warnedLayoutFile) {
    vscode.window.showErrorMessage(`${vscode.workspace.asRelativePath(file)} が壊れているため、設定を保存できません。ファイルを直すか削除してください。`);
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

function linesOf(filePath) {
  const open = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && d.uri.fsPath === filePath);
  return open ? splitLines(open.getText()) : readLines(filePath);
}

// いま操作しているプレビュー（タブが前面のもの。無ければ横のプレビュー）
const activeSession = () => [...sessions].find(s => s.panel.active) ?? sidePreview;

// コマンドやステータスバーが対象にする原稿
function activeManuscript() {
  const editorDoc = vscode.window.activeTextEditor?.document;
  if (isManuscript(editorDoc)) return editorDoc;
  return activeSession()?.doc ?? null;
}

// ---- プレビュー（1枚の webview と、それが表示している原稿） ----

/**
 * doc: 表示する原稿。null なら「原稿を開いてください」の案内を出す
 * follow: アクティブなテキストエディタに追従して doc を差し替える（横のプレビュー）
 * initialLine: 最初の描画で表示する doc の行（開いたファイルの先頭か、テキストエディタから切り替えたときの見ていた位置）
 */
function createSession(panel, { doc = null, follow = false, initialLine = null } = {}) {
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
  let renderTimer;
  let editQueue = Promise.resolve();

  const session = {
    panel,
    doc,
    follow,
    files: [],
    // プレビュー自身の編集を反映している最中か（その変更通知は「外からの変更」に数えない）
    applying: false,
    // 取り消し・テキストエディタ・外部ツールなど、プレビュー以外が原稿を変えた
    externalChange: false,
    // 表示範囲。描画のたびに設定ファイルの値（既定は作品全体）で更新する
    scope: DEFAULT_VIEW.scope,
    // プレビューでの編集の取り消し・やり直し。カスタムエディタの Cmd+Z は開いたファイルにしか効かず、
    // 作品全体の表示で別のファイルを編集したときに無関係な変更を取り消してしまうので、自前で持つ
    // 要素: { filePath, startLine, before: 行の配列, after: 行の配列, time }
    undoStack: [],
    redoStack: [],
    // プレビューの外でファイルが変わったら、そのファイルの履歴は行位置が当てにならないので捨てる
    dropHistory(filePath) {
      session.undoStack = session.undoStack.filter(e => e.filePath !== filePath);
      session.redoStack = session.redoStack.filter(e => e.filePath !== filePath);
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

  // テキストエディタ側のカーソル位置（このプレビューが表示しているファイルにあるときだけ）
  function revealTarget() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return null;
    const fileIndex = session.files.indexOf(editor.document.uri.fsPath);
    return fileIndex < 0 ? null : { fileIndex, line: editor.selection.active.line };
  }

  // 最初の描画の1回だけ、開いたファイルの表示位置を返す
  function takeInitialReveal() {
    if (initialLine == null) return null;
    const target = { fileIndex: session.files.indexOf(session.doc.uri.fsPath), line: initialLine };
    initialLine = null;
    return target.fileIndex < 0 ? null : target;
  }

  // focusEdit: 描画後にプレビュー側で編集を始める位置（{ fileIndex, line, offset }）
  function render({ focusEdit = null } = {}) {
    clearTimeout(renderTimer);
    if (!session.doc) {
      panel.webview.postMessage({ type: 'message', text: '原稿のテキストファイル（.txt）を開くとプレビューを表示します。' });
      return;
    }

    const filePath = session.doc.uri.fsPath;
    const { layout, view, english } = resolvedSettingsFor(session.doc);
    session.scope = view.scope;
    const metrics = computeMetrics(layout, { english });
    try {
      const built = buildDocument({ filePath, scope: session.scope, metrics, linesOf });
      session.files = built.files;
      const presets = allPresets(english);
      const initialReveal = takeInitialReveal();
      const layoutFile = layoutFileFor(session.doc);
      if (follow) panel.title = `プレビュー: ${built.files.length > 1 ? basename(dirname(filePath)) : basename(filePath)}`;
      panel.webview.postMessage({
        type: 'render',
        css: built.css,
        body: built.body,
        stats: built.stats,
        metrics,
        language: metrics.language,
        layout: metrics.layout,
        presets,
        presetName: Object.keys(presets).find(name => layoutsEqual(presets[name], layout, { english })) ?? null,
        layoutFile: layoutFile ? vscode.workspace.asRelativePath(layoutFile) : null,
        userPresetNames: Object.keys(userPresets(english)),
        scope: session.scope,
        view,
        canShowWork: listWorkFiles(filePath).includes(filePath),
        reveal: initialReveal ?? revealTarget(),
        // タブを開いた直後は、プレビューにフォーカスがあってもその位置へ動かす
        forceReveal: !!initialReveal,
        sources: built.sources,
        focusEdit,
        // true なら、プレビューが段落を編集中でも組み直す（編集中の表示が古くなっているため）
        external: session.externalChange,
      });
      session.externalChange = false;
    } catch (err) {
      panel.webview.postMessage({ type: 'message', text: `プレビューを作れませんでした: ${err.message}` });
    }
  }

  // edit: 1行を text で置き換える（text に改行があれば行が増える）
  // merge: 行頭での Backspace。前の行の末尾へつなげる
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

  function recordHistory(entry) {
    session.redoStack = [];
    const now = Date.now();
    const last = session.undoStack.at(-1);
    // 1つの段落の中で打ち続けている間は1回分にまとめる（行数が変わる編集はまとめない）
    const typing = (e) => e.before.length === 1 && e.after.length === 1;
    if (last && typing(last) && typing(entry) && last.filePath === entry.filePath
      && last.startLine === entry.startLine && now - last.time < UNDO_GROUP_MS) {
      last.after = entry.after;
      last.time = now;
      return;
    }
    session.undoStack.push({ ...entry, time: now });
  }

  // redo: false で取り消し、true でやり直し
  async function undoPreviewEdit(redo) {
    const from = redo ? session.redoStack : session.undoStack;
    const to = redo ? session.undoStack : session.redoStack;
    const entry = from.pop();
    if (!entry) return;
    const [current, restored] = redo ? [entry.before, entry.after] : [entry.after, entry.before];

    const target = await vscode.workspace.openTextDocument(entry.filePath);
    const endLine = entry.startLine + current.length - 1;
    const intact = endLine < target.lineCount
      && current.every((text, i) => target.lineAt(entry.startLine + i).text === text);
    if (!intact) {
      session.dropHistory(entry.filePath);
      vscode.window.showWarningMessage(`${basename(entry.filePath)} がプレビューの外で変更されているため、${redo ? 'やり直せません' : '取り消せません'}。`);
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    edit.replace(target.uri, new vscode.Range(entry.startLine, 0, endLine, target.lineAt(endLine).text.length), restored.join('\n'));
    if (!(await applyTracked(edit))) return;
    // まとめた入力の途中から打ち直しても、この取り消しとは別の1回にする
    entry.time = 0;
    to.push(entry);

    // 変わった段落の末尾で編集を続ける（別のファイルなら、そこまで表示を動かす）
    const fileIndex = session.files.indexOf(entry.filePath);
    const line = entry.startLine + restored.length - 1;
    render({ focusEdit: fileIndex < 0 ? null : { fileIndex, line, offset: restored.at(-1).length } });
  }

  async function saveFiles() {
    const dirty = vscode.workspace.textDocuments.filter(d => d.isDirty && session.files.includes(d.uri.fsPath));
    await Promise.all(dirty.map(d => d.save()));
  }

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
        // 表示範囲・倍率・編集のオンオフ。設定ファイルに書き、同じ設定を見ているプレビューすべてに反映する
        return session.doc && updateSettings(session.doc, { view: msg.view });
      case 'jump':
        return openInTextEditor(session.files[msg.fileIndex], msg.line, panel);
      case 'openText':
        // 見ている位置のファイル（作品全体の表示なら、開いたファイルとは限らない）をテキストエディタで開く
        return replaceWithTextEditor(session, session.files[msg.fileIndex] ?? session.doc?.uri.fsPath, msg.line ?? 0);
      case 'refresh':
        return render({ focusEdit: msg.focusEdit ?? null });
      case 'edit':
      case 'merge':
        // 入力のたびに届くので、適用順が前後しないよう直列にする
        editQueue = editQueue.then(() => applyPreviewEdit(msg))
          .catch(err => vscode.window.showErrorMessage(`プレビューでの編集を反映できませんでした: ${err.message}`));
        return editQueue;
      case 'undo':
      case 'redo':
        // 直前の入力の反映が終わってから取り消す
        editQueue = editQueue.then(() => undoPreviewEdit(msg.type === 'redo'))
          .catch(err => vscode.window.showErrorMessage(`プレビューでの編集を${msg.type === 'redo' ? 'やり直せ' : '取り消せ'}ませんでした: ${err.message}`));
        return editQueue;
      case 'save':
        return saveFiles();
      case 'savePreset':
        return session.doc && savePreset(session.doc);
      case 'deletePreset':
        return deletePreset(msg.name);
      case 'exportPdf':
        return exportPdf(session);
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

// .txt を「小説プレビュー」で開いたときのタブ（カスタムエディタ）。文書の保存・取り消しは VS Code が面倒を見る
const editorProvider = {
  resolveCustomTextEditor(document, panel) {
    // 作品全体の表示でも、開いたファイルの位置から見せる（テキストエディタから切り替えたときは、そこで見ていた行）
    const initialLine = pendingReveal?.filePath === document.uri.fsPath ? pendingReveal.line : 0;
    pendingReveal = null;
    createSession(panel, { doc: document, initialLine });
    updateStatusBar();
  },
};

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

// プレビューからテキストエディタの該当行へ。プレビューのタブは残し、すでに見えているエディタがあればそこへ、無ければ横に開く
async function openInTextEditor(filePath, line, fromPanel) {
  if (!filePath) return;
  const visible = vscode.window.visibleTextEditors.find(e => e.document.uri.fsPath === filePath);
  const anyEditor = vscode.window.visibleTextEditors.find(e => isManuscript(e.document) && e.viewColumn !== fromPanel.viewColumn);
  const doc = await vscode.workspace.openTextDocument(filePath);
  const editor = await vscode.window.showTextDocument(doc, {
    viewColumn: visible?.viewColumn ?? anyEditor?.viewColumn ?? vscode.ViewColumn.Beside,
  });
  const pos = new vscode.Position(Math.min(line, doc.lineCount - 1), 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

// 「テキストで開く」。.txt のタブとして開いたプレビューは、同じ場所でテキストエディタに入れ替える
// （横に出したプレビューは隣にエディタがある前提なので、そちらの該当行へ飛ぶだけ）
async function replaceWithTextEditor(session, filePath, line) {
  if (!filePath) return;
  if (session.follow) return openInTextEditor(filePath, line, session.panel);

  const doc = await vscode.workspace.openTextDocument(filePath);
  const editor = await vscode.window.showTextDocument(doc, { viewColumn: session.panel.viewColumn });
  const pos = new vscode.Position(Math.min(line, doc.lineCount - 1), 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
  // 文書はテキストエディタが引き継ぐので、未保存の変更があってもプレビューのタブを閉じて失うものはない
  session.panel.dispose();
}

// 「プレビューに切り替える」。テキストエディタのタブを、同じ場所で小説プレビューに入れ替える（「テキストで開く」の逆）
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

// ---- プリセット ----

const presetTarget = () =>
  vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;

// 英語のレイアウトは "english": true を付けて保存し、英語の原稿のときだけ出す
async function savePreset(doc) {
  const { layout, english } = resolvedSettingsFor(doc);
  const name = await vscode.window.showInputBox({
    title: `レイアウトをプリセットとして保存${english ? '（English）' : ''}`,
    prompt: 'プリセット名',
    value: describeLayout(layout, { english }),
    validateInput: v => (v.trim() ? null : '名前を入力してください'),
  });
  if (!name) return;
  const saved = english ? { ...layout, english: true } : layout;
  await config().update('presets', { ...userPresets(false), ...userPresets(true), [name.trim()]: saved }, presetTarget());
}

async function deletePreset(name) {
  const presets = { ...userPresets(false), ...userPresets(true) };
  if (!(name in presets)) return;
  delete presets[name];
  await config().update('presets', presets, presetTarget());
}

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

// ---- PDF出力（scripts/txt-to-pdf.mts） ----

const shellQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

// session があればその表示範囲（このファイル / 作品全体）で、無ければ開いている原稿1ファイルを出力する。
// 日本語は scripts/txt-to-pdf.mts、英語は scripts/txt-to-en-pdf.mts（判型は用紙から選ぶ）
function exportPdf(session = activeSession()) {
  const doc = session?.doc ?? activeManuscript();
  if (!doc) return;
  const filePath = doc.uri.fsPath;
  const root = vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath;
  const { layout, english } = resolvedSettingsFor(doc);
  const metrics = computeMetrics(layout, { english });
  const script = english ? EN_PDF_SCRIPT : PDF_SCRIPT;
  if (!root || !existsSync(join(root, script))) {
    vscode.window.showErrorMessage(`${script} が見つからないため、PDFを出力できません。`);
    return;
  }

  const dir = dirname(filePath);
  const whole = session?.doc === doc && session.scope === 'work' && session.files.length > 1;
  // 英訳は story/en/ に置くので、作品名は en の親から取る
  const workDir = basename(dir) === 'en' ? dirname(dir) : dir;
  const work = basename(workDir) === 'story' ? basename(dirname(workDir)) : basename(workDir);
  const name = whole ? work : `${work}-${basename(filePath, '.txt')}`;
  const input = shellQuote(relative(root, whole ? dir : filePath));

  let out;
  let options;
  if (english) {
    const pageSize = enPdfPageSize(layout);
    if (!pageSize) {
      vscode.window.showWarningMessage('英語のPDF出力は 6×9in / 5×8in / A5（縦）のどれかで組みます。今の用紙はどれでもないため 6×9in で出力します。');
    }
    out = `out/preview/${name}-en-${pageSize ?? '6x9'}.pdf`;
    options = `--${pageSize ?? '6x9'}`;
  } else {
    if (!matchesPdfScriptPage(layout)) {
      vscode.window.showWarningMessage('PDF出力は A4横・既定の余白で組みます。用紙・余白の設定はプレビューにだけ反映されます。');
    }
    const size = `${metrics.chars}x${metrics.lines}`;
    out = `out/preview/${name}-${metrics.vertical ? size : 'horizontal'}.pdf`;
    // 行数自動（既定の30字組）はスクリプトの既定そのものなので --size を付けない
    options = !metrics.vertical ? '--horizontal' : layout.lines == null && layout.chars === 30 ? '' : `--size ${size}`;
  }

  if (!pdfTerminal || pdfTerminal.exitStatus) {
    pdfTerminal = vscode.window.createTerminal({ name: '小説PDF出力', cwd: root });
  }
  pdfTerminal.show(true);
  pdfTerminal.sendText([
    'mkdir -p out/preview &&',
    `AUTO_OPEN=1 node ${script}`,
    options,
    `-o ${shellQuote(out)}`,
    input,
    '--open',
  ].filter(Boolean).join(' '));
}

// ---- ステータスバー ----

const formatPages = (n) => (Math.round(n * 10) / 10).toLocaleString('ja-JP');

function updateStatusBar() {
  const doc = activeManuscript();
  // 横のプレビューだけが残っていて、前面が原稿でもプレビューでもないときは出さない
  const showing = doc && (isManuscript(vscode.window.activeTextEditor?.document) || [...sessions].some(s => s.panel.active));
  if (!showing) {
    statusBar.hide();
    return;
  }
  const layout = layoutFor(doc);
  const metrics = metricsFor(doc);
  const stats = computeStats([splitLines(doc.getText())], metrics);

  const editor = vscode.window.activeTextEditor;
  const selectedText = editor?.document === doc ? editor.selections.map(sel => doc.getText(sel)).join('\n') : '';

  if (metrics.language === 'en') {
    const selectedWords = selectedText.split(/\s+/).filter(Boolean).length;
    const parts = [
      selectedWords > 0 ? `選択 ${selectedWords.toLocaleString('en-US')} / ${stats.words.toLocaleString('en-US')} words` : `${stats.words.toLocaleString('en-US')} words`,
      describeLayout(layout, { english: true }),
    ];
    statusBar.text = `$(book) ${parts.join(' ・ ')}`;
    statusBar.tooltip = '語数（メタ行を除く）・現在のレイアウト（English）\nクリックでレイアウトを選ぶ';
    statusBar.show();
    return;
  }

  const selected = countTextChars(stripInlineMarkup(selectedText));
  const parts = [
    selected > 0 ? `選択 ${selected.toLocaleString('ja-JP')}字 / ${stats.chars.toLocaleString('ja-JP')}字` : `${stats.chars.toLocaleString('ja-JP')}字`,
    `400字詰め ${formatPages(stats.genkoPages)}枚`,
    `${describeLayout(layout)} ${formatPages(stats.gridPages)}枚`,
  ];
  statusBar.text = `$(book) ${parts.join(' ・ ')}`;
  statusBar.tooltip = '文字数（ルビ・メタ行を除く）・400字詰め原稿用紙換算・現在のレイアウトでの換算枚数\nクリックでレイアウトを選ぶ';
  statusBar.show();
}

// ---- 起動 ----

export function activate(ctx) {
  context = ctx;
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 200);
  statusBar.command = 'novelPreview.selectLayout';

  // 設定ファイルを手で書き換えたとき・置き場所を変えたときにも追従する
  const layoutWatcher = vscode.workspace.createFileSystemWatcher(`**/${LAYOUT_FILENAME}`);

  // エディタで開いていない原稿の追加・削除・外部からの書き換え（Claude Code など）も拾う。
  // 同じディレクトリの原稿は、作品全体の表示にも単独表示の章番号にも効くので、そのディレクトリを見ているプレビューを組み直す
  const manuscriptWatcher = vscode.workspace.createFileSystemWatcher('**/*.txt');
  const onManuscriptFileEvent = (uri) => {
    const dir = dirname(uri.fsPath);
    for (const session of sessions) {
      if (session.doc && dirname(session.doc.uri.fsPath) === dir) session.scheduleRender();
    }
  };

  let statusTimer;
  const scheduleStatusBar = () => {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(updateStatusBar, RENDER_DELAY_MS);
  };

  ctx.subscriptions.push(
    statusBar,
    vscode.window.registerCustomEditorProvider(EDITOR_VIEW_TYPE, editorProvider, {
      // enableFindWidget: Cmd+F でプレビュー内を検索できるようにする
      webviewOptions: { retainContextWhenHidden: true, enableFindWidget: true },
    }),
    vscode.commands.registerCommand('novelPreview.open', openSidePreview),
    vscode.commands.registerCommand('novelPreview.reopenAsPreview', replaceWithPreview),
    vscode.commands.registerCommand('novelPreview.selectLayout', selectLayout),
    vscode.commands.registerCommand('novelPreview.exportPdf', () => exportPdf()),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      updateStatusBar();
      if (!isManuscript(editor?.document)) return;
      const filePath = editor.document.uri.fsPath;
      for (const session of sessions) {
        const changed = session.follow && session.doc?.uri.fsPath !== filePath;
        if (session.follow) session.doc = editor.document;
        // 作品全体を表示中に同じ作品の別ファイルへ移っただけなら、組み直さず位置だけ合わせる
        if (changed && !(session.scope === 'work' && session.files.includes(filePath))) session.render();
        else session.postReveal();
      }
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length === 0) return;
      scheduleStatusBar();
      const undoRedo = e.reason === vscode.TextDocumentChangeReason.Undo || e.reason === vscode.TextDocumentChangeReason.Redo;
      for (const session of sessions) {
        if (!session.files.includes(e.document.uri.fsPath)) continue;
        if (undoRedo || !session.applying) session.externalChange = true;
        if (!session.applying) session.dropHistory(e.document.uri.fsPath);
        // 取り消し・やり直しは待たせず、すぐ表示に反映する
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
