# 小説プレビュー（VS Code 拡張）

原稿テキスト（`.txt`）を、PDF 出力（`novel pdf`）と同じパーサ・同じスタイルで組んでページ表示する。
英語原稿（`story/en/` などの英訳）は英語 PDF 出力（`novel pdf-en`）と同じペーパーバック風の組版で表示する。

## 入れ方

GitHub Release に置いた vsix を入れる（creation では `mise run ext-install` がこれを行う）。

```sh
gh release download --repo omni-stove/novel-kit --pattern novel-preview.vsix --dir /tmp --clobber
code --install-extension /tmp/novel-preview.vsix --force
```

手元で直したものを試すときは、このリポジトリで `pnpm install && pnpm --dir vscode run install-extension`
（`vscode/dist/novel-preview.vsix` を作って入れる）。

「PDF出力」ボタンは、開いているワークスペースの `node_modules/.bin/novel` を使う。ワークスペースの依存に novel-kit を入れておく。

## リリース

`vscode/package.json` の `version` を上げてコミットし、`vscode-v<version>` のタグを push する。
GitHub Actions（`.github/workflows/release-extension.yml`）がテスト・vsix の作成をして、Release に置く。

```sh
git tag vscode-v0.8.0 && git push origin vscode-v0.8.0
```

## 使い方

- `.txt` をそのまま「小説プレビュー」で開く（タブそのものがプレビューになる）。このリポジトリでは `.vscode/settings.json` の
  `"workbench.editorAssociations": { "*.txt": "novelPreview.editor" }` で既定にしてある
  - 作品全体を表示しているときも、開いたファイルの先頭の位置から表示する
  - 素のテキストに切り替えるときは、ツールバーの「テキストで開く」（同じタブの場所で、見ている位置の行から開く）か、タブを右クリック →「エディターを指定して開く…」
  - プレビューに戻すときは、テキストエディタ右上の本のボタン、またはタブを右クリック →「小説プレビューに切り替える」（同じタブの場所で、見ていた位置から開く）
  - 保存（`Cmd+S`）や未保存マークは通常のファイルと同じ
- テキストエディタで開いているときは、右上のプレビューボタンか `Cmd+K V` で横にプレビューを出せる
- `Cmd+F` でプレビュー内を検索できる（ルビの読みは検索対象外。ルビ付きの語も親文字で見つかる）
- 編集内容は保存前でもプレビューに反映される。カーソル行はプレビュー側で色が付く
- プレビューの段落をクリックすると、その場で編集できる（ツールバーの「編集」がオンのとき）
  - 編集中の段落は元テキスト（`|漢字《かんじ》` などの記法つき）に戻り、入力はそのままエディタ側のファイルに反映される
  - カーソルキーで段落の端を越えると隣の段落へ移る（縦書きなら左で次の行・段落、右で前へ）
  - Enter で段落を分け、行頭の Backspace で前の行につなげる。Esc か段落の外をクリックで編集を終える。`Cmd+S` で保存
  - `Cmd+クリック` でエディタの該当行へ飛ぶ（「編集」オフのときはダブルクリック）
- 既定は「作品全体」（同じディレクトリの本文ファイルを連結。`synopsis.txt`・`characters.txt` は除く）。「このファイル」で単独表示に切り替える（切り替えは設定ファイルに保存される）
- ステータスバーに 文字数・400字詰め原稿用紙換算・現在のレイアウトでの換算枚数 を表示する（クリックでレイアウト選択）。英語原稿では語数

## 英語原稿

- 言語は原稿の文字で判定する。本文（メタ行を除く）のアルファベットが日本語の文字より多ければ英語の組版になる（指定はしない）
- 英語の組版は `novel pdf-en` と同じ（EB Garamond・横書き・章扉に Chapter One と POV・`*` でイタリック・`"` はカーリー引用符・`■■■` は `* * *`・`>>>` はそのまま）
  - 文字サイズ（pt）と行送り（倍率）を直接指定し、字数×行数は版面から決まる。既定は 6×9in ペーパーバック（11pt・1.4、余白は PDF 出力と同じ）
  - 英語のレイアウトは `novel.json` の `english` に持つ（用紙・向き・余白・`fontSize`・`lineHeight`・`fontFamily`）。日本語と同じファイルなので、`story/en/` の英訳も作品の設定ファイル1つで済む
  - プリセットは英語の原稿のときだけ英語用（6×9in / 5×8in / A5）が出る。保存したプリセットは `"english": true` が付く
  - 横書き固定。「文字方向」の設定は使わない
  - 「画面に合わせる」は用紙を画面の高さに合わせ、1ページずつ中央に表示する（ホイール・カーソルキーで次のページへ）
  - 段落の編集・エディタとの行き来は日本語と同じ。章題をクリックすると `【章題】` の行を編集する
