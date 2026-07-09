// Alle git-toegang: execFile (geen shell), NUL-gescheiden formaten, en een
// per-SHA cache voor commit details. Geen vscode-import zodat dit los
// testbaar blijft.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
  COMMIT_FORMAT, mergeFileChanges, parseCommitRecords, parseNameStatusZ, parseNumstatZ,
} from './gitParsers';
import type { CommitDetails, RepoInfo } from './shared/messages';

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
  });
}

export class GitService {
  private detailsCache = new Map<string, CommitDetails>();

  private constructor(
    readonly repoRoot: string,
    private readonly rebaseDir: string,
  ) {}

  /** Resolve de repo-root vanaf het todo-pad. Volgorde: `git rev-parse`
   * met de directory boven rebase-merge als gitdir, dan het `gitdir`-bestand
   * (linked worktrees), dan twee-niveaus-omhoog als laatste redmiddel. */
  static async fromTodoPath(todoPath: string): Promise<GitService> {
    const rebaseDir = path.dirname(todoPath);
    const gitDir = path.dirname(rebaseDir);
    let root: string | undefined;

    try {
      root = (await git(['--git-dir', gitDir, 'rev-parse', '--show-toplevel'], path.dirname(gitDir))).trim() || undefined;
    } catch {
      root = undefined;
    }
    if (!root) {
      try {
        const pointer = (await readFile(path.join(gitDir, 'gitdir'), 'utf8')).trim();
        root = path.dirname(pointer);
      } catch {
        root = path.dirname(gitDir);
      }
    }
    return new GitService(root, rebaseDir);
  }

  /** Branch + onto uit de rebase-merge state-bestanden die naast de todo liggen. */
  async repoInfo(): Promise<RepoInfo> {
    const info: RepoInfo = { root: this.repoRoot };
    try {
      const headName = (await readFile(path.join(this.rebaseDir, 'head-name'), 'utf8')).trim();
      info.branch = headName.replace(/^refs\/heads\//, '');
    } catch { /* detached of ontbrekend state-bestand: geen branchnaam tonen */ }
    info.commitUrlBase = await this.commitUrlBase();
    try {
      const onto = (await readFile(path.join(this.rebaseDir, 'onto'), 'utf8')).trim();
      const record = parseCommitRecords(await git(
        ['show', '--no-patch', `--format=${COMMIT_FORMAT}`, onto], this.repoRoot,
      ))[0];
      info.onto = record.shortSha;
      info.ontoSubject = record.subject;
    } catch { /* onto is puur informatief */ }
    return info;
  }

  /** Absoluut pad voor een message-edit-bestand in de rebase-merge map.
   * Die map leeft precies zo lang als de rebase (git ruimt 'm op bij
   * afronden én abort) en overleeft conflict-pauzes. */
  messageFilePath(filename: string): string {
    return path.join(this.rebaseDir, filename);
  }

  /** Batch: metadata voor alle sha's in één git-aanroep (zonder file stats). */
  async commitMeta(shas: string[]): Promise<Map<string, CommitDetails>> {
    const out = new Map<string, CommitDetails>();
    if (shas.length === 0) return out;

    try {
      const records = parseCommitRecords(await git(
        ['show', '--no-patch', `--format=${COMMIT_FORMAT}`, '--end-of-options', ...shas], this.repoRoot,
      ));
      for (let i = 0; i < records.length; i++) {
        // Map op de sha zoals die in de todo staat (meestal verkort).
        out.set(shas[i] ?? records[i].sha, { ...records[i], files: [] });
      }
    } catch {
      // Eén onvindbare sha laat de batch falen; val terug op per-sha zodat de
      // rest van de lijst gewoon metadata krijgt.
      for (const sha of shas) {
        try {
          const record = parseCommitRecords(await git(
            ['show', '--no-patch', `--format=${COMMIT_FORMAT}`, '--end-of-options', sha], this.repoRoot,
          ))[0];
          if (record) out.set(sha, { ...record, files: [] });
        } catch { /* rij toont dan alleen de todo-regel */ }
      }
    }
    return out;
  }

  /** Volledige details inclusief file changes; gecachet per sha. */
  async commitDetails(sha: string): Promise<CommitDetails> {
    const cached = this.detailsCache.get(sha);
    if (cached) return cached;

    const [meta, numstatOut, nameStatusOut] = await Promise.all([
      this.commitMeta([sha]),
      git(['show', '--format=', '--numstat', '-z', '-M', '--end-of-options', sha], this.repoRoot),
      git(['show', '--format=', '--name-status', '-z', '-M', '--end-of-options', sha], this.repoRoot),
    ]);
    const details = meta.get(sha);
    if (!details) throw new Error(`commit ${sha} not found`);

    details.files = mergeFileChanges(parseNumstatZ(numstatOut), parseNameStatusZ(nameStatusOut));
    this.detailsCache.set(sha, details);
    return details;
  }

  /** Web-URL-prefix voor commit-pagina's op origin (GitHub/Gitea/GitLab
   * delen het /commit/-pad). Undefined zonder bruikbare remote. */
  private async commitUrlBase(): Promise<string | undefined> {
    try {
      const remote = (await git(['remote', 'get-url', 'origin'], this.repoRoot)).trim();
      const ssh = /^(?:ssh:\/\/)?(?:[\w.-]+@)?([\w.-]+(?::\d+)?)[:/](.+?)(?:\.git)?$/;
      if (remote.startsWith('http://') || remote.startsWith('https://')) {
        return `${remote.replace(/\.git$/, '')}/commit/`;
      }
      const match = ssh.exec(remote);
      if (match) return `https://${match[1].replace(/:\d+$/, '')}/${match[2]}/commit/`;
    } catch { /* geen remote: link verbergen */ }
    return undefined;
  }

  /** Bestandsinhoud op een bepaalde revisie; lege string voor niet-bestaande
   * kanten (added files, root commits). */
  async fileAt(rev: string, filePath: string): Promise<string> {
    try {
      return await git(['show', '--end-of-options', `${rev}:${filePath}`], this.repoRoot);
    } catch {
      return '';
    }
  }
}
