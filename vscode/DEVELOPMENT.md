# 小説プレビュー（開発メモ）

利用者向けの説明は README.md（英語。Marketplace の拡張のページになる）と README.ja.md（日本語）で、書き足すときは両方を揃える。ここは開発・配布の手順。vsix には入らない。

## 手元で試す

インストールせずに、いまのソースの拡張を見本の作品（`vscode/sample/`）で開く:

```sh
make ext-dev
```

拡張開発用のウィンドウ（Extension Development Host）が開き、`.txt` は小説プレビューで、`novel.json` は作品の設定の画面で開く。`make ext-dev` は止めるまでソース（`vscode/src`・`src`）の変更を見てビルドし直し、ビルドした拡張か `vscode/media` が変わるとそのウィンドウが自分で再読み込みするので、保存すれば開いている原稿が最新のソースで組み直される。VS Code でこのリポジトリを開いているなら、F5（「小説プレビュー（見本の作品）」）でも同じウィンドウと監視ビルドが始まり、ブレークポイントも効く。

見本の作品は、日本語の原稿（`ja/`。ルビ・傍点・メモ・エピグラフ・場面区切り・部の境界）と英語の原稿（`en/`）を持つ。出力（`out/`）は git に入らない。

入れて試すときは:

```sh
pnpm install && pnpm --dir vscode run install-extension
```

GitHub Release に置いた vsix を入れるときは:

```sh
gh release download --repo omni-stove/novel-kit --pattern novel-preview.vsix --dir /tmp --clobber
code --install-extension /tmp/novel-preview.vsix --force
```

## 表示の言語

拡張の表示は英語を原文にし、日本語の訳を添える（VS Code の表示言語が日本語なら日本語、それ以外は英語）。

- `package.json` のコマンド名・設定の説明などは `%key%` にして、英語を `package.nls.json`、日本語を `package.nls.ja.json` に書く
- 拡張と webview の文言は英語で `vscode.l10n.t('…')`（vscode を import しないモジュールは `src/l10n.mjs` の `t`、webview は `media/l10n.js` の `t`）に渡し、日本語の訳を `l10n/bundle.l10n.ja.json` に書く。訳の抜けと使わなくなった訳はテスト（`src/l10n.mjs`）が拾う
- 作品の設定のフォームの項目の説明（`src/work-settings.mjs`）は、日本語の訳を `schemas/novel.schema.json` の description と同じ文にする（これもテストで確かめる）

## リリース

main に push すると、CI（`.github/workflows/release.yml`）が前回のリリースから `vscode/` などに変更があればテストして、vsix を `vscode-v<version>` の GitHub Release に置く。version は CalVer（`YYYY.MDD.N`、JST の日付と、その日の何回目か。例: `2026.1021.0`）で、CI がリリースのときだけ `vscode/package.json` に書き込む。リポジトリの `version` は `0.0.0` のまま。

同じ vsix を CI が Marketplace にも publish する。publisher `omnistove` の Personal Access Token（Organization は All accessible organizations、Scope は Marketplace の Manage）をリポジトリの Secret `VSCE_PAT` に入れておく。手元から `pnpm --dir vscode run publish` で出すときは、先に `npm pkg set version=...` で version を入れる（`0.0.0` のままだとその version で出てしまう）。
