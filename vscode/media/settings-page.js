// @ts-check
// novel.json を開いたときの「作品の設定」の画面（カスタムエディタ）。フォームは settings.js
(() => {
  const vscode = acquireVsCodeApi();
  const form = createWorkSettingsForm(document.getElementById('root'), (msg) => vscode.postMessage(msg));
  window.addEventListener('message', ({ data }) => {
    if (data.type === 'state') form.render(data);
  });
  vscode.postMessage({ type: 'ready' });
})();
