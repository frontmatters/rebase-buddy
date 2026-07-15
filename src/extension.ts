import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GitService } from './gitService';
import { activeRebaseTodoPath, listRebaseCandidates, workingTreeDirty } from './gitService';
import { DIFF_SCHEME, GitContentProvider, RebaseEditorProvider } from './rebaseEditor';

const PREV_KEY = 'rebaseBuddy.prevSequenceEditor';
const OLD_PREV_KEY = 'rebaser.prevSequenceEditor'; // pre-0.8.0 installs

function gitConfig(args: string[]): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    execFile('git', ['config', '--global', ...args], { cwd: os.homedir() }, (err, stdout) => {
      // exit code 1 bij `--get` betekent: key bestaat niet — geen fout.
      if (err && args[0] !== '--get') reject(new Error(err.message));
      else resolve(err ? undefined : stdout.trim());
    });
  });
}

/** Pad naar de `code`-CLI van deze installatie — werkt ook als `code` niet op PATH staat. */
function cliPath(): string {
  const bundled = path.join(vscode.env.appRoot, 'bin', 'code');
  return existsSync(bundled) ? bundled : 'code';
}

function relTime(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 60) return `${mins}m`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}

/** Workspace folder waarin de rebase moet draaien; vraagt alleen bij multi-root. */
async function pickRepoRoot(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    void vscode.window.showErrorMessage('Rebase Buddy: open a folder with a git repository first.');
    return undefined;
  }
  const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
  return folder?.uri.fsPath;
}

export function activate(context: vscode.ExtensionContext): void {
  const services = new Map<string, GitService>();
  const output = vscode.window.createOutputChannel('Rebase Buddy');

  // 0.8.0: ids hernoemd van rebaser.* naar rebaseBuddy.*; neem de opgeslagen
  // vorige sequence-editor mee zodat disable blijft werken na de update.
  const legacy = context.globalState.get<string | null>(OLD_PREV_KEY);
  if (legacy !== undefined && context.globalState.get(PREV_KEY) === undefined) {
    void context.globalState.update(PREV_KEY, legacy);
    void context.globalState.update(OLD_PREV_KEY, undefined);
  }

  context.subscriptions.push(
    output,
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, new GitContentProvider(services)),
    vscode.window.registerCustomEditorProvider(
      'rebaseBuddy.editor',
      new RebaseEditorProvider(context, services, output),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),

    vscode.commands.registerCommand('rebaseBuddy.enable', async () => {
      const previous = await gitConfig(['--get', 'sequence.editor']);
      await context.globalState.update(PREV_KEY, previous ?? null);
      await gitConfig(['sequence.editor', `"${cliPath()}" --wait`]);
      void vscode.window.showInformationMessage(
        'Rebase Buddy is now your git rebase editor. Run `git rebase -i` to use it.',
      );
    }),

    vscode.commands.registerCommand('rebaseBuddy.disable', async () => {
      const previous = context.globalState.get<string | null>(PREV_KEY, null);
      if (previous) {
        await gitConfig(['sequence.editor', previous]);
      } else {
        await gitConfig(['--unset', 'sequence.editor']).catch(() => undefined);
      }
      await context.globalState.update(PREV_KEY, undefined);
      void vscode.window.showInformationMessage('Rebase Buddy disabled; previous rebase editor restored.');
    }),

    vscode.commands.registerCommand('rebaseBuddy.rebaseFromHere', async () => {
      const root = await pickRepoRoot();
      if (!root) return;

      // Lopende rebase: niet een tweede starten maar de bestaande todo openen.
      const activeTodo = await activeRebaseTodoPath(root).catch(() => undefined);
      if (activeTodo) {
        void vscode.window.showInformationMessage('A rebase is already in progress; opening its todo.');
        await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(activeTodo), 'rebaseBuddy.editor');
        return;
      }
      if (await workingTreeDirty(root).catch(() => false)) {
        void vscode.window.showWarningMessage(
          'Rebase Buddy: commit or stash your changes first — a rebase needs a clean working tree.',
        );
        return;
      }

      let candidates;
      try {
        candidates = await listRebaseCandidates(root);
      } catch (err) {
        void vscode.window.showErrorMessage(`Rebase Buddy: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (candidates.length === 0) {
        void vscode.window.showInformationMessage('Rebase Buddy: no commits to rebase on this branch.');
        return;
      }

      const picked = await vscode.window.showQuickPick(
        candidates.map((record) => ({
          label: record.subject,
          description: record.shortSha,
          detail: `${record.author} · ${relTime(record.date)}${record.parents.length === 0 ? ' · root commit' : ''}`,
          record,
        })),
        {
          placeHolder: 'Pick the oldest commit to rewrite (the rebase starts there)',
          matchOnDescription: true,
        },
      );
      if (!picked) return;

      // Zelfde pad als de terminal-flow: git schrijft z'n todo en opent deze
      // editor via GIT_SEQUENCE_EDITOR — per aanroep, los van `enable`.
      const args = picked.record.parents.length === 0
        ? ['rebase', '-i', '--root']
        : ['rebase', '-i', `${picked.record.sha}^`];
      execFile('git', args, {
        cwd: root,
        env: { ...process.env, GIT_SEQUENCE_EDITOR: `"${cliPath()}" --wait` },
      }, (err, stdout, stderr) => {
        const text = `${stderr}\n${stdout}`.trim();
        if (text) output.appendLine(`[rebase-buddy] rebase: ${text}`);
        // Abort vanuit de editor maakt de todo leeg; git meldt dan "nothing to do".
        if (err && /nothing to do/i.test(text)) return;
        if (err) {
          const last = text.split('\n').filter(Boolean).pop() ?? err.message;
          void vscode.window.showWarningMessage(`git rebase: ${last}`);
        }
      });
    }),
  );
}
