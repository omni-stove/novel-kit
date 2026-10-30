#!/usr/bin/env node

/**
 * RTF を原稿の txt にするスクリプト
 *
 * Scrivener・Google ドキュメント・Word・テキストエディットなどで書いた英語の原稿を取り込むためのもの。
 * 一度だけ txt にする取り込みで、以後は txt を原稿として書く。
 *
 * 使い方:
 *   novel import -o output.txt input.rtf
 *
 * オプション:
 *   -o, --output <file>   出力ファイル名（必須）
 *
 * 変換:
 *   斜体・下線            *text*（英語の原稿では下線は斜体の印なので、斜体にする）
 *   太字                  ［＃太字］text［＃太字終わり］
 *   Chapter One など      #。「Chapter One: Title」や、中央寄せの「Chapter One」の次の中央寄せの行の題は # Title
 *   見出しのスタイル      # text（アウトラインレベルを持つ段落）
 *   # 題・【題】の段落    章見出しにする（【】は novel rtf --ja の出力）
 *   # / * * * など        * * *。ほかの記号だけを中央寄せにした段落は *: 記号
 *   空の段落・改ページ    出さない（英語の原稿では空行も場面区切りになるため）
 *   Shunn 形式の表紙      語数の行から「by 著者名」の行までと、末尾の END は出さない
 *   ルビ・傍点・脚注・画像  出さず、落とした数を表示する（ルビは親文字だけ残す）
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { ARG, fail, parseCliArgs, requireOutput, runMain } from './lib/cli.mjs';
import {
  hashHeadingToViewpoint,
  isBreakLine,
  isMetaLine,
  isSeparator,
  isViewpointLine,
  parseViewpointLine,
} from './lib/text-parser.mjs';

/**
 * \fcharset の値から \'hh の文字コードへ。表に無い値と \fcharset の無いフォントは文書の \ansicpg に従う。
 * 0（ANSI）は \ansicpg ではなく西欧の cp1252 にする。日本語の macOS のテキストエディットは \ansicpg932 のまま、
 * \fcharset0 のフォントの ’ を cp1252 の \'92 で書くため
 */
const CHARSET_ENCODINGS = {
  0: 'windows-1252',
  77: 'macintosh',
  128: 'shift_jis',
  129: 'euc-kr',
  134: 'gbk',
  136: 'big5',
  161: 'windows-1253',
  162: 'windows-1254',
  163: 'windows-1258',
  177: 'windows-1255',
  178: 'windows-1256',
  186: 'windows-1257',
  204: 'windows-1251',
  238: 'windows-1250',
};

const CODEPAGE_ENCODINGS = { 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 10000: 'macintosh' };

function codepageEncoding(cpg) {
  if (CODEPAGE_ENCODINGS[cpg]) return CODEPAGE_ENCODINGS[cpg];
  if (cpg >= 1250 && cpg <= 1258) return `windows-${cpg}`;
  return 'windows-1252';
}

/** 本文に出さない destination。先頭の \* が無くても読み飛ばす */
const SKIPPED_DESTINATIONS = new Set([
  'colortbl',
  'stylesheet',
  'info',
  'header',
  'headerl',
  'headerr',
  'headerf',
  'footer',
  'footerl',
  'footerr',
  'footerf',
  'footnote',
  'pict',
  'object',
  'listtable',
  'listoverridetable',
  'revtbl',
  'filetbl',
  'pntext',
  'pntxta',
  'pntxtb',
  'nonshppict',
  'shp',
  'upr',
  'xe',
  'tc',
  'txe',
]);

const SPECIAL_CHARS = {
  emdash: '—',
  endash: '–',
  emspace: ' ',
  enspace: ' ',
  qmspace: ' ',
  bullet: '•',
  lquote: '‘',
  rquote: '’',
  ldblquote: '“',
  rdblquote: '”',
  tab: '\t',
  cell: ' ',
};

