/**
 * Vivliostyle で PDF 化する HTML の共通部品
 */

// Google Fonts の読み込みタグ（family は css2 API のクエリ形式。例: 'Noto+Serif+JP:wght@400'）
export function googleFontsLinks(family) {
  return `  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=${family}&display=swap" rel="stylesheet">`;
}

/**
 * 縦書き本文で escapeHtml（text-parser）が生成する span クラスのスタイル。
 * txt-to-pdf / txt-to-novel-pdf が共有する。
 */
export const VERTICAL_GLYPH_CSS = `
    /* 1文字ずつの欧文・数字（.latin / .upright）。text-combine-upright: all だと
       Chromium は合成した横組みをフォントの ascent/descent で配置するため、
       Noto Serif JP（Web フォント版）では列の中央より約 0.2em 右・やや下へ寄る。
       フォントの縦組み用メトリクス（vmtx）で配置する upright なら列の中央に揃う。 */
    .latin {
      text-orientation: upright;
    }

    .sideways-latin {
      text-orientation: sideways;
    }

    .sideways-latin rt {
      text-orientation: mixed;
    }

    .upright {
      text-orientation: upright;
    }

    /* 縦中横（1〜2桁の数字・!?等）。
       text-combine-upright: all は Chromium/Vivliostyle で合成結果が
       1em より狭いと中央に揃わず左へ寄る（例: 【+42Y】の「42」だけが左寄り）。
       横書きの inline-block を 1em 幅で中央寄せして確実にセンタリングする。 */
    .tcy {
      display: inline-block;
      writing-mode: horizontal-tb;
      text-orientation: initial;
      width: 1em;
      text-align: center;
      line-height: 1em;
    }

    /* 単独の全角ハイフン（章番号「1-1」の区切り等）。
       .dash の sideways や glyph の rotate ではフォントのインク位置の都合で列の中央より
       左へずれるため、tcy と同じ 1em の正方セル（配置が確実）にグリフを透明で残して
       文字数カウントを保ちつつ、::before でセル中央に縦向きの短い棒を実描画する。 */
    .hyphen {
      display: inline-block;
      writing-mode: horizontal-tb;
      text-orientation: initial;
      width: 1em;
      text-align: center;
      line-height: 1em;
      position: relative;
      color: transparent;
    }

    .hyphen::before {
      content: "";
      position: absolute;
      left: 50%;
      top: 50%;
      width: 0.07em;
      height: 0.8em;
      transform: translate(-50%, -50%);
      background: #000;
    }

    /* 略語の区切りピリオド（O.M. / U.S.A. 等）。素の「.」は mixed のまま
       セルの左下へ寄ってずれる。縦書きの句点と同じく、1em セルの右上へ
       フォント本来のピリオド字形のまま寄せる（前の文字の直後にまとまって読める）。 */
    .dot {
      display: inline-flex;
      writing-mode: horizontal-tb;
      text-orientation: initial;
      width: 1em;
      height: 1em;
      align-items: flex-start;
      justify-content: flex-end;
      line-height: 0;
    }

    .emphasis {
      text-emphasis: filled sesame;
      text-emphasis-position: over right;
    }

    ruby {
      ruby-align: center;
      position: relative;
    }

    /* ルビは親文字の右（block-start 側）に絶対配置する。
       プレビューは段組み（multicol）で頁を送るため、rt の箱を段の端より外に置くと
       Chromium が段の内側へ押し戻して親文字に重ねて描く（各頁の先頭行だけルビが潰れる）。
       箱は親文字の右端に揃えて段内に置き、レイアウトに影響しない transform で
       自分の幅ぶん（-0.4em の食い込み込み）右へ見かけだけずらす。 */
    rt {
      font-size: 0.5em;
      position: absolute;
      right: 0;
      top: 50%;
      transform: translate(calc(100% - 0.4em), -50%);
      white-space: nowrap;
    }

    /* escapeHtml の rubyLayout が字数から決めた配置（--rt-* は rt の em、--rb-* は親文字の em）。
       ルビが短ければ字間を空けて親文字いっぱいに広げ、長ければ親文字側の字間・前後のアキを広げる */
    ruby.fit {
      white-space: nowrap;
      padding-inline: calc(var(--rb-pad, 0) * 1em);
    }

    .ruby-gap {
      display: inline-block;
      inline-size: calc(var(--rb-gap, 0) * 1em);
    }

    ruby.fit > rt {
      top: auto;
      right: auto;
      inset-inline-start: calc(var(--rt-off, 0) * 1em);
      inset-block-start: 0;
      transform: translateX(calc(100% - 0.4em));
      letter-spacing: calc(var(--rt-ls, 0) * 1em);
    }
`;