- 「PDF出力」は `novel pdf-en` を用紙に合わせた判型（`--6x9` / `--5x8` / `--a5`）で実行して `out/preview/` に出力する。その他の用紙では 6×9in になる

## レイアウト定義

Word の「ページ設定 > 文字数と行数」と同じ考え方で、用紙・余白・字数・行数を決めると文字サイズと行送りが決まる。

- ツールバーで字数×行数（英語では文字サイズ×行送り）、「ページ設定」で文字方向・用紙サイズ・向き・余白・フォントを変える
- レイアウトは `novel.json` に保存する。原稿のディレクトリから上へたどって一番近いものを読み、変更もそのファイルへ書く
  - どこにも無ければ、最初に変更したとき原稿と同じディレクトリに作る
  - 上位（例: `src/`）に置けば複数作品の共通設定になり、作品側に置いたものが優先される
  - 手で書き換えてもプレビューに即反映される。省略した項目は既定値
  - 英語の原稿用のレイアウトは同じファイルの `english` に持つ（後述）
  - 表示範囲（このファイル / 作品全体）・表示倍率・「編集」のオンオフも同じファイルの `view` に保存する:
    `"view": { "scope": "work", "zoom": "fit", "edit": true }`（`zoom` は `fit`（画面に合わせる） / 数値%）
  - 見つからないときは `novelPreview.defaultPreset` のプリセットで表示する
  - 同じファイルに作品情報と出力の定義（`title` / `author` / `input` / `outputs`）も書ける。`novel build` が読む（リポジトリ直下の README）。プレビューから設定を変えても、これらの項目はそのまま残る
- 「プリセットとして保存…」で `.vscode/settings.json` の `novelPreview.presets` に保存する。手で書くなら:

```jsonc
"novelPreview.presets": {
  "横溝賞（42字×34行）": { "chars": 42, "lines": 34 },
  "新書": { "paper": "B6", "orientation": "portrait", "chars": 42, "lines": 16,
            "margin": { "top": 15, "right": 12, "bottom": 17, "left": 12 } }
}
```

省略した項目は既定値（A4横・縦書き・余白 上20/右20/下25/左20mm）になる。この既定値は `novel pdf` の版面と同じ。
英語用のプリセットは `"english": true` と `fontSize`（pt）・`lineHeight`（倍率）を持つ:

```jsonc
"6×9in": { "english": true, "paper": "6x9in", "orientation": "portrait", "fontSize": 11, "lineHeight": 1.4,
           "margin": { "top": 17.78, "right": 15.24, "bottom": 15.24, "left": 20.32 } }
```

## PDF との差

プレビューは Chromium の段組みでページを割る近似で、Vivliostyle の組版（白紙ページの除去など）とは数ページ単位でずれることがある（約100頁の長編で2頁程度）。
句読点のぶら下げ（PDF の `hanging-punctuation: allow-end last`）は Chromium では効かないため、webview 側で同じ規則（行末の「、。，．」をぶら下げ、段落末の閉じ括弧をはみ出させる。直後が閉じ括弧なら追い出し）を再現している。
提出前の確認は「PDF出力」ボタン（`novel pdf --size 字数x行数` を実行して `out/preview/` に出力）で行う。PDF 出力は A4横固定なので、用紙・余白の変更はプレビューにだけ効く。
英語の PDF（`novel pdf-en`）は見開きで内側・外側の余白を使い分け、章を右ページから始める指定（`--recto`）や部扉（`--part`）もあるが、プレビューは単ページで左右の余白をそのまま使い、部扉は出さない。

## 開発

- `src/document.mjs` 原稿 → HTML（リポジトリ直下の `src/` の組版エンジンを利用）/ `src/extension.mjs` VS Code との接続 / `media/` webview 側
- レイアウト定義と寸法計算（`../src/layout.mjs`）・設定ファイルの読み書き（`../src/config.mjs`）は CLI と共有している
- テストはリポジトリ直下の `pnpm test` に含まれる
