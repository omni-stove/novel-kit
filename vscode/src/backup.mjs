/**
 * 「バックアップ」（原稿を git にコミットしてリモートへ push する）の手順の決め方（vscode API に依存しない）。
 * 実際の git の操作は extension.mjs が VS Code の Git 拡張の API で行う。
 */

/**
 * いまのリポジトリの状態から、バックアップでする操作を決める。
 * state: { staged: すべての変更をステージしたあとのステージの変更の数, remotes: リモート名の一覧,
 *   branch: いまのブランチ名（detached HEAD なら null）, upstream: 追跡するリモートのブランチがあるか, ahead: まだ push していないコミットの数 }
 * 返す値: { commit, publish, pull, push: { remote, branch, setUpstream } | null, nothingNew }。
 * リモートが無ければ publish（Git 拡張の「ブランチの発行」でリモートを作らせる）、追跡するブランチが無ければ setUpstream で push する
 */
export function backupPlan({ staged, remotes, branch, upstream, ahead }) {
  const commit = staged > 0;
  if (remotes.length === 0) return { commit, publish: true, pull: false, push: null, nothingNew: false };
  const remote = remotes.includes('origin') ? 'origin' : remotes[0];
  return {
    commit,
    publish: false,
    // 別の PC で push したものを先に取り込まないと push が拒まれる
    pull: upstream,
    push: { remote, branch, setUpstream: !upstream },
    nothingNew: !commit && upstream && ahead === 0,
  };
}

/** バックアップのコミットのメッセージ。date の地方時の日時だけで「2026-10-27 14:05」 */
export function backupMessage(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest;

  describe('backupPlan', () => {
    const base = { staged: 2, remotes: ['origin'], branch: 'main', upstream: true, ahead: 0 };

    test('変更があればコミットし、取り込んでから push する', () => {
      expect(backupPlan(base)).toEqual({
        commit: true,
        publish: false,
        pull: true,
        push: { remote: 'origin', branch: 'main', setUpstream: false },
        nothingNew: false,
      });
    });

    test('変更も未 push のコミットも無ければ nothingNew', () => {
      expect(backupPlan({ ...base, staged: 0 }).nothingNew).toBe(true);
      expect(backupPlan({ ...base, staged: 0, ahead: 1 }).nothingNew).toBe(false);
    });

    test('追跡するブランチが無ければ取り込まず、origin（無ければ最初のリモート）へ setUpstream で push する', () => {
      expect(backupPlan({ ...base, upstream: false, remotes: ['backup', 'origin'] })).toMatchObject({
        pull: false,
        push: { remote: 'origin', branch: 'main', setUpstream: true },
        nothingNew: false,
      });
      expect(backupPlan({ ...base, upstream: false, remotes: ['backup'] }).push.remote).toBe('backup');
    });

    test('リモートが無ければ publish', () => {
      expect(backupPlan({ ...base, remotes: [], upstream: false })).toMatchObject({ publish: true, push: null });
    });
  });

  test('backupMessage は地方時の日時', () => {
    expect(backupMessage(new Date(2026, 9, 7, 9, 5))).toBe('2026-10-07 09:05');
  });
}
