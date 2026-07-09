// Puur en testbaar: git-rebase-todo tekst ↔ TodoEntry-model.
// Comments/blanks zijn semantisch betekenisloos voor git; we verzamelen ze in
// een trailer die bij serialisatie onderaan terugkomt. Zo blijft herordenen
// eenduidig zonder ambigue comment-posities.

import type { ActionEntry, TodoAction, TodoEntry } from './shared/messages';

const ACTION_ALIASES: Record<string, TodoAction> = {
  p: 'pick', pick: 'pick',
  r: 'reword', reword: 'reword',
  e: 'edit', edit: 'edit',
  s: 'squash', squash: 'squash',
  f: 'fixup', fixup: 'fixup',
  d: 'drop', drop: 'drop',
};

// Regels die git kent maar die wij alleen doorlaten (read-only in de UI).
const RAW_COMMANDS = new Set([
  'x', 'exec', 'b', 'break', 'l', 'label', 't', 'reset', 'm', 'merge',
  'u', 'update-ref', 'noop',
]);

export interface ParsedTodo {
  entries: TodoEntry[];
  trailer: string;
}

export function parseTodo(text: string): ParsedTodo {
  const entries: TodoEntry[] = [];
  const trailerLines: string[] = [];

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      trailerLines.push(line);
      continue;
    }

    const entry = parseActionLine(trimmed);
    if (entry) {
      entries.push(entry);
    } else {
      entries.push({ kind: 'raw', text: trimmed });
    }
  }

  // Trailing lege regels dragen niets bij; normaliseer voor een stabiele round-trip.
  while (trailerLines.length > 0 && trailerLines[trailerLines.length - 1].trim() === '') {
    trailerLines.pop();
  }
  while (trailerLines.length > 0 && trailerLines[0].trim() === '') {
    trailerLines.shift();
  }

  return { entries, trailer: trailerLines.join('\n') };
}

function parseActionLine(line: string): ActionEntry | null {
  const tokens = line.split(/\s+/);
  const action = ACTION_ALIASES[tokens[0]];
  if (!action || RAW_COMMANDS.has(tokens[0])) return null;

  let i = 1;
  let flag: string | undefined;
  if (action === 'fixup' && (tokens[i] === '-C' || tokens[i] === '-c')) {
    flag = tokens[i];
    i += 1;
  }
  const sha = tokens[i];
  if (!sha) return null;

  const entry: ActionEntry = { kind: 'action', action, sha, subject: tokens.slice(i + 1).join(' ') };
  if (flag) entry.flag = flag;
  return entry;
}

export function serializeTodo(entries: TodoEntry[], trailer: string): string {
  // Newlines in velden zouden extra todo-regels injecteren die git uitvoert;
  // plat slaan naar spaties, wat er ook binnenkomt.
  const flatten = (s: string) => s.replace(/[\r\n]+/g, ' ');
  const lines = entries.map((e) => {
    if (e.kind === 'raw') return flatten(e.text);
    const flag = e.flag ? `${e.flag} ` : '';
    return `${e.action} ${flag}${e.sha} ${flatten(e.subject)}`.trimEnd();
  });

  let out = lines.join('\n') + '\n';
  if (trailer !== '') out += '\n' + trailer + '\n';
  return out;
}

/** Alles uitcommentariëren: git ziet een lege todo en breekt de rebase af. */
export function abortTodo(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) return line;
      return `# ${line}`;
    })
    .join('\n');
}
