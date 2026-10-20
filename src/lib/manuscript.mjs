/**
 * 原稿ファイルの集合に対する処理。
 * ディレクトリ走査、部・章の採番、複数ファイルのマージ、あらすじ等の付属ファイル検出など。
 * 1ファイル内のテキスト解釈は text-parser.mjs。
 */

import { readdirSync, statSync, existsSync } from 'fs';
import { basename, dirname, join } from 'path';
import { fail } from './cli.mjs';
import {
  readLines,
  getFilteredLines,
  fileHasViewpointStart,
  isEpigraphLine,
  isMetaLine,
  isSeparator,
  isViewpointLine,
  stripInlineMarkup,
  trimBlankEdges,
  countChars,
} from './text-parser.mjs';
import { countWrappedRows } from './grid.mjs';

export const SYNOPSIS_FILENAME = 'synopsis.txt';
export const CHARACTERS_FILENAME = 'characters.txt';

export const FILE_SEPARATOR_MARK = '◇◇◇';
export const FILE_SEPARATOR_LINES = ['', FILE_SEPARATOR_MARK, ''];

// 視点行で始まらなくても、前のファイルが末尾の【】（次章のアンカー）で終わっていれば章の頭になる
export function startsNewChapter(files, i) {
  return i === 0 || files[i].hasViewpointStart || files[i - 1].hasViewpointEnd;
}

// 原稿では Epigraph: 行が【】より前に書かれるが、紙面では章見出しの後ろに置く。
// 見出しが来ないまま本文が始まるファイルでは本文の前に置く
export function moveEpigraphsAfterHeading(lines, { blankAfter = false } = {}) {
  const out = [];
  let pending = [];

  lines.forEach((line, i) => {
    if (isEpigraphLine(line)) {
      pending.push(line);
      return;
    }
    if (pending.length > 0 && isViewpointLine(line)) {
      out.push(line, ...pending);
      pending = [];
      const next = lines[i + 1];
      if (blankAfter && next !== undefined && next.trim() !== '') out.push('');
      return;
    }
    if (pending.length > 0 && line.trim() !== '') {
      out.push(...pending);
      pending = [];
    }
    out.push(line);
  });

  return [...out, ...pending];
}

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

export function requireInputFiles(paths, excludeFiles = undefined) {
  if (paths.length === 0) fail('入力ファイルまたはディレクトリを指定してください');
  const files = collectInputFiles(paths, excludeFiles);
  if (files.length === 0) fail('txtファイルが見つかりません');
  return files;
}

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

export function loadSynopsisLines(filePath) {
  return trimBlankEdges(readLines(filePath).filter(l => !isMetaLine(l) && !isViewpointLine(l)));
}

// PDF・EPUB・規定チェックで章番号が食い違わないよう、採番はここだけで行う
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