/**
 * RTF の文字列（バイト列を latin1 で読んだもの）を段落の列にする。
 * 段落は { runs: [{ text, italic, bold }], align: 'left' | 'center' | 'right', outline: number | null }。
 * dropped は本文に出さなかったルビ・傍点・脚注・画像の数。
 */
export function parseRtf(source) {
  const paragraphs = [];
  const dropped = { ruby: 0, emphasis: 0, footnote: 0, image: 0 };
  const fontCharsets = new Map();
  let ansiEncoding = 'windows-1252';
  let defaultFont = null;
  let para = { align: 'left', outline: null };
  let runs = [];
  let hexBytes = [];
  let skipFallback = 0;
  let group = { mode: 'text', italic: false, bold: false, underline: false, uc: 1, font: null, fresh: false };
  const stack = [];

  const append = (text) => {
    const italic = group.italic || group.underline;
    const last = runs.at(-1);
    if (last && last.italic === italic && last.bold === group.bold) last.text += text;
    else runs.push({ text, italic, bold: group.bold });
  };

  const emit = (text) => {
    if (group.mode === 'text') append(text);
    else if (group.mode === 'fldinst') group.capture.text += text;
  };

  const flushHex = () => {
    if (hexBytes.length === 0) return;
    const charset = fontCharsets.get(group.font ?? defaultFont);
    const encoding = CHARSET_ENCODINGS[charset] ?? ansiEncoding;
    emit(new TextDecoder(encoding).decode(Uint8Array.from(hexBytes)));
    hexBytes = [];
  };

  const pushByte = (byte) => {
    if (skipFallback > 0) {
      skipFallback--;
      return;
    }
    hexBytes.push(byte);
  };

  const endParagraph = () => {
    paragraphs.push({ runs, ...para });
    runs = [];
  };

  const enterDestination = (word) => {
    if (word === 'fldinst') {
      group.mode = 'fldinst';
      group.capture = { text: '' };
      group.captureOwner = true;
      return;
    }
    if (word === 'footnote') dropped.footnote++;
    if (word === 'pict' || word === 'shppict') dropped.image++;
    group.mode = word === 'fonttbl' ? 'fonttbl' : 'skip';
  };

  const controlWord = (word, param) => {
    const starred = group.starred;
    group.starred = false;
    if (group.fresh) {
      group.fresh = false;
      if (starred || word === 'fonttbl' || SKIPPED_DESTINATIONS.has(word)) {
        if (group.mode !== 'skip') enterDestination(word);
        return;
      }
    }
    if (group.mode === 'skip') return;
    if (group.mode === 'fonttbl') {
      if (word === 'f') group.font = param;
      else if (word === 'fcharset') fontCharsets.set(group.font, param);
      return;
    }

    switch (word) {
      case 'ansicpg':
        ansiEncoding = codepageEncoding(param);
        return;
      case 'mac':
        ansiEncoding = 'macintosh';
        return;
      case 'deff':
        defaultFont = param;
        return;
      case 'f':
        group.font = param;
        return;
      case 'uc':
        group.uc = param;
        return;
      case 'u':
        emit(String.fromCharCode(param < 0 ? param + 0x10000 : param));
        skipFallback = group.uc;
        return;
    }
    if (group.mode !== 'text') return;

    switch (word) {
      case 'par':
      case 'sect':
      case 'row':
        endParagraph();
        return;
      case 'line':
        // 行の中の改行も、txt では1行ずつ別の段落になる
        endParagraph();
        return;
      case 'pard':
        para = { align: 'left', outline: null };
        return;
      case 'qc':
        para.align = 'center';
        return;
      case 'qr':
        para.align = 'right';
        return;
      case 'ql':
      case 'qj':
        para.align = 'left';
        return;
      case 'outlinelevel':
        para.outline = param;
        return;
      case 'plain':
        group.italic = group.bold = group.underline = false;
        return;
      case 'i':
        group.italic = param !== 0;
        return;
      case 'b':
        group.bold = param !== 0;
        return;
      case 'ulnone':
        group.underline = false;
        return;
      case 'accnone':
        return;
    }
    if (word.startsWith('ul') && !word.startsWith('ulc')) group.underline = param !== 0;
    else if (word.startsWith('acc')) dropped.emphasis++;
    else if (word in SPECIAL_CHARS) append(SPECIAL_CHARS[word]);
  };

  const controlWordRe = /([a-zA-Z]{1,32})(-?\d{1,10})? ?/y;
  for (let i = 0; i < source.length; ) {
    const ch = source[i];
    if (ch === '\\' && source[i + 1] === "'") {
      pushByte(Number.parseInt(source.slice(i + 2, i + 4), 16));
      i += 4;
      continue;
    }
    // 書き出したソフトによっては \'hh を使わず生のバイトを置くので、\'hh と同じ文字コードで読む
    if (ch.charCodeAt(0) >= 0x80) {
      group.fresh = false;
      pushByte(ch.charCodeAt(0));
      i++;
      continue;
    }
    flushHex();
    if (ch === '{') {
      skipFallback = 0;
      stack.push(group);
      group = { ...group, fresh: true, starred: false, captureOwner: false };
      i++;
    } else if (ch === '}') {
      skipFallback = 0;
      if (group.captureOwner && /^\s*EQ\b/i.test(group.capture.text) && /\\o/i.test(group.capture.text)) {
        dropped.ruby++;
      }
      group = stack.pop() ?? group;
      i++;
    } else if (ch === '\\') {
      skipFallback = 0;
      controlWordRe.lastIndex = i + 1;
      const match = controlWordRe.exec(source);
      if (match) {
        const [all, word, param] = match;
        i += 1 + all.length;
        if (word === 'bin') {
          i += Number(param);
          continue;
        }
        controlWord(word, param === undefined ? null : Number(param));
        continue;
      }
      const symbol = source[i + 1];
      i += 2;
      if (symbol === '*') {
        group.starred = true;
        continue;
      }
      group.fresh = false;
      if (symbol === '\\' || symbol === '{' || symbol === '}') emit(symbol);
      else if (symbol === '~') emit(' ');
      else if (symbol === '_') emit('-');
      else if ((symbol === '\n' || symbol === '\r') && group.mode === 'text') endParagraph();
    } else if (ch === '\r' || ch === '\n') {
      i++;
    } else {
      group.fresh = false;
      i++;
      if (skipFallback > 0) skipFallback--;
      else emit(ch);
    }
  }
  flushHex();
  if (runs.length > 0) endParagraph();

  return { paragraphs, dropped };
}

