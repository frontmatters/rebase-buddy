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

/** Bestandsnamen voor message-edits: strikt hex-sha + occurrence-teller,
 * zodat het pad in de exec-regel by construction shell-veilig is. */
const MSG_FILENAME_RE = /^rb-msg-[0-9a-f]{4,40}-\d+$/;

/** Todo-regel voor een message-edit. `--git-path` resolvet ook in linked
 * worktrees (waar `.git` een bestand is); git draait deze regels via
 * `sh -c` met cwd = worktree-root, dus de substitutie gebeurt op het
 * juiste moment op de juiste plek. */
export function buildExecLine(filename: string): string {
  if (!MSG_FILENAME_RE.test(filename)) {
    throw new Error(`unsafe message filename: ${filename}`);
  }
  return `exec git commit --amend -F "$(git rev-parse --git-path 'rebase-merge/${filename}')"`;
}

const OWN_EXEC_RE = /^exec git commit --amend -F "\$\(git rev-parse --git-path 'rebase-merge\/(rb-msg-[0-9a-f]{4,40}-\d+)'\)"$/;

/** Vouwt door ons geïnjecteerde amend-regels terug in de voorafgaande
 * action-entry (als editedMessage-vlag). `isKnown` beslist of de host het
 * message-bestand daadwerkelijk beheert — onbekende regels blijven raw,
 * zodat handgemaakte lookalikes nooit als de onze behandeld worden. */
export function foldOwnExecLines(
  entries: TodoEntry[],
  isKnown: (filename: string) => boolean,
): TodoEntry[] {
  const out: TodoEntry[] = [];
  for (const entry of entries) {
    const match = entry.kind === 'raw' ? OWN_EXEC_RE.exec(entry.text) : null;
    const prev = out[out.length - 1];
    if (match && isKnown(match[1]) && prev?.kind === 'action' && prev.editedMessage === undefined) {
      prev.editedMessage = '';
      continue;
    }
    out.push(entry);
  }
  return out;
}

export function serializeTodo(
  entries: TodoEntry[],
  trailer: string,
  execFor?: (entry: TodoEntry, index: number) => string | undefined,
): string {
  // Newlines in velden zouden extra todo-regels injecteren die git uitvoert;
  // plat slaan naar spaties, wat er ook binnenkomt.
  const flatten = (s: string) => s.replace(/[\r\n]+/g, ' ');
  const lines: string[] = [];
  entries.forEach((e, i) => {
    if (e.kind === 'raw') {
      lines.push(flatten(e.text));
    } else {
      const flag = e.flag ? `${e.flag} ` : '';
      lines.push(`${e.action} ${flag}${e.sha} ${flatten(e.subject)}`.trimEnd());
    }
    const filename = execFor?.(e, i);
    if (filename) lines.push(buildExecLine(filename));
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
