#!/usr/bin/env node

/**
 * 原稿のtxtファイルをRTF（リッチテキスト）に変換するスクリプト
 *
 * txt自体は書式情報を持たないプレーンテキストなので、txt→RTFの変換で失われるものはない
 * （ロスが起きるのは逆方向のRTF→txt）。ただしこのリポジトリのtxtは独自記法で
 * ルビ・傍点などを表現しているため、それらをRTFの実書式に変換する。
 *
 * 使い方:
 *   novel rtf -o output.rtf file1.txt file2.txt ...
 *   novel rtf -o output.rtf ./src/od/story/
 *
 * オプション:
 *   -o, --output <file>   出力ファイル名（必須）
 *   --title <title>       冒頭に書名を出力
 *   --author <author>     冒頭に著者名を出力
 *   --ja                  日本語原稿フォーマット（ＭＳ明朝10.5pt・シングルスペース）で出力する。
 *                         指定しない場合は英語投稿用の標準原稿フォーマット（Shunn形式）:
 *                         Times New Roman 12pt・ダブルスペース・1インチマージン・
 *                         1ページ目に連絡先と語数・2ページ目以降に柱（姓/題/頁）・
 *                         場面区切りは # 1つ・末尾にEND
 *   --shunn               Shunn形式を明示指定（デフォルトなので通常は不要）
 *   --contact "a;b;c"     Shunn形式の1ページ目左上に出す連絡先（セミコロン区切りで複数行。
 *                         省略時は--authorの名前のみ）
 *   --ruby-parens         ルビをEQフィールドでなく「親文字（ルビ）」の括弧表記にする
 *                         （Word以外のRTF対応ソフトはEQフィールドを描画できないため）
 *   --no-chapter-break    章見出し（【】行）の前で改ページしない
 *   --open                生成後に開く
 *   --scene-break <記号>  場面区切りの記号（既定: Shunn形式は #、--jaは ◇◇◇）
 *
 * 原稿の記法:
 *   Memo: ...        出力しない
 *   【title】        章見出し。Shunn形式では改ページ後に中央寄せの「Chapter <数詞>」
 *                    ＋章題の章扉、--jaでは太字見出し＋改ページ
 *   Lead: ...        右寄せで出力（直後の Source: 行が出典）
 *   Subhead: ...     Shunn形式では章扉の章題の下に中央寄せ、--jaでは【】の見出しの後ろに全角空白で続けて出力
 *   |親《るび》      ルビ（WordのEQフィールド。--ruby-parensで括弧表記）
 *   《《text》》     傍点（\accdot）
 *   *text*           イタリック（英語原稿用）
 *   <<text>>         縦書き用の横倒し指定。RTFは横書きなので中身のみ出力
 *   * / * * *        場面区切り。Shunn形式では #、--jaでは ◇◇◇（中央寄せ。どちらも --scene-break で変えられる）
 *   ◇◇◇ など         記号だけの行。--jaでは書いた記号のまま中央寄せ（Shunn形式では # の場面区切り）
 */

import { statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { BOLD_CLOSE, BOLD_OPEN, parseAozoraLine } from './lib/aozora.mjs';
import { ARG, openFile, parseCliArgs, requireOutput, runMain } from './lib/cli.mjs';
import { chapterNumberWord } from './lib/english.mjs';
import { requireInputFiles } from './lib/manuscript.mjs';
import {
  countTextChars,
  epigraphDisplayLines,
  getBodyLines,
  isEpigraphLine,
  isSeparator,
  isSubheadLine,
  isViewpointLine,
  parseEpigraphLine,
  parseSubheadLine,
  parseViewpointLine,
  readLines,
  SCENE_BREAK_MARK,
  separatorMark,
  stripInlineMarkup,
  tokenizeInlineMarkup,
  trimBlankEdges,
} from './lib/text-parser.mjs';

/** Shunn 形式の場面区切りの既定の記号 */
const SHUNN_SCENE_BREAK = '#';

/** --ja の本文の文字サイズ（RTF の \fs は半ポイント単位。21 = 10.5pt） */
const BODY_FS = 21;
/** ルビの文字サイズ（EQ フィールドの hps。半ポイント単位） */
const RUBY_HPS = 10;
/** ルビを上げる量（EQ フィールドの up。半ポイント単位） */
const RUBY_UP = 10;

export function parseArgs(argv) {
  return parseCliArgs(
    argv,
    [
      ARG.output,
      ARG.title,
      ARG.author,
      { key: 'shunn', flags: ['--shunn'] },
      { key: 'shunn', flags: ['--ja'], value: false },
      {
        key: 'contact',
        flags: ['--contact'],
        takesValue: true,
        parse: (v) =>
          v
            .split(';')
            .map((s) => s.trim())
            .filter(Boolean),
      },
      { key: 'rubyParens', flags: ['--ruby-parens'] },
      { key: 'chapterBreak', flags: ['--no-chapter-break'], value: false },
      ARG.open,
      ARG.sceneBreak,
    ],
    { shunn: true, chapterBreak: true },
  );
}

/** RTF特殊文字をエスケープし、非ASCII文字を \uN 表記にする（プロローグの \uc1 に合わせ、フォールバックは ? 1文字） */
export function rtfEscapeText(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = text.charCodeAt(i);
    if (ch === '\\' || ch === '{' || ch === '}') {
      out += `\\${ch}`;
    } else if (code < 0x80) {
      out += ch;
    } else {
      // \uN は符号付き16bit。サロゲートペアは2つの \uN として出力する（Wordが解釈する）
      out += `\\u${code > 0x7fff ? code - 0x10000 : code}?`;
    }
  }
  return out;
}

/** WordのEQフィールドによるルビ。フィールド非対応ソフトでは fldrslt の親文字が表示される */
export function rubyField(base, ruby) {
  const b = rtfEscapeText(base);
  const r = rtfEscapeText(ruby);
  return `{\\field{\\*\\fldinst EQ \\\\* jc2 \\\\* "Font:MS Mincho" \\\\* hps${RUBY_HPS} \\\\o\\\\ad(\\\\s\\\\up ${RUBY_UP}(${r}),${b})}{\\fldrslt ${b}}}`;
}

export function formatInlineRtf(text, { rubyParens = false } = {}) {
  return tokenizeInlineMarkup(text)
    .map((token) => {
      switch (token.type) {
        case 'emphasis':
          return `{\\accdot ${rtfEscapeText(token.text)}}`;
        case 'ruby':
          return rubyParens ? rtfEscapeText(`${token.base}（${token.ruby}）`) : rubyField(token.base, token.ruby);
        case 'italic':
          return `{\\i ${rtfEscapeText(token.text)}}`;
        case 'bold':
          return `{\\b ${rtfEscapeText(token.text)}}`;
        // 横倒し <<text>> はRTFが横書きなので中身のみ
        default:
          return rtfEscapeText(token.text);
      }
    })
    .join('');
}

