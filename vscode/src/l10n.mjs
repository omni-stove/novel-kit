/**
 * vscode に依存しないモジュール（テストから読む webview.mjs・prose.mjs・work-settings.mjs）の文言の訳。
 * 原文は英語で、訳は activate で setBundle に渡す vscode.l10n.bundle（l10n/bundle.l10n.<言語>.json の中身）から引く。
 * 訳が無ければ原文のまま。{0}・{1}… を args で埋める（vscode.l10n.t と同じ書き方）
 */

let bundle = {};

/** 訳の表（vscode.l10n.bundle。英語の表示なら undefined） */
export function setBundle(next) {
  bundle = next ?? {};
}

/** 訳の表を webview に渡す script 要素。webview の media/l10n.js がこれを読んで、同じ訳を引く */
// 実行しない JSON なので CSP の nonce は要らないが、</script> で閉じられないよう < はエスケープする
export const l10nScript = () =>
  `<script type="application/json" id="l10n-bundle">${JSON.stringify(bundle).replaceAll('<', '\\u003c')}</script>`;

/** 原文 message の訳。{n} を args[n] で埋める */
export function t(message, ...args) {
  const text = bundle[message] ?? message;
  return text.replace(/\{(\d+)\}/g, (match, i) => (i < args.length ? String(args[i]) : match));
}

if (import.meta.vitest) {
  const { test, expect, afterEach } = import.meta.vitest;
  const { readdirSync, readFileSync } = await import('node:fs');

  afterEach(() => setBundle(undefined));

  test('訳があれば訳を、無ければ原文を返し、{n} を埋める', () => {
    expect(t('{0} of {1}', 1, 2)).toBe('1 of 2');
    setBundle({ '{0} of {1}': '{1} 中 {0}' });
    expect(t('{0} of {1}', 1, 2)).toBe('2 中 1');
    expect(t('Missing {0}')).toBe('Missing {0}');
  });

  test('日本語の訳は、原文の {n} をすべて使う', () => {
    const ja = JSON.parse(readFileSync(new URL('../l10n/bundle.l10n.ja.json', import.meta.url), 'utf8'));
    const holes = (s) => [...new Set([...s.matchAll(/\{(\d+)\}/g)].map((m) => m[1]))].sort();
    const broken = Object.entries(ja).filter(([en, text]) => holes(en).join() !== holes(text).join());
    expect(broken).toEqual([]);
  });

  test('拡張と webview の t() の原文には、すべて日本語の訳があり、使っていない訳は無い', () => {
    const ja = JSON.parse(readFileSync(new URL('../l10n/bundle.l10n.ja.json', import.meta.url), 'utf8'));
    const sources = ['./', '../media/'].flatMap((dir) =>
      readdirSync(new URL(dir, import.meta.url))
        .filter((name) => /\.m?js$/.test(name))
        .map((name) => readFileSync(new URL(dir + name, import.meta.url), 'utf8').split('if (import.meta.vitest)')[0]),
    );
    const messages = new Set(
      sources.flatMap((code) =>
        [...code.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) =>
          m[1].replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c)),
        ),
      ),
    );
    expect([...messages].filter((m) => !(m in ja))).toEqual([]);
    expect(Object.keys(ja).filter((m) => !messages.has(m))).toEqual([]);
  });
}
