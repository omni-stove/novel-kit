/**
 * novel.json を開いたときの「作品の設定」の画面（カスタムエディタ）と、小説パネルの「作品設定」のタブの拡張側。
 * 作品情報・英語の出力の項目・部の境界・出力の定義をフォームで編集する。レイアウトは小説パネルの「ページ設定」、表示設定はプレビューのツールバーで変える。
 * 編集は novel.json の文書への WorkspaceEdit にするので、テキストエディタとも同期する（カスタムエディタでは保存・取り消しも VS Code が面倒を見る）。
 */

import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import { OUTPUT_FORMATS } from '../../src/build.mjs';
import {
  describeOutputs,
  describeWorkFiles,
  formatDescriptions,
  manuscriptDirs,
  outputFields,
  serializeWork,
  workFields,
} from './work-settings.mjs';

/** 作品の設定（カスタムエディタ）のID */
// package.json の customEditors と同じIDでなければならない
export const SETTINGS_VIEW_TYPE = 'novelPreview.workSettings';

const RENDER_DELAY_MS = 250;

function renderHtml({ cssUris, jsUris, cspSource, nonce }) {
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
  <div id="root"></div>
  ${jsUris.map((uri) => `<script nonce="${nonce}" src="${uri}"></script>`).join('\n  ')}
</body>
</html>`;
}

/**
 * novel.json の文書1つぶんの、作品の設定のフォーム（media/settings.js）の拡張側。
 * 文書・原稿が変わるたびに post(state) でフォームへ状態を送り、フォームからのメッセージを onMessage(msg) で受ける。
 * build(uri, names): novel.json の出力（names。null なら選ばせる）を作る、linesOf(filePath): 原稿の行列（エディタで開いていれば未保存の内容）、
 * openText(): 「テキストで開く」、save: 書くたびに保存するか。
 * 返す値: { render, onMessage, dispose }
 */
export function createWorkSettingsController(document, { post, build, linesOf, openText, save = false }) {
  const configDir = dirname(document.uri.fsPath);
  let renderTimer;
  /** @type {Promise<unknown>} */
  let editQueue = Promise.resolve();

  function render() {
    clearTimeout(renderTimer);
    const file = vscode.workspace.asRelativePath(document.uri);
    let raw;
    try {
      raw = JSON.parse(document.getText() || '{}');
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('JSON のオブジェクトではありません');
    } catch (err) {
      post({ file, error: `${file} を読めません: ${err.message}` });
      return;
    }
    post({
      file,
      raw,
      fields: formFields(),
      formats: formFormats(),
      work: describeWorkFiles(configDir, raw, { linesOf }),
      dirs: manuscriptDirs(configDir),
      outputs: describeOutputs(raw),
    });
  }
  const scheduleRender = () => {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, RENDER_DELAY_MS);
  };

  /** 画面で変えた設定（raw 全体）を文書に書く。変わっていなければ何もしない */
  async function update(raw) {
    const text = serializeWork(raw);
    if (text === document.getText()) return;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), text);
    await vscode.workspace.applyEdit(edit);
    if (save) await document.save();
  }

  function onMessage(msg) {
    switch (msg.type) {
      case 'ready':
        return render();
      case 'update':
        // 入力のたびに届くので、適用順が前後しないよう直列にする
        editQueue = editQueue
          .then(() => update(msg.raw))
          .catch((err) => vscode.window.showErrorMessage(`設定を書き込めませんでした: ${err.message}`));
        return editQueue;
      case 'build':
        // build はディスク上の novel.json を読むので、未保存の編集を先に保存する
        return editQueue
          .then(() => (document.isDirty ? document.save() : undefined))
          .then(() => build(document.uri, msg.names ?? null));
      case 'openFile':
        return vscode.commands.executeCommand('vscode.open', vscode.Uri.file(join(configDir, msg.name)));
      case 'openText':
        return openText();
    }
  }

  // 原稿の追加・削除・見出しの書き換えで、部の境界の一覧と章番号が変わる
  const manuscriptWatcher = vscode.workspace.createFileSystemWatcher('**/*.txt');
  const subscriptions = [
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length === 0) return;
      if (e.document === document) render();
      else if (e.document.uri.fsPath.endsWith('.txt')) scheduleRender();
    }),
    manuscriptWatcher,
    manuscriptWatcher.onDidCreate(scheduleRender),
    manuscriptWatcher.onDidChange(scheduleRender),
    manuscriptWatcher.onDidDelete(scheduleRender),
  ];

  return {
    render,
    onMessage,
    dispose() {
      clearTimeout(renderTimer);
      for (const s of subscriptions) s.dispose();
    },
  };
}

let fieldsCache;
/** フォームの入力欄の定義（work / english / output: format → 項目） */
const formFields = () => (fieldsCache ??= { output: outputFields(), ...workFields() });
/** フォームで選べる出力形式 [{ format, description }] */
const formFormats = () => OUTPUT_FORMATS.map((format) => ({ format, description: formatDescriptions()[format] }));

/**
 * カスタムエディタの provider。build(uri, names): novel.json の出力（names。null なら選ばせる）を作る、
 * linesOf(filePath): 原稿の行列（エディタで開いていれば未保存の内容）
 */
export function createSettingsEditorProvider(context, { build, linesOf }) {
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');

  return {
    resolveCustomTextEditor(document, panel) {
      const controller = createWorkSettingsController(document, {
        post: (state) => panel.webview.postMessage({ type: 'state', ...state }),
        build,
        linesOf,
        openText: () => {
          panel.reveal();
          return vscode.commands.executeCommand('reopenActiveEditorWith', 'default');
        },
      });
      const uri = (name) => panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, name));
      panel.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
      panel.webview.html = renderHtml({
        cssUris: [uri('settings.css'), uri('work-settings.css')],
        jsUris: [uri('settings.js'), uri('settings-page.js')],
        cspSource: panel.webview.cspSource,
        nonce: randomBytes(16).toString('hex'),
      });
      const subscription = panel.webview.onDidReceiveMessage(controller.onMessage);
      panel.onDidDispose(() => {
        subscription.dispose();
        controller.dispose();
      });
    },
  };
}
