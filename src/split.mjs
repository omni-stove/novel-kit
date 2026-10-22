#!/usr/bin/env node

/**
 * 章ごとにtxtファイルを出力するスクリプト
 *
 * Usage: novel split <story-dir> [output-dir] [title] [genre] [--target=...] [--splits=070,120,170]
 *   story-dir:  txtファイルが入ったディレクトリ (例: src/enoch/story)
 *   output-dir: 出力先ディレクトリ (デフォルト: <story-dir>/chapters)
 *   title:      作品タイトル（最初の章の先頭に挿入）
 *   genre:      ジャンル（最初の章の先頭に挿入）
 *   --target:   想定読者・ペルソナ（任意。指定時のみ最初の章の先頭に挿入）。
 *               `--persona` でも同じ意味で受け付ける。
 *   --splits:   ファイル名（数値プレフィックス）で章境界を指定。
 *               指定された場合は【】ではなくファイル単位でまとめて区切る。
 *               例: --splits=070,120,170 → 070から、120から、170からが新しい章
 *   --scene-break: 場面区切り（* の行）とファイルの継ぎ目に書く記号（既定: ＊）
 *   --scene-break-indent: 区切りの行の前に全角空白を字数分入れて下げる（既定: 下げない）
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ARG, fail, parseCliArgs, parseList, runMain } from './lib/cli.mjs';
import {
  CHARACTERS_FILENAME,
  fileSeparatorLines,
  getTextFilesFromDir,
  moveEpigraphsAfterHeading,
  SYNOPSIS_FILENAME,
  startsNewChapter,
} from './lib/manuscript.mjs';
import {
  applyViewpointLabel,
  countTextChars,
  getFilteredLines,
  indentSeparator,
  isEpigraphLine,
  isSeparator,
  isViewpointLine,
  SCENE_BREAK_MARK,
  separatorMark,
  trimBlankEdges,
  unfoldSources,
} from './lib/text-parser.mjs';

export function parseArgs(argv) {
  return parseCliArgs(
    argv,
    [
      { key: 'splits', flags: ['--splits'], takesValue: true, parse: parseList },
      { key: 'target', flags: ['--target', '--persona'], takesValue: true },
      ARG.sceneBreak,
      ARG.sceneBreakIndent,
    ],
    { sceneBreak: SCENE_BREAK_MARK },
  );
}

function fileNumOf(path) {
  const m = basename(path).match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

function groupIndexOf(path, markerNums) {
  if (!markerNums) return 0;
  const num = fileNumOf(path);
  if (num === null) return 0;
  let idx = 0;
  for (const m of markerNums) {
    if (num >= m) idx++;
    else break;
  }
  return idx;
}

function collectLines(filePaths, markerNums, sceneBreak, sceneBreakIndent) {
  const place = (mark) => indentSeparator(mark, sceneBreakIndent);
  const allLines = [];
  const files = filePaths.map((f) => getFilteredLines(f, { keepEpigraphs: true, aozora: false }));
  let prevGroup = -1;
  files.forEach(({ lines }, i) => {
    const src = basename(filePaths[i]);
    const group = groupIndexOf(filePaths[i], markerNums);
    const groupChanged = markerNums && i > 0 && group !== prevGroup;
    // ファイル末尾の空行の数が継ぎ目の空きに持ち込まれないよう、ファイルごとに詰めてから1行だけ空ける
    if (i > 0 && !groupChanged) {
      const gap = startsNewChapter(files, i) ? [''] : fileSeparatorLines(place(sceneBreak));
      allLines.push(...gap.map((text) => ({ text, source: null, group })));
    }
    for (const line of trimBlankEdges(lines)) {
      allLines.push({ text: isSeparator(line) ? place(separatorMark(line, sceneBreak)) : line, source: src, group });
    }
    prevGroup = group;
  });
  return allLines;
}

/** 見出し（と直後のエピグラフ）と本文の間に、--splits なしの章ファイルと同じく空行を1つ置く */
function blankAfterHeadings(lines) {
  const out = [];
  let inHeading = false;
  for (const line of lines) {
    if (isViewpointLine(line)) {
      out.push(line);
      inHeading = true;
      continue;
    }
    if (inHeading && isEpigraphLine(line)) {
      out.push(line);
      continue;
    }
    if (inHeading && line.trim() !== '') out.push('');
    out.push(line);
    inHeading = false;
  }
  return out;
}

