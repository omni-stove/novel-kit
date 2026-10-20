# novel-kit

小説原稿（`.txt`）の組版エンジンと、それを使う CLI（`novel`）・VS Code 拡張「小説プレビュー」。
プレビューと PDF は同じパーサ・同じ組版で作るので、プレビューで見たとおりに PDF が出る。

- `src/` 組版エンジン（`lib/` のパーサ・原稿の集め方・HTML 生成、`pdf.mjs` などの各コマンド、`layout.mjs` / `config.mjs` のレイアウトと設定ファイル）
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
novel build <作品のディレクトリ or novel.json> [出力名...] [--out-dir dir] [--pages 42,50-53] [--limit n] [--target 読者] [--ruby-parens]
novel pdf       [オプション] -o out.pdf  <原稿のファイル or ディレクトリ>...   # 縦書き（横書き）の PDF
novel pdf-en    [オプション] -o out.pdf  <原稿>...                            # 英語のペーパーバック風 PDF
novel novel-pdf [オプション] -o out.pdf  <原稿>...                            # 文庫本見開きの PDF
novel epub      [オプション] -o out.epub <原稿>...
novel rtf       [--ja | --shunn] [オプション] -o out.rtf <原稿>...
novel split     <原稿のディレクトリ> [出力先ディレクトリ] [作品名] [ジャンル] [--splits=070,120] [--target 読者]
novel merge     <原稿のディレクトリ> [出力ファイル] [作品名] [ジャンル] [--splits=070,120] [--target 読者] [--ruby-parens]
novel count     [--size 30x40] <原稿>...
```

各コマンドのオプションは、`src/` のそれぞれのファイル（`pdf.mjs` / `en-pdf.mjs` / `novel-pdf.mjs` / `epub.mjs` / `rtf.mjs` / `split.mjs` / `merge.mjs` / `count.mjs`）の先頭のコメントにある。
生成した PDF は `--open` で開く（環境変数 `AUTO_OPEN=0` なら開かない）。

## 設定ファイル（novel.json）

作品のディレクトリ（例: `src/<作品>/story/`）に置く。原稿から上へたどって一番近いものが使われる。
VS Code 拡張のレイアウト・表示設定と、`novel build` の作品情報・出力の定義を1つのファイルに持つ。

```json
{
  "title": "コズミック・オルガン",
  "author": "園口回",
  "genre": "SF",
  "parts": ["070", "085"],
  "outDir": "out",
  "outputs": {
    "pdf": { "format": "pdf", "out": "cosmic-organ.pdf", "coverless": true },
    "review": { "format": "pdf", "out": "cosmic-organ-review.pdf", "review": true },
    "pdf-en": { "format": "pdf-en", "out": "cosmic-organ-en.pdf", "input": ["en"], "title": "Cosmic Organ", "author": "Mawaru Sonoguchi" },
    "novel": { "format": "novel-pdf", "out": "コズミック・オルガン.pdf", "dark": true },
    "epub": { "format": "epub", "out": "コズミック・オルガン.epub" },
    "rtf": { "format": "rtf", "out": "cosmic-organ.rtf" },
    "split": { "format": "split", "out": "co-chapters" },
    "all": { "format": "merge", "out": "co-all.txt" }
  },
  "chars": 40,
  "lines": 40
}
```

- `input`: 原稿のファイルかディレクトリ（設定ファイルのディレクトリから。並び順どおりに連結）。省略時は `["."]`。split / merge はディレクトリ1つだけ
- 作品の項目（`title` / `author` / `genre` / `target` / `input` / `parts`）は出力ごとに上書きできる。`null` を書くとその出力では使わない
- `outDir`: 出力先ディレクトリ。プロジェクトのルート（設定ファイルから上へたどって最初に `package.json` があるディレクトリ）から。絶対パスも可。省略時は `out`
  - 出力ごとに `outDir` を書けばその出力だけ変わり、`novel build --out-dir <dir>` ならその実行だけ変わる（優先順位は `--out-dir` → 出力の `outDir` → 作品の `outDir`）
  - VS Code 拡張の「PDF出力」も `<outDir>/preview/` に出す
- `outputs.<名前>.out`: 出力ファイル名（split はディレクトリ名）。`outDir` から
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