/** ファイル列を解析し、RTFの段落列と文字数・語数を返す */
export function buildParagraphs(inputFiles, opts) {
  const paragraphs = [];
  let totalChars = 0;
  let totalWords = 0;
  const body = opts.shunn ? '\\pard\\fi720\\sl480\\slmult1 ' : '\\pard ';
  const center = opts.shunn ? '\\pard\\qc\\sl480\\slmult1 ' : '\\pard\\qc ';
  let pendingBreak = false;
  let chapterNumber = 0;

  for (const file of inputFiles) {
    const sourceLines = readLines(file);
    const { lines } = getBodyLines(sourceLines, { keepEpigraphs: true, subheadsInViewpoint: !opts.shunn });
    const subheads = sourceLines.filter(isSubheadLine).map(parseSubheadLine).filter(Boolean);
    trimBlankEdges(lines);

    for (const rawLine of lines) {
      const aozora = parseAozoraLine(rawLine);
      if (aozora.kind === 'pageBreak') {
        if (paragraphs.length > 0) paragraphs.push('\\pard\\page\\par');
        pendingBreak = false;
        continue;
      }
      if (aozora.kind !== 'text') continue;
      const line = aozora.heading ? `${BOLD_OPEN}${aozora.text}${BOLD_CLOSE}` : aozora.text;

      if (line.trim() === '') {
        if (opts.shunn) pendingBreak = true;
        else paragraphs.push('\\pard\\par');
        continue;
      }

      if (isSeparator(line)) {
        if (opts.shunn) pendingBreak = true;
        else
          paragraphs.push(`\\pard\\qc ${rtfEscapeText(separatorMark(line, opts.sceneBreak ?? SCENE_BREAK_MARK))}\\par`);
        continue;
      }

      if (isViewpointLine(line) && opts.shunn) {
        pendingBreak = false;
        chapterNumber++;
        const { title, rest } = parseViewpointLine(line);
        if (opts.chapterBreak && paragraphs.length > 0) {
          paragraphs.push('\\pard\\sl480\\slmult1\\page\\par');
          for (let i = 0; i < 3; i++) paragraphs.push('\\pard\\sl480\\slmult1\\par');
        }
        paragraphs.push(`${center}Chapter ${chapterNumberWord(chapterNumber)}\\par`);
        if (title) paragraphs.push(`${center}${formatInlineRtf(title, opts)}\\par`);
        for (const subhead of subheads) paragraphs.push(`${center}${formatInlineRtf(subhead, opts)}\\par`);
        paragraphs.push('\\pard\\sl480\\slmult1\\par');
        if (rest) {
          totalWords += stripInlineMarkup(rest).split(/\s+/).filter(Boolean).length;
          paragraphs.push(`${body}${formatInlineRtf(rest, opts)}\\par`);
        }
        continue;
      }

      if (pendingBreak) {
        if (paragraphs.length > 0)
          paragraphs.push(`${center}${rtfEscapeText(opts.sceneBreak ?? SHUNN_SCENE_BREAK)}\\par`);
        pendingBreak = false;
      }

      if (isEpigraphLine(line)) {
        const { quote, source } = parseEpigraphLine(line);
        for (const text of epigraphDisplayLines(quote, source)) {
          paragraphs.push(`\\pard\\qr ${formatInlineRtf(text, opts)}\\par`);
        }
        continue;
      }

      if (isViewpointLine(line)) {
        const breakCw = opts.chapterBreak && paragraphs.length > 0 ? '\\page' : '';
        paragraphs.push(`\\pard${breakCw}\\b ${formatInlineRtf(line, opts)}\\b0\\par`);
        continue;
      }

      const plain = stripInlineMarkup(line);
      totalChars += countTextChars(plain);
      totalWords += plain.split(/\s+/).filter(Boolean).length;
      paragraphs.push(`${body}${formatInlineRtf(line, opts)}\\par`);
    }
  }

  if (opts.shunn) paragraphs.push(`${center}END\\par`);

  return { paragraphs, totalChars, totalWords };
}

export function buildRtf(
  paragraphs,
  { title = null, author = null, shunn = false, contact = null, totalWords = 0 } = {},
) {
  if (shunn) return buildShunnRtf(paragraphs, { title, author, contact, totalWords });

  const head = [];
  if (title) head.push(`\\pard\\qc\\fs32\\b ${rtfEscapeText(title)}\\b0\\fs${BODY_FS}\\par`);
  if (author) head.push(`\\pard\\qc ${rtfEscapeText(author)}\\par`);
  if (head.length > 0) head.push('\\pard\\par');

  return [
    '{\\rtf1\\ansi\\ansicpg932\\uc1\\deff0\\deflang1033\\deflangfe1041',
    `{\\fonttbl{\\f0\\froman\\fcharset128 ${rtfEscapeText('ＭＳ 明朝')}{\\*\\falt MS Mincho};}}`,
    `\\f0\\fs${BODY_FS}`,
    ...head,
    ...paragraphs,
    '}',
  ].join('\n');
}

/**
 * Shunn標準原稿フォーマット（https://www.shunn.net/format/story/）のRTFを組み立てる。
 * US Letter・1インチマージン・Times New Roman 12pt・ダブルスペース。
 * 1ページ目: 左上に連絡先、右上に語数、1/3ほど下に題名と by 著者名。
 * 2ページ目以降: 右上に「姓 / 題 / ページ番号」の柱。
 */