function splitByGroups(allLines) {
  const groups = new Map();
  for (const item of allLines) {
    if (!groups.has(item.group)) groups.set(item.group, []);
    groups.get(item.group).push(item);
  }
  return [...groups.values()].map((items) => ({
    header: null,
    epigraphs: [],
    lines: blankAfterHeadings(moveEpigraphsAfterHeading(items.map((it) => it.text))),
    sources: new Set(items.filter((it) => it.source && it.text.trim() !== '').map((it) => it.source)),
  }));
}

function splitByViewpoints(allLines) {
  const chapters = [];
  let currentChapter = null;
  let pendingEpigraphs = [];

  for (const { text: line, source } of allLines) {
    if (isEpigraphLine(line)) {
      pendingEpigraphs.push(line);
      continue;
    }
    if (isViewpointLine(line)) {
      if (currentChapter) chapters.push(currentChapter);
      currentChapter = { header: line, epigraphs: pendingEpigraphs, lines: [], sources: new Set() };
      if (source) currentChapter.sources.add(source);
      pendingEpigraphs = [];
      continue;
    }
    if (currentChapter) {
      currentChapter.lines.push(line);
      if (source && line.trim() !== '') currentChapter.sources.add(source);
    } else {
      currentChapter = { header: null, epigraphs: pendingEpigraphs, lines: [line], sources: new Set() };
      if (source) currentChapter.sources.add(source);
      pendingEpigraphs = [];
    }
  }
  if (currentChapter) chapters.push(currentChapter);
  return chapters;
}

function numberViewpoints(chapters, byGroups) {
  if (byGroups) {
    chapters.forEach((ch, p) => {
      const partNumber = p + 1;
      let sectionNumber = 1;
      if (ch.header && isViewpointLine(ch.header)) {
        ch.header = applyViewpointLabel(ch.header, `${partNumber}-${sectionNumber}`);
        sectionNumber++;
      }
      for (let i = 0; i < ch.lines.length; i++) {
        if (isViewpointLine(ch.lines[i])) {
          ch.lines[i] = applyViewpointLabel(ch.lines[i], `${partNumber}-${sectionNumber}`);
          sectionNumber++;
        }
      }
    });
    return;
  }
  let sectionNumber = 1;
  for (const ch of chapters) {
    if (ch.header && isViewpointLine(ch.header)) {
      ch.header = applyViewpointLabel(ch.header, sectionNumber);
      sectionNumber++;
    }
  }
}

export function buildChapters(
  filePaths,
  markerNums = null,
  { sceneBreak = SCENE_BREAK_MARK, sceneBreakIndent = null } = {},
) {
  const allLines = collectLines(filePaths, markerNums, sceneBreak, sceneBreakIndent);
  const chapters = markerNums ? splitByGroups(allLines) : splitByViewpoints(allLines);

  const nonEmptyChapters = chapters.filter((ch) => ch.lines.some((l) => l.trim() !== ''));
  numberViewpoints(nonEmptyChapters, Boolean(markerNums));
  return nonEmptyChapters;
}

