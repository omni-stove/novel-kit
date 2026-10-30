/**
 * 原稿テキスト（1ファイル分）の解釈。
 * 行の種別判定、インライン記法（ルビ・傍点・横倒し・イタリック。青空文庫の注記は aozora.mjs で読み替える）、
 * 縦書きHTMLへの変換、エピグラフの整形など、テキストそのものに関する処理を置く。
 * 複数ファイルの集合や採番・ディレクトリ走査は manuscript.mjs。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  BOLD_CLOSE,
  BOLD_OPEN,
  ITALIC_CLOSE,
  ITALIC_OPEN,
  LEFT_RUBY_CLOSE,
  LEFT_RUBY_OPEN,
  LEFT_RUBY_SEP,
  normalizeAozoraInline,
  parseAozoraLine,
  SIDELINE_CLOSE,
  SIDELINE_OPEN,
  TCY_CLOSE,
  TCY_OPEN,
} from './aozora.mjs';

/**
 * 場面区切りの行か。原稿では * だけの行（* / *** / * * *。全角の ＊ も可）で書き、出力ごとの記号に変える
 * （既定は日本語が SCENE_BREAK_MARK、英語のペーパーバックが * * *、Shunn 形式が #。
 * 作品ごとに novel.json の sceneBreak / english.sceneBreak で変えられ、CLI には --scene-break で渡す）。
 */
export function isSceneBreak(line) {
  return /^[*＊]([ 　]*[*＊])*$/.test(line.trim());
}

/** 日本語の出力での場面区切りの既定。章の途中で切れたファイルの継ぎ目にも使う */
export const SCENE_BREAK_MARK = '＊';

/**
 * 区切りの記号を明示する行か（*: ☆☆☆。* とコロンはそれぞれ全角でも可）。記号だけの行とは判定できない記号（☆・〜 など）でも
 * 区切りにでき、記号を書かない *: は場面区切りになる。
 */
export function isBreakLine(line) {
  return /^[*＊][:：]/.test(line);
}

/**
 * 区切りの行か。場面区切り（*）と *: の行のほか、記号だけの行（◇◇◇・■■■・※・>>> など）は
 * 書いた記号のまま、場面区切りと同じ位置（中央か、sceneBreakIndent の字下げ）に置く飾りの区切りになる。
 */
export function isSeparator(line) {
  return isSceneBreak(line) || isBreakLine(line) || /^[◇◆□■○●◎※>＞]+$/.test(line.trim());
}

/** 区切りの行を紙面に出す記号にする。sceneBreakMark は出力ごとの場面区切りの記号 */
export function separatorMark(line, sceneBreakMark = SCENE_BREAK_MARK) {
  if (isSceneBreak(line)) return sceneBreakMark;
  if (isBreakLine(line)) return line.replace(/^[*＊][:：]/, '').trim() || sceneBreakMark;
  return line.trim();
}

/**
 * 区切りの記号を、行頭から indent 字下げた行にする（全角空白を前に足す）。indent が null なら記号のまま。
 * 中央寄せのできないテキストの出力と、字下げをマス目どおりに揃えたい RTF・docx で使う
 */
export function indentSeparator(mark, indent = null) {
  return indent == null ? mark : `${'　'.repeat(indent)}${mark}`;
}

export function isMemoLine(line) {
  return line.startsWith('Memo:');
}

/**
 * 章頭に本文と別に組む文の行か（Lead: 文。エピグラフなど）。
 * 直後（空行を挟んでもよい）の Source: 行がその出典になる（foldSources で1行にまとめてから読む）。
 */
export function isEpigraphLine(line) {
  return line.startsWith('Lead:');
}

export function isSourceLine(line) {
  return line.startsWith('Source:');
}

/** foldSources が Lead: の行の後ろに出典を足すときの区切り。原稿には現れない私用領域の文字 */
const SOURCE_MARK = '\uF120';

/**
 * Source: の行の中身を、その前の Lead: の行（間は空行だけ）の後ろに SOURCE_MARK で区切って足した行列を返す。
 * 行数は変えないので、返した行列の添字は元の行番号のまま使える。Source: の行そのものは残る（メタ行として落とす側に任せる）。
 * 前が Lead: でない Source: の行は使わない。
 */
export function foldSources(lines) {
  const out = [...lines];
  let lead = -1;
  lines.forEach((line, i) => {
    if (isEpigraphLine(line)) lead = i;
    else if (isSourceLine(line) && lead !== -1) {
      const source = line.replace(/^Source:\s*/, '').trim();
      if (source) out[lead] = `${out[lead].trimEnd()}${SOURCE_MARK}${source}`;
      lead = -1;
    } else if (line.trim() !== '') lead = -1;
  });
  return out;
}

/**
 * foldSources を通した Lead: の行を本文と出典に分ける。aozora: false なら青空文庫の注記を読み替えない（txt に書き出す split / merge）。
 * 出典が無ければ source は null
 */
export function parseEpigraphLine(line, { aozora = true } = {}) {
  const [quote, source] = line.replace(/^Lead:\s*/, '').split(SOURCE_MARK);
  const read = (t) => (aozora ? normalizeAozoraInline(t) : t).trim();
  return { quote: read(quote), source: source === undefined ? null : read(source) };
}

/** foldSources を通した Lead: の行を、原稿の Lead: / Source: の行に戻す（split の章ファイル用） */
export function unfoldSources(line) {
  if (!isEpigraphLine(line)) return [line];
  const { quote, source } = parseEpigraphLine(line, { aozora: false });
  return source === null ? [`Lead: ${quote}`] : [`Lead: ${quote}`, `Source: ${source}`];
}

/**
 * 章見出しに添える行か（Subhead: 名前。視点人物名など、章ごとに添える短い文）。
 * 日本語の出力では視点行【】の後ろに足し（foldSubheads）、英語の出力では章ヘッダの章題の下に組む。
 */
export function isSubheadLine(line) {
  return line.startsWith('Subhead:');
}

export function parseSubheadLine(line) {
  return normalizeAozoraInline(line.replace(/^Subhead:\s*/, '')).trim();
}

export function isViewpointLine(line) {
  return /^【.*】/.test(line);
}

/** 【章題】の後ろに本文が続く書き方（英語原稿など）があるため、見出し（title）と残り（rest）に分ける */
export function parseViewpointLine(line) {
  const match = line.match(/^【(.*)】(.*)$/);
  return match ? { title: match[1].trim(), rest: match[2].trim() } : { title: '', rest: '' };
}

export function applyViewpointLabel(line, label) {
  const { title } = parseViewpointLine(line);
  return title ? line.replace(/^【.*】/, `【${label}　${title}】`) : line.replace(/^【】/, `【${label}】`);
}

/**
 * Subhead: の行の中身を、最初の視点行【】の後ろに全角空白で区切って足した行列を返す（日本語の出力用）。
 * 行数は変えないので、返した行列の添字は元の行番号のまま使える。Subhead: の行そのものは残る（メタ行として落とす側に任せる）。
 */
export function foldSubheads(lines) {
  const subheads = lines
    .filter(isSubheadLine)
    .map((l) => l.replace(/^Subhead:\s*/, '').trim())
    .filter(Boolean);
  const target = lines.findIndex(isViewpointLine);
  if (subheads.length === 0 || target === -1) return lines;
  return lines.map((l, i) => (i === target ? [l.trimEnd(), ...subheads].join('　') : l));
}

/** 本文として組まない行か（Memo: は出力しないメモ、Lead:（と出典の Source:）と Subhead: は章頭に別に組む） */
export function isMetaLine(line) {
  return isMemoLine(line) || isEpigraphLine(line) || isSourceLine(line) || isSubheadLine(line);
}

function analyzeLines(lines) {
  const contentLines = lines.filter((l) => l.trim() !== '' && !isMetaLine(l));
  const hasViewpointStart = contentLines.length > 0 && isViewpointLine(contentLines[0]);

  return {
    hasViewpointStart,
    hasEmptyViewpointStart: hasViewpointStart && /^【】/.test(contentLines[0]),
    firstContentLine: contentLines.length > 0 ? contentLines[0] : null,
    epigraphs: foldSources(lines)
      .filter((l) => isEpigraphLine(l))
      .map((l) => parseEpigraphLine(l)),
  };
}

/** 残す行の元の添字（0始まり）。メタ行を落とす（keepEpigraphs なら Lead: の行は残す）。selectBodyLines と同じ条件 */
function selectBodyLineIndices(lines, { keepEpigraphs = false } = {}) {
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    if (isMetaLine(lines[i]) && !(keepEpigraphs && isEpigraphLine(lines[i]))) continue;
    result.push(i);
  }
  return result;
}

/** 本文の行を返す。青空文庫の注記は行の中だけ読み替える（改ページ・字下げなど行の単位の注記は、組む側が parseAozoraLine で読む） */
function selectBodyLines(lines, opts = {}) {
  const folded = foldSubheads(foldSources(lines));
  return selectBodyLineIndices(lines, opts).map((i) => normalizeAozoraInline(folded[i]));
}

export function trimBlankEdges(lines) {
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines;
}

/**
 * 原稿の文字列を行に分ける。見出しの書き方 `# 題` / `#` は、ここで【題】/【】に読み替える
 * （【】は以前の書き方として残す。行は1対1のままなので、行番号で原稿を書き換える側にも影響しない）。
 */
export function splitLines(content) {
  return splitRawLines(content).map(hashHeadingToViewpoint);
}

/** 見出しを読み替えない行の分割。プレビューの編集で原稿の行をそのまま書き戻すための元テキストに使う */
export function splitRawLines(content) {
  return content.split('\n').map((l) => l.replace(/\r$/, ''));
}

/**
 * `# 題` を【題】に、`#` だけの行を【】にする。日本語入力のまま打てるよう、全角の ＃ と全角空白でもよい。
 * `#Tag` や `## 題` は本文のまま
 */
export function hashHeadingToViewpoint(line) {
  const match = line.match(/^[#＃](?:[ \t　]+(.*?))?[ \t　]*$/);
  return match ? `【${match[1] ?? ''}】` : line;
}

export function readLines(filePath) {
  return splitLines(readFileSync(filePath, 'utf-8'));
}

// 記法の除去は呼び出し側で行う（ルビを括弧で残すかどうかが出力先ごとに違うため）
export function countTextChars(text) {
  return [...text.replace(/\s/g, '')].length;
}

/** 傍線の開きの文字から種類（SIDELINE_OPEN のキー）を引く */
const SIDELINE_STYLE_OF = Object.fromEntries(Object.entries(SIDELINE_OPEN).map(([style, ch]) => [ch, style]));
const SIDELINE_OPENS = Object.values(SIDELINE_OPEN).join('');
const SIDELINE_OPEN_RE = new RegExp(`[${SIDELINE_OPENS}]`, 'g');
const LEFT_RUBY_RE = new RegExp(`${LEFT_RUBY_OPEN}(.+?)${LEFT_RUBY_SEP}(.+?)${LEFT_RUBY_CLOSE}`, 'g');

const INLINE_MARKUP_RE = new RegExp(
  `《《(.+?)》》|\\|(.+?)《(.+?)》|<<(.+?)>>|\\*([^*]+)\\*|${BOLD_OPEN}(.+?)${BOLD_CLOSE}|${TCY_OPEN}(.+?)${TCY_CLOSE}` +
    `|${ITALIC_OPEN}(.+?)${ITALIC_CLOSE}|([${SIDELINE_OPENS}])` +
    `|${LEFT_RUBY_OPEN}(.+?)${LEFT_RUBY_SEP}(.+?)${LEFT_RUBY_CLOSE}`,
  'g',
);

/** 閉じの文字が種類によらず同じなので、入れ子を数えて開きに対応する閉じの位置を返す。なければ -1 */
function findSidelineClose(text, from) {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === SIDELINE_CLOSE) {
      if (depth === 0) return i;
      depth--;
    } else if (SIDELINE_OPENS.includes(ch)) depth++;
  }
  return -1;
}

