// Pure parsers voor git-output (NUL-gescheiden, dus veilig voor elk pad en
// elke commit message). Gescheiden van gitService zodat ze zonder git of
// vscode te testen zijn.

import type { FileChange } from './shared/messages';

export interface CommitRecord {
  sha: string;
  shortSha: string;
  author: string;
  email: string;
  date: string;
  parents: string[];
  subject: string;
  body: string;
}

export const COMMIT_FORMAT = '%H%x00%h%x00%an%x00%ae%x00%aI%x00%P%x00%s%x00%b%x1e';

/** Output van `git show --no-patch --format=COMMIT_FORMAT <sha...>`. */
export function parseCommitRecords(output: string): CommitRecord[] {
  return output
    .split('\x1e')
    .map((record) => record.replace(/^\n+/, ''))
    .filter((record) => record.length > 0)
    .map((record) => {
      const [sha, shortSha, author, email, date, parents, subject, body = ''] = record.split('\x00');
      return {
        sha, shortSha, author, email, date,
        parents: parents === '' ? [] : parents.split(' '),
        subject,
        body: body.replace(/\n+$/, ''),
      };
    });
}

export interface NumstatEntry {
  path: string;
  oldPath?: string;
  added: number | null;
  deleted: number | null;
}

/** Output van `git show --format= --numstat -z -M <sha>`.
 * Per bestand: `added\tdeleted\tpath\0`; bij renames is het pad-veld leeg en
 * volgen oud en nieuw pad als aparte NUL-velden. `-` markeert binair. */
export function parseNumstatZ(output: string): NumstatEntry[] {
  const fields = output.split('\x00');
  const entries: NumstatEntry[] = [];

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.trim() === '') continue;
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(field);
    if (!match) continue;

    const added = match[1] === '-' ? null : Number(match[1]);
    const deleted = match[2] === '-' ? null : Number(match[2]);
    if (match[3] !== '') {
      entries.push({ path: match[3], added, deleted });
    } else {
      if (fields[i + 1] === undefined || fields[i + 2] === undefined) break;
      entries.push({ path: fields[i + 2], oldPath: fields[i + 1], added, deleted });
      i += 2;
    }
  }
  return entries;
}

export interface NameStatusEntry {
  path: string;
  oldPath?: string;
  status: string;
}

/** Output van `git show --format= --name-status -z -M <sha>`. */
export function parseNameStatusZ(output: string): NameStatusEntry[] {
  const fields = output.split('\x00');
  const entries: NameStatusEntry[] = [];

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i].replace(/^\n+/, '');
    if (field.trim() === '') continue;
    const status = field[0];
    if (status === 'R' || status === 'C') {
      if (fields[i + 1] === undefined || fields[i + 2] === undefined) break;
      entries.push({ status, oldPath: fields[i + 1], path: fields[i + 2] });
      i += 2;
    } else {
      if (fields[i + 1] === undefined) break;
      entries.push({ status, path: fields[i + 1] });
      i += 1;
    }
  }
  return entries;
}

export function mergeFileChanges(numstat: NumstatEntry[], nameStatus: NameStatusEntry[]): FileChange[] {
  const statusByPath = new Map(nameStatus.map((e) => [e.path, e]));
  return numstat.map((n) => {
    const s = statusByPath.get(n.path);
    return {
      path: n.path,
      oldPath: n.oldPath ?? s?.oldPath,
      status: s?.status ?? 'M',
      added: n.added,
      deleted: n.deleted,
    };
  });
}
