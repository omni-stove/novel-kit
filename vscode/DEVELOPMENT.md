# 小説プレビュー（開発メモ）

利用者向けの説明は README.md（Marketplace の拡張のページになる）。ここは開発・配布の手順。vsix には入らない。

## 手元で試す

```sh
pnpm install && pnpm --dir vscode run install-extension
```

GitHub Release に置いた vsix を入れるときは:

```sh
gh release download --repo omni-stove/novel-kit --pattern novel-preview.vsix --dir /tmp --clobber
code --install-extension /tmp/novel-preview.vsix --force
```

## リリース

main に push すると、CI（`.github/workflows/release.yml`）が前回のリリースから `vscode/` などに変更があればテストして、vsix を `vscode-v<version>` の GitHub Release に置く。version は CalVer（`YYYY.MDD.N`、JST の日付と、その日の何回目か。例: `2026.1021.0`）で、CI がリリースのときだけ `vscode/package.json` に書き込む。リポジトリの `version` は `0.0.0` のまま。

Marketplace へは `pnpm --dir vscode run publish`（先に `vsce login omnistove` で publisher の Personal Access Token を登録しておく）。