/**
 * 1行をインライン記法のトークンに分ける。type は text / emphasis / ruby（base, ruby）/ sideways / italic / bold / tcy /
 * sideline（style は SIDELINE_OPEN のキー）/ leftRuby（base, ruby）。
 * sideways・sideline の中身にはルビ記法が入りうるので、text は未解釈のまま返す
 */
export function tokenizeInlineMarkup(text) {
  const tokens = [];
  let last = 0;
  const re = new RegExp(INLINE_MARKUP_RE);
  let m = re.exec(text);
  for (; m; m = re.exec(text)) {
    if (m[9] !== undefined) {
      const close = findSidelineClose(text, m.index + 1);
      if (close < 0) continue;
      if (m.index > last) tokens.push({ type: 'text', text: text.slice(last, m.index) });
      tokens.push({ type: 'sideline', style: SIDELINE_STYLE_OF[m[9]], text: text.slice(m.index + 1, close) });
      last = close + 1;
      re.lastIndex = last;
      continue;
    }
    if (m.index > last) tokens.push({ type: 'text', text: text.slice(last, m.index) });
    if (m[1] !== undefined) tokens.push({ type: 'emphasis', text: m[1] });
    else if (m[2] !== undefined) tokens.push({ type: 'ruby', base: m[2], ruby: m[3] });
    else if (m[4] !== undefined) tokens.push({ type: 'sideways', text: m[4] });
    else if (m[5] !== undefined) tokens.push({ type: 'italic', text: m[5] });
    else if (m[6] !== undefined) tokens.push({ type: 'bold', text: m[6] });
    else if (m[7] !== undefined) tokens.push({ type: 'tcy', text: m[7] });
    else if (m[8] !== undefined) tokens.push({ type: 'italic', text: m[8] });
    else tokens.push({ type: 'leftRuby', base: m[10], ruby: m[11] });
    last = m.index + m[0].length;
  }
  if (last < text.length) tokens.push({ type: 'text', text: text.slice(last) });
  return tokens;
}

/**
 * インライン記法を外して本文の文字だけにする。青空文庫の注記も読み替えてから外す（行の単位の注記も文字としては数えない）。
 * rubyParens なら ルビを「親文字（ルビ）」の形で残す。
 */
export function stripInlineMarkup(text, { rubyParens = false } = {}) {
  return tokenizeInlineMarkup(normalizeAozoraInline(text).replace(/［＃[^］]*］/g, ''))
    .map((t) => {
      if (t.type === 'ruby' || t.type === 'leftRuby') return rubyParens ? `${t.base}（${t.ruby}）` : t.base;
      if (t.type === 'text') return t.text;
      return stripInlineMarkup(t.text, { rubyParens });
    })
    .join('');
}

export function escapeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** ルビ1字は親文字の半分の大きさ。以下の長さの単位は親文字の em */
const RUBY_SCALE = 0.5;
/** ルビが隣の文字へはみ出してよい量の上限（ルビ1字分） */
const RUBY_MAX_OVERHANG = 0.5;
const KANA_OR_SPACE_RE = /[ぁ-ゖァ-ヺー　 ]/;
/**
 * 1字ずつ <ruby> に分割しても processInnerText の結果が変わらない文字だけからなるか。
 * 2桁数字の縦中横のように複数字をまとめて組む文字があると、分けたとき組みが変わるため。
 */
const RUBY_SPLIT_SAFE_VERTICAL_RE = /^[぀-ヿ㐀-鿿豈-﫿々〆A-Za-z 　]+$/;
const RUBY_SPLIT_SAFE_HORIZONTAL_RE = /^[぀-ヿ㐀-鿿豈-﫿々〆　]+$/;
const RUBY_ASCII_ROMAN_RE = /\b(XII|XI|VIII|VII|VI|IX|IV|III|II)\b/;

/**
 * ルビが隣接文字 ch へはみ出してよい量（0 か RUBY_MAX_OVERHANG）。かな・空白に加え、ルビ側の半分が空いている約物
 * （side が 'before' なら句読点・閉じ括弧、'after' なら開き括弧）を許す。
 */
function rubyOverhangCap(ch, side) {
  if (!ch) return 0;
  if (KANA_OR_SPACE_RE.test(ch)) return RUBY_MAX_OVERHANG;
  const punct = side === 'before' ? '、。，．」』）〕】〉' : '「『（〔【〈';
  return punct.includes(ch) ? RUBY_MAX_OVERHANG : 0;
}

/**
 * 組み上がりの字数（1字＝1em のセル数）。縦書きでは2桁数字と !? の対が縦中横で1セルになり、
 * 横書きでは半角が半分の幅になる。
 */
function rubyCellCount(text, vertical) {
  if (!vertical) return [...text].reduce((sum, c) => sum + (/[\x20-\x7E]/.test(c) ? 0.5 : 1), 0);
  return [...text.replace(/(?<![\d.,])\d{2}(?![\d.,])/g, '0').replace(/[!?！？]{2}/g, '！')].length;
}

/**
 * 親文字 n 字・ルビ m 字の配置を決める。
 *   ルビが短い → 親文字の長さに合わせて 1:2:1 で均等配置（gap＝ルビの字間、rtStart＝先頭のアキ）。
 *                字数が同じなら1字ずつ親文字の真横に来る
 *   ルビが長い → まず前後の文字へはみ出させ（rtStart が負）、余りは親文字の字間を広げて吸収（widen）
 */
export function layoutRuby(n, m, capBefore = 0, capAfter = 0) {
  const baseLen = n;
  const rubyLen = m * RUBY_SCALE;
  if (rubyLen <= baseLen) {
    // 字間をそれ以上広げると間延びするため、ルビ1字分で止めて残りは中央に寄せる
    const gap = Math.min((baseLen - rubyLen) / m, RUBY_SCALE);
    return { gap, rtStart: (baseLen - rubyLen - gap * (m - 1)) / 2, widen: 0 };
  }
  const excess = rubyLen - baseLen;
  let before = Math.min(capBefore, excess / 2);
  const after = Math.min(capAfter, excess - before);
  before = Math.min(capBefore, excess - after);
  return { gap: 0, rtStart: -before, widen: excess - before - after };
}

// 生成済みの span を1単位にするのは、縦中横などの1字分の箱を割って点を打ち分けないため
const EMPHASIS_UNIT_RE = /\uE002[\uE010-\uEFFF]\uE002|<span[^>]*>[^<]*<\/span>|&[^;]+;|.\p{M}*/gsu;
// text-emphasis と同じく約物・空白には点を打たない。私用領域は太字・斜体・傍線の目印
const NO_EMPHASIS_RE = /^[\p{P}\p{Z}\p{Cc}\p{Co}]+$/u;

const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unitText = (unit) =>
  unit.replace(/<[^>]+>/g, '').replace(/&(?:#x([0-9a-f]+)|#(\d+)|(\w+));/gi, (m, hex, dec, name) => {
    if (name) return HTML_ENTITIES[name.toLowerCase()] ?? m;
    const cp = hex ? parseInt(hex, 16) : Number(dec);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });

const cssNum = (v) => String(Math.round(v * 1000) / 1000);