export function chapterFileLines(chapter, leadLines = []) {
  const headerLines = [...leadLines];
  if (chapter.header) headerLines.push(chapter.header);
  headerLines.push(...chapter.epigraphs);
  const bodyLines = trimBlankEdges(chapter.lines);
  return (headerLines.length > 0 ? [...headerLines, '', ...bodyLines] : bodyLines).flatMap(unfoldSources);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  const storyDir = args.files[0];
  if (!storyDir) {
    fail('Usage: novel split <story-dir> [output-dir] [title] [genre] [--target=...] [--splits=070,120,170]');
  }

  const outputDir = args.files[1] || join(storyDir, 'chapters');
  const title = args.files[2] || null;
  const genre = args.files[3] || null;
  const target = args.target;
  const markerNums = args.splits
    ? args.splits
        .map((s) => parseInt(s, 10))
        .filter((n) => !Number.isNaN(n))
        .sort((a, b) => a - b)
    : null;
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });

  const filePaths = getTextFilesFromDir(storyDir, [SYNOPSIS_FILENAME, CHARACTERS_FILENAME]);
  const nonEmptyChapters = buildChapters(filePaths, markerNums, {
    sceneBreak: args.sceneBreak,
    sceneBreakIndent: args.sceneBreakIndent,
  });

  for (let i = 0; i < nonEmptyChapters.length; i++) {
    const chapter = nonEmptyChapters[i];
    const fileName = `chapter-${String(i + 1).padStart(3, '0')}.txt`;

    const leadLines = [];
    if (i === 0 && genre) leadLines.push(genre);
    if (i === 0 && title) leadLines.push(title);
    if (i === 0 && target) leadLines.push(`ターゲット: ${target}`);
    const bodyLines = chapterFileLines(chapter, leadLines);

    writeFileSync(join(outputDir, fileName), `${bodyLines.join('\n')}\n`, 'utf-8');
    console.log(`${fileName} (${countTextChars(bodyLines.join(''))}字) ← ${[...chapter.sources].join(', ')}`);
  }

  console.log(`\n合計 ${nonEmptyChapters.length} 章を ${outputDir} に出力しました`);
}

runMain(import.meta.url, main);

