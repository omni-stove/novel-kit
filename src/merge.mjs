#!/usr/bin/env node

/**
 * 複数txtファイルを1つのテキストファイルにマージするスクリプト
 *
 * Usage: novel merge <story-dir> [output-file] [title] [genre] [--target=...] [--splits=060,085,...] [--ruby-parens]
 *   story-dir:   txtファイルが入ったディレクトリ (例: src/enoch/story)
 *   output-file: 出力先ファイルパス (デフォルト: <story-dir>/merged.txt)
 *   title:       作品タイトル（出力の先頭に挿入）
 *   genre:       ジャンル（出力の先頭に挿入）
 *   --target:    想定読者・ペルソナ（任意。指定時のみ出力の先頭に挿入）。
 *                `--persona` でも同じ意味で受け付ける。
 *   --splits:    部の境界となるファイル名プレフィックス（novel split の --splits と同形式）。
 *                該当ファイルから新しい部が始まり、視点行の連番は「部-節」形式
 *                （1-1, 1-2, 2-1, ...）でリセットされる。部境界では ◇◇◇ は挿入しない。
 *                `--part 060,085,...` でも同じ意味で受け付ける。
 *   --ruby-parens: ルビ |漢字《かんじ》 を 漢字（かんじ） の括弧表記にし、傍点などの記法は外して中身だけ残す
 *                （GA文庫大賞など、ルビを全角括弧で書く指定の応募先向け）。
 *   --scene-break: 場面区切り（* の行）とファイルの継ぎ目に書く記号（既定: ◇◇◇）
 */

import { writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ARG, fail, parseCliArgs, parseList, runMain } from './lib/cli.mjs';
import {
  fileSeparatorLines,
  getTextFilesFromDir,
  moveEpigraphsAfterHeading,
  resolvePartIndices,
  SYNOPSIS_FILENAME,
  startsNewChapter,
} from './lib/manuscript.mjs';
import {
  applyViewpointLabel,
  countTextChars,
  getFilteredLines,
  isEpigraphLine,
  isSeparator,
  isViewpointLine,
  SCENE_BREAK_MARK,
  separatorMark,
  stripInlineMarkup,
  trimBlankEdges,
} from './lib/text-parser.mjs';

export function parseArgs(argv) {
  return parseCliArgs(
    argv,
    [
      { key: 'splits', flags: ['--splits', '--part', '--parts'], takesValue: true, parse: parseList },
      { key: 'target', flags: ['--target', '--persona'], takesValue: true },
      { key: 'rubyParens', flags: ['--ruby-parens'] },
      ARG.sceneBreak,
    ],
    { sceneBreak: SCENE_BREAK_MARK },
  );
}

export function mergeLines(filePaths, partFirstIndices = null, { sceneBreak = SCENE_BREAK_MARK } = {}) {
  const partBoundarySet = partFirstIndices ? new Set(partFirstIndices) : null;
  const allLines = [];
  let partNumber = 1;
  let sectionNumber = 1;
  const files = filePaths.map((f) => getFilteredLines(f, { keepEpigraphs: true, aozora: false }));

  files.forEach(({ lines }, i) => {
    const startsPart = partBoundarySet?.has(i);
    if (startsPart) {
      partNumber++;
      sectionNumber = 1;
    }
    // ファイル末尾の空行の数が継ぎ目の空きに持ち込まれないよう、ファイルごとに詰めてから1行だけ空ける
    if (i > 0) allLines.push(...(startsPart || startsNewChapter(files, i) ? [''] : fileSeparatorLines(sceneBreak)));

    for (const line of moveEpigraphsAfterHeading(trimBlankEdges(lines), { blankAfter: true })) {
      if (isEpigraphLine(line)) {
        // 出力は最終成果物なので Epigraph: プレフィックスは外す
        allLines.push(line.replace(/^Epigraph:\s*/, ''));
      } else if (isViewpointLine(line)) {
        const label = partBoundarySet ? `${partNumber}-${sectionNumber}` : sectionNumber;
        allLines.push(applyViewpointLabel(line, label));
        sectionNumber++;
      } else if (isSeparator(line)) {
        allLines.push(separatorMark(line, sceneBreak));
      } else {
        allLines.push(line);
      }
    }
  });

  return trimBlankEdges(allLines);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  const storyDir = args.files[0];
  if (!storyDir) {
    fail(
      'Usage: novel merge <story-dir> [output-file] [title] [genre] [--target=...] [--splits=060,085,...] [--ruby-parens]',
    );
  }

  const outputFile = args.files[1] || join(storyDir, 'merged.txt');
  const title = args.files[2] || null;
  const genre = args.files[3] || null;
  const target = args.target;

  // 出力先がstory-dir内（デフォルト）の場合に再実行で自分自身を取り込まないよう除外する
  const filePaths = getTextFilesFromDir(storyDir, [SYNOPSIS_FILENAME, basename(outputFile)]);

  let partFirstIndices = null;
  if (args.splits) {
    partFirstIndices = resolvePartIndices(args.splits, filePaths).filter((i) => i > 0);
    const allParts = [0, ...partFirstIndices];
    console.log(`部の境界: ${allParts.map((p, i) => `第${i + 1}部=${basename(filePaths[p])}`).join(', ')}`);
  }

  const headerLines = [];
  if (title) headerLines.push(`タイトル: ${title}`);
  if (genre) headerLines.push(`ジャンル: ${genre}`);
  if (target) headerLines.push(`ターゲット: ${target}`);
  if (headerLines.length > 0) headerLines.push('');
  const bodyLines = mergeLines(filePaths, partFirstIndices, { sceneBreak: args.sceneBreak });
  const allLines = [
    ...headerLines,
    ...(args.rubyParens ? bodyLines.map((line) => stripInlineMarkup(line, { rubyParens: true })) : bodyLines),
  ];

  writeFileSync(outputFile, `${allLines.join('\n')}\n`, 'utf-8');
  console.log(`${outputFile} に出力しました (${countTextChars(allLines.join(''))}字)`);
}

