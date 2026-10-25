/**
 * 原稿ファイルの並べ替えと、ファイル名の先頭の番号（010_ など）の振り直し（vscode API に依存しない）。
 * 並びは PDF 出力と同じ（getTextFilesFromDir）で、番号を振り直せば並べ替えた順がそのまま出力の順になる。
 */

import { basename, dirname, join } from 'node:path';

/** 振り直す番号の間隔。あとから間にファイルを足せるよう 1 ずつにはしない */
const NUMBER_STEP = 10;

const PREFIX = /^\d+/;

/** ファイル名の先頭の番号（novel.json の parts が指すもの）。無ければ null */
const prefixOf = (file) => basename(file).match(PREFIX)?.[0] ?? null;

/**
 * files（作品の並び）から moving を取り出し、target（落とした先の項目のファイル。null なら末尾）の位置へ入れた並びを返す。
 * 下へ動かすときは target の後ろ、上へ動かすときは target の前に入れる（隣の項目に落とせば入れ替わる）。
 * moving が files に無い・target が moving だけのときは files のまま
 */
export function moveFiles(files, moving, target = null) {
  const set = new Set(moving);
  const picked = files.filter((f) => set.has(f));
  if (picked.length === 0) return [...files];
  const rest = files.filter((f) => !set.has(f));
  if (!target) return [...rest, ...picked];
  const anchors = target.filter((f) => !set.has(f) && files.includes(f));
  if (anchors.length === 0) return [...files];
  const down = files.indexOf(anchors[0]) > files.indexOf(picked[0]);
  const at = down ? rest.indexOf(anchors.at(-1)) + 1 : rest.indexOf(anchors[0]);
  return [...rest.slice(0, at), ...picked, ...rest.slice(at)];
}

/**
 * files の並びどおりに、先頭の番号を NUMBER_STEP 刻みで振り直す計画。
 * 桁数は 3 桁と、いまの番号の桁数・振る番号の桁数のうち一番大きいもの。番号の後ろ（_手紙.txt など）はそのまま残し、
 * 番号の無いファイルは「番号_元の名前」にする。
 * 返す値: [{ from, to, oldToken: いまの番号（無ければ null）, newToken: 振る番号 }]（files の順）
 */
export function renumberPlan(files) {
  const width = Math.max(3, String(files.length * NUMBER_STEP).length, ...files.map((f) => prefixOf(f)?.length ?? 0));
  return files.map((from, i) => {
    const name = basename(from);
    const oldToken = prefixOf(from);
    const newToken = String((i + 1) * NUMBER_STEP).padStart(width, '0');
    const rest = oldToken === null ? `_${name}` : name.slice(oldToken.length);
    return { from, to: join(dirname(from), newToken + rest), oldToken, newToken };
  });
}

/**
 * 部の境界（parts）を、番号を振り直したあとの番号に書き換える。境界は番号でなくファイルに付いていくので、
 * 部の頭のファイルを動かせば境界もいっしょに動く。
 * oldFiles: 振り直す前の並び（同じ番号のファイルが複数あれば、matchPartIndices と同じく先のものを指す）。
 * oldFiles のどの番号にも当たらない指定（別のディレクトリのファイルや、英訳がまだ無いファイルの番号）はそのまま残す。
 * 返す値: 書き換えた parts（重複を除き番号順）。parts が null なら null
 */
