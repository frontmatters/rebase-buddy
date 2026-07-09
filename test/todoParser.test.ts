import { describe, expect, it } from 'vitest';
import { abortTodo, buildExecLine, foldOwnExecLines, parseTodo, serializeTodo } from '../src/todoParser';
import type { ActionEntry } from '../src/shared/messages';

const SAMPLE = `pick ab12cd3 feat: add login form
reword f00ba44 fix: typo in header
squash 1234567 wip
fixup -C 89abcde amend styles
exec npm test
drop deadbee chore: junk

# Rebase 4a5b6c7..ab12cd3 onto 4a5b6c7 (6 commands)
#
# Commands:
# p, pick <commit> = use commit
`;

describe('parseTodo', () => {
  it('parses action lines with full and short names', () => {
    const { entries } = parseTodo('pick ab12cd3 subject\np 1111111 short form\nr 2222222 reword short');
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({ kind: 'action', action: 'pick', sha: 'ab12cd3', subject: 'subject' });
    expect((entries[1] as ActionEntry).action).toBe('pick');
    expect((entries[2] as ActionEntry).action).toBe('reword');
  });

  it('parses all six actions', () => {
    const text = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop']
      .map((a, i) => `${a} ${String(i).repeat(7)} msg ${i}`)
      .join('\n');
    const { entries } = parseTodo(text);
    expect(entries.map((e) => (e as ActionEntry).action)).toEqual([
      'pick', 'reword', 'edit', 'squash', 'fixup', 'drop',
    ]);
  });

  it('keeps the fixup -C flag', () => {
    const { entries } = parseTodo('fixup -C 89abcde amend styles');
    expect(entries[0]).toEqual({ kind: 'action', action: 'fixup', sha: '89abcde', subject: 'amend styles', flag: '-C' });
  });

  it('treats exec/break/label/reset/merge/update-ref/noop as raw passthrough', () => {
    const text = 'exec npm test\nbreak\nlabel onto\nreset onto\nmerge feature\nupdate-ref refs/heads/x\nnoop';
    const { entries } = parseTodo(text);
    expect(entries.every((e) => e.kind === 'raw')).toBe(true);
    expect(entries).toHaveLength(7);
  });

  it('treats unknown lines as raw instead of dropping them', () => {
    const { entries } = parseTodo('frobnicate ab12cd3 what');
    expect(entries[0]).toEqual({ kind: 'raw', text: 'frobnicate ab12cd3 what' });
  });

  it('collects comments and blanks into the trailer', () => {
    const { entries, trailer } = parseTodo(SAMPLE);
    expect(entries).toHaveLength(6);
    expect(trailer).toContain('# Commands:');
  });

  it('handles a commit without subject', () => {
    const { entries } = parseTodo('pick ab12cd3');
    expect(entries[0]).toEqual({ kind: 'action', action: 'pick', sha: 'ab12cd3', subject: '' });
  });
});

describe('serializeTodo', () => {
  it('round-trips: parse(serialize(parse(x))) is stable', () => {
    const first = parseTodo(SAMPLE);
    const text = serializeTodo(first.entries, first.trailer);
    const second = parseTodo(text);
    expect(second.entries).toEqual(first.entries);
    expect(second.trailer).toEqual(first.trailer);
  });

  it('writes actions in canonical long form with flags', () => {
    const { entries } = parseTodo('f -C 89abcde amend\np ab12cd3 x');
    const text = serializeTodo(entries, '');
    expect(text).toBe('fixup -C 89abcde amend\npick ab12cd3 x\n');
  });

  it('reflects reordering', () => {
    const { entries, trailer } = parseTodo('pick 1111111 one\npick 2222222 two');
    const text = serializeTodo([entries[1], entries[0]], trailer);
    expect(text.indexOf('two')).toBeLessThan(text.indexOf('one'));
  });
});

describe('abortTodo', () => {
  it('comments out every actionable line so git sees nothing to do', () => {
    const text = abortTodo(SAMPLE);
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      expect(line.startsWith('#')).toBe(true);
    }
  });
});

describe('serializeTodo — injection hardening', () => {
  it('flattens newlines in subjects so no extra todo lines can be injected', () => {
    const text = serializeTodo(
      [{ kind: 'action', action: 'pick', sha: 'ab12cd3', subject: 'fix\nexec rm -rf /' }], '');
    expect(text).toBe('pick ab12cd3 fix exec rm -rf /\n');
    expect(text.split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('flattens newlines in raw entries', () => {
    const text = serializeTodo([{ kind: 'raw', text: 'exec npm test\nexec evil' }], '');
    expect(text.split('\n').filter(Boolean)).toHaveLength(1);
  });
});

describe('message-edit exec lines', () => {
  it('buildExecLine constructs a worktree-safe, quoted exec line', () => {
    expect(buildExecLine('rb-msg-ab12cd3-0')).toBe(
      'exec git commit --amend -F "$(git rev-parse --git-path \'rebase-merge/rb-msg-ab12cd3-0\')"');
  });

  it('buildExecLine rejects filenames outside the safe pattern', () => {
    expect(() => buildExecLine("rb-msg-$(rm -rf)-0")).toThrow();
    expect(() => buildExecLine('rb-msg-ab12cd3-0; rm -rf /')).toThrow();
    expect(() => buildExecLine("msg-ab12cd3-0")).toThrow();
  });

  it('serializeTodo appends the exec line for entries with a known edit', () => {
    const { entries } = parseTodo('pick ab12cd3 subject\npick f00ba44 other');
    const text = serializeTodo(entries, '', (entry) =>
      entry.kind === 'action' && entry.sha === 'ab12cd3' ? 'rb-msg-ab12cd3-0' : undefined);
    expect(text).toBe(
      'pick ab12cd3 subject\n'
      + 'exec git commit --amend -F "$(git rev-parse --git-path \'rebase-merge/rb-msg-ab12cd3-0\')"\n'
      + 'pick f00ba44 other\n');
  });

  it('foldOwnExecLines folds a known exec back into the preceding entry', () => {
    const line = buildExecLine('rb-msg-ab12cd3-0');
    const { entries } = parseTodo(`pick ab12cd3 subject\n${line}\npick f00ba44 other`);
    const folded = foldOwnExecLines(entries, (name) => name === 'rb-msg-ab12cd3-0');
    expect(folded).toHaveLength(2);
    expect(folded[0]).toMatchObject({ kind: 'action', sha: 'ab12cd3', editedMessage: '' });
    expect(folded[1]).toMatchObject({ kind: 'action', sha: 'f00ba44' });
    expect((folded[1] as { editedMessage?: string }).editedMessage).toBeUndefined();
  });

  it('foldOwnExecLines leaves unknown or orphan exec lines as raw entries', () => {
    const line = buildExecLine('rb-msg-ab12cd3-0');
    const { entries } = parseTodo(`pick ab12cd3 subject\n${line}\n${line}`);
    const folded = foldOwnExecLines(entries, () => false);
    expect(folded.filter((e) => e.kind === 'raw')).toHaveLength(2);
  });

  it('round-trips: serialize with exec, parse, fold gives the same model', () => {
    const { entries } = parseTodo('pick ab12cd3 subject');
    const text = serializeTodo(entries, '', () => 'rb-msg-ab12cd3-0');
    const folded = foldOwnExecLines(parseTodo(text).entries, () => true);
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({ kind: 'action', sha: 'ab12cd3', editedMessage: '' });
  });
});
