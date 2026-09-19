/**
 * 原稿ファイルの集合に対する処理。
 * ディレクトリ走査、部・章の採番、複数ファイルのマージ、あらすじ等の付属ファイル検出など。
 * 1ファイル内のテキスト解釈は text-parser.mts。
 */

import { readdirSync, statSync, existsSync } from 'fs';
import { basename, dirname, join } from 'path';
import { fail } from './cli.mts';
import {
  readLines,
  getFilteredLines,
  fileHasViewpointStart,
  isEpigraphLine,
  isMetaLine,
  isViewpointLine,
  trimBlankEdges,
  countChars,
} from './text-parser.mts';

export const SYNOPSIS_FILENAME = 'synopsis.txt';
export const CHARACTERS_FILENAME = 'characters.txt';

// 視点行で始まらないファイルの前に挟む区切り（空行・◇◇◇・空行）
export const FILE_SEPARATOR_LINES = ['', '◇◇◇', ''];

export function getTextFilesFromDir(dirPath, excludeFiles = [SYNOPSIS_FILENAME]) {
  return readdirSync(dirPath)
    .filter(f => f.endsWith('.txt') && !excludeFiles.includes(f))
    .sort((a, b) => {
      const numA = parseInt(a.match(/\d+/)?.[0] || '0', 10);
      const numB = parseInt(b.match(/\d+/)?.[0] || '0', 10);
      return numA - numB;
    })
    .map(f => join(dirPath, f));
}

// ファイルとディレクトリの混在した指定を txt ファイルの列に展開する
export function collectInputFiles(paths, excludeFiles = undefined) {
  const files = [];
  for (const path of paths) {
    if (statSync(path).isDirectory()) {
      files.push(...(excludeFiles ? getTextFilesFromDir(path, excludeFiles) : getTextFilesFromDir(path)));
    } else {
      files.push(path);
    }
  }
  return files;
}

// collectInputFiles ＋ 入力なしのときの共通エラー
export function requireInputFiles(paths, excludeFiles = undefined) {
  if (paths.length === 0) fail('入力ファイルまたはディレクトリを指定してください');
  const files = collectInputFiles(paths, excludeFiles);
  if (files.length === 0) fail('txtファイルが見つかりません');
  return files;
}

// 部境界の指定トークン（ファイル名の数値プレフィックス、またはフォールバックとして
// 1始まりのファイル順インデックス）を0始まりインデックスに解決する
export function resolvePartIndices(tokens, filePaths) {
  const resolved = [];
  for (const tok of tokens) {
    const idxByPrefix = filePaths.findIndex(f => basename(f).match(/^\d+/)?.[0] === tok);
    if (idxByPrefix >= 0) {
      resolved.push(idxByPrefix);
      continue;
    }
    const asInt = parseInt(tok, 10);
    if (!isNaN(asInt) && asInt >= 1 && asInt <= filePaths.length) {
      resolved.push(asInt - 1);
      continue;
    }
    fail(`部境界の値 "${tok}" に対応するファイルが見つかりません`);
  }
  return [...new Set(resolved)].sort((a, b) => a - b);
}

/**
 * 入力に付随するファイル（synopsis.txt 等）を探す。
 * 指定されたディレクトリ、なければ先頭入力ファイルと同じディレクトリを見る
 */
export function findSidecarFile(inputFiles, inputPaths, filename) {
  for (const p of inputPaths) {
    try {
      if (statSync(p).isDirectory()) {
        const sidecarPath = join(p, filename);
        if (existsSync(sidecarPath)) return sidecarPath;
      }
    } catch { /* ignore */ }
  }
  if (inputFiles.length > 0) {
    const sidecarPath = join(dirname(inputFiles[0]), filename);
    if (existsSync(sidecarPath)) return sidecarPath;
  }
  return null;
}

// あらすじファイルを本文行だけにする（メタ行と【】行を除き、前後の空行を詰める）
export function loadSynopsisLines(filePath) {
  return trimBlankEdges(readLines(filePath).filter(l => !isMetaLine(l) && !isViewpointLine(l)));
}

/**
 * 各ファイルに割り当てる章番号ラベルを算出する（PDF・EPUB・規定チェック共通の採番規則）。
 * 部指定なし: 「1」「2」…。部指定あり: 部内が1章なら「N」、複数章なら「N-M」。
 */