export function remapParts(parts, oldFiles, plan) {
  if (!parts) return null;
  const newTokenOf = new Map(plan.map((p) => [p.from, p.newToken]));
  const mapped = parts.map((tok) => {
    const file = oldFiles.find((f) => prefixOf(f) === tok);
    return file && newTokenOf.has(file) ? newTokenOf.get(file) : tok;
  });
  const num = (tok) => (/^\d+$/.test(tok) ? parseInt(tok, 10) : Number.POSITIVE_INFINITY);
  return [...new Set(mapped)].sort((a, b) => num(a) - num(b));
}

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest;

  describe('moveFiles', () => {
    const files = ['a', 'b', 'c', 'd', 'e'];

    test('下へ動かすと落とした項目の後ろ、上へ動かすと前に入る（隣に落とせば入れ替わる）', () => {
      expect(moveFiles(files, ['a'], ['b'])).toEqual(['b', 'a', 'c', 'd', 'e']);
      expect(moveFiles(files, ['d'], ['c'])).toEqual(['a', 'b', 'd', 'c', 'e']);
      expect(moveFiles(files, ['e'], ['b'])).toEqual(['a', 'e', 'b', 'c', 'd']);
    });
    test('複数ファイルの章はまとめて動き、複数ファイルの章に落とすとその章を飛び越える', () => {
      expect(moveFiles(files, ['a', 'b'], ['c', 'd'])).toEqual(['c', 'd', 'a', 'b', 'e']);
      expect(moveFiles(files, ['e'], ['b', 'c'])).toEqual(['a', 'e', 'b', 'c', 'd']);
    });
    test('target が無ければ末尾へ動かす', () => {
      expect(moveFiles(files, ['b'], null)).toEqual(['a', 'c', 'd', 'e', 'b']);
    });
    test('自分自身に落とした・知らないファイルのときは並びを変えない', () => {
      expect(moveFiles(files, ['b', 'c'], ['c'])).toEqual(files);
      expect(moveFiles(files, ['x'], ['a'])).toEqual(files);
      expect(moveFiles(files, ['a'], ['x'])).toEqual(files);
    });
  });

  describe('renumberPlan', () => {
    test('10 刻み・3 桁で振り直し、番号の後ろは残す', () => {
      const plan = renumberPlan(['/w/030_冬至.txt', '/w/010_手紙.txt', '/w/020.txt']);
      expect(plan.map((p) => [basename(p.to), p.oldToken, p.newToken])).toEqual([
        ['010_冬至.txt', '030', '010'],
        ['020_手紙.txt', '010', '020'],
        ['030.txt', '020', '030'],
      ]);
      expect(plan[0].to).toBe(join('/w', '010_冬至.txt'));
    });
    test('番号の無いファイルは「番号_元の名前」にし、いまの桁数や振る番号の桁数が多ければそれに合わせる', () => {
      expect(renumberPlan(['/w/prologue.txt', '/w/0005_a.txt']).map((p) => basename(p.to))).toEqual([
        '0010_prologue.txt',
        '0020_a.txt',
      ]);
      const many = Array.from({ length: 100 }, (_, i) => `/w/${i}.txt`);
      expect(basename(renumberPlan(many).at(-1).to)).toBe('1000.txt');
    });
  });

  describe('remapParts', () => {
    test('境界はファイルに付いていき、番号順に並べ直す', () => {
      const oldFiles = ['/w/010_a.txt', '/w/020_b.txt', '/w/050_c.txt'];
      const plan = renumberPlan(['/w/050_c.txt', '/w/010_a.txt', '/w/020_b.txt']);
      expect(remapParts(['050', '020'], oldFiles, plan)).toEqual(['010', '030']);
    });
    test('当たらない指定は残し、parts が無ければ null', () => {
      const oldFiles = ['/w/010_a.txt', '/w/020_b.txt'];
      const plan = renumberPlan(['/w/020_b.txt', '/w/010_a.txt']);
      expect(remapParts(['010', '099'], oldFiles, plan)).toEqual(['020', '099']);
      expect(remapParts(null, oldFiles, plan)).toBeNull();
    });
    test('同じ番号のファイルが複数あれば、振り直す前の並びで先のものを指す', () => {
      const oldFiles = ['/w/010_a.txt', '/w/010_b.txt'];
      const plan = renumberPlan(['/w/010_b.txt', '/w/010_a.txt']);
      expect(remapParts(['010'], oldFiles, plan)).toEqual(['020']);
    });
  });
}