if (import.meta.vitest) {
  const { describe, test, expect, vi } = import.meta.vitest;
  const { mkdtempSync, readdirSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');

  const split = (files, markerNums = null, opts = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'split-chapters-'));
    try {
      const paths = Object.entries(files).map(([name, content]) => {
        writeFileSync(join(dir, name), content);
        return join(dir, name);
      });
      return buildChapters(paths, markerNums, opts).map((ch) => ({
        lines: chapterFileLines(ch),
        sources: [...ch.sources],
      }));
    } finally {
      rmSync(dir, { recursive: true });
    }
  };

  describe('【】ごとに分ける（--splits なし）', () => {
    test('見出しごとに章を切り、通し番号を見出しに付ける', () => {
      expect(
        split({
          '010.txt': '【】\n本文一\n',
          '020.txt': '【夜】\n本文二\n',
        }),
      ).toEqual([
        { lines: ['【1】', '', '本文一'], sources: ['010.txt'] },
        { lines: ['【2　夜】', '', '本文二'], sources: ['020.txt'] },
      ]);
    });
    test('章の途中で切れたファイルは前の章に＊を挟んでつなぐ', () => {
      expect(split({ '010.txt': '【】\n本文一\n\n', '020.txt': '続き\n' })).toEqual([
        { lines: ['【1】', '', '本文一', '', '＊', '', '続き'], sources: ['010.txt', '020.txt'] },
      ]);
    });
    test('sceneBreakIndent があれば、区切りの行と継ぎ目の記号の前に全角空白を入れる', () => {
      expect(
        split({ '010.txt': '【】\n一\n*\n二\n', '020.txt': '続き\n' }, null, { sceneBreakIndent: 1 })[0].lines,
      ).toEqual(['【1】', '', '一', '　＊', '二', '', '　＊', '', '続き']);
    });
    test('エピグラフは出典の Source: 行とともに見出しの下にまとめる', () => {
      expect(split({ '010.txt': 'Lead: 引用\nSource: 出典\n【】\n本文\n' })[0].lines).toEqual([
        '【1】',
        'Lead: 引用',
        'Source: 出典',
        '',
        '本文',
      ]);
    });
    test('* の場面区切りは ＊ にする', () => {
      expect(split({ '010.txt': '【】\n一\n\n*\n\n二\n' })[0].lines).toEqual(['【1】', '', '一', '', '＊', '', '二']);
    });
  });

  describe('ファイル番号で分ける（--splits）', () => {
    const files = {
      '010.txt': 'Lead: 一\n【】\n本文一\n',
      '020.txt': '【】\n本文二\n',
      '030.txt': 'Lead: 三\n【】\n本文三\n',
      '040.txt': '続き\n',
    };
    test('指定番号以降のファイルを次の章にまとめ、視点行は「部-節」で採番し直す', () => {
      expect(split(files, [30])).toEqual([
        {
          lines: ['【1-1】', 'Lead: 一', '', '本文一', '', '【1-2】', '', '本文二'],
          sources: ['010.txt', '020.txt'],
        },
        { lines: ['【2-1】', 'Lead: 三', '', '本文三', '', '＊', '', '続き'], sources: ['030.txt', '040.txt'] },
      ]);
    });
  });

  describe('章の切り出し', () => {
    test('最初の【】より前の本文は見出しのない章にし、本文のない章は出さない', () => {
      expect(split({ '010.txt': '前置き\n【】\n\n【】\n本文\n' })).toEqual([
        { lines: ['前置き'], sources: ['010.txt'] },
        { lines: ['【1】', '', '本文'], sources: ['010.txt'] },
      ]);
    });
    test('青空文庫の注記は書いたまま出す', () => {
      expect(split({ '010.txt': '【】\n一\n［＃改ページ］\n［＃３字下げ］二\n' })[0].lines).toEqual([
        '【1】',
        '',
        '一',
        '［＃改ページ］',
        '［＃３字下げ］二',
      ]);
    });
  });

  describe('parseArgs', () => {
    test('位置引数と既定値', () => {
      expect(parseArgs(['story', 'out', '題', 'SF'])).toEqual({
        files: ['story', 'out', '題', 'SF'],
        splits: null,
        target: null,
        sceneBreak: '＊',
        sceneBreakIndent: null,
      });
    });
    test('--splits はカンマ区切り、--persona は --target と同じ', () => {
      expect(parseArgs(['--splits=070, 120,170', '--persona', '30代', '--scene-break', '◆◆◆'])).toMatchObject({
        splits: ['070', '120', '170'],
        target: '30代',
        sceneBreak: '◆◆◆',
      });
    });
  });

  describe('main', () => {
    const run = (files, argsAfterDir) => {
      const dir = mkdtempSync(join(tmpdir(), 'split-main-'));
      try {
        for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
          main([dir, ...argsAfterDir(dir)]);
        } finally {
          log.mockRestore();
        }
        const outDir = argsAfterDir(dir).find((a) => !a.startsWith('-')) ?? join(dir, 'chapters');
        return Object.fromEntries(
          readdirSync(outDir)
            .sort()
            .map((f) => [f, readFileSync(join(outDir, f), 'utf-8')]),
        );
      } finally {
        rmSync(dir, { recursive: true });
      }
    };

    test('既定では <story-dir>/chapters に章ごとに書き、あらすじと登場人物は含めない', () => {
      expect(
        run(
          {
            '010.txt': '【】\n一\n',
            '020.txt': '【】\n二\n',
            'synopsis.txt': 'あらすじ\n',
            'characters.txt': '人物\n',
          },
          () => [],
        ),
      ).toEqual({ 'chapter-001.txt': '【1】\n\n一\n', 'chapter-002.txt': '【2】\n\n二\n' });
    });
    test('ジャンル・タイトル・ターゲットは最初の章の先頭にだけ入れる', () => {
      const out = run({ '010.txt': '【】\n一\n', '020.txt': '【】\n二\n' }, (dir) => [
        join(dir, 'out'),
        '題',
        'SF',
        '--target=30代',
      ]);
      expect(out).toEqual({
        'chapter-001.txt': 'SF\n題\nターゲット: 30代\n【1】\n\n一\n',
        'chapter-002.txt': '【2】\n\n二\n',
      });
    });
    test('--splits の番号のファイルから新しい章にする', () => {
      const out = run({ '070.txt': '【】\n一\n', '100.txt': '【】\n二\n', '120.txt': '【】\n三\n' }, () => [
        '--splits=120',
      ]);
      expect(Object.keys(out)).toEqual(['chapter-001.txt', 'chapter-002.txt']);
      expect(out['chapter-002.txt']).toBe('【2-1】\n\n三\n');
    });
  });
}