runMain(import.meta.url, main);

if (import.meta.vitest) {
  const { describe, test, expect, vi } = import.meta.vitest;
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');

  const merge = (contents, partFirstIndices = null) => {
    const dir = mkdtempSync(join(tmpdir(), 'merge-txt-'));
    try {
      const paths = contents.map((content, i) => {
        const path = join(dir, `${String((i + 1) * 10).padStart(3, '0')}.txt`);
        writeFileSync(path, content);
        return path;
      });
      return mergeLines(paths, partFirstIndices);
    } finally {
      rmSync(dir, { recursive: true });
    }
  };

  describe('mergeLines', () => {
    test('見出しに通し番号を振り、Memo 行は落とす', () => {
      expect(merge(['Memo: x\n【】\n本文一\n', '【夜】\n本文二\n'])).toEqual([
        '【1】',
        '本文一',
        '',
        '【2　夜】',
        '本文二',
      ]);
    });
    test('* の場面区切りは ◇◇◇ にし、ほかの記号の区切りは書いたまま', () => {
      expect(merge(['【】\n一\n\n* * *\n\n二\n■■■\n三\n'])).toEqual(['【1】', '一', '', '◇◇◇', '', '二', '■■■', '三']);
    });
    test('章の途中で切れたファイルの継ぎ目には空行・◇◇◇・空行を挟む', () => {
      expect(merge(['【】\n本文一\n', '続き\n'])).toEqual(['【1】', '本文一', '', '◇◇◇', '', '続き']);
    });
    test('ファイル末尾の空行がいくつあっても継ぎ目の空きは1行', () => {
      expect(merge(['【】\n本文一\n\n\n', '\n続き\n'])).toEqual(['【1】', '本文一', '', '◇◇◇', '', '続き']);
    });
    test('エピグラフはプレフィックスを外して見出しの直後に置き、本文との間を1行空ける', () => {
      expect(merge(['Epigraph: 引用——出典\n【】\n本文\n'])).toEqual(['【1】', '引用——出典', '', '本文']);
    });
    test('部境界を渡すと「部-節」で採番し直し、部の頭には◇◇◇を挟まない', () => {
      expect(merge(['【】\n一\n', '【】\n二\n', '三\n'], [2])).toEqual([
        '【1-1】',
        '一',
        '',
        '【1-2】',
        '二',
        '',
        '三',
      ]);
      expect(merge(['【】\n一\n', '【】\n二\n', '【】\n三\n'], [1])).toEqual([
        '【1-1】',
        '一',
        '',
        '【2-1】',
        '二',
        '',
        '【2-2】',
        '三',
      ]);
    });
  });

  test('青空文庫の注記は書いたまま出す', () => {
    expect(merge(['【】\n一\n［＃改ページ］\n［＃３字下げ］二\n'])).toEqual([
      '【1】',
      '一',
      '［＃改ページ］',
      '［＃３字下げ］二',
    ]);
  });

  describe('parseArgs', () => {
    test('位置引数と既定値', () => {
      expect(parseArgs(['story', 'out.txt', '題', 'SF'])).toEqual({
        files: ['story', 'out.txt', '題', 'SF'],
        splits: null,
        target: null,
        rubyParens: false,
        sceneBreak: '◇◇◇',
      });
    });
    test('--part・--parts は --splits と、--persona は --target と同じ', () => {
      expect(parseArgs(['--part', '060,085']).splits).toEqual(['060', '085']);
      expect(parseArgs(['--parts=060']).splits).toEqual(['060']);
      expect(parseArgs(['--splits=060,085', '--persona', '30代', '--ruby-parens', '--scene-break=＊'])).toMatchObject({
        splits: ['060', '085'],
        target: '30代',
        rubyParens: true,
        sceneBreak: '＊',
      });
    });
  });

  describe('main', () => {
    const run = (files, args = () => []) => {
      const dir = mkdtempSync(join(tmpdir(), 'merge-main-'));
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
        main([dir, ...args(dir)]);
        main([dir, ...args(dir)]);
        return readFileSync(join(dir, 'merged.txt'), 'utf-8');
      } finally {
        log.mockRestore();
        rmSync(dir, { recursive: true });
      }
    };

    test('既定では <story-dir>/merged.txt に書き、再実行しても自分自身やあらすじは取り込まない', () => {
      expect(run({ '010.txt': '【】\n一\n', 'synopsis.txt': 'あらすじ\n' })).toBe('【1】\n一\n');
    });
    test('タイトル・ジャンル・ターゲットを先頭に入れる', () => {
      expect(run({ '010.txt': '【】\n一\n' }, (dir) => [join(dir, 'merged.txt'), '題', 'SF', '--target=30代'])).toBe(
        'タイトル: 題\nジャンル: SF\nターゲット: 30代\n\n【1】\n一\n',
      );
    });
    test('--ruby-parens でルビを括弧表記にし、傍点の記法は外す', () => {
      expect(run({ '010.txt': '|漢字《かんじ》と《《傍点》》\n' }, () => ['--ruby-parens'])).toBe(
        '漢字（かんじ）と傍点\n',
      );
    });
    test('--splits の番号のファイルから部を分け、「部-節」で採番する', () => {
      expect(run({ '010.txt': '【】\n一\n', '020.txt': '【】\n二\n' }, () => ['--splits=020'])).toBe(
        '【1-1】\n一\n\n【2-1】\n二\n',
      );
    });
  });
}