const BOLD_OPEN = '［＃太字］';
const BOLD_CLOSE = '［＃太字終わり］';

/** 段落の書式つきの文字列を、原稿の記法にした文字列と記法を外した文字列にする */
function paragraphText(runs) {
  let text = '';
  let plain = '';
  for (const run of runs) {
    const content = run.text.replace(/\t/g, ' ');
    plain += content;
    // 記法の印を単語の内側に付けるため、端の空白は印の外に出す
    const [, lead, core, trail] = content.match(/^(\s*)(.*?)(\s*)$/s);
    let marked = core;
    if (core && run.italic) marked = `*${marked}*`;
    if (core && run.bold) marked = `${BOLD_OPEN}${marked}${BOLD_CLOSE}`;
    text += lead + marked + trail;
  }
  const trim = (s) => s.replace(/^[  ]+|[  ]+$/g, '');
  return { text: trim(text), plain: trim(plain) };
}

const CHAPTER_RE = /^chapter\s+[\p{L}\p{N}]+(?:\s*[:.\-–—]\s*(.*))?$/iu;
const SCENE_BREAK_RE = /^[#＃*＊~\s]+$/;
const SYMBOLS_ONLY_RE = /^[^\p{L}\p{N}]+$/u;

function isSymbolBreak({ plain, align }) {
  return SCENE_BREAK_RE.test(plain) || isSeparator(plain) || (align === 'center' && SYMBOLS_ONLY_RE.test(plain));
}

/**
 * Shunn 形式の表紙（連絡先・語数・題名・by 著者名）の最後の段落の位置。表紙でなければ -1。
 * 語数の行の後ろに中央寄せの「by 著者名」があるときだけ表紙とみなす。
 */
function shunnCoverEnd(paragraphs) {
  const words = paragraphs.slice(0, 10).findIndex((p) => /\d[\d,]*\s+words$/i.test(p.plain));
  if (words < 0) return -1;
  const byline = paragraphs
    .slice(words + 1, words + 11)
    .findIndex((p) => p.align === 'center' && /^by\s+\S/i.test(p.plain));
  return byline < 0 ? -1 : words + 1 + byline;
}

/**
 * parseRtf の段落を原稿の行にする。
 * stats は章見出しと場面区切りの数と、Shunn 形式の表紙を外したか。
 */
export function toManuscriptLines(rtfParagraphs) {
  let paragraphs = rtfParagraphs.map((p) => ({ ...p, ...paragraphText(p.runs) })).filter((p) => p.plain !== '');
  const coverEnd = shunnCoverEnd(paragraphs);
  if (coverEnd >= 0) paragraphs = paragraphs.slice(coverEnd + 1);
  const last = paragraphs.at(-1);
  if (last && last.align === 'center' && /^end$/i.test(last.plain)) paragraphs = paragraphs.slice(0, -1);

  const lines = [];
  const stats = { chapters: 0, sceneBreaks: 0, cover: coverEnd >= 0 };
  const lastIsSeparator = () => lines.length === 0 || lines.at(-1) === '' || isSeparator(lines.at(-1));

  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    const chapter = p.plain.match(CHAPTER_RE);
    // # だけの段落は Shunn 形式の場面区切りなので、題のある # だけを見出しにする
    const viewpoint = /^[#＃][ \t　]+\S/.test(p.plain) ? hashHeadingToViewpoint(p.plain) : p.plain;
    if (chapter || p.outline !== null || isViewpointLine(viewpoint)) {
      // 見出しは書式を外して、記法の入らない題にする
      let title = p.plain;
      let rest = '';
      if (chapter) {
        title = (chapter[1] ?? '').trim();
        const next = paragraphs[i + 1];
        // Shunn 形式の章扉は「Chapter One」の次の中央寄せの行に章題を置く
        if (!title && p.align === 'center' && next?.align === 'center' && !isSymbolBreak(next)) {
          if (!next.plain.match(CHAPTER_RE) && next.plain.length <= 100) {
            title = next.plain;
            i++;
          }
        }
      } else if (isViewpointLine(viewpoint)) ({ title, rest } = parseViewpointLine(viewpoint));
      // 後ろに本文が続く見出しは # では書けないので、【】のまま残す
      lines.push(rest ? viewpoint : title ? `# ${title}` : '#', '');
      stats.chapters++;
      continue;
    }

    if (isSymbolBreak(p)) {
      if (lastIsSeparator()) continue;
      lines.push(SCENE_BREAK_RE.test(p.plain) ? '* * *' : isSeparator(p.plain) ? p.plain : `*: ${p.plain}`);
      stats.sceneBreaks++;
      continue;
    }

    // 行頭の Memo: などは原稿の記法になってしまうため、全角空白を前に置いて本文にする
    lines.push(isMetaLine(p.text) || isBreakLine(p.text) ? `　${p.text}` : p.text);
  }

  while (lines.length > 0 && (lines.at(-1) === '' || isSeparator(lines.at(-1)))) {
    if (lines.at(-1) !== '') stats.sceneBreaks--;
    lines.pop();
  }
  return { lines, stats };
}

/** RTF の文字列を原稿の txt にする */
export function rtfToManuscript(source) {
  const { paragraphs, dropped } = parseRtf(source);
  const { lines, stats } = toManuscriptLines(paragraphs);
  return { text: lines.length > 0 ? `${lines.join('\n')}\n` : '', stats, dropped };
}

export function main(argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv, [ARG.output]);
  requireOutput(args, 'output.txt');
  if (args.files.length !== 1) fail('取り込む RTF を1つ指定してください (novel import -o output.txt input.rtf)');

  const source = readFileSync(args.files[0], 'latin1');
  if (!source.startsWith('{\\rtf')) fail(`RTF ではありません: ${args.files[0]}`);
  const { text, stats, dropped } = rtfToManuscript(source);
  writeFileSync(args.output, text);

  console.log(`txt出力: ${args.output}`);
  console.log(`章見出し: ${stats.chapters} / 場面区切り: ${stats.sceneBreaks}`);
  if (stats.cover) console.log('Shunn 形式の表紙を外した');
  const labels = { ruby: 'ルビ', emphasis: '傍点', footnote: '脚注', image: '画像' };
  const lost = Object.entries(dropped)
    .filter(([, n]) => n > 0)
    .map(([key, n]) => `${labels[key]} ${n}`);
  if (lost.length > 0) console.warn(`取り込めずに落とした書式: ${lost.join(' / ')}`);
}

