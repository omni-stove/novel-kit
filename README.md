# novel-kit

小説原稿（`.txt`）の組版エンジンと、それを使う CLI（`novel`）・VS Code 拡張「小説プレビュー」。
プレビューと PDF は同じパーサ・同じ組版で作るので、プレビューで見たとおりに PDF が出る。

- `src/` 組版エンジン（`lib/` のパーサ・原稿の集め方・HTML 生成、`pdf.mjs` / `en-pdf.mjs` / `count.mjs` の各コマンド、`layout.mjs` / `config.mjs` のレイアウトと設定ファイル）
- `bin/novel.mjs` CLI の入口
- `vscode/` VS Code 拡張（[vscode/README.md](vscode/README.md)）

## 入れ方

原稿のリポジトリの依存に入れる。

```sh
pnpm add -D github:omni-stove/novel-kit
```

`node_modules/.bin/novel` が入る（mise なら `[env] _.path = ["{{config_root}}/node_modules/.bin"]` で `novel` だけで呼べる）。

## CLI

```sh
novel build <作品のディレクトリ or novel.json> [出力名...] [--pages 42,50-53] [--limit n]
novel pdf    [オプション] -o out.pdf <原稿のファイル or ディレクトリ>...
novel pdf-en [オプション] -o out.pdf <原稿のファイル or ディレクトリ>...
novel count  [--size 30x40] <原稿のファイル or ディレクトリ>...
```

`pdf` / `pdf-en` / `count` のオプションは、それぞれ `src/pdf.mjs` / `src/en-pdf.mjs` / `src/count.mjs` の先頭のコメントにある。
生成した PDF は `--open` で開く（環境変数 `AUTO_OPEN=0` なら開かない）。

## 設定ファイル（novel.json）

作品のディレクトリ（例: `src/<作品>/story/`）に置く。原稿から上へたどって一番近いものが使われる。
VS Code 拡張のレイアウト・表示設定と、`novel build` の作品情報・出力の定義を1つのファイルに持つ。

```json
{
  "title": "コズミック・オルガン",
  "author": "園口回",
  "outputs": {
    "pdf": { "format": "pdf", "out": "out/cosmic-organ.pdf", "coverless": true, "parts": ["070", "085"] },
    "review": { "format": "pdf", "out": "out/cosmic-organ-review.pdf", "review": true },
    "pdf-en": { "format": "pdf-en", "out": "out/cosmic-organ-en.pdf", "input": ["en"], "title": "Cosmic Organ", "author": "Mawaru Sonoguchi" }
  },
  "chars": 40,
  "lines": 40
}
```

- `input`: 原稿のファイルかディレクトリ（設定ファイルのディレクトリから。並び順どおりに連結）。省略時は `["."]`
- `outputs.<名前>.out`: プロジェクトのルート（設定ファイルから上へたどって最初に `package.json` があるディレクトリ）から
- PDF の字数×行数は、プレビューと同じトップレベルのレイアウト（`chars` / `lines` / `writingMode`）を使う。出力ごとに上書きもできる
- 英語の PDF の判型は `english` のレイアウトの用紙（6×9in / 5×8in / A5）から選ぶ
- 出力ごとの項目の一覧は `src/build.mjs` の先頭のコメントと、`vscode/schemas/novel.schema.json` にある（VS Code では補完が効く）

## 開発

```sh
pnpm install
pnpm test
```

テストは各ファイルの末尾にある（vitest の in-source test）。
`src/` は Node がそのまま実行する素の JavaScript（`.mjs`）にしている。`node_modules` の中の `.ts` / `.mts` は Node が型を剥がして実行できないため。