export function computeSectionLabels(filePaths, partFirstIndices = null) {
  const resetSet = partFirstIndices ? new Set(partFirstIndices) : null;

  // 部ごとの章数を事前集計する（採番ラベルは章数が確定してからでないと決められない）
  let partSectionCounts = null;
  if (resetSet) {
    partSectionCounts = [];
    let count = 0;
    filePaths.forEach((filePath, idx) => {
      if (idx > 0 && resetSet.has(idx)) {
        partSectionCounts.push(count);
        count = 0;
      }
      if (fileHasViewpointStart(filePath)) count++;
    });
    partSectionCounts.push(count);
  }

  let partNumber = 1;
  let sectionNumber = 1;
  return filePaths.map((filePath, idx) => {
    if (resetSet && idx > 0 && resetSet.has(idx)) {
      partNumber++;
      sectionNumber = 1;
    }
    const sectionLabel = resetSet
      ? (partSectionCounts[partNumber - 1] === 1 ? String(partNumber) : `${partNumber}-${sectionNumber}`)
      : String(sectionNumber);
    if (fileHasViewpointStart(filePath)) sectionNumber++;
    return sectionLabel;
  });
}

export function parseWithSectionNumbering(filePaths, parseFn, options = {}) {
  const { partFirstIndices = null, ...restOptions } = options;
  const labels = computeSectionLabels(filePaths, partFirstIndices);
  return filePaths.map((filePath, idx) =>
    parseFn(filePath, { ...restOptions, sectionNumber: labels[idx] })
  );
}

export function logSections(sections, inputFiles) {
  let totalChars = 0;
  let sectionChars = 0;
  for (let i = 0; i < inputFiles.length; i++) {
    const content = sections[i].html || sections[i].xhtml;
    const chars = countChars(content);
    totalChars += chars;
    sectionChars += chars;
    const startMarker = sections[i].hasViewpointStart ? '\u{1F4D6}' : '  ';
    const endMarker = sections[i].hasViewpointEnd ? '\u{1F4D5}' : '  ';
    const sectionTotal = sections[i].hasViewpointEnd ? `  計${sectionChars.toLocaleString()}字` : '';
    console.log(`${startMarker}${endMarker} 処理中: ${basename(inputFiles[i])} (${chars.toLocaleString()}字)${sectionTotal}`);
    if (sections[i].hasViewpointEnd) sectionChars = 0;
  }
  return totalChars;
}

/**
 * 応募用テンプレート（docx/docm）向けに複数ファイルを1本の行列にマージする。
 *   - 空の【】は通し番号で【N】にする（章題つきの【…】はそのまま）
 *   - 視点行で始まらないファイルの前には 空行・◇◇◇・空行 を挟む
 *   - 視点行の直後に空行を1行入れる
 *   - keepEpigraphs 時は Epigraph: 行を章見出しの直後（見出しがなければ本文の前）へ移動する
 *     （PDF出力と同じ配置。見出し直後の空行はエピグラフの後ろで出力側が補う）
 */
