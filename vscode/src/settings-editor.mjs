/**
 * novel.json を開いたときの「作品の設定」の画面（カスタムエディタ）。
 * 作品情報・英語の出力の項目・部の境界・出力の定義をフォームで編集する。レイアウトと表示設定はプレビューのページ設定で変える。
 * 編集は novel.json の文書への WorkspaceEdit にするので、保存・取り消しは VS Code が面倒を見て、テキストエディタとも同期する。
 */

import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import { OUTPUT_FORMATS } from '../../src/build.mjs';
import {
  describeOutputs,
  describeWorkFiles,
  formatDescriptions,
  outputFields,
  serializeWork,
  workFields,
} from './work-settings.mjs';

/** 作品の設定（カスタムエディタ）のID */
// package.json の customEditors と同じIDでなければならない
export const SETTINGS_VIEW_TYPE = 'novelPreview.workSettings';

const RENDER_DELAY_MS = 250;

function renderHtml({ cssUri, jsUri, cspSource, nonce }) {
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
  <link rel="stylesheet" href="${cssUri}">
</head>
<body>
  <header id="toolbar">
    <strong>作品の設定</strong>
    <span id="file"></span>
    <button id="build" title="novel.json の outputs から選んで出力を作る（novel build と同じ）">出力を作る…</button>
    <button id="open-text" title="このタブをテキストエディタに切り替える">テキストで開く</button>
  </header>
  <p id="error" hidden></p>
  <main id="form"></main>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}

/**
 * カスタムエディタの provider。build(uri, names): novel.json の出力（names。null なら選ばせる）を作る、
 * linesOf(filePath): 原稿の行列（エディタで開いていれば未保存の内容）
 */
export function createSettingsEditorProvider(context, { build, linesOf }) {
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
  const fields = { output: outputFields(), ...workFields() };
  const formats = OUTPUT_FORMATS.map((format) => ({ format, description: formatDescriptions()[format] }));

  return {
    resolveCustomTextEditor(document, panel) {
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
          if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            throw new Error('JSON のオブジェクトではありません');
        } catch (err) {
          panel.webview.postMessage({ type: 'state', file, error: `${file} を読めません: ${err.message}` });
          return;
        }
        panel.webview.postMessage({
          type: 'state',
          file,
          raw,
          fields,
          formats,
          work: describeWorkFiles(configDir, raw, { linesOf }),
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
            panel.reveal();
            return vscode.commands.executeCommand('reopenActiveEditorWith', 'default');
        }
      }

      panel.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
      panel.webview.html = renderHtml({
        cssUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'settings.css')),
        jsUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'settings.js')),
        cspSource: panel.webview.cspSource,
        nonce: randomBytes(16).toString('hex'),
      });

      // 原稿の追加・削除・見出しの書き換えで、部の境界の一覧と章番号が変わる
      const manuscriptWatcher = vscode.workspace.createFileSystemWatcher('**/*.txt');
      const subscriptions = [
        panel.webview.onDidReceiveMessage(onMessage),
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
      panel.onDidDispose(() => {
        clearTimeout(renderTimer);
        for (const s of subscriptions) s.dispose();
      });
    },
  };
}