function buildShunnRtf(paragraphs, { title, author, contact, totalWords }) {
  const surname = author ? author.trim().split(/\s+/).pop() : '';
  const wordCount = `${totalWords.toLocaleString('en-US')} words`;
  const contactLines = contact ?? (author ? [author] : []);

  const head = [];
  // 右タブ位置は本文幅 6.5in = 9360twip
  const firstContact = contactLines[0] ? rtfEscapeText(contactLines[0]) : '';
  head.push(`\\pard\\tqr\\tx9360 ${firstContact}\\tab ${wordCount}\\par`);
  for (const line of contactLines.slice(1)) {
    head.push(`\\pard ${rtfEscapeText(line)}\\par`);
  }
  // Shunn 形式は題名をページの1/3あたりに置くため
  for (let i = 0; i < 5; i++) head.push('\\pard\\sl480\\slmult1\\par');
  if (title) head.push(`\\pard\\qc\\sl480\\slmult1 ${rtfEscapeText(title)}\\par`);
  if (author) head.push(`\\pard\\qc\\sl480\\slmult1 by ${rtfEscapeText(author)}\\par`);
  head.push('\\pard\\sl480\\slmult1\\par');

  // Shunn 形式は1ページ目に柱を出さないので、\titlepg で1ページ目を分け \headerf は定義しない
  const headerText = [surname, title]
    .filter(Boolean)
    .map((s) => rtfEscapeText(s))
    .join(' / ');
  const header = `{\\header\\pard\\qr ${headerText ? `${headerText} / ` : ''}{\\field{\\*\\fldinst PAGE}{\\fldrslt 2}}\\par}`;

  return [
    '{\\rtf1\\ansi\\ansicpg1252\\uc1\\deff0\\deflang1033',
    '{\\fonttbl{\\f0\\froman\\fcharset0 Times New Roman;}}',
    '\\paperw12240\\paperh15840\\margl1440\\margr1440\\margt1440\\margb1440',
    '\\sectd\\titlepg\\pgnstarts1',
    header,
    '\\f0\\fs24',
    ...head,
    ...paragraphs,
    '}',
  ].join('\n');
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  requireOutput(args, 'output.rtf');
  const inputFiles = requireInputFiles(args.files);

  for (const f of inputFiles) console.log(`処理中: ${basename(f)}`);

  const { paragraphs, totalChars, totalWords } = buildParagraphs(inputFiles, args);
  writeFileSync(args.output, buildRtf(paragraphs, { ...args, totalWords }));

  const fileSize = statSync(args.output).size;
  console.log(`\nRTF出力: ${args.output}`);
  if (args.shunn) console.log(`語数: ${totalWords.toLocaleString()} words (${(fileSize / 1024).toFixed(0)}KB)`);
  else console.log(`文字数: ${totalChars.toLocaleString()}字 (${(fileSize / 1024).toFixed(0)}KB)`);

  if (args.open) openFile(args.output);
}

