// Gedeeld protocol tussen extension host en webview.
// Het todo-bestand blijft de single source of truth: de webview stuurt na elke
// mutatie de volledige entry-lijst (`setEntries`); de host serialiseert die
// terug naar tekst. Grofkorrelig maar raceloos.

export type TodoAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';

export interface ActionEntry {
  kind: 'action';
  action: TodoAction;
  /** SHA zoals in het todo-bestand staat (meestal verkort). */
  sha: string;
  subject: string;
  /** Optionele fixup-vlag: -C of -c (message uit deze commit gebruiken). */
  flag?: string;
}

/** Regel die we niet bewerken maar wel op positie tonen: exec, break, label, … */
export interface RawEntry {
  kind: 'raw';
  text: string;
}

export type TodoEntry = ActionEntry | RawEntry;

export interface FileChange {
  path: string;
  oldPath?: string;
  /** Git status letter: A, M, D, R, C, T, … */
  status: string;
  /** null bij binaire bestanden. */
  added: number | null;
  deleted: number | null;
}

export interface CommitDetails {
  sha: string;
  shortSha: string;
  author: string;
  email: string;
  /** ISO-8601 author date. */
  date: string;
  subject: string;
  body: string;
  parents: string[];
  files: FileChange[];
}

export interface RepoInfo {
  /** Branch die gerebased wordt, zonder refs/heads/ prefix. */
  branch?: string;
  /** Verkorte SHA van de onto-commit. */
  onto?: string;
  ontoSubject?: string;
  root: string;
}

export type ToWebview =
  | { type: 'init'; entries: TodoEntry[]; repo: RepoInfo }
  | { type: 'entries'; entries: TodoEntry[] }
  | { type: 'details'; sha: string; details: CommitDetails | null; error?: string };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'setEntries'; entries: TodoEntry[] }
  | { type: 'requestDetails'; sha: string }
  | { type: 'openDiff'; sha: string; file: FileChange }
  | { type: 'start' }
  | { type: 'abort' };
