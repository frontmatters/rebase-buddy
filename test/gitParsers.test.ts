import { describe, expect, it } from 'vitest';
import { mergeFileChanges, parseCommitRecords, parseNameStatusZ, parseNumstatZ } from '../src/gitParsers';

const NUL = '\x00';
const RS = '\x1e';

describe('parseCommitRecords', () => {
  it('parses a batch of NUL-separated records', () => {
    const record = [
      'a'.repeat(40), 'ab12cd3', 'user1', 'm@example.com',
      '2026-07-09T10:00:00+02:00', 'f00 b44', 'feat: add login', 'Longer body\n\nSecond paragraph',
    ].join(NUL);
    const out = parseCommitRecords(record + RS + '\n');
    expect(out).toHaveLength(1);
    expect(out[0].shortSha).toBe('ab12cd3');
    expect(out[0].parents).toEqual(['f00', 'b44']);
    expect(out[0].body).toBe('Longer body\n\nSecond paragraph');
  });

  it('handles a root commit (no parents) and empty body', () => {
    const record = ['b'.repeat(40), '1234567', 'A', 'a@b.c', '2026-01-01T00:00:00Z', '', 'init', ''].join(NUL);
    const out = parseCommitRecords(record + RS);
    expect(out[0].parents).toEqual([]);
    expect(out[0].body).toBe('');
  });
});

describe('parseNumstatZ', () => {
  it('parses adds/deletes and binary markers', () => {
    const buf = `12\t4\tsrc/app.ts${NUL}-\t-\tlogo.png${NUL}`;
    const out = parseNumstatZ(buf);
    expect(out).toEqual([
      { path: 'src/app.ts', added: 12, deleted: 4 },
      { path: 'logo.png', added: null, deleted: null },
    ]);
  });

  it('parses renames (empty path, then old and new as separate fields)', () => {
    const buf = `3\t1\t${NUL}old/name.ts${NUL}new/name.ts${NUL}`;
    const out = parseNumstatZ(buf);
    expect(out).toEqual([{ path: 'new/name.ts', oldPath: 'old/name.ts', added: 3, deleted: 1 }]);
  });
});

describe('parseNameStatusZ', () => {
  it('parses simple statuses and renames with score', () => {
    const buf = `M${NUL}src/app.ts${NUL}A${NUL}new.ts${NUL}R100${NUL}old/name.ts${NUL}new/name.ts${NUL}`;
    const out = parseNameStatusZ(buf);
    expect(out).toEqual([
      { path: 'src/app.ts', status: 'M' },
      { path: 'new.ts', status: 'A' },
      { path: 'new/name.ts', oldPath: 'old/name.ts', status: 'R' },
    ]);
  });
});

describe('mergeFileChanges', () => {
  it('joins numstat counts with name-status letters by final path', () => {
    const out = mergeFileChanges(
      [{ path: 'a.ts', added: 5, deleted: 2 }, { path: 'b.ts', added: 1, deleted: 0 }],
      [{ path: 'a.ts', status: 'M' }, { path: 'b.ts', status: 'A' }],
    );
    expect(out).toEqual([
      { path: 'a.ts', oldPath: undefined, status: 'M', added: 5, deleted: 2 },
      { path: 'b.ts', oldPath: undefined, status: 'A', added: 1, deleted: 0 },
    ]);
  });

  it('falls back to M when name-status misses a path', () => {
    const out = mergeFileChanges([{ path: 'x.ts', added: 1, deleted: 1 }], []);
    expect(out[0].status).toBe('M');
  });
});