runMain(import.meta.url, main);

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest;
  const { writeFileSync: wf, unlinkSync: ul } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');

  describe('rtfEscapeText', () => {
    test('ASCIIはそのまま、RTF特殊文字はエスケープ', () => {
      expect(rtfEscapeText('abc')).toBe('abc');
      expect(rtfEscapeText('a{b}c\\d')).toBe('a\\{b\\}c\\\\d');
    });
    test('非ASCII文字は \\uN 表記（U+8000以上は負数）', () => {
      expect(rtfEscapeText('漢')).toBe('\\u28450?'); // U+6F22
      expect(rtfEscapeText('鬼')).toBe('\\u-25796?'); // U+9B3C = 39740 → 39740-65536
    });
    test('サロゲートペアは2つの \\uN として出力', () => {
      expect(rtfEscapeText('𠮟')).toBe('\\u-10174?\\u-8289?'); // U+20B9F
    });
  });

  describe('formatInlineRtf', () => {
    test('傍点 《《text》》 を \\accdot に変換', () => {
      expect(formatInlineRtf('《《強調》》')).toBe('{\\accdot \\u24375?\\u-30017?}');
    });
    test('ルビはEQフィールドに変換され、fldrsltに親文字が残る', () => {
      const rtf = formatInlineRtf('|漢字《かんじ》');
      expect(rtf).toContain('\\fldinst EQ');
      expect(rtf).toContain(`{\\fldrslt ${rtfEscapeText('漢字')}}`);
    });
    test('rubyParens指定でルビを括弧表記にする', () => {
      expect(formatInlineRtf('|漢字《かんじ》', { rubyParens: true })).toBe(rtfEscapeText('漢字（かんじ）'));
    });
    test('横倒し <<text>> は中身のみ出力', () => {
      expect(formatInlineRtf('<<ABC>>')).toBe('ABC');
    });
    test('*text* をイタリックに変換', () => {
      expect(formatInlineRtf('*May I stay?*')).toBe('{\\i May I stay?}');
      expect(formatInlineRtf('a *b* c')).toBe('a {\\i b} c');
    });
    test('記法がなければエスケープのみ', () => {
      expect(formatInlineRtf('plain text')).toBe('plain text');
    });
  });

  describe('buildParagraphs', () => {
    const opts = { rubyParens: false, chapterBreak: true };

    test('章見出し・本文・区切り・空行を変換し、* の場面区切りは ◇◇◇ にする', () => {
      const tmp = join(tmpdir(), `rtf-${process.pid}-a.txt`);
      wf(tmp, 'Memo: 無視される\n【一章】\n本文。\n\n* * *\n続き。\n');
      try {
        const { paragraphs, totalChars } = buildParagraphs([tmp], opts);
        expect(paragraphs[0]).toContain('\\b ');
        expect(paragraphs[0]).not.toContain('\\page'); // 先頭章は改ページしない
        expect(paragraphs[2]).toBe('\\pard\\par');
        expect(paragraphs[3]).toBe(`\\pard\\qc ${rtfEscapeText('◇◇◇')}\\par`);
        expect(paragraphs).toHaveLength(5); // Memoは出力されない
        expect(totalChars).toBe(6); // 「本文。」+「続き。」
      } finally {
        ul(tmp);
      }
    });

    test('2章目以降は \\page で改ページする', () => {
      const a = join(tmpdir(), `rtf-${process.pid}-b.txt`);
      const b = join(tmpdir(), `rtf-${process.pid}-c.txt`);
      wf(a, '【一章】\n本文A。\n');
      wf(b, '【二章】\n本文B。\n');
      try {
        const { paragraphs } = buildParagraphs([a, b], opts);
        const chapter2 = paragraphs.find((p) => p.includes('\\page'));
        expect(chapter2).toBeDefined();
        expect(chapter2).toContain(rtfEscapeText('【二章】'));
      } finally {
        ul(a);
        ul(b);
      }
    });

    test('--no-chapter-break では改ページしない', () => {
      const a = join(tmpdir(), `rtf-${process.pid}-d.txt`);
      wf(a, '【一章】\n本文。\n【二章】\n続き。\n');
      try {
        const { paragraphs } = buildParagraphs([a], { ...opts, chapterBreak: false });
        expect(paragraphs.every((p) => !p.includes('\\page'))).toBe(true);
      } finally {
        ul(a);
      }
    });

    test('Epigraphは右寄せで引用と出典に分かれる', () => {
      const tmp = join(tmpdir(), `rtf-${process.pid}-e.txt`);
      wf(tmp, 'Lead: 我思う\nSource: デカルト\n【】\n本文。\n');
      try {
        const { paragraphs } = buildParagraphs([tmp], opts);
        const qr = paragraphs.filter((p) => p.includes('\\qr'));
        expect(qr).toHaveLength(2);
        expect(qr[1]).toContain(rtfEscapeText('——デカルト'));
      } finally {
        ul(tmp);
      }
    });
  });

  describe('buildParagraphs (shunn)', () => {
    const opts = { shunn: true, rubyParens: false, chapterBreak: true };

    test('空行と区切り記号の連続は # 1つにまとまり、末尾にENDが付く', () => {
      const tmp = join(tmpdir(), `rtf-${process.pid}-s.txt`);
      wf(tmp, 'First para.\n\n***\n\nSecond para.\n');
      try {
        const { paragraphs, totalWords } = buildParagraphs([tmp], opts);
        expect(paragraphs.filter((p) => p.endsWith(' #\\par'))).toHaveLength(1);
        expect(paragraphs[paragraphs.length - 1]).toContain('END');
        expect(totalWords).toBe(4);
      } finally {
        ul(tmp);
      }
    });

    test('章は Chapter <数詞> の章扉になり、【】や # は出力されない', () => {
      const a = join(tmpdir(), `rtf-${process.pid}-u.txt`);
      const b = join(tmpdir(), `rtf-${process.pid}-v.txt`);
      wf(a, '【Alpha】\nBody A.\n');
      wf(b, '【】\nBody B.\n');
      try {
        const { paragraphs } = buildParagraphs([a, b], opts);
        expect(paragraphs[0]).toContain('\\qc');
        expect(paragraphs[0]).toContain('Chapter One');
        expect(paragraphs[1]).toContain('Alpha');
        expect(paragraphs.some((p) => p.includes('\\page'))).toBe(true); // 2章目は改ページ
        expect(paragraphs.some((p) => p.includes('Chapter Two'))).toBe(true);
        expect(paragraphs.filter((p) => p.endsWith(' #\\par'))).toHaveLength(0);
        expect(paragraphs.join('')).not.toContain(rtfEscapeText('【'));
      } finally {
        ul(a);
        ul(b);
      }
    });

    test('Subhead: は章扉の章題の下に中央寄せで出し、本文には出さない', () => {
      const tmp = join(tmpdir(), `rtf-${process.pid}-sub.txt`);
      wf(tmp, 'Subhead: Nadia Solis\n【Alpha】\nBody.\n');
      try {
        const { paragraphs, totalWords } = buildParagraphs([tmp], opts);
        expect(paragraphs[1]).toContain('Alpha');
        expect(paragraphs[2]).toContain('\\qc');
        expect(paragraphs[2]).toContain('Nadia Solis');
        expect(paragraphs.filter((p) => p.includes('Subhead'))).toHaveLength(0);
        expect(totalWords).toBe(1);
      } finally {
        ul(tmp);
      }
    });

    test('本文はダブルスペース・0.5in字下げ、先頭の区切りは出力しない', () => {
      const tmp = join(tmpdir(), `rtf-${process.pid}-t.txt`);
      wf(tmp, 'Only para.\n');
      try {
        const { paragraphs } = buildParagraphs([tmp], opts);
        expect(paragraphs[0]).toContain('\\fi720\\sl480\\slmult1');
      } finally {
        ul(tmp);
      }
    });
  });

  describe('buildShunnRtf (via buildRtf)', () => {
    test('柱・語数・題名・byライン・Letterサイズを含む', () => {
      const rtf = buildRtf(['\\pard body\\par'], {
        shunn: true,
        title: 'My Story',
        author: 'Mawaru Sonoguchi',
        totalWords: 4_567,
      });
      expect(rtf).toContain('Times New Roman');
      expect(rtf).toContain('\\paperw12240');
      expect(rtf).toContain('4,567 words');
      expect(rtf).toContain('Sonoguchi / My Story / ');
      expect(rtf).toContain('\\fldinst PAGE');
      expect(rtf).toContain('by Mawaru Sonoguchi');
      expect(rtf).toContain('\\titlepg');
    });

    test('--contact の複数行が1ページ目に入る', () => {
      const rtf = buildRtf([], {
        shunn: true,
        title: 'T',
        author: 'A B',
        totalWords: 100,
        contact: ['A B', '1-2-3 Chiyoda', 'a@example.com'],
      });
      expect(rtf).toContain('1-2-3 Chiyoda');
      expect(rtf).toContain('a@example.com');
    });
  });

  describe('buildRtf', () => {
    test('プロローグと閉じ括弧で包み、title/authorを冒頭に出す', () => {
      const rtf = buildRtf(['\\pard body\\par'], { title: '書名', author: '著者' });
      expect(rtf.startsWith('{\\rtf1\\ansi\\ansicpg932')).toBe(true);
      expect(rtf.endsWith('}')).toBe(true);
      expect(rtf).toContain(rtfEscapeText('書名'));
      expect(rtf).toContain(rtfEscapeText('著者'));
      expect(rtf).toContain('\\falt MS Mincho');
    });
  });

  describe('parseArgs', () => {
    test('既定は Shunn 形式・章見出しで改ページ', () => {
      expect(parseArgs(['-o', 'out.rtf', 'a.txt'])).toEqual({
        files: ['a.txt'],
        output: 'out.rtf',
        title: null,
        author: null,
        shunn: true,
        contact: null,
        rubyParens: false,
        chapterBreak: true,
        open: false,
        sceneBreak: null,
      });
    });
    test('--ja で日本語原稿、--shunn で Shunn 形式に戻す', () => {
      expect(parseArgs(['--ja']).shunn).toBe(false);
      expect(parseArgs(['--ja', '--shunn']).shunn).toBe(true);
    });
    test('--contact はセミコロン区切りで複数行にする', () => {
      expect(parseArgs(['--contact', 'A B; 1-2-3 Chiyoda ;;a@example.com']).contact).toEqual([
        'A B',
        '1-2-3 Chiyoda',
        'a@example.com',
      ]);
    });
    test('--ruby-parens・--no-chapter-break・--open・--scene-break を読む', () => {
      expect(parseArgs(['--ruby-parens', '--no-chapter-break', '--open', '--scene-break=＊'])).toMatchObject({
        rubyParens: true,
        chapterBreak: false,
        open: true,
        sceneBreak: '＊',
      });
    });
  });

  describe('buildParagraphs（区切り記号と青空文庫の注記）', () => {
    const paragraphsOf = (content, opts) => {
      const tmp = join(tmpdir(), `rtf-${process.pid}-x.txt`);
      wf(tmp, content);
      try {
        return buildParagraphs([tmp], { rubyParens: false, chapterBreak: true, ...opts }).paragraphs;
      } finally {
        ul(tmp);
      }
    };

    test('--ja では記号だけの行を書いた記号のまま中央寄せにし、* は --scene-break の記号にする', () => {
      expect(paragraphsOf('一\n■■■\n二\n*\n三\n', { shunn: false, sceneBreak: '＊' })).toEqual([
        `\\pard ${rtfEscapeText('一')}\\par`,
        `\\pard\\qc ${rtfEscapeText('■■■')}\\par`,
        `\\pard ${rtfEscapeText('二')}\\par`,
        `\\pard\\qc ${rtfEscapeText('＊')}\\par`,
        `\\pard ${rtfEscapeText('三')}\\par`,
      ]);
    });
    test('Shunn 形式では記号だけの行も場面区切りになり、--scene-break の記号を使う', () => {
      const paragraphs = paragraphsOf('One.\n■■■\nTwo.\n', { shunn: true, sceneBreak: '~' });
      expect(paragraphs[1]).toBe('\\pard\\qc\\sl480\\slmult1 ~\\par');
    });
    test('Shunn 形式の場面区切りの既定は #', () => {
      const paragraphs = paragraphsOf('One.\n*\nTwo.\n', { shunn: true });
      expect(paragraphs[1]).toBe('\\pard\\qc\\sl480\\slmult1 #\\par');
    });
    test('青空文庫の改ページは改ページにし、字下げの範囲の注記行は出さず、行頭の注記は外す', () => {
      expect(
        paragraphsOf('一\n［＃改ページ］\n［＃ここから２字下げ］\n［＃３字下げ］二\n［＃ここで字下げ終わり］\n', {
          shunn: false,
        }),
      ).toEqual([`\\pard ${rtfEscapeText('一')}\\par`, '\\pard\\page\\par', `\\pard ${rtfEscapeText('二')}\\par`]);
    });
  });

  describe('buildRtf の1ページ目', () => {
    test('Shunn 形式で --contact がなければ連絡先は著者名だけで、語数と同じ行に出す', () => {
      const rtf = buildRtf([], { shunn: true, title: 'T', author: 'A B', totalWords: 100 });
      expect(rtf).toContain('\\pard\\tqr\\tx9360 A B\\tab 100 words\\par');
    });
    test('--ja はＭＳ明朝10.5pt', () => {
      const rtf = buildRtf([], {});
      expect(rtf).toContain(rtfEscapeText('ＭＳ 明朝'));
      expect(rtf).toContain('\\f0\\fs21');
    });
  });
}
