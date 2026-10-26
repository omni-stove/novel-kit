// @ts-check

/** 拡張が HTML に入れた訳の表（#l10n-bundle。vscode/src/l10n.mjs の l10nScript） */
const L10N_BUNDLE = JSON.parse(document.getElementById('l10n-bundle')?.textContent || '{}');

/** 原文 message（英語）の訳。訳が無ければ原文のまま。{n} を args[n] で埋める（vscode/src/l10n.mjs の t と同じ） */
// biome-ignore lint/correctness/noUnusedVariables: 別の script（preview.js・panel.js・settings.js）から呼ぶ
function t(message, ...args) {
  const text = L10N_BUNDLE[message] ?? message;
  return text.replace(/\{(\d+)\}/g, (match, i) => (i < args.length ? String(args[i]) : match));
}