runMain(import.meta.url, main);

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest;
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { buildParagraphs, buildRtf } = await import('./rtf.mjs');

  const withDir = (fn) => {
    const dir = mkdtempSync(join(tmpdir(), 'novel-import-test-'));
    try {
      return fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  /** txt を novel rtf で RTF にする */
  const rtfOf = (content, opts) =>
    withDir((dir) => {
      const file = join(dir, '010.txt');
      writeFileSync(file, content);
      const { paragraphs, totalWords } = buildParagraphs([file], { rubyParens: false, chapterBreak: true, ...opts });
      return buildRtf(paragraphs, { ...opts, totalWords });
    });

  const textOf = (rtf) => rtfToManuscript(rtf).text;

  describe('rtfToManuscript', () => {
    test('novel rtf の Shunn 形式から、表紙と END を外して元の原稿に戻す', () => {
      const original = [
        '# The Letter',
        '',
        'The lighthouse *stood* alone — for years.',
        '"Hello," he said.',
        '* * *',
        'Next morning.',
        '#',
        '',
        'Another chapter.',
        '',
      ].join('\n');
      const { text, stats } = rtfToManuscript(
        rtfOf(original, {
          shunn: true,
          title: 'The Sea',
          author: 'Saku Mori',
          contact: ['Saku Mori', 'a@example.com'],
        }),
      );
      expect(text).toBe(original);
      expect(stats).toEqual({ chapters: 2, sceneBreaks: 1, cover: true });
    });

    test('novel rtf --ja の見出しは章見出しに戻し、ルビは親文字だけ残して数える', () => {
      const { text, dropped } = rtfToManuscript(
        rtfOf('【一章】\n　|漢字《かんじ》の《《強調》》。\n', { shunn: false }),
      );
      expect(text).toBe('# 一章\n\n　漢字の強調。\n');
      expect(dropped).toMatchObject({ ruby: 1, emphasis: 1 });
    });

    test("Word の書き出し: cp1252 の \\'hh・特殊文字・斜体・下線・太字・見出しのスタイル", () => {
      const rtf = String.raw`{\rtf1\ansi\ansicpg1252\deff0{\fonttbl{\f0\froman\fcharset0 Times New Roman;}}
{\*\generator Microsoft Word;}{\info{\title Draft}}{\header\pard Mori / Draft / 2\par}
\pard\plain\s1\outlinelevel0\b The Arrival\par
\pard\plain \'93Wait,\'94 she said\emdash {\i too} {\ul late}.\par
\pard It\rquote s {\b\i over }now.\line Second line.\par
\pard\qc ***\par
\pard Tea{\super\chftn}{\footnote\pard\plain\chftn A note.}\par}`;
      expect(textOf(rtf)).toBe(
        [
          '# The Arrival',
          '',
          '“Wait,” she said—*too* *late*.',
          'It’s ［＃太字］*over*［＃太字終わり］ now.',
          'Second line.',
          '* * *',
          'Tea',
          '',
        ].join('\n'),
      );
      expect(rtfToManuscript(rtf).dropped.footnote).toBe(1);
    });

    test("テキストエディットの書き出し: フォントの文字コードで \\'hh を読み、\\uc の代わりの文字は飛ばす", () => {
      const rtf = String.raw`{\rtf1\ansi\ansicpg1252\cocoartf2761
{\fonttbl\f0\fnil\fcharset128 HiraginoMincho-W3;\f1\fswiss\fcharset0 Helvetica;}
\f0 \'82\'a0\uc2${'\\u'}12356 \'82\'a2\f1 \'e9\par}`;
      expect(textOf(rtf)).toBe('あいé\n');
    });

    test("\\fcharset0 のフォントの \\'hh は、\\ansicpg932 でも cp1252 で読む", () => {
      const rtf = String.raw`{\rtf1\ansi\ansicpg932{\fonttbl\f0\froman\fcharset0 Times-Roman;}\f0 Saku\'92s \'97 lamp\par}`;
      expect(textOf(rtf)).toBe('Saku’s — lamp\n');
    });

    test('「Chapter One: 題」は # 題、題のない Chapter は #、中央寄せの記号だけの段落は *: 記号', () => {
      const rtf = String.raw`{\rtf1\ansi
\pard Chapter One: The Start\par\pard Body.\par\pard\qc ~ ~\par\pard More.\par
\pard\qc ${'\\u'}10086?\par\pard Then.\par
\pard Chapter 2\par\pard Body two.\par}`;
      expect(textOf(rtf)).toBe(
        ['# The Start', '', 'Body.', '* * *', 'More.', '*: ❦', 'Then.', '#', '', 'Body two.', ''].join('\n'),
      );
    });

    test('# 題の段落は見出しにし、後ろに本文が続く【題】は【】のまま残す', () => {
      expect(
        textOf(
          String.raw`{\rtf1\ansi \pard # Dawn\par\pard Body.\par\pard ${'\\u'}12304?Dusk${'\\u'}12305?Dear Anna,\par}`,
        ),
      ).toBe('# Dawn\n\nBody.\n【Dusk】Dear Anna,\n');
    });

    test('空の段落は出さず、続く区切りと先頭・末尾の区切りは出さない', () => {
      const rtf = String.raw`{\rtf1\ansi \pard #\par\pard One.\par\pard\par\pard #\par\pard * * *\par\pard Two.\par\pard #\par}`;
      expect(textOf(rtf)).toBe('One.\n* * *\nTwo.\n');
    });

    test('行頭が原稿の記法になる本文は、全角空白を前に置く', () => {
      expect(textOf(String.raw`{\rtf1\ansi \pard Memo: buy milk.\par}`)).toBe('　Memo: buy milk.\n');
    });

    test('画像と EQ でないフィールドは、画像を数えてフィールドの表示の文字を残す', () => {
      const rtf = String.raw`{\rtf1\ansi \pard {\*\shppict{\pict\pngblip 89504e47}}{\nonshppict{\pict\wmetafile8 0100}}See {\field{\*\fldinst HYPERLINK "https://example.com"}{\fldrslt here}}.\par}`;
      const { text, dropped } = rtfToManuscript(rtf);
      expect(text).toBe('See here.\n');
      expect(dropped.image).toBe(1);
    });
  });
}
