/**
 * Vivliostyle で PDF 化する HTML の共通部品
 */

import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';

/** 挿絵に使える画像の拡張子と media type（EPUB の manifest と data URI に使う） */
export const IMAGE_MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

/** 挿絵の画像が無ければ、どの画像かわかるメッセージで投げる */
export function requireImage(path) {
  if (!existsSync(path)) throw new Error(`挿絵の画像が見つかりません: ${path}`);
}

/**
 * 画像を data URI にする。Vivliostyle が組む HTML は書き出した場所から原稿の画像を参照できるとは限らないので、HTML に埋め込む
 */
export function imageDataUri(path) {
  requireImage(path);
  const mediaType = IMAGE_MEDIA_TYPES[extname(path).toLowerCase()];
  return `data:${mediaType};base64,${readFileSync(path).toString('base64')}`;
}

/**
 * Google Fonts の読み込みタグを返す。
 * family は css2 API のクエリ形式（例: 'Noto+Serif+JP:wght@400'）。
 */
export function googleFontsLinks(family) {
  return `  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=${family}&display=swap" rel="stylesheet">`;
}

/**
 * 区切りの行（p.separator）の置き方の CSS 宣言。indent が null なら行の中央、数なら行頭から indent 字下げる。
 * 中央は (字数 − 記号の字数) が奇数だとマス目から半字ずれるので、マス目に揃えたいときは字下げで指定する
 */
export function separatorPlacementCss(indent = null) {
  return indent == null ? 'text-align: center; text-indent: 0;' : `text-align: start; text-indent: ${indent}em;`;
}

/**
 * 青空文庫の注記（改ページ・見出し・太字・斜体・傍線）から組んだ要素のスタイル。pdf / novel-pdf / epub が共有する。
 * 見出しは本文と同じ大きさのゴシック体の太字にする（章の見出し【】とは別の、本文中の見出し）。
 * 傍線は縦書きでは字の右、横書きでは字の下に引く
 */
export const AOZORA_CSS = `
    .page-break-marker {
      break-before: page;
      page-break-before: always;
    }

    .aozora-heading {
      font-family: "Noto Sans JP", "游ゴシック", "Yu Gothic", "Hiragino Sans", sans-serif;
      font-weight: bold;
      text-indent: 0;
    }

    strong.bold {
      font-weight: bold;
    }

    i.italic {
      font-style: italic;
    }

    /* right は縦書きのときだけ効き、横書きでは under が効く */
    .sideline {
      text-decoration-line: underline;
      text-underline-position: under right;
    }

    .sideline-double {
      text-decoration-style: double;
    }

    /* CSS には一点鎖線が無いので、鎖線は点線で代える */
    .sideline-chain {
      text-decoration-style: dotted;
    }

    .sideline-dashed {
      text-decoration-style: dashed;
    }

    .sideline-wavy {
      text-decoration-style: wavy;
    }
`;

/**
 * 縦書き本文で escapeHtml（text-parser）が生成する span クラスのスタイル。
 * pdf / novel-pdf が共有する。
 */
export const VERTICAL_GLYPH_CSS = `
    /* text-combine-upright: all だと
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

    /* text-combine-upright: all は Chromium/Vivliostyle で合成結果が
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

    /* .dash の sideways や glyph の rotate ではフォントのインク位置の都合で列の中央より
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

    /* 素の「.」は mixed のままだとセルの左下へ寄ってずれるため、
       1em セルの右上へフォント本来のピリオド字形のまま寄せる。 */
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

    /* span の箱はフォントの ascent/descent ぶん字面（1em）より太く、その端に揃えると
       点が隣の行へ食い込むため、字の中心から 0.5em（点の 1em）外に置く。
       rt と同じく、点の箱を段の端より外に置くと段組みのプレビューで内側へ押し戻されるため、
       箱は字の中に置いて transform で見かけだけ右へ出す。
       text-indent は絶対配置の箱にも継承され、字下げした段落で点がずれるため打ち消す。 */
    .emphasis-dot {
      position: relative;
    }

    .emphasis-dot::after {
      content: "\\FE45";
      position: absolute;
      right: 50%;
      top: 50%;
      font-size: 0.5em;
      line-height: 1;
      text-indent: 0;
      transform: translate(calc(100% + 1em), -50%);
    }

    ruby {
      ruby-align: center;
      position: relative;
    }

    /* プレビューは段組み（multicol）で頁を送るため、rt の箱を段の端より外に置くと
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

    /* 左ルビ（青空文庫の注記）は rt と同じ置き方を左右反転し、親文字の左端から自分の幅ぶん左へずらす */
    ruby.left-ruby > rt {
      right: auto;
      left: 0;
      transform: translate(calc(-100% + 0.4em), -50%);
    }
`;

/**
 * 横書き本文で VERTICAL_GLYPH_CSS の後ろに足すスタイル。ルビと傍点を縦書きの右から字の上へ置き直す。
 * pdf（横書き）と VS Code 拡張のスクロール表示が使う。
 */
export const HORIZONTAL_GLYPH_CSS = `
    /* 縦書きと同じく、点とルビは行の箱を広げないよう絶対配置にし、
       字の中心から 0.5em 上（点・ルビの 1em）に置く。 */
    .emphasis-dot::after {
      right: auto;
      top: auto;
      left: 50%;
      bottom: 50%;
      transform: translate(-50%, -1em);
    }

    rt {
      right: auto;
      top: auto;
      left: 50%;
      bottom: 50%;
      line-height: 1;
      text-indent: 0;
      transform: translate(-50%, -1em);
    }

    ruby.fit > rt {
      bottom: 50%;
      inset-block-start: auto;
      transform: translateY(-1em);
    }

    /* 左ルビは横書きでは字の下に置く。縦書き用の ruby.left-ruby > rt より後ろで同じ詳細度にして上書きする */
    ruby.left-ruby > rt {
      left: 50%;
      top: 50%;
      bottom: auto;
      transform: translate(-50%, 1em);
    }
`;

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest;

  describe('googleFontsLinks', () => {
    test('css2 API のクエリ形式の family をそのまま読み込む', () => {
      expect(googleFontsLinks('Noto+Serif+JP:wght@400')).toContain(
        '<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+JP:wght@400&display=swap" rel="stylesheet">',
      );
    });
  });

  describe('separatorPlacementCss', () => {
    test('indent が無ければ中央、あれば行頭から indent 字下げる', () => {
      expect(separatorPlacementCss()).toBe('text-align: center; text-indent: 0;');
      expect(separatorPlacementCss(19)).toBe('text-align: start; text-indent: 19em;');
      expect(separatorPlacementCss(0)).toBe('text-align: start; text-indent: 0em;');
    });
  });
}
