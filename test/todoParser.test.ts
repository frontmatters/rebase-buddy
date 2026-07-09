import { describe, expect, it } from 'vitest';
import { abortTodo, parseTodo, serializeTodo } from '../src/todoParser';
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