export function mergeManuscriptLines(filePaths, { keepEpigraphs = false } = {}) {
  const allLines = [];
  let sectionNumber = 1;

  for (let i = 0; i < filePaths.length; i++) {
    const { lines, hasViewpointStart } = getFilteredLines(filePaths[i], { keepEpigraphs });
    const epigraphLines = lines.filter(l => isEpigraphLine(l));
    // マージ時に区切り字の前後へ余計なスペースが入るのを防ぐ
    const bodyLines = trimBlankEdges(lines.filter(l => !isEpigraphLine(l)));
    let pendingEpigraphs = epigraphLines.length > 0 ? epigraphLines : null;

    if (i > 0 && !hasViewpointStart) allLines.push(...FILE_SEPARATOR_LINES);

    for (const line of bodyLines) {
      if (isViewpointLine(line)) {
        let viewpointLine = line;
        if (/^【】/.test(line)) {
          viewpointLine = line.replace(/^【】/, `【${sectionNumber}】`);
          sectionNumber++;
        }
        allLines.push(viewpointLine);
        if (pendingEpigraphs) {
          allLines.push(...pendingEpigraphs);
          pendingEpigraphs = null;
        } else {
          allLines.push('');
        }
      } else {
        if (pendingEpigraphs && line.trim() !== '') {
          allLines.push(...pendingEpigraphs);
          pendingEpigraphs = null;
        }
        allLines.push(line);
      }
    }
  }

  return trimBlankEdges(allLines);
}

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest;
  const { writeFileSync, unlinkSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { parseTextFile } = await import('./text-parser.mts');

  const makeTmpFiles = (contents) => {
    const paths = contents.map((_, i) => join(tmpdir(), `ms-${process.pid}-${Date.now()}-${i}.txt`));
    paths.forEach((p, i) => writeFileSync(p, contents[i]));
    return paths;
  };
  const withTmpFiles = (contents, fn) => {
    const paths = makeTmpFiles(contents);
    try {
      return fn(paths);
    } finally {
      paths.forEach(p => unlinkSync(p));
    }
  };

  describe('parseWithSectionNumbering', () => {
    test('部に複数章がある場合は「部-章」形式で採番される', () => {
      withTmpFiles(['【】\n本文\n', '【】\n本文\n', '【】\n本文\n'], (paths) => {
        const sections = parseWithSectionNumbering(paths, parseTextFile, {
          vertical: false,
          partFirstIndices: [2],
        });
        expect(sections[0].html).toContain('【1-1】');
        expect(sections[1].html).toContain('【1-2】');
      });
    });

    test('部に章が1つしかない場合は「部」のみで採番される', () => {
      withTmpFiles(['【】\n本文\n', '【】\n本文\n', '【】\n本文\n'], (paths) => {
        const sections = parseWithSectionNumbering(paths, parseTextFile, {
          vertical: false,
          partFirstIndices: [2],
        });
        expect(sections[2].html).toContain('【2】');
        expect(sections[2].html).not.toContain('【2-1】');
      });
    });

    test('視点行を持たない継続ファイルは章数に数えない', () => {
      // 2部目は「視点行あり＋継続ファイル」の2ファイル構成だが章は1つ → 【2】
      withTmpFiles(['【】\n本文\n', '【】\n本文\n', '続きの本文\n'], (paths) => {
        const sections = parseWithSectionNumbering(paths, parseTextFile, {
          vertical: false,
          partFirstIndices: [1],
        });
        expect(sections[0].html).toContain('【1】');
        expect(sections[1].html).toContain('【2】');
      });
    });

    test('--part未指定時は従来どおり通し番号', () => {
      withTmpFiles(['【】\n本文\n', '【】\n本文\n'], (paths) => {
        const sections = parseWithSectionNumbering(paths, parseTextFile, { vertical: false });
        expect(sections[0].html).toContain('【1】');
        expect(sections[1].html).toContain('【2】');
      });
    });

    test('computeSectionLabels: 継続ファイルには現在の章ラベルを割り当て、番号は進めない', () => {
      withTmpFiles(['【】\n本文\n', '続きの本文\n', '【】\n本文\n'], (paths) => {
        expect(computeSectionLabels(paths)).toEqual(['1', '2', '2']);
      });
    });
  });

  describe('resolvePartIndices', () => {
    test('ファイル名の数値プレフィックスで解決し、重複を除いて昇順にする', () => {
      const files = ['/x/010.txt', '/x/020.txt', '/x/030.txt'];
      expect(resolvePartIndices(['030', '020', '020'], files)).toEqual([1, 2]);
    });
    test('プレフィックスに一致しなければ1始まりのファイル順として解釈する', () => {
      const files = ['/x/a.txt', '/x/b.txt', '/x/c.txt'];
      expect(resolvePartIndices(['2'], files)).toEqual([1]);
    });
  });

  describe('findSidecarFile / loadSynopsisLines', () => {
    test('ディレクトリ指定ならその中、ファイル指定なら同じディレクトリから探す', () => {
      withTmpFiles(['本文\n'], ([story]) => {
        const dir = dirname(story);
        const name = `ms-sidecar-${process.pid}.txt`;
        const sidecar = join(dir, name);
        writeFileSync(sidecar, 'Memo: x\n\n【】\nあらすじ。\n\n');
        try {
          expect(findSidecarFile([story], [dir], name)).toBe(sidecar);
          expect(findSidecarFile([story], [story], name)).toBe(sidecar);
          expect(findSidecarFile([story], [story], 'no-such-file.txt')).toBeNull();
          expect(loadSynopsisLines(sidecar)).toEqual(['あらすじ。']);
        } finally {
          unlinkSync(sidecar);
        }
      });
    });
  });

  describe('mergeManuscriptLines', () => {
    test('空の【】を採番し、視点行の直後に空行を入れ、視点行なしのファイル前に◇◇◇を挟む', () => {
      withTmpFiles(['【】\n本文一\n\n', '\n続き\n', 'POV: A\n【夜】\n本文二\n【】\n'], (paths) => {
        expect(mergeManuscriptLines(paths)).toEqual([
          '【1】', '', '本文一',
          '', '◇◇◇', '',
          '続き',
          '【夜】', '', '本文二',
        ]);
      });
    });

    test('keepEpigraphs: エピグラフを章見出しの直後へ移し、見出しがなければ本文の前に置く', () => {
      withTmpFiles(['Epigraph: 引用——出典\n【】\n本文\n', 'Epigraph: 二\n\n続き\n'], (paths) => {
        expect(mergeManuscriptLines(paths, { keepEpigraphs: true })).toEqual([
          '【1】', 'Epigraph: 引用——出典', '本文',
          '', '◇◇◇', '',
          'Epigraph: 二', '続き',
        ]);
        expect(mergeManuscriptLines(paths)).toEqual([
          '【1】', '', '本文',
          '', '◇◇◇', '',
          '続き',
        ]);
      });
    });
  });
}