export function escapeHtml(text, { vertical = true, separateSymbolClasses = false, rubyLayout = false } = {}) {
  const rubyPlaceholders = [];
  const emphasisPlaceholders = [];

  // プレースホルダーを私用領域の文字にするのは、ASCII文字・数字を含むと後続の縦中横・ラテン文字処理で壊れるため
  const phRuby = (i) => `\uE000${String.fromCharCode(0xe010 + i)}\uE000`;
  const phEmphasis = (i) => `\uE001${String.fromCharCode(0xe010 + i)}\uE001`;
  const sidewaysPlaceholders = [];
  const phSideways = (i) => `\uE003${String.fromCharCode(0xe010 + i)}\uE003`;

  // 生成した span タグ内の英字をラテン文字処理で二重に処理しないよう、プレースホルダーにして最後に展開する
  const spanPlaceholders = [];
  const phSpan = (html) => {
    const idx = spanPlaceholders.length;
    spanPlaceholders.push(html);
    return `\uE002${String.fromCharCode(0xe010 + idx)}\uE002`;
  };

  function processInnerText(t) {
    let r = escapeXml(t);
    // 半角スペースのままだと HTML の空白コラプスで連続・行頭・行末のスペースが潰れるため、U+3000 にする
    r = r.replace(/ /g, '　');
    if (vertical) {
      // text-combine-upright: all は Chromium/Vivliostyle で字幅差のある組（IV 等）が右に寄るため使わず、単一コードポイントのローマ数字にする
      const asciiRomanMap = {
        II: '\u2161',
        III: '\u2162',
        IV: '\u2163',
        VI: '\u2165',
        VII: '\u2166',
        VIII: '\u2167',
        IX: '\u2168',
        XI: '\u216A',
        XII: '\u216B',
      };
      r = r.replace(new RegExp(RUBY_ASCII_ROMAN_RE, 'g'), (match) =>
        phSpan(`<span class="upright">${asciiRomanMap[match]}</span>`),
      );
      r = r.replace(/[\u2160-\u216B\u2170-\u217B]+/g, (match) => {
        return [...match].map((c) => phSpan(`<span class="upright">${c}</span>`)).join('');
      });
      r = r.replace(/\+[-\u2212]/g, '\u00B1');
      r = r.replace(/-/g, '\uFF0D');
      r = r.replace(/\+/g, '\uFF0B');
      r = r.replace(/!/g, '！');
      r = r.replace(/\?/g, '？');
      r = r.replace(/@/g, '＠');
      r = r.replace(/\//g, '／');
      r = r.replace(/[！？]{2}/g, (match) => {
        const hw = match.replace(/！/g, '!').replace(/？/g, '?');
        return phSpan(`<span class="tcy">${hw}</span>`);
      });
      r = r.replace(/\.?\d[\d,.]*\d|\d/g, (match) => {
        const converted = match.replace(/\./g, '．').replace(/,/g, '，');
        if (/^\d{1,2}$/.test(match)) return phSpan(`<span class="tcy">${match}</span>`);
        return [...converted].map((c) => phSpan(`<span class="upright">${c}</span>`)).join('');
      });
      // U+00D7（×）と U+00F7（÷）は数学記号なので除外
      const latinChar = 'a-zA-Z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u024F\\u1E00-\\u1EFF';
      const latinRe = new RegExp(`[${latinChar}]+(?:\\s[${latinChar}]+)*`, 'g');
      // 単語ごとにまとめると y/g/p/j のディセンダがベースラインで下にずれるため、1文字ずつ正方セルに収める
      r = r.replace(latinRe, (match) => {
        return [...match].map((c) => (/\s/.test(c) ? c : phSpan(`<span class="latin">${c}</span>`))).join('');
      });
      r = r.replace(/[\u0370-\u03FF]+/g, (match) => {
        return [...match].map((c) => phSpan(`<span class="upright">${c}</span>`)).join('');
      });
      // mixed のままだとピリオドのグリフがセルの左下へ寄り列の中央からずれるため、1em の正方セル中央に描く
      r = r.replace(/\./g, () => phSpan('<span class="dot">.</span>'));
      // ＝（外国人名の二重ハイフン）は mixed のままだと横倒しの二本線が左へずれるため、ダッシュとして組む
      if (separateSymbolClasses) {
        r = r.replace(/([—―\uFF0D\uFF1D]+)/g, '<span class="dash">$1</span>');
        r = r.replace(/([…‥]+)/g, '<span class="ellipsis">$1</span>');
        r = r.replace(/([～〜]+)/g, '<span class="wave-dash">$1</span>');
      } else {
        // 単独の全角ハイフンは sideways 回転だとグリフが列の中央より左へずれるため、hyphen（1em ボックス＋rotate）で組む
        r = r.replace(/([—―－＝]+)/g, (m) =>
          m === '－' ? `<span class="hyphen">${m}</span>` : `<span class="dash">${m}</span>`,
        );
        r = r.replace(/([…‥]+)/g, '<span class="dash">$1</span>');
        r = r.replace(/([～〜]+)/g, '<span class="dash">$1</span>');
      }
    }
    return r;
  }

  /**
   * 字数に合わせて配置したルビの HTML。配置は CSS（lib/html.mjs の ruby.fit）がカスタムプロパティで読む。
   * rt 側の値は rt 自身の em（親文字の半分）で読まれるため、RUBY_SCALE で割って渡す。
   */
  function fittedRubyHtml({ base, ruby, prev, prevShared, next, nextShared }) {
    const n = rubyCellCount(base, vertical);
    const m = rubyCellCount(ruby, vertical);
    const capBefore = rubyOverhangCap(prev, 'before') / (prevShared ? 2 : 1);
    const capAfter = rubyOverhangCap(next, 'after') / (nextShared ? 2 : 1);
    const { gap, rtStart, widen } = layoutRuby(n, m, capBefore, capAfter);
    const rtVars = (start) => `--rt-off:${cssNum(start / RUBY_SCALE)};--rt-ls:${cssNum(gap / RUBY_SCALE)}`;

    // 1つの <ruby> のままだと途中で行を折り返せないため、ルビが収まるなら親文字1字ごとに分ける
    const splitSafe = vertical
      ? (t) => RUBY_SPLIT_SAFE_VERTICAL_RE.test(t) && !RUBY_ASCII_ROMAN_RE.test(t)
      : (t) => RUBY_SPLIT_SAFE_HORIZONTAL_RE.test(t);
    if (widen === 0 && rtStart >= 0 && n >= 2 && splitSafe(base) && splitSafe(ruby)) {
      const charStart = (k) => rtStart + k * (RUBY_SCALE + gap);
      const cells = [...base].map(() => []);
      [...ruby].forEach((c, k) => {
        cells[Math.min(n - 1, Math.floor(charStart(k) + RUBY_SCALE / 2))].push({ c, k });
      });
      return [...base]
        .map((b, i) => {
          if (cells[i].length === 0) return processInnerText(b);
          const start = charStart(cells[i][0].k) - i;
          const rt = processInnerText(cells[i].map(({ c }) => c).join(''));
          return `<ruby class="fit" style="${rtVars(start)}">${processInnerText(b)}<rt>${rt}</rt></ruby>`;
        })
        .join('');
    }

    const vars = [rtVars(rtStart)];
    let baseHtml = processInnerText(base);
    if (widen > 0 && n >= 2 && splitSafe(base)) {
      vars.push(`--rb-pad:${cssNum(widen / n / 2)}`, `--rb-gap:${cssNum(widen / n)}`);
      baseHtml = [...base].map(processInnerText).join('<span class="ruby-gap"></span>');
    } else if (widen > 0) {
      vars.push(`--rb-pad:${cssNum(widen / 2)}`);
    }
    return `<ruby class="fit" style="${vars.join(';')}">${baseHtml}<rt>${processInnerText(ruby)}</rt></ruby>`;
  }

  let result = text.replace(new RegExp(`${TCY_OPEN}(.+?)${TCY_CLOSE}`, 'g'), (_, content) =>
    vertical ? phSpan(`<span class="tcy">${escapeXml(content.replace(LEFT_RUBY_RE, '$1'))}</span>`) : content,
  );

  result = result.replace(/<<(.+?)>>/g, (_, content) => {
    const idx = sidewaysPlaceholders.length;
    sidewaysPlaceholders.push(content);
    return phSideways(idx);
  });

  result = result.replace(LEFT_RUBY_RE, (_, base, ruby) => {
    const idx = rubyPlaceholders.length;
    rubyPlaceholders.push({ base, ruby, left: true });
    return phRuby(idx);
  });

  result = result.replace(/《《(.+?)》》/g, (_, content) => {
    const idx = emphasisPlaceholders.length;
    emphasisPlaceholders.push(content);
    return phEmphasis(idx);
  });

  result = result.replace(/\|(.+?)《(.+?)》/g, (match, base, ruby, offset, whole) => {
    const idx = rubyPlaceholders.length;
    const before = [...whole.slice(0, offset)];
    const after = [...whole.slice(offset + match.length)];
    rubyPlaceholders.push({
      base,
      ruby,
      prev: before.at(-1),
      prevShared: before.at(-2) === '》',
      next: after[0],
      nextShared: after[1] === '|',
    });
    return phRuby(idx);
  });

  result = processInnerText(result);

  const RUBY_PLACEHOLDER_RE = /\uE000([\uE010-\uEFFF])\uE000/g;
  const rubyHtmlOf = (ch) => {
    const placeholder = rubyPlaceholders[ch.charCodeAt(0) - 0xe010];
    const { base, ruby, left } = placeholder;
    // 字数に合わせた配置（fittedRubyHtml）は右（横書きでは上）のルビの置き方なので、左ルビには使わない
    if (left) return `<ruby class="left-ruby">${processInnerText(base)}<rt>${processInnerText(ruby)}</rt></ruby>`;
    if (!rubyLayout) return `<ruby>${processInnerText(base)}<rt>${processInnerText(ruby)}</rt></ruby>`;
    return fittedRubyHtml(placeholder);
  };

  result = result.replace(RUBY_PLACEHOLDER_RE, (_, ch) => rubyHtmlOf(ch));

  result = result.replace(/\uE001([\uE010-\uEFFF])\uE001/g, (_, ch) => {
    // 傍点の中の左ルビは、点を打つ単位に割られないよう1つのまとまりにして展開する
    const html = processInnerText(emphasisPlaceholders[ch.charCodeAt(0) - 0xe010]).replace(
      RUBY_PLACEHOLDER_RE,
      (_m, r) => phSpan(rubyHtmlOf(r)),
    );
    if (!rubyLayout) return `<span class="emphasis">${html}</span>`;
    // text-emphasis の圏点は Chromium が行の箱に含めて行送りを広げ、字詰めの版面や行間が崩れるため、
    // 1字ずつの箱にレイアウトに影響しない点を CSS（lib/html.mjs の .emphasis-dot）で描く
    return html.replace(EMPHASIS_UNIT_RE, (unit) => {
      const markup = unit.startsWith('\uE002') ? spanPlaceholders[unit.charCodeAt(1) - 0xe010] : unit;
      return NO_EMPHASIS_RE.test(unitText(markup)) ? unit : `<span class="emphasis-dot">${unit}</span>`;
    });
  });

  result = result.replace(/\uE003([\uE010-\uEFFF])\uE003/g, (_, ch) => {
    let content = sidewaysPlaceholders[ch.charCodeAt(0) - 0xe010];
    content = escapeXml(content);
    content = content.replace(/\|(.+?)《(.+?)》/g, (_, base, ruby) => `<ruby>${base}<rt>${ruby}</rt></ruby>`);
    content = content.replace(
      LEFT_RUBY_RE,
      (_, base, ruby) => `<ruby class="left-ruby">${base}<rt>${ruby}</rt></ruby>`,
    );
    return `<span class="sideways-latin">${content}</span>`;
  });

  // 傍点の中の左ルビは、スパンのプレースホルダーを含んだ HTML ごと1つのスパンのプレースホルダーにするので、入れ子が無くなるまで展開する
  for (let prev; prev !== result; ) {
    prev = result;
    result = result.replace(/\uE002([\uE010-\uEFFF])\uE002/g, (_, ch) => spanPlaceholders[ch.charCodeAt(0) - 0xe010]);
  }

  return result
    .replaceAll(BOLD_OPEN, '<strong class="bold">')
    .replaceAll(BOLD_CLOSE, '</strong>')
    .replaceAll(ITALIC_OPEN, '<i class="italic">')
    .replaceAll(ITALIC_CLOSE, '</i>')
    .replace(SIDELINE_OPEN_RE, (ch) => `<span class="sideline sideline-${SIDELINE_STYLE_OF[ch]}">`)
    .replaceAll(SIDELINE_CLOSE, '</span>');
}

/**
 * エピグラフ行の表示幅（em換算）。縦書きでは半角英字も1字ずつ全角幅のセルに、1〜2桁の数字は縦中横で1字幅に組まれるため、
 * 1〜2桁の数字列を1字、それ以外は1文字を1字として数える。
 */
function epigraphSourceLength(text) {
  let len = 0;
  const rest = stripInlineMarkup(text).replace(/\d{1,2}/g, () => {
    len += 1;
    return '';
  });
  len += [...rest].length;
  return len;
}

/** 本文＋引用元が一字下げを保ったまま1行（1列 chars 字）に収まるか。引用元か chars が無ければ false */
export function epigraphFitsOneLine(quote, source, chars) {
  if (!source || !chars) return false;
  return epigraphSourceLength(quote) + epigraphSourceLength(`——${source}`) <= chars - 1;
}

export function epigraphDisplayLines(quote, source, chars = null) {
  if (epigraphFitsOneLine(quote, source, chars)) return [`${quote}——${source}`];
  return source ? [quote, `——${source}`] : [quote];
}

function epigraphsToHtml(epigraphs, escapeOpts, chars = null) {
  return epigraphs
    .map(({ quote, source }) => {
      if (epigraphFitsOneLine(quote, source, chars)) {
        return `<p class="epigraph-line">${escapeHtml(`${quote}——${source}`, escapeOpts)}</p>`;
      }
      // 本文の行末を引用元の先頭に揃える位置と、一字下げより上に突き抜けないためのクランプは CSS 側で計算するため、長さを渡す
      const quoteStyle = source
        ? ` style="--epigraph-quote-len: ${epigraphSourceLength(quote)}; --epigraph-source-len: ${epigraphSourceLength(`——${source}`)}"`
        : '';
      const parts = [`<p class="epigraph-quote"${quoteStyle}>${escapeHtml(quote, escapeOpts)}</p>`];
      if (source) parts.push(`<p class="epigraph-source">${escapeHtml(`——${source}`, escapeOpts)}</p>`);
      return parts.join('\n');
    })
    .join('\n');
}

/**
 * 青空文庫の字下げ（行頭と範囲の合計）・地付き・地から上げを段落の style 属性にする
 * @param {{ indent?: number, alignEnd?: boolean, raise?: number }} line
 * @param {number} blockIndent
 */
function aozoraStyle({ indent, alignEnd, raise }, blockIndent) {
  const styles = [];
  if (blockIndent + indent > 0) styles.push(`margin-inline-start: ${blockIndent + indent}em`);
  if (alignEnd) styles.push('text-align: end');
  if (raise > 0) styles.push(`margin-inline-end: ${raise}em`);
  return styles.length > 0 ? ` style="${styles.join('; ')}"` : '';
}

const aozoraHeadingClass = (heading) => `aozora-heading aozora-heading-${heading}`;

/**
 * 挿絵の注記の行（{ kind: 'illust', src, alt }）を、画像1つの div にする。
 * illustSrc は原稿のディレクトリ（baseDir）から解決した画像の絶対パスを受けて img の src を返す。
 * illustSrc が無い出力（投稿用の pdf・プレビューなど）は挿絵を入れないので空文字を返す
 */
function illustHtml({ src, alt }, { baseDir, illustSrc }) {
  if (!illustSrc) return '';
  return `<div class="illust"><img src="${escapeXml(illustSrc(resolve(baseDir, src)))}" alt="${escapeXml(alt)}" /></div>`;
}

const isIllustLine = (line) => line != null && parseAozoraLine(line).kind === 'illust';

/** 原稿ファイルを読んで parseTextLines で縦書き（横書き）HTML にする。opts は parseTextLines と同じ（baseDir の既定は原稿のディレクトリ） */
export function parseTextFile(filePath, opts = {}) {
  return parseTextLines(readLines(filePath), { baseDir: dirname(filePath), ...opts });
}

/**
 * 行列から HTML に変換する（ファイルを介さないのは、未保存のエディタ内容をプレビューする VS Code 拡張用）。
 * 返り値は { html, hasViewpointStart, hasEmptyViewpointStart }。
 *   blankAfterHeading: 視点行（章見出し）と本文の間に空行を1つ補う（既定は補わない。原稿側の空行はそのまま）
 *   lineNumbers: 段落・視点行・空行に元テキストの行番号（0始まり）を data-line で付ける
 *   sceneBreak: 場面区切り（* の行）を組む記号
 *   illustSrc: 挿絵の画像の絶対パスから img の src を返す関数。省くと挿絵の注記の行を出さない
 *   baseDir: 挿絵のファイル名を解決するディレクトリ（既定はカレントディレクトリ）
 */
export function parseTextLines(
  lines,
  {
    vertical = true,
    separateSymbolClasses = false,
    sectionNumber = null,
    chars = null,
    blankAfterHeading = false,
    lineNumbers = false,
    sceneBreak = SCENE_BREAK_MARK,
    illustSrc = null,
    baseDir = '.',
  } = {},
) {
  const htmlParts = [];

  const { hasViewpointStart, hasEmptyViewpointStart, epigraphs } = analyzeLines(lines);
  const processLines = selectBodyLines(lines);
  const sourceLineNumbers = lineNumbers ? selectBodyLineIndices(lines) : null;
  const lineAttr = (i) => (sourceLineNumbers ? ` data-line="${sourceLineNumbers[i]}"` : '');

  let lastWasViewpoint = false;

  const escapeOpts = { vertical, separateSymbolClasses, rubyLayout: true };

  let pendingEpigraphs = epigraphs.length > 0 ? [...epigraphs] : null;
  let blockIndent = 0;

  for (let i = 0; i < processLines.length; i++) {
    const aozora = parseAozoraLine(processLines[i]);
    if (aozora.kind === 'pageBreak') {
      htmlParts.push('<div class="page-break-marker"></div>');
      lastWasViewpoint = false;
      continue;
    }
    if (aozora.kind === 'illust') {
      const html = illustHtml(aozora, { baseDir, illustSrc });
      if (html) htmlParts.push(html);
      lastWasViewpoint = false;
      continue;
    }
    if (aozora.kind !== 'text') {
      blockIndent = aozora.indent ?? 0;
      continue;
    }
    const line = aozora.text;
    const style = aozoraStyle(aozora, blockIndent);

    if (isSeparator(line)) {
      const prevLine = i > 0 ? processLines[i - 1] : null;
      const nextLine = i < processLines.length - 1 ? processLines[i + 1] : null;
      const hasPrevEmpty = prevLine !== null && prevLine.trim() === '';
      const hasNextEmpty = nextLine !== null && nextLine.trim() === '';

      if (hasPrevEmpty && hasNextEmpty) {
        if (htmlParts.length > 0 && /^<p class="empty"[^>]*>&nbsp;<\/p>$/.test(htmlParts[htmlParts.length - 1])) {
          htmlParts.pop();
        }
        htmlParts.push(
          `<div class="separator-block"><p class="separator">${escapeHtml(separatorMark(line, sceneBreak), escapeOpts)}</p></div>`,
        );
        i++;
        lastWasViewpoint = false;
        continue;
      }

      htmlParts.push(`<p class="separator">${escapeHtml(separatorMark(line, sceneBreak), escapeOpts)}</p>`);
      lastWasViewpoint = false;
      continue;
    }

    if (line.trim() === '') {
      // 挿絵は1ページに組むので、隣の空行を出すと前後のページの端に余分な空きが出る
      if (illustSrc && (isIllustLine(processLines[i - 1]) || isIllustLine(processLines[i + 1]))) continue;
      htmlParts.push(`<p class="empty"${lineAttr(i)}>&nbsp;</p>`);
      lastWasViewpoint = false;
      continue;
    }

    if (isViewpointLine(line)) {
      const viewpointLine = sectionNumber !== null ? applyViewpointLabel(line, sectionNumber) : line;
      if (pendingEpigraphs) {
        htmlParts.push(
          `<div class="epigraph-page">\n<p class="viewpoint"${lineAttr(i)}>${escapeHtml(viewpointLine, escapeOpts)}</p>\n${epigraphsToHtml(pendingEpigraphs, escapeOpts, chars)}\n</div>`,
        );
        pendingEpigraphs = null;
        lastWasViewpoint = true;
      } else {
        htmlParts.push(`<p class="viewpoint"${lineAttr(i)}>${escapeHtml(viewpointLine, escapeOpts)}</p>`);
        lastWasViewpoint = blankAfterHeading;
      }
      continue;
    }

    if (lastWasViewpoint) {
      htmlParts.push('<p class="empty">&nbsp;</p>');
      lastWasViewpoint = false;
    }

    if (pendingEpigraphs) {
      htmlParts.push(`<div class="epigraph">\n${epigraphsToHtml(pendingEpigraphs, escapeOpts, chars)}\n</div>`);
      htmlParts.push('<p class="empty">&nbsp;</p>');
      pendingEpigraphs = null;
    }

    if (aozora.heading) {
      htmlParts.push(
        `<p class="${aozoraHeadingClass(aozora.heading)}"${lineAttr(i)}${style}>${escapeHtml(line, escapeOpts)}</p>`,
      );
      continue;
    }

    const charsPerLine = chars || 30;
    const estimatedLines = Math.ceil([...line].length / charsPerLine);
    if (estimatedLines <= 3) {
      const cls = line.startsWith('「') ? 'dialogue-short' : 'paragraph-short';
      htmlParts.push(`<p class="${cls}"${lineAttr(i)}${style}>${escapeHtml(line, escapeOpts)}</p>`);
    } else {
      const cls = line.startsWith('「') ? 'dialogue-long' : 'paragraph-long';
      htmlParts.push(`<p class="${cls}"${lineAttr(i)}${style}>${escapeHtml(line, escapeOpts)}</p>`);
    }
  }

  return { html: htmlParts.join('\n'), hasViewpointStart, hasEmptyViewpointStart };
}

/**
 * 原稿ファイルを EPUB の章の XHTML にする。illustSrc は parseTextLines と同じ（挿絵のファイル名は原稿のディレクトリから解決する）。
 * blankAfterHeading: 視点行（とその後ろのエピグラフ）と本文の間に空行を1つ置く（既定は置かない）
 */
export function parseTextFileForEpub(
  filePath,
  { sectionNumber = null, sceneBreak = SCENE_BREAK_MARK, blankAfterHeading = false, illustSrc = null } = {},
) {
  const lines = readLines(filePath);
  const xhtmlParts = [];
  const escapeOpts = { vertical: true, separateSymbolClasses: true };

  const { hasViewpointStart, hasEmptyViewpointStart, firstContentLine, epigraphs } = analyzeLines(lines);

  let chapterTitle = null;
  if (hasViewpointStart) {
    const firstLine = sectionNumber !== null ? applyViewpointLabel(firstContentLine, sectionNumber) : firstContentLine;
    chapterTitle = parseViewpointLine(firstLine).title || null;
  }

  // セクションを結合したときに余分な空きが出ないよう、先頭・末尾の空行を落とす
  const processLines = trimBlankEdges(selectBodyLines(lines));

  let pendingEpigraph =
    epigraphs.length > 0 ? `<div class="epigraph">\n${epigraphsToHtml(epigraphs, escapeOpts)}\n</div>` : null;
  let blockIndent = 0;

  for (let i = 0; i < processLines.length; i++) {
    const aozora = parseAozoraLine(processLines[i]);
    if (aozora.kind === 'pageBreak') {
      xhtmlParts.push('<div class="page-break-marker"></div>');
      continue;
    }
    if (aozora.kind === 'illust') {
      const xhtml = illustHtml(aozora, { baseDir: dirname(filePath), illustSrc });
      if (xhtml) xhtmlParts.push(xhtml);
      continue;
    }
    if (aozora.kind !== 'text') {
      blockIndent = aozora.indent ?? 0;
      continue;
    }
    const line = aozora.text;
    const style = aozoraStyle(aozora, blockIndent);

    if (line.trim() === '') {
      // 区切り・視点行の前後の間隔は CSS の margin で取るため、隣の空行を出すと二重になる。
      // 挿絵は1ページに組むので、隣の空行を出すと前後のページの端に余分な空きが出る
      const prevLine = i > 0 ? processLines[i - 1] : null;
      const nextLine = i < processLines.length - 1 ? processLines[i + 1] : null;
      const adjacentToSpecial =
        (prevLine !== null && (isSeparator(prevLine) || isViewpointLine(prevLine))) ||
        (nextLine !== null && (isSeparator(nextLine) || isViewpointLine(nextLine))) ||
        (illustSrc && (isIllustLine(prevLine) || isIllustLine(nextLine)));
      if (!adjacentToSpecial) {
        xhtmlParts.push('<p><br /></p>');
      }
      continue;
    }

    if (isSeparator(line)) {
      xhtmlParts.push(`<p class="separator">${escapeHtml(separatorMark(line, sceneBreak), escapeOpts)}</p>`);
      continue;
    }

    if (isViewpointLine(line)) {
      const viewpointLine = sectionNumber !== null ? applyViewpointLabel(line, sectionNumber) : line;
      xhtmlParts.push(`<p class="viewpoint">${escapeHtml(viewpointLine, escapeOpts)}</p>`);
      if (pendingEpigraph) {
        xhtmlParts.push(pendingEpigraph);
        pendingEpigraph = null;
      }
      // 視点行に隣り合う原稿の空行は上で落とすので、二重にはならない
      if (blankAfterHeading && i < processLines.length - 1) xhtmlParts.push('<p><br /></p>');
      continue;
    }

    if (pendingEpigraph) {
      xhtmlParts.push(pendingEpigraph);
      pendingEpigraph = null;
    }

    xhtmlParts.push(
      aozora.heading
        ? `<p class="${aozoraHeadingClass(aozora.heading)}"${style}>${escapeHtml(line, escapeOpts)}</p>`
        : `<p${style}>${escapeHtml(line, escapeOpts)}</p>`,
    );
  }

  return {
    xhtml: xhtmlParts.join('\n'),
    chapterTitle,
    hasViewpointStart,
    hasEmptyViewpointStart,
  };
}

export function getBodyLinesFromContent(content, opts = {}) {
  return getBodyLines(splitLines(content), opts);
}

/**
 * 本文として組む行（メタ行を除く）を返す。返り値は { lines, indices, hasViewpointStart }。
 *   indices: 返した各行の元の行番号（0始まり。プレビューで段落から元テキストの行を引くため）
 *   keepEpigraphs: Lead: の行も残す（Source: の出典は foldSources で足してあるので parseEpigraphLine で読む）
 *   aozora: false なら青空文庫の注記を読み替えずに原稿のまま返す（txt に書き出す split / merge）
 *   subheadsInViewpoint: false なら Subhead: の中身を視点行に足さない（章ヘッダに別に組む英語の出力）
 */
export function getBodyLines(lines, { keepEpigraphs = false, aozora = true, subheadsInViewpoint = true } = {}) {
  const { hasViewpointStart } = analyzeLines(lines);
  const indices = selectBodyLineIndices(lines, { keepEpigraphs });
  const folded = foldSources(lines);
  const source = subheadsInViewpoint ? foldSubheads(folded) : folded;
  return {
    lines: indices.map((i) => (aozora ? normalizeAozoraInline(source[i]) : source[i])),
    indices,
    hasViewpointStart,
  };
}

export function getFilteredLines(filePath, opts = {}) {
  return getBodyLines(readLines(filePath), opts);
}

/** parseTextFile の hasViewpointStart と同じ条件（空行・メタ行を飛ばした最初の行が視点行か）で、パースせずに事前判定する */
export function fileHasViewpointStart(filePath) {
  for (const line of readLines(filePath)) {
    if (line.trim() === '' || isMetaLine(line)) continue;
    return isViewpointLine(line);
  }
  return false;
}

export function countChars(html) {
  const text = html
    .replace(/<div class="separator-block">.*?<\/div>/gs, '')
    .replace(/<p class="separator">.*?<\/p>/g, '')
    .replace(/<rt>.*?<\/rt>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, '')
    .replace(/&#160;/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    // 規定チェックと同じ基準にするため、字下げの全角スペースもマスとして数える
    .replace(/[\r\n\t\u00A0]/g, '');
  return [...text].length;
}

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest;
  const { writeFileSync, unlinkSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');

  describe('splitLines / countTextChars', () => {
    test('CRLF の CR を落とす', () => {
      expect(splitLines('a\r\nb\n')).toEqual(['a', 'b', '']);
    });
    test('# Title は【Title】、# だけの行は【】にし、#Tag や ## は本文のまま', () => {
      expect(splitLines('# The Letter\r\n#\n#  \n#Tag\n## Part\n # x')).toEqual([
        '【The Letter】',
        '【】',
        '【】',
        '#Tag',
        '## Part',
        ' # x',
      ]);
    });
    test('全角の ＃ と全角空白でも見出しにする', () => {
      expect(splitLines('＃　朝の駅\n＃\n# 夜　の　海　\n＃タグ')).toEqual([
        '【朝の駅】',
        '【】',
        '【夜　の　海】',
        '＃タグ',
      ]);
    });
    test('空白・改行・全角スペースを除いてコードポイントで数える', () => {
      expect(countTextChars('あ い\n　う\t')).toBe(3);
      expect(countTextChars('𠮟る')).toBe(2);
    });
  });

  describe('tokenizeInlineMarkup', () => {
    test('記法のないテキストは1トークン', () => {
      expect(tokenizeInlineMarkup('本文')).toEqual([{ type: 'text', text: '本文' }]);
      expect(tokenizeInlineMarkup('')).toEqual([]);
    });
    test('ルビ・傍点・横倒し・イタリックを出現順に切り出す', () => {
      expect(tokenizeInlineMarkup('a|漢字《かんじ》b《《強》》c<<AB>>d*it*e')).toEqual([
        { type: 'text', text: 'a' },
        { type: 'ruby', base: '漢字', ruby: 'かんじ' },
        { type: 'text', text: 'b' },
        { type: 'emphasis', text: '強' },
        { type: 'text', text: 'c' },
        { type: 'sideways', text: 'AB' },
        { type: 'text', text: 'd' },
        { type: 'italic', text: 'it' },
        { type: 'text', text: 'e' },
      ]);
    });
    test('青空文庫の斜体・傍線・左ルビを切り出す', () => {
      const line = normalizeAozoraInline('あ［＃「あ」は斜体］い［＃「い」に破線］英［＃「英」の左に「え」のルビ］');
      expect(tokenizeInlineMarkup(line)).toEqual([
        { type: 'italic', text: 'あ' },
        { type: 'sideline', style: 'dashed', text: 'い' },
        { type: 'leftRuby', base: '英', ruby: 'え' },
      ]);
    });
    test('stripInlineMarkup は傍線の中のルビも外し、左ルビは親文字だけ（rubyParens なら括弧で）残す', () => {
      const leftRuby = '英雄［＃「英雄」の左に「ヒーロー」のルビ］';
      expect(stripInlineMarkup('［＃傍線］|東京《とうきょう》［＃傍線終わり］へ')).toBe('東京へ');
      expect(stripInlineMarkup(leftRuby)).toBe('英雄');
      expect(stripInlineMarkup(leftRuby, { rubyParens: true })).toBe('英雄（ヒーロー）');
    });
  });

  describe('escapeXml', () => {
    test('& < > " をエスケープする', () => {
      expect(escapeXml('a<b>&"c"')).toBe('a&lt;b&gt;&amp;&quot;c&quot;');
    });
  });

  describe('epigraphDisplayLines', () => {
    test('幅指定なしは引用行と出典行に分ける', () => {
      expect(epigraphDisplayLines('引用文', '出典')).toEqual(['引用文', '——出典']);
      expect(epigraphDisplayLines('引用文', null)).toEqual(['引用文']);
    });
    test('一字下げを保って幅に収まるなら1行にまとめる', () => {
      expect(epigraphDisplayLines('引用文', '出典', 8)).toEqual(['引用文——出典']);
      expect(epigraphDisplayLines('引用文', '出典', 7)).toEqual(['引用文', '——出典']);
    });
  });

  describe('青空文庫の注記', () => {
    test('ルビ・傍点・縦中横・太字を組む', () => {
      const { html } = parseTextLines(
        [
          '　東京《とうきょう》で覚悟［＃「覚悟」に傍点］を決め、第123［＃「123」は縦中横］話、［＃太字］ここ［＃太字終わり］',
        ],
        { lineNumbers: true },
      );
      expect(html).toContain('<rt>');
      expect(html).toContain('とうきょう');
      expect(html).toContain('<span class="emphasis-dot">覚</span><span class="emphasis-dot">悟</span>');
      expect(html).toContain('<span class="tcy">123</span>');
      expect(html).toContain('<strong class="bold">ここ</strong>');
      expect(html).not.toContain('［＃');
    });
    test('改ページ・字下げ・地付き・見出しを組み、行番号は元の行を指す', () => {
      const { html } = parseTextLines(
        [
          '一',
          '［＃改ページ］',
          '［＃ここから２字下げ］',
          '二',
          '［＃１字下げ］三',
          '［＃ここで字下げ終わり］',
          '［＃地付き］四',
          '五［＃「五」は中見出し］',
        ],
        { lineNumbers: true },
      );
      expect(html).toContain('<div class="page-break-marker"></div>');
      expect(html).toContain('<p class="paragraph-short" data-line="3" style="margin-inline-start: 2em">二</p>');
      expect(html).toContain('<p class="paragraph-short" data-line="4" style="margin-inline-start: 3em">三</p>');
      expect(html).toContain('<p class="paragraph-short" data-line="6" style="text-align: end">四</p>');
      expect(html).toContain('<p class="aozora-heading aozora-heading-medium" data-line="7">五</p>');
      expect(html).not.toContain('［＃');
    });
    test('挿絵は illustSrc があれば原稿のディレクトリから解決した画像を組み、無ければ出さない', () => {
      const lines = ['一', '', '［＃「駅」のキャプション付きの図（img/a.png）入る］', '', '二'];
      const { html } = parseTextLines(lines, { baseDir: '/work', illustSrc: (path) => `src:${path}` });
      expect(html).toBe(
        '<p class="paragraph-short">一</p>\n<div class="illust"><img src="src:/work/img/a.png" alt="駅" /></div>\n<p class="paragraph-short">二</p>',
      );
      expect(parseTextLines(lines).html).not.toContain('illust');
    });
    test('字数の数え方では注記を数えない', () => {
      expect(stripInlineMarkup('東京《とうきょう》［＃「東京」に傍点］')).toBe('東京');
    });
  });

  describe('indentSeparator', () => {
    test('indent の字数だけ全角空白を前に足し、null なら記号のまま', () => {
      expect(indentSeparator('＊', 3)).toBe('　　　＊');
      expect(indentSeparator('＊', 0)).toBe('＊');
      expect(indentSeparator('＊')).toBe('＊');
    });
  });

  describe('separatorMark', () => {
    test('場面区切りは出力ごとの記号に、ほかの記号は書いたまま', () => {
      expect(separatorMark('* * *')).toBe('＊');
      expect(separatorMark('*', '#')).toBe('#');
      expect(separatorMark('■■■')).toBe('■■■');
      expect(separatorMark(' >>> ', '#')).toBe('>>>');
    });
    test('*: の行は書いた記号に、記号が無ければ場面区切りの記号にする', () => {
      expect(separatorMark('*: ☆　☆　☆', '#')).toBe('☆　☆　☆');
      expect(separatorMark('＊：〜〜〜')).toBe('〜〜〜');
      expect(separatorMark('*:', '#')).toBe('#');
      expect(separatorMark('＊:  ', null)).toBe(null);
    });
    test('sceneBreak で場面区切りの記号を変えられる', () => {
      const { html } = parseTextLines(['一', '*', '二'], { sceneBreak: '＊　＊　＊' });
      expect(html).toContain('<p class="separator">＊　＊　＊</p>');
    });
    test('日本語の組版では * の行が ＊ になり、イタリックにはならない', () => {
      const { html } = parseTextLines(['本文一', '', '* * *', '', '本文二', '■■■', '本文三']);
      expect(html).toContain('<div class="separator-block"><p class="separator">＊</p></div>');
      expect(html).toContain('<p class="separator">■■■</p>');
      expect(html).not.toContain('<i');
    });
  });

  describe('isSeparator', () => {
    test('\u25C7\u306E\u307F\u3067\u69CB\u6210\u3055\u308C\u308B\u884C\u306Ftrue', () => {
      expect(isSeparator('\u25C7')).toBe(true);
      expect(isSeparator('\u25C7\u25C7\u25C7')).toBe(true);
    });
    test('\u591A\u69D8\u306A\u533A\u5207\u308A\u8A18\u53F7\u3082true', () => {
      expect(isSeparator('\u25C6\u25C6')).toBe(true);
      expect(isSeparator('\u25A1')).toBe(true);
      expect(isSeparator('\u25A0\u25A0\u25A0')).toBe(true);
      expect(isSeparator('\u25CB\u25CF\u25CE')).toBe(true);
      expect(isSeparator('\u203B\u203B')).toBe(true);
      expect(isSeparator('\uFF0A')).toBe(true);
      expect(isSeparator('***')).toBe(true);
      expect(isSeparator('>>>')).toBe(true);
    });
    test('* の行は空白を挟んでも場面区切り', () => {
      for (const line of ['*', '***', '* * *', '＊　＊　＊', '  * * *  ']) {
        expect(isSceneBreak(line)).toBe(true);
        expect(isSeparator(line)).toBe(true);
      }
      expect(isSceneBreak('◇◇◇')).toBe(false);
      expect(isSceneBreak('*強調*')).toBe(false);
    });
    test('*: で始まる行は記号を問わず区切り。行頭に無ければ本文', () => {
      for (const line of ['*: ☆☆☆', '＊：〜', '*：◎', '*:']) expect(isSeparator(line)).toBe(true);
      expect(isSeparator(' *: ☆☆☆')).toBe(false);
      expect(isSeparator('*強調*: ☆')).toBe(false);
    });
    test('\u6587\u5B57\u304C\u6DF7\u3056\u308B\u3068false', () => {
      expect(isSeparator('\u25C7\u3042')).toBe(false);
      expect(isSeparator('\u3042\u25C7')).toBe(false);
      expect(isSeparator('')).toBe(false);
      expect(isSeparator('\u672C\u6587')).toBe(false);
    });
  });

  describe('isMemoLine / isEpigraphLine / isSourceLine', () => {
    test('プレフィックス一致でtrue', () => {
      expect(isMemoLine('Memo: なにか')).toBe(true);
      expect(isEpigraphLine('Lead: 引用')).toBe(true);
      expect(isSourceLine('Source: 出典')).toBe(true);
    });
    test('プレフィックスがなければfalse', () => {
      expect(isMemoLine('memo: 小文字')).toBe(false);
      expect(isEpigraphLine(' Lead: 先頭空白')).toBe(false);
    });
  });

  describe('getBodyLinesFromContent', () => {
    test('Memo 行は本文から除き、ほかの「〜:」で始まる行は本文として残す', () => {
      const { lines } = getBodyLinesFromContent('Memo: plot.md\nPOV: 太郎\n\n本文。\n');
      expect(lines).toEqual(['POV: 太郎', '', '本文。', '']);
    });
    test('末尾の【】も本文に残す（見出しとして組む）', () => {
      expect(getBodyLinesFromContent('【】\n本文。\n【】').lines).toEqual(['【】', '本文。', '【】']);
    });
  });

  describe('Lead: / Source:', () => {
    test('Source: は前の Lead:（間は空行だけ）の出典になり、——で分けたりはしない', () => {
      const lines = foldSources(['Lead: 「だとしたら——」', '', 'Source: ドストエフスキー', 'Lead: 引用のみ']);
      expect(lines).toHaveLength(4);
      expect(parseEpigraphLine(lines[0])).toEqual({ quote: '「だとしたら——」', source: 'ドストエフスキー' });
      expect(parseEpigraphLine(lines[3])).toEqual({ quote: '引用のみ', source: null });
    });
    test('前が Lead: でない Source: は使わない', () => {
      expect(foldSources(['Lead: 一', '本文', 'Source: 出典'])).toEqual(['Lead: 一', '本文', 'Source: 出典']);
    });
    test('unfoldSources は原稿の Lead: / Source: の行に戻す', () => {
      const [lead] = foldSources(['Lead: 引用', 'Source: 出典']);
      expect(unfoldSources(lead)).toEqual(['Lead: 引用', 'Source: 出典']);
      expect(unfoldSources('Lead: 引用のみ')).toEqual(['Lead: 引用のみ']);
      expect(unfoldSources('本文')).toEqual(['本文']);
    });
  });

  describe('isViewpointLine', () => {
    test('\u3010name\u3011\u5F62\u5F0F\u306Ftrue', () => {
      expect(isViewpointLine('\u3010\u592A\u90CE\u3011')).toBe(true);
      expect(isViewpointLine('\u3010\u3011')).toBe(true);
      expect(isViewpointLine('\u3010\u592A\u90CE\u3011\u5F8C\u7D9A\u30C6\u30AD\u30B9\u30C8')).toBe(true);
    });
    test('\u3010\u3011\u304C\u5148\u982D\u3067\u306A\u3051\u308C\u3070false', () => {
      expect(isViewpointLine(' \u3010\u592A\u90CE\u3011')).toBe(false);
      expect(isViewpointLine('\u672C\u6587\u3010\u592A\u90CE\u3011')).toBe(false);
      expect(isViewpointLine('\u300C\u30BB\u30EA\u30D5\u300D')).toBe(false);
    });
  });

  describe('parseViewpointLine', () => {
    test('章題と、同じ行に続く本文とに分ける', () => {
      expect(parseViewpointLine('【　夜　】It was late.')).toEqual({ title: '夜', rest: 'It was late.' });
      expect(parseViewpointLine('【】')).toEqual({ title: '', rest: '' });
    });
  });

  describe('applyViewpointLabel', () => {
    test('\u7A7A\u306E\u3010\u3011\u306F\u30E9\u30D9\u30EB\u3060\u3051\u304C\u5165\u308B', () => {
      expect(applyViewpointLabel('\u3010\u3011', '1-2')).toBe('\u30101-2\u3011');
      expect(applyViewpointLabel('\u3010\u3011', 5)).toBe('\u30105\u3011');
    });
    test('\u3010title\u3011\u306F\u30E9\u30D9\u30EB\u3068title\u304C\u5168\u89D2space\u533A\u5207\u308A', () => {
      expect(applyViewpointLabel('\u3010\u592A\u90CE\u3011', '1-2')).toBe('\u30101-2\u3000\u592A\u90CE\u3011');
      expect(applyViewpointLabel('\u3010\u592A\u90CE\u3011 \u30BB\u30EA\u30D5', '3')).toBe(
        '\u30103\u3000\u592A\u90CE\u3011 \u30BB\u30EA\u30D5',
      );
    });
  });

  describe('stripInlineMarkup', () => {
    test('ルビは親文字のみ残す', () => {
      expect(stripInlineMarkup('|漢字《かんじ》')).toBe('漢字');
    });
    test('rubyParens指定でルビを括弧表記にする', () => {
      expect(stripInlineMarkup('|漢字《かんじ》', { rubyParens: true })).toBe('漢字（かんじ）');
    });
    test('傍点・横倒しは中身だけ残す', () => {
      expect(stripInlineMarkup('《《強調》》')).toBe('強調');
      expect(stripInlineMarkup('<<ABC>>')).toBe('ABC');
    });
    test('複数記法が混在しても全部解除', () => {
      expect(stripInlineMarkup('|漢字《かんじ》と《《強調》》と<<X>>')).toBe('漢字と強調とX');
    });
    test('特別な記法がなければそのまま返す', () => {
      expect(stripInlineMarkup('普通の本文')).toBe('普通の本文');
    });
  });

  describe('escapeHtml', () => {
    test('HTML\u7279\u6B8A\u6587\u5B57\u3092\u30A8\u30B9\u30B1\u30FC\u30D7\uFF08\u6A2A\u66F8\u304D\u30E2\u30FC\u30C9\uFF09', () => {
      expect(escapeHtml('<p>"a & b"</p>', { vertical: false })).toBe('&lt;p&gt;&quot;a　&amp;　b&quot;&lt;/p&gt;');
    });
    test('\u7E26\u66F8\u304D\u30E2\u30FC\u30C9\u3067\u306F\u6570\u5B57\u3092\u7E26\u4E2D\u6A2A/upright\u306B\u3001\u30CF\u30A4\u30D5\u30F3\u3092\u5168\u89D2\u5316', () => {
      expect(escapeHtml('5', { vertical: true })).toBe('<span class="tcy">5</span>');
      expect(escapeHtml('99', { vertical: true })).toBe('<span class="tcy">99</span>');
      expect(escapeHtml('100', { vertical: true })).toBe(
        '<span class="upright">1</span><span class="upright">0</span><span class="upright">0</span>',
      );
      expect(escapeHtml('1,234', { vertical: true })).toBe(
        '<span class="upright">1</span><span class="upright">\uFF0C</span><span class="upright">2</span><span class="upright">3</span><span class="upright">4</span>',
      );
      expect(escapeHtml('a-b', { vertical: true })).toBe(
        '<span class="latin">a</span><span class="hyphen">\uFF0D</span><span class="latin">b</span>',
      );
      expect(escapeHtml('ab', { vertical: true })).toBe('<span class="latin">a</span><span class="latin">b</span>');
    });
    test('単独の全角ハイフンは hyphen クラス、連続ダッシュ・全角イコールは dash クラス', () => {
      expect(escapeHtml('1-1', { vertical: true })).toBe(
        '<span class="tcy">1</span><span class="hyphen">\uFF0D</span><span class="tcy">1</span>',
      );
      expect(escapeHtml('\u2014\u2014', { vertical: true })).toBe('<span class="dash">\u2014\u2014</span>');
      expect(escapeHtml('1--2', { vertical: true })).toBe(
        '<span class="tcy">1</span><span class="dash">\uFF0D\uFF0D</span><span class="tcy">2</span>',
      );
      expect(escapeHtml('1-1', { vertical: true, separateSymbolClasses: true })).toBe(
        '<span class="tcy">1</span><span class="dash">\uFF0D</span><span class="tcy">1</span>',
      );
    });
    test('\u7E26\u66F8\u304D\u3067\u30A2\u30AF\u30BB\u30F3\u30C8\u4ED8\u304D\u30E9\u30C6\u30F3\u6587\u5B57\u3082 latin \u30AF\u30E9\u30B9\u3067\u7ACB\u3066\u308B', () => {
      expect(escapeHtml('ab', { vertical: true })).toBe('<span class="latin">a</span><span class="latin">b</span>');
      expect(escapeHtml('C\u00F4te', { vertical: true })).toBe(
        '<span class="latin">C</span><span class="latin">\u00F4</span><span class="latin">t</span><span class="latin">e</span>',
      );
      expect(escapeHtml('\u00DCber', { vertical: true })).toBe(
        '<span class="latin">\u00DC</span><span class="latin">b</span><span class="latin">e</span><span class="latin">r</span>',
      );
      expect(escapeHtml('\u0110\u00E0', { vertical: true })).toBe(
        '<span class="latin">\u0110</span><span class="latin">\u00E0</span>',
      );
    });
    test('\u7E26\u66F8\u304D\u3067 !? \u3092\u5168\u89D2\u306B\u3001!? \u306E\u9023\u7D9A\u306F\u7E26\u4E2D\u6A2A\u306B\u307E\u3068\u3081\u308B', () => {
      expect(escapeHtml('\u3042!', { vertical: true })).toBe('\u3042\uFF01');
      expect(escapeHtml('\u3042?', { vertical: true })).toBe('\u3042\uFF1F');
      expect(escapeHtml('!?', { vertical: true })).toBe('<span class="tcy">!?</span>');
      expect(escapeHtml('\uFF01\uFF01', { vertical: true })).toBe('<span class="tcy">!!</span>');
    });
    test('\u30EB\u30D3 |\u89AA\u300A\u3075\u308A\u300B \u3092 <ruby> \u306B\u5909\u63DB', () => {
      expect(escapeHtml('|\u6F22\u5B57\u300A\u304B\u3093\u3058\u300B', { vertical: false })).toBe(
        '<ruby>\u6F22\u5B57<rt>\u304B\u3093\u3058</rt></ruby>',
      );
    });
    test('rubyLayout: 字数が同じなら親文字1字ごとに分け、ルビ1字ずつを真横に置く', () => {
      expect(escapeHtml('|籠手《こて》', { rubyLayout: true })).toBe(
        '<ruby class="fit" style="--rt-off:0.5;--rt-ls:1">籠<rt>こ</rt></ruby>' +
          '<ruby class="fit" style="--rt-off:0.5;--rt-ls:1">手<rt>て</rt></ruby>',
      );
    });
    test('rubyLayout: 短いルビは親文字の長さに均等配置し、中心が乗る親文字に付ける', () => {
      expect(escapeHtml('|琥珀《こはく》', { rubyLayout: true })).toBe(
        '<ruby class="fit" style="--rt-off:0.167;--rt-ls:0.333">琥<rt>こ</rt></ruby>' +
          '<ruby class="fit" style="--rt-off:-0.5;--rt-ls:0.333">珀<rt>はく</rt></ruby>',
      );
    });
    test('rubyLayout: 長いルビは前後のかなへはみ出させ、余りは親文字の前後を空ける', () => {
      expect(escapeHtml('彼は|蹲《うずくま》る', { rubyLayout: true })).toBe(
        '彼は<ruby class="fit" style="--rt-off:-1;--rt-ls:0">蹲<rt>うずくま</rt></ruby>る',
      );
      expect(escapeHtml('漢|志《こころざし》漢', { rubyLayout: true })).toBe(
        '漢<ruby class="fit" style="--rt-off:0;--rt-ls:0;--rb-pad:0.75">志<rt>こころざし</rt></ruby>漢',
      );
    });
    test('rubyLayout: 漢字に挟まれた長いルビは親文字の字間を均等に広げる', () => {
      expect(escapeHtml('「|東恋《あずまれん》」', { rubyLayout: true })).toBe(
        '「<ruby class="fit" style="--rt-off:0;--rt-ls:0;--rb-pad:0.125;--rb-gap:0.25">東<span class="ruby-gap"></span>恋<rt>あずまれん</rt></ruby>」',
      );
    });
    test('layoutRuby: 字間はルビ1字分までで、それ以上は中央に寄せる', () => {
      expect(layoutRuby(2, 2)).toEqual({ gap: 0.5, rtStart: 0.25, widen: 0 });
      expect(layoutRuby(4, 1)).toEqual({ gap: 0.5, rtStart: 1.75, widen: 0 });
      expect(layoutRuby(6, 3)).toEqual({ gap: 0.5, rtStart: 1.75, widen: 0 });
    });
    test('layoutRuby: はみ出しは許される側へ最大限使い、残りだけ親文字を広げる', () => {
      expect(layoutRuby(1, 4, 0.5, 0.5)).toEqual({ gap: 0, rtStart: -0.5, widen: 0 });
      expect(layoutRuby(1, 3, 0, 0.5)).toEqual({ gap: 0, rtStart: -0, widen: 0 });
      expect(layoutRuby(1, 5, 0.5, 0)).toEqual({ gap: 0, rtStart: -0.5, widen: 1 });
    });
    test('\u508D\u70B9 \u300A\u300Atext\u300B\u300B \u3092 span.emphasis \u306B\u5909\u63DB', () => {
      expect(escapeHtml('\u300A\u300A\u5F37\u8ABF\u300B\u300B', { vertical: false })).toBe(
        '<span class="emphasis">\u5F37\u8ABF</span>',
      );
    });
    test('rubyLayout: 縦書きの傍点は行送りを広げないよう1字ずつの箱にし、約物には打たない', () => {
      expect(escapeHtml('《《覚悟、12》》', { rubyLayout: true })).toBe(
        '<span class="emphasis-dot">覚</span><span class="emphasis-dot">悟</span>、<span class="emphasis-dot"><span class="tcy">12</span></span>',
      );
    });
    test('rubyLayout: 横書きの傍点も行間を広げないよう1字ずつの箱にする', () => {
      expect(escapeHtml('《《覚悟、12》》', { rubyLayout: true, vertical: false })).toBe(
        '<span class="emphasis-dot">覚</span><span class="emphasis-dot">悟</span>、<span class="emphasis-dot">1</span><span class="emphasis-dot">2</span>',
      );
    });
    test('\u6A2A\u5012\u3057 <<text>> \u3092 span.sideways-latin \u306B\u5909\u63DB', () => {
      expect(escapeHtml('<<ABC>>', { vertical: false })).toBe('<span class="sideways-latin">ABC</span>');
    });
    test('separateSymbolClasses=true \u3067\u30C0\u30C3\u30B7\u30E5/\u4E09\u70B9/\u6CE2\u30C0\u30C3\u30B7\u30E5\u304C\u5225\u30AF\u30E9\u30B9\u306B', () => {
      expect(escapeHtml('\u2014', { vertical: true, separateSymbolClasses: true })).toBe(
        '<span class="dash">\u2014</span>',
      );
      expect(escapeHtml('\u2026', { vertical: true, separateSymbolClasses: true })).toBe(
        '<span class="ellipsis">\u2026</span>',
      );
      expect(escapeHtml('\uFF5E', { vertical: true, separateSymbolClasses: true })).toBe(
        '<span class="wave-dash">\uFF5E</span>',
      );
    });
    test('\u65E2\u5B9A (separateSymbolClasses=false) \u3067\u306F\u5168\u90E8 dash \u30AF\u30E9\u30B9', () => {
      expect(escapeHtml('\u2026', { vertical: true })).toBe('<span class="dash">\u2026</span>');
      expect(escapeHtml('\uFF5E', { vertical: true })).toBe('<span class="dash">\uFF5E</span>');
    });
    test('\u534A\u89D2\u30B9\u30DA\u30FC\u30B9\u306F\u5168\u89D2\u30B9\u30DA\u30FC\u30B9(U+3000)\u306B\u5909\u63DB\u3055\u308C\u3001\u4E00\u6587\u5B57\u5206\u306E\u5E45\u3092\u4FDD\u3064', () => {
      expect(escapeHtml('\u3042 \u3044', { vertical: true })).toBe('\u3042\u3000\u3044');
      expect(escapeHtml('\u3042 \u3044', { vertical: false })).toBe('\u3042\u3000\u3044');
      expect(escapeHtml('\u3042  \u3044', { vertical: true })).toBe('\u3042\u3000\u3000\u3044');
      expect(escapeHtml('\u3042\u3000\u3044', { vertical: true })).toBe('\u3042\u3000\u3044');
    });
    test('\u30E9\u30C6\u30F3\u8A9E\u9593\u306E\u534A\u89D2\u30B9\u30DA\u30FC\u30B9\u3082\u5168\u89D2\u5316\u3055\u308C\u5358\u8A9E\u9023\u7D50\u306F\u7DAD\u6301\u3055\u308C\u308B', () => {
      expect(escapeHtml('ab cd', { vertical: true })).toBe(
        '<span class="latin">a</span><span class="latin">b</span>\u3000<span class="latin">c</span><span class="latin">d</span>',
      );
    });
  });

  describe('parseTextFile 視点行', () => {
    test('既定では視点行と本文の間に空行を補わない（原稿側の空行はそのまま）', () => {
      const tmp = join(tmpdir(), `vp-noblank-${Date.now()}.txt`);
      try {
        writeFileSync(tmp, '【】\n本文1行目\n');
        expect(parseTextFile(tmp, { vertical: false }).html).toMatch(
          /<p class="viewpoint">【】<\/p>\n<p[^>]*>本文1行目<\/p>/,
        );
        writeFileSync(tmp, '【】\n\n本文1行目\n');
        expect(parseTextFile(tmp, { vertical: false }).html).toMatch(
          /<p class="viewpoint">【】<\/p>\n<p class="empty">&nbsp;<\/p>\n<p[^>]*>本文1行目<\/p>/,
        );
      } finally {
        unlinkSync(tmp);
      }
    });

    test('blankAfterHeading: 視点行の直後に空行を1つ補い、原稿側にあれば二重にしない', () => {
      const tmp = join(tmpdir(), `vp-blank-${Date.now()}.txt`);
      try {
        for (const src of ['【】\n本文1行目\n', '【】\n\n本文1行目\n']) {
          writeFileSync(tmp, src);
          expect(parseTextFile(tmp, { vertical: false, blankAfterHeading: true }).html).toMatch(
            /<p class="viewpoint">【】<\/p>\n<p class="empty">&nbsp;<\/p>\n<p[^>]*>本文1行目<\/p>/,
          );
        }
      } finally {
        unlinkSync(tmp);
      }
    });
  });

  describe('parseTextLines lineNumbers', () => {
    test('メタ行を飛ばした元テキストの行番号を data-line に付ける', () => {
      const { html } = parseTextLines(['Memo: a', '【】', '', '本文一', 'Memo: x', '「台詞」'], { lineNumbers: true });
      expect(html).toContain('<p class="viewpoint" data-line="1">');
      expect(html).toContain('<p class="paragraph-short" data-line="3">本文一</p>');
      expect(html).toContain('<p class="dialogue-short" data-line="5">');
      expect(html).toContain('<p class="empty" data-line="2">&nbsp;</p>');
      expect(html).not.toContain('data-line="4"');
    });
    test('行番号つきの空行も、区切り行の前後では区切りブロックに吸収される', () => {
      const { html } = parseTextLines(['一', '', '◇◇◇', '', '二'], { lineNumbers: true });
      expect(html).not.toContain('class="empty"');
      expect(html).toContain('<div class="separator-block">');
    });
    test('既定では data-line を付けない', () => {
      expect(parseTextLines(['本文']).html).toBe('<p class="paragraph-short">本文</p>');
    });
  });

  describe('parseTextFile epigraph', () => {
    test('視点行＋エピグラフの直後には空行を1つ挟む', () => {
      const tmp = join(tmpdir(), `epi-vp-${Date.now()}.txt`);
      writeFileSync(tmp, 'Lead: 引用\nSource: 出典\n【】\n本文1行目\n');
      try {
        const { html } = parseTextFile(tmp, { vertical: false });
        expect(html).toContain('epigraph-page');
        expect(html).toMatch(/<\/div>\n<p class="empty">&nbsp;<\/p>\n<p[^>]*>本文1行目<\/p>/);
      } finally {
        unlinkSync(tmp);
      }
    });

    test('視点行＋エピグラフの後に原稿側の空行があっても空行は二重にならない', () => {
      const tmp = join(tmpdir(), `epi-vp-blank-${Date.now()}.txt`);
      writeFileSync(tmp, 'Lead: 引用\nSource: 出典\n【】\n\n本文1行目\n');
      try {
        const { html } = parseTextFile(tmp, { vertical: false });
        expect(html).toMatch(/<\/div>\n<p class="empty">&nbsp;<\/p>\n<p[^>]*>本文1行目<\/p>/);
      } finally {
        unlinkSync(tmp);
      }
    });

    test('本文＋引用元が1行に収まるエピグラフは1行にまとめる', () => {
      const tmp = join(tmpdir(), `epi-oneline-${Date.now()}.txt`);
      writeFileSync(tmp, 'Lead: 引用文\nSource: 出典\n【】\n本文1行目\n');
      try {
        const { html } = parseTextFile(tmp, { vertical: false, chars: 30 });
        expect(html).toContain('<p class="epigraph-line">引用文——出典</p>');
        expect(html).not.toContain('epigraph-quote');
      } finally {
        unlinkSync(tmp);
      }
    });

    test('1行に収まらないエピグラフは従来どおり2行に分ける', () => {
      const tmp = join(tmpdir(), `epi-twoline-${Date.now()}.txt`);
      writeFileSync(tmp, 'Lead: 引用文\nSource: 出典\n【】\n本文1行目\n');
      try {
        const { html } = parseTextFile(tmp, { vertical: false, chars: 7 });
        expect(html).toContain('epigraph-quote');
        expect(html).toContain('epigraph-source');
        expect(html).not.toContain('epigraph-line');
      } finally {
        unlinkSync(tmp);
      }
    });

    test('視点行なしでもエピグラフの直後には空行を1つ挟む', () => {
      const tmp = join(tmpdir(), `epi-novp-${Date.now()}.txt`);
      writeFileSync(tmp, 'Lead: 引用\nSource: 出典\n本文1行目\n');
      try {
        const { html } = parseTextFile(tmp, { vertical: false });
        expect(html).toMatch(
          /<div class="epigraph">[\s\S]*?<\/div>\n<p class="empty">&nbsp;<\/p>\n<p[^>]*>本文1行目<\/p>/,
        );
      } finally {
        unlinkSync(tmp);
      }
    });
  });

  describe('escapeHtml の組み', () => {
    test('rubyLayout: 句読点の前・開き括弧の後にはルビをはみ出させる', () => {
      expect(escapeHtml('。|蹲《うずくま》漢', { rubyLayout: true })).toBe(
        '。<ruby class="fit" style="--rt-off:-1;--rt-ls:0;--rb-pad:0.25">蹲<rt>うずくま</rt></ruby>漢',
      );
    });
    test('rubyLayout: 1字を挟んで隣り合うルビは、その1字へのはみ出しを半分ずつ分け合う', () => {
      expect(escapeHtml('漢|蹲《うずくま》の|蹲《うずくま》漢', { rubyLayout: true })).toBe(
        '漢<ruby class="fit" style="--rt-off:0;--rt-ls:0;--rb-pad:0.375">蹲<rt>うずくま</rt></ruby>' +
          'の<ruby class="fit" style="--rt-off:-0.5;--rt-ls:0;--rb-pad:0.375">蹲<rt>うずくま</rt></ruby>漢',
      );
    });
    test('rubyLayout: 縦書きの2桁数字・横書きの半角2字は親文字1字分として数える', () => {
      expect(escapeHtml('漢|12《じゅうに》漢', { rubyLayout: true })).toBe(
        '漢<ruby class="fit" style="--rt-off:0;--rt-ls:0;--rb-pad:0.5"><span class="tcy">12</span><rt>じゅうに</rt></ruby>漢',
      );
      expect(escapeHtml('漢|AB《えーびー》漢', { rubyLayout: true, vertical: false })).toBe(
        '漢<ruby class="fit" style="--rt-off:0;--rt-ls:0;--rb-pad:0.5">AB<rt>えーびー</rt></ruby>漢',
      );
    });
    test('縦書きで × は latin にしない、略語のピリオドは dot、小数点は全角にする', () => {
      expect(escapeHtml('a×b')).toBe('<span class="latin">a</span>×<span class="latin">b</span>');
      expect(escapeHtml('O.M.')).toBe(
        '<span class="latin">O</span><span class="dot">.</span><span class="latin">M</span><span class="dot">.</span>',
      );
      expect(escapeHtml('1.5')).toBe(
        '<span class="upright">1</span><span class="upright">．</span><span class="upright">5</span>',
      );
    });
    test('縦書きで ASCII のローマ数字を1字のローマ数字にして立てる', () => {
      expect(escapeHtml('XII世')).toBe('<span class="upright">\u216B</span>世');
    });
    test('青空文庫の縦中横は縦書きだけ tcy にし、横書きでは中身をそのまま組む', () => {
      expect(escapeHtml(`${TCY_OPEN}123${TCY_CLOSE}`)).toBe('<span class="tcy">123</span>');
      expect(escapeHtml(`${TCY_OPEN}123${TCY_CLOSE}`, { vertical: false })).toBe('123');
    });
    test('青空文庫の傍線は種類ごとのクラス、斜体は i、左ルビは left-ruby の ruby にする', () => {
      const aozora = (line, opts) => escapeHtml(normalizeAozoraInline(line), opts);
      expect(aozora('運命［＃「運命」に波線］が')).toBe('<span class="sideline sideline-wavy">運命</span>が');
      expect(aozora('［＃二重傍線］|東京《とうきょう》［＃二重傍線終わり］')).toBe(
        '<span class="sideline sideline-double"><ruby>東京<rt>とうきょう</rt></ruby></span>',
      );
      expect(aozora('ここ［＃「ここ」は斜体］')).toBe('<i class="italic">ここ</i>');
      expect(aozora('英雄［＃「英雄」の左に「ヒーロー」のルビ］', { rubyLayout: true })).toBe(
        '<ruby class="left-ruby">英雄<rt>ヒーロー</rt></ruby>',
      );
    });
    test('傍点の中の傍線の目印には点を打たない', () => {
      const line = normalizeAozoraInline('［＃傍点］あ［＃傍線］い［＃傍線終わり］［＃傍点終わり］');
      expect(escapeHtml(line, { rubyLayout: true })).toBe(
        '<span class="emphasis-dot">あ</span>' +
          '<span class="sideline sideline-solid"><span class="emphasis-dot">い</span></span>',
      );
    });
    test('傍点の中の左ルビは、中の縦中横や英字も組む', () => {
      const aozora = (line) => escapeHtml(normalizeAozoraInline(line), { rubyLayout: true });
      expect(aozora('［＃傍点］英雄［＃「英雄」の左に「hero」のルビ］［＃傍点終わり］')).not.toMatch(/[\uE000-\uEFFF]/);
      expect(aozora('［＃傍点］第2話［＃「第2話」の左に「だいにわ」のルビ］［＃傍点終わり］')).toContain(
        '第<span class="tcy">2</span>話',
      );
    });
    test('横倒しの中のルビも組む', () => {
      expect(tokenizeInlineMarkup('<<A|漢《かん》>>')).toEqual([{ type: 'sideways', text: 'A|漢《かん》' }]);
      expect(escapeHtml('<<A|漢《かん》>>', { vertical: false })).toBe(
        '<span class="sideways-latin">A<ruby>漢<rt>かん</rt></ruby></span>',
      );
    });
  });

  describe('本文として組まない行', () => {
    test('Memo: と Lead: と Source: と Subhead: はメタ行', () => {
      expect(isMetaLine('Memo: x')).toBe(true);
      expect(isMetaLine('Lead: x')).toBe(true);
      expect(isMetaLine('Source: x')).toBe(true);
      expect(isMetaLine('Subhead: x')).toBe(true);
      expect(isMetaLine('本文')).toBe(false);
    });
    test('foldSubheads は Subhead: の中身を最初の視点行の後ろに足し、行数は変えない', () => {
      expect(foldSubheads(['Subhead: ナディア', 'Subhead: -21Y', '【】', '本文', '【】'])).toEqual([
        'Subhead: ナディア',
        'Subhead: -21Y',
        '【】　ナディア　-21Y',
        '本文',
        '【】',
      ]);
      expect(foldSubheads(['【夜】　太郎 ', 'Subhead: 花子'])[0]).toBe('【夜】　太郎　花子');
      expect(foldSubheads(['Subhead: 花子', '本文'])).toEqual(['Subhead: 花子', '本文']);
    });
    test('getBodyLines は Subhead: を視点行に足し、subheadsInViewpoint: false なら足さない', () => {
      const lines = ['Subhead: 花子', '【】', '本文'];
      expect(getBodyLines(lines).lines).toEqual(['【】　花子', '本文']);
      expect(getBodyLines(lines, { subheadsInViewpoint: false }).lines).toEqual(['【】', '本文']);
    });
    test('parseTextLines は Subhead: を視点行の後ろに組む', () => {
      expect(parseTextLines(['Subhead: 花子', '【】', '本文']).html).toContain('<p class="viewpoint">【】　花子</p>');
    });
    test('parseSubheadLine は Subhead: の後ろを前後の空白を除いて返す', () => {
      expect(parseSubheadLine('Subhead:   Nadia Solis ')).toBe('Nadia Solis');
      expect(parseSubheadLine('Subhead:')).toBe('');
    });
    test('stripInlineMarkup は行の単位の注記も数えない', () => {
      expect(stripInlineMarkup('［＃３字下げ］本文')).toBe('本文');
    });
    test('getBodyLines は元の行番号を返し、aozora: false なら注記を読み替えない', () => {
      const content = 'Memo: x\nLead: 引用\n本文［＃「本文」に傍点］';
      expect(getBodyLinesFromContent(content)).toEqual({
        lines: ['《《本文》》'],
        indices: [2],
        hasViewpointStart: false,
      });
      expect(getBodyLinesFromContent(content, { keepEpigraphs: true, aozora: false })).toEqual({
        lines: ['Lead: 引用', '本文［＃「本文」に傍点］'],
        indices: [1, 2],
        hasViewpointStart: false,
      });
    });
    test('fileHasViewpointStart は空行・メタ行を飛ばした最初の行で判定する', () => {
      const tmp = join(tmpdir(), `vp-start-${Date.now()}.txt`);
      try {
        writeFileSync(tmp, 'Memo: x\n\n【】\n本文\n');
        expect(fileHasViewpointStart(tmp)).toBe(true);
        writeFileSync(tmp, '本文\n【】\n');
        expect(fileHasViewpointStart(tmp)).toBe(false);
      } finally {
        unlinkSync(tmp);
      }
    });
  });

  describe('parseTextLines 段落', () => {
    test('推定3行を超える段落は long、「で始まる段落は dialogue', () => {
      const { html } = parseTextLines(['あ'.repeat(91), '「い」', 'う'.repeat(90)], { chars: 30 });
      expect(html).toBe(
        `<p class="paragraph-long">${'あ'.repeat(91)}</p>\n<p class="dialogue-short">「い」</p>\n<p class="paragraph-short">${'う'.repeat(90)}</p>`,
      );
    });
  });

  describe('parseTextFileForEpub', () => {
    test('先頭・末尾の空行と、区切り・視点行に隣接する空行は出さない', () => {
      const tmp = join(tmpdir(), `epub-blank-${Date.now()}.txt`);
      try {
        writeFileSync(tmp, '\n【夜】\n\n一\n\n二\n\n*\n\n三\n\n');
        const { xhtml, chapterTitle } = parseTextFileForEpub(tmp);
        expect(chapterTitle).toBe('夜');
        expect(xhtml).toBe(
          '<p class="viewpoint">【夜】</p>\n<p>一</p>\n<p><br /></p>\n<p>二</p>\n<p class="separator">＊</p>\n<p>三</p>',
        );
      } finally {
        unlinkSync(tmp);
      }
    });
    test('blankAfterHeading: 視点行の後ろに空行を1つ置き、原稿側の空行と二重にしない', () => {
      const tmp = join(tmpdir(), `epub-heading-${Date.now()}.txt`);
      try {
        for (const text of ['【夜】\n一\n', '【夜】\n\n一\n']) {
          writeFileSync(tmp, text);
          expect(parseTextFileForEpub(tmp, { blankAfterHeading: true }).xhtml).toBe(
            '<p class="viewpoint">【夜】</p>\n<p><br /></p>\n<p>一</p>',
          );
        }
      } finally {
        unlinkSync(tmp);
      }
    });
  });

  describe('countChars', () => {
    test('HTML\u30BF\u30B0\u3092\u9664\u53BB\u3057\u3066\u6587\u5B57\u6570\u3092\u6570\u3048\u308B', () => {
      expect(countChars('<p>\u672C\u6587</p>')).toBe(2);
    });
    test('\u30EB\u30D3\u306E rt \u306F\u9664\u5916', () => {
      expect(countChars('<p><ruby>\u6F22\u5B57<rt>\u304B\u3093\u3058</rt></ruby></p>')).toBe(2);
    });
    test('separator-block \u3068 p.separator \u306F\u9664\u5916', () => {
      expect(countChars('<p>\u672C\u6587</p>\n<p class="separator">\u25C7\u25C7\u25C7</p>')).toBe(2);
      expect(
        countChars('<p>\u672C\u6587</p>\n<div class="separator-block"><p class="separator">\u25C7</p></div>'),
      ).toBe(2);
    });
    test('&nbsp; \u3084 &amp; \u306A\u3069\u306E\u30A8\u30F3\u30C6\u30A3\u30C6\u30A3\u306F\u4E2D\u8EAB\u306B\u5C55\u958B\u305B\u305A\u7A7A\u767D\u6271\u3044', () => {
      expect(countChars('<p>&nbsp;</p>')).toBe(0);
      expect(countChars('<p>a&amp;b</p>')).toBe(3);
    });
    test('\u7A7A\u767D\u30FB\u5168\u89D2\u7A7A\u767D\u306F\u30DE\u30B9\u3068\u3057\u3066\u6570\u3048\u308B\uFF08\u6539\u884C\u30FB\u30BF\u30D6\u306F\u9664\u5916\uFF09', () => {
      expect(countChars('<p>\u3042 \u3044\u3000\u3046</p>')).toBe(5);
      expect(countChars('<p>\u3042</p>\n<p>\u3044</p>')).toBe(2);
    });
  });
}
