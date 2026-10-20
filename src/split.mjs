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
 */

import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join, basename } from 'path';
import {
  readLines, getFilteredLines, isViewpointLine, isEpigraphLine, applyViewpointLabel, trimBlankEdges, countTextChars,
} from './lib/text-parser.mjs';
import {
  getTextFilesFromDir, startsNewChapter, moveEpigraphsAfterHeading,
  FILE_SEPARATOR_LINES, SYNOPSIS_FILENAME, CHARACTERS_FILENAME,
} from './lib/manuscript.mjs';
import { parseCliArgs, parseList, fail, runMain } from './lib/cli.mjs';

function parseArgs(argv) {
  return parseCliArgs(argv, [
    { key: 'splits', flags: ['--splits'], takesValue: true, parse: parseList },
    { key: 'target', flags: ['--target', '--persona'], takesValue: true },
  ]);
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

function collectLines(filePaths, markerNums) {
  const allLines = [];
  const files = filePaths.map(f => getFilteredLines(f, { keepEpigraphs: true }));
  let prevGroup = -1;
  files.forEach(({ lines, pov }, i) => {
    const src = basename(filePaths[i]);
    const group = groupIndexOf(filePaths[i], markerNums);
    const groupChanged = markerNums && i > 0 && group !== prevGroup;
    // ファイル末尾の空行の数が継ぎ目の空きに持ち込まれないよう、ファイルごとに詰めてから1行だけ空ける
    if (i > 0 && !groupChanged) {
      const gap = startsNewChapter(files, i) ? [''] : FILE_SEPARATOR_LINES;
      allLines.push(...gap.map(text => ({ text, source: null, group })));
    }
    for (const line of trimBlankEdges(lines)) {
      const text = pov && isViewpointLine(line) ? `${line}　${pov}` : line;
      allLines.push({ text, source: src, group });
    }
    prevGroup = group;
  });
  const prevHasViewpointEnd = files.length > 0 && files[files.length - 1].hasViewpointEnd;

  // 最終ファイル末尾の【】は「次章のアンカー」ではなく終端マーカーなので、本文末尾に残す
  if (prevHasViewpointEnd && filePaths.length > 0) {
    const lastPath = filePaths[filePaths.length - 1];
    // 空アンカー【】は次章用のプレースホルダーなので対象外。中身のある【…】だけを終端マーカーとして残す
    const lastLine = [...readLines(lastPath)].reverse().find(l => l.trim() !== '');
    const endLine = lastLine && isViewpointLine(lastLine) && /^【\s*[^】\s]/.test(lastLine) ? lastLine : null;
    if (endLine) allLines.push({ text: endLine, source: basename(lastPath), group: prevGroup, endMarker: true });
  }
  return allLines;
}

function splitByGroups(allLines) {
  const groups = new Map();
  for (const item of allLines) {
    if (!groups.has(item.group)) groups.set(item.group, []);
    groups.get(item.group).push(item);
  }
  return [...groups.values()].map(items => ({
    header: null,
    epigraphs: [],
    lines: moveEpigraphsAfterHeading(items.map(it => it.text), { blankAfter: true }),
    sources: new Set(items.filter(it => it.source && it.text.trim() !== '').map(it => it.source)),
  }));
}

function splitByViewpoints(allLines) {
  const chapters = [];
  let currentChapter = null;
  let pendingEpigraphs = [];

  for (const { text: line, source, endMarker } of allLines) {
    if (isEpigraphLine(line)) {
      pendingEpigraphs.push(line);
      continue;
    }
    if (isViewpointLine(line) && !endMarker) {
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
      // 最初の【】の前にテキストがある場合（通常はない）
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

export function buildChapters(filePaths, markerNums = null) {
  const allLines = collectLines(filePaths, markerNums);
  const chapters = markerNums ? splitByGroups(allLines) : splitByViewpoints(allLines);

  // 本文のない章（最初の【】前の空行や、ヘッダーのみの章）は出力しない
  const nonEmptyChapters = chapters.filter(ch => ch.lines.some(l => l.trim() !== ''));
  numberViewpoints(nonEmptyChapters, Boolean(markerNums));
  return nonEmptyChapters;
}

export function chapterFileLines(chapter, leadLines = []) {
  const headerLines = [...leadLines];
  if (chapter.header) headerLines.push(chapter.header);
  headerLines.push(...chapter.epigraphs);
  const bodyLines = trimBlankEdges(chapter.lines);
  return headerLines.length > 0 ? [...headerLines, '', ...bodyLines] : bodyLines;
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
    ? args.splits.map(s => parseInt(s, 10)).filter(n => !Number.isNaN(n)).sort((a, b) => a - b)
    : null;
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });

  const filePaths = getTextFilesFromDir(storyDir, [SYNOPSIS_FILENAME, CHARACTERS_FILENAME]);
  const nonEmptyChapters = buildChapters(filePaths, markerNums);

  for (let i = 0; i < nonEmptyChapters.length; i++) {
    const chapter = nonEmptyChapters[i];
    const fileName = `chapter-${String(i + 1).padStart(3, '0')}.txt`;

    const leadLines = [];
    if (i === 0 && genre) leadLines.push(genre);
    if (i === 0 && title) leadLines.push(title);
    if (i === 0 && target) leadLines.push(`ターゲット: ${target}`);
    const bodyLines = chapterFileLines(chapter, leadLines);

    writeFileSync(join(outputDir, fileName), bodyLines.join('\n') + '\n', 'utf-8');
    console.log(`${fileName} (${countTextChars(bodyLines.join(''))}字) ← ${[...chapter.sources].join(', ')}`);
  }

  console.log(`\n合計 ${nonEmptyChapters.length} 章を ${outputDir} に出力しました`);
}

runMain(import.meta.url, main);

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest;
  const { mkdtempSync } = await import('fs');
  const { tmpdir } = await import('os');

  const split = (files, markerNums = null) => {
    const dir = mkdtempSync(join(tmpdir(), 'split-chapters-'));
    try {
      const paths = Object.entries(files).map(([name, content]) => {
        writeFileSync(join(dir, name), content);
        return join(dir, name);
      });
      return buildChapters(paths, markerNums).map(ch => ({
        lines: chapterFileLines(ch),
        sources: [...ch.sources],
      }));
    } finally {
      rmSync(dir, { recursive: true });
    }
  };

  describe('【】ごとに分ける（--splits なし）', () => {
    test('視点行ごとに章を切り、通し番号とPOV名を見出しに付ける', () => {
      expect(split({
        '010.txt': 'POV: アキ\n【】\n本文一\n【】\n',
        '020.txt': '【夜】\n本文二\n',
      })).toEqual([
        { lines: ['【1】　アキ', '', '本文一'], sources: ['010.txt'] },
        { lines: ['【2　夜】', '', '本文二'], sources: ['020.txt'] },
      ]);
    });
    test('章の途中で切れたファイルは前の章に◇◇◇を挟んでつなぐ', () => {
      expect(split({ '010.txt': '【】\n本文一\n\n', '020.txt': '続き\n' })).toEqual([
        { lines: ['【1】', '', '本文一', '', '◇◇◇', '', '続き'], sources: ['010.txt', '020.txt'] },
      ]);
    });
    test('エピグラフは見出しの下にまとめる', () => {
      expect(split({ '010.txt': 'Epigraph: 引用——出典\n【】\n本文\n' })[0].lines)
        .toEqual(['【1】', 'Epigraph: 引用——出典', '', '本文']);
    });
    test('最終ファイル末尾の章題つき【…】は終端マーカーとして本文に残し、空の【】は落とす', () => {
      expect(split({ '010.txt': '【】\n本文\n【了】\n' })[0].lines).toEqual(['【1】', '', '本文', '【了】']);
      expect(split({ '010.txt': '【】\n本文\n【】\n' })[0].lines).toEqual(['【1】', '', '本文']);
    });
  });

  describe('ファイル番号で分ける（--splits）', () => {
    const files = {
      '010.txt': 'Epigraph: 一\n【】\n本文一\n',
      '020.txt': '【】\n本文二\n',
      '030.txt': 'Epigraph: 三\n【】\n本文三\n',
      '040.txt': '続き\n',
    };
    test('指定番号以降のファイルを次の章にまとめ、視点行は「部-節」で採番し直す', () => {
      expect(split(files, [30])).toEqual([
        { lines: ['【1-1】', 'Epigraph: 一', '', '本文一', '', '【1-2】', '本文二'], sources: ['010.txt', '020.txt'] },
        { lines: ['【2-1】', 'Epigraph: 三', '', '本文三', '', '◇◇◇', '', '続き'], sources: ['030.txt', '040.txt'] },
      ]);
    });
  });
}
