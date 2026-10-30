# novel-kit

小説原稿（`.txt`）の組版エンジンと、それを使う CLI（`novel`）・VS Code 拡張「Novel Kit」（[vscode/README.md](vscode/README.md)）。

![42字×34行で組んだ原稿のページ表示と、エクスプローラーの小説の目次](vscode/images/page.png)

![ページ表示の段落をクリックして書き足し、確定するとルビつきで組み直される](vscode/images/edit.gif)

## 入れ方

原稿のリポジトリの依存に入れる。

```sh
pnpm add -D github:omni-stove/novel-kit
```

mise なら `[env] _.path = ["{{config_root}}/node_modules/.bin"]` で `novel` だけで呼べる。

原稿の記法は [vscode/docs/notation.md](vscode/docs/notation.md) にまとめた。

作品の設定ファイル `novel.json` は `vscode/schemas/novel.schema.json` のスキーマで書く（VS Code では補完が効く）。

Scrivener・Google ドキュメント・Word などで書いた英語の原稿は、RTF に書き出して `novel import -o draft.txt draft.rtf` で txt にできる（斜体・太字・章見出し・場面区切りを記法にする。ルビと傍点は落とす）。

バージョンを固定するときは `github:omni-stove/novel-kit#cli-v2026.1021.0` のようにタグを付ける。

## リリース

main に push すると、CI（`.github/workflows/release.yml`）が前回のリリースから変更のあったものだけをテストしてリリースする。CLI は `cli-v<version>` の GitHub Release に `pnpm pack` の tarball を、VS Code 拡張は `vscode-v<version>` に vsix を置く。

version は CalVer の `YYYY.MDD.N`（JST の日付と、その日の何回目か。例: `2026.1021.0`）。月日をゼロ埋めしないのは、semver と VS Code 拡張の version が各部の先頭の 0 を許さないため。CI がリリースのときだけ `package.json` に書き込むので、リポジトリの `version` は `0.0.0` のまま。

## 開発

```sh
pnpm install
pnpm test
```

`src/` は Node がそのまま実行する素の JavaScript（`.mjs`）にしている。`node_modules` の中の `.ts` / `.mts` は Node が型を剥がして実行できないため。
