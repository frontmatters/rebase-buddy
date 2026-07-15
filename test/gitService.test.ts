// Integratietests voor de module-level git-helpers: echte git in een
// wegwerp-repo. De GitService-klasse zelf blijft buiten scope (die hangt
// aan een lopende rebase); de helpers zijn puur repo-in, data-uit.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activeRebaseTodoPath, listRebaseCandidates, workingTreeDirty } from '../src/gitService';

function git(args: string[], cwd: string): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
}

let repo: string;

beforeAll(() => {
  // realpath: git geeft geresolvede paden terug (/var → /private/var op macOS).
  repo = realpathSync(mkdtempSync(path.join(tmpdir(), 'rb-gitservice-')));
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.name', 'Fixture User'], repo);
  git(['config', 'user.email', 'fixture@example.com'], repo);
  for (const [n, msg] of [['one', 'first'], ['two', 'second'], ['three', 'third']] as const) {
    writeFileSync(path.join(repo, 'a.txt'), `${n}\n`);
    git(['add', '.'], repo);
    git(['commit', '-qm', msg], repo);
  }
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('listRebaseCandidates', () => {
  it('falls back to the recent history when origin has no default branch', async () => {
    const records = await listRebaseCandidates(repo);
    expect(records.map((r) => r.subject)).toEqual(['third', 'second', 'first']);
    // De root commit is herkenbaar aan het ontbreken van parents (→ --root).
    expect(records[2].parents).toEqual([]);
    expect(records[0].parents).toHaveLength(1);
  });

  it('limits the range to the merge-base with the origin default branch', async () => {
    const firstSha = git(['rev-list', '--max-parents=0', 'HEAD'], repo).trim();
    git(['update-ref', 'refs/remotes/origin/main', firstSha], repo);
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], repo);

    const records = await listRebaseCandidates(repo);
    expect(records.map((r) => r.subject)).toEqual(['third', 'second']);
  });
});

describe('workingTreeDirty', () => {
  it('is false for a clean tree and ignores untracked files', async () => {
    expect(await workingTreeDirty(repo)).toBe(false);
    writeFileSync(path.join(repo, 'untracked.txt'), 'x\n');
    expect(await workingTreeDirty(repo)).toBe(false);
  });

  it('is true when a tracked file changed', async () => {
    writeFileSync(path.join(repo, 'a.txt'), 'dirty\n');
    expect(await workingTreeDirty(repo)).toBe(true);
    git(['checkout', '--', '.'], repo);
    expect(await workingTreeDirty(repo)).toBe(false);
  });
});

describe('activeRebaseTodoPath', () => {
  it('is undefined without a rebase and finds the todo of a running one', async () => {
    expect(await activeRebaseTodoPath(repo)).toBeUndefined();

    const rebaseDir = path.join(repo, '.git', 'rebase-merge');
    mkdirSync(rebaseDir);
    writeFileSync(path.join(rebaseDir, 'git-rebase-todo'), 'pick abc123 test\n');
    expect(await activeRebaseTodoPath(repo)).toBe(path.join(rebaseDir, 'git-rebase-todo'));

    rmSync(rebaseDir, { recursive: true });
  });
});