// 原稿用紙換算（cols字詰めで何行・何字か）。印刷時の改ページや挿入行は含めない連続換算で、
// 出力実態に合わせた枚数は check-manuscript-format が数える
export function countGenkoRows(lines, cols) {
  let rows = 0;
  let chars = 0;

  // 末尾の改行が生む空要素や、メタ行と本文の間・前後の余白行は枚数に含めない
  for (const rawLine of trimBlankEdges(lines.filter(l => !isMetaLine(l)))) {
    if (isSeparator(rawLine)) continue;

    // 視点行【】は章タイトルとして1行扱い
    if (isViewpointLine(rawLine)) {
      rows++;
      chars += [...stripInlineMarkup(rawLine.replace(/^【.*?】/, ''))].length;
      continue;
    }

    const line = stripInlineMarkup(rawLine);
    rows += line.trim() === '' ? 1 : countWrappedRows(line, cols);
    if (line.trim() !== '') chars += [...line].length;
  }

  return { rows, chars };
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

// 応募用テンプレート（docx/docm）へ流し込む1本の行列
// blankAfterHeading: 視点行（章見出し）の直後に空行を1つ補う（既定は補わない。原稿側の空行はそのまま）
export function mergeManuscriptLines(filePaths, { keepEpigraphs = false, blankAfterHeading = false } = {}) {
  const allLines = [];
  let sectionNumber = 1;

  for (let i = 0; i < filePaths.length; i++) {
    const { lines, hasViewpointStart } = getFilteredLines(filePaths[i], { keepEpigraphs });
    // マージ時に区切り字の前後へ余計なスペースが入るのを防ぐ
    const bodyLines = trimBlankEdges(moveEpigraphsAfterHeading(lines));

    if (i > 0 && !hasViewpointStart) allLines.push(...FILE_SEPARATOR_LINES);

    bodyLines.forEach((line, j) => {
      if (!isViewpointLine(line)) {
        allLines.push(line);
        return;
      }
      if (/^【】/.test(line)) {
        allLines.push(line.replace(/^【】/, `【${sectionNumber}】`));
        sectionNumber++;
      } else {
        allLines.push(line);
      }
      // エピグラフが続くときの空行は、表示行に展開する出力側がエピグラフの後ろに補う
      const next = bodyLines[j + 1] ?? '';
      if (blankAfterHeading && !isEpigraphLine(next) && next.trim() !== '') allLines.push('');
    });
  }

  return trimBlankEdges(allLines);
}

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest;
  const { writeFileSync, unlinkSync, mkdtempSync, rmSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { parseTextFile } = await import('./text-parser.mjs');

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

    test('部境界を渡さなければ通し番号', () => {
      withTmpFiles(['【】\n本文\n', '【】\n本文\n'], (paths) => {
        const sections = parseWithSectionNumbering(paths, parseTextFile, { vertical: false });
        expect(sections[0].html).toContain('【1】');
        expect(sections[1].html).toContain('【2】');
      });
    });

  });

  describe('computeSectionLabels', () => {
    test('視点行を持たない継続ファイルには次の章のラベルを割り当て、番号は進めない', () => {
      withTmpFiles(['【】\n本文\n', '続きの本文\n', '【】\n本文\n'], (paths) => {
        expect(computeSectionLabels(paths)).toEqual(['1', '2', '2']);
      });
    });
  });

  describe('getTextFilesFromDir / collectInputFiles', () => {
    const withDir = (names, fn) => {
      const dir = mkdtempSync(join(tmpdir(), 'ms-dir-'));
      try {
        names.forEach(name => writeFileSync(join(dir, name), ''));
        return fn(dir);
      } finally {
        rmSync(dir, { recursive: true });
      }
    };

    test('txtだけをファイル名の数値順に並べ、synopsis.txt は除く', () => {
      withDir(['100.txt', '20.txt', '3.txt', 'synopsis.txt', 'memo.md'], (dir) => {
        expect(getTextFilesFromDir(dir).map(f => basename(f))).toEqual(['3.txt', '20.txt', '100.txt']);
      });
    });
    test('除外ファイルは呼び出し側で差し替えられる（数字のないファイル名は先頭に来る）', () => {
      withDir(['010.txt', 'characters.txt', 'synopsis.txt'], (dir) => {
        expect(getTextFilesFromDir(dir, [CHARACTERS_FILENAME]).map(f => basename(f))).toEqual(['synopsis.txt', '010.txt']);
      });
    });
    test('ディレクトリは中のtxtに展開し、ファイル指定は除外対象でもそのまま通す', () => {
      withDir(['010.txt', '020.txt', 'synopsis.txt'], (dir) => {
        const explicit = join(dir, 'synopsis.txt');
        expect(collectInputFiles([explicit, dir]).map(f => basename(f))).toEqual(['synopsis.txt', '010.txt', '020.txt']);
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

  describe('countGenkoRows', () => {
    test('メタ行と区切り行は数えず、前後の空行も含めない', () => {
      expect(countGenkoRows(['Memo: x', '', '本文', '', '◇◇◇', '', '続き', ''], 20)).toEqual({ rows: 4, chars: 4 });
    });
    test('視点行は長さによらず1行で、【】の中は字数に入れない', () => {
      expect(countGenkoRows([`【${'あ'.repeat(30)}】`, '本文'], 20)).toEqual({ rows: 2, chars: 2 });
    });
    test('ルビ・傍点の記法を外し、ぶら下げを効かせて折り返す', () => {
      expect(countGenkoRows([`|漢字《かんじ》${'あ'.repeat(18)}。`], 20)).toEqual({ rows: 1, chars: 21 });
      expect(countGenkoRows(['あ'.repeat(21)], 20)).toEqual({ rows: 2, chars: 21 });
    });
  });

  describe('startsNewChapter', () => {
    test('先頭ファイル・視点行で始まるファイル・前のファイルが【】で終わるファイルが章の頭', () => {
      const files = [
        { hasViewpointStart: false, hasViewpointEnd: false },
        { hasViewpointStart: false, hasViewpointEnd: true },
        { hasViewpointStart: false, hasViewpointEnd: false },
        { hasViewpointStart: true, hasViewpointEnd: false },
      ];
      expect(files.map((_, i) => startsNewChapter(files, i))).toEqual([true, false, true, true]);
    });
  });

  describe('moveEpigraphsAfterHeading', () => {
    test('【】より前に書かれたエピグラフを見出しの直後へ移す', () => {
      expect(moveEpigraphsAfterHeading(['Epigraph: 一', 'Epigraph: 二', '', '【】', '本文']))
        .toEqual(['', '【】', 'Epigraph: 一', 'Epigraph: 二', '本文']);
    });
    test('見出しが来ないまま本文が始まるなら本文の前に置く', () => {
      expect(moveEpigraphsAfterHeading(['Epigraph: 一', '', '続き', '【】', '本文']))
        .toEqual(['', 'Epigraph: 一', '続き', '【】', '本文']);
    });
    test('blankAfter: 見出しの直後へ移したエピグラフと本文の間に空行を補う（原稿側にあれば補わない）', () => {
      expect(moveEpigraphsAfterHeading(['Epigraph: 一', '【】', '本文'], { blankAfter: true }))
        .toEqual(['【】', 'Epigraph: 一', '', '本文']);
      expect(moveEpigraphsAfterHeading(['Epigraph: 一', '【】', '', '本文'], { blankAfter: true }))
        .toEqual(['【】', 'Epigraph: 一', '', '本文']);
    });
    test('複数の章を含む行列では、それぞれ直後の見出しへ移す', () => {
      expect(moveEpigraphsAfterHeading(['Epigraph: 一', '【】', '本文', 'Epigraph: 二', '【】', '本文']))
        .toEqual(['【】', 'Epigraph: 一', '本文', '【】', 'Epigraph: 二', '本文']);
    });
    test('本文のないファイルでもエピグラフは捨てない', () => {
      expect(moveEpigraphsAfterHeading(['Epigraph: 一', ''])).toEqual(['', 'Epigraph: 一']);
    });
  });

  describe('mergeManuscriptLines', () => {
    test('空の【】を採番し、視点行なしのファイル前に◇◇◇を挟む（視点行の直後に空行は補わない）', () => {
      withTmpFiles(['【】\n本文一\n\n', '\n続き\n', 'POV: A\n【夜】\n本文二\n【】\n'], (paths) => {
        expect(mergeManuscriptLines(paths)).toEqual([
          '【1】', '本文一',
          '', '◇◇◇', '',
          '続き',
          '【夜】', '本文二',
        ]);
      });
    });

    test('blankAfterHeading: 視点行の直後に空行を1行補い、原稿側にあれば二重にしない', () => {
      withTmpFiles(['【】\n本文一\n', '【】\n\n本文二\n'], (paths) => {
        expect(mergeManuscriptLines(paths, { blankAfterHeading: true })).toEqual([
          '【1】', '', '本文一',
          '【2】', '', '本文二',
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
          '【1】', '本文',
          '', '◇◇◇', '',
          '続き',
        ]);
        expect(mergeManuscriptLines(paths, { blankAfterHeading: true })).toEqual([
          '【1】', '', '本文',
          '', '◇◇◇', '',
          '続き',
        ]);
      });
    });
  });
}
