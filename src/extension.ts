import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GitService } from './gitService';
import { DIFF_SCHEME, GitContentProvider, RebaseEditorProvider } from './rebaseEditor';

const PREV_KEY = 'rebaser.prevSequenceEditor';

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

export function activate(context: vscode.ExtensionContext): void {
  const services = new Map<string, GitService>();
  const output = vscode.window.createOutputChannel('Rebaser');

  context.subscriptions.push(
    output,
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, new GitContentProvider(services)),
    vscode.window.registerCustomEditorProvider(
      'rebaser.editor',
      new RebaseEditorProvider(context, services, output),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),

    vscode.commands.registerCommand('rebaser.enable', async () => {
      const previous = await gitConfig(['--get', 'sequence.editor']);
      await context.globalState.update(PREV_KEY, previous ?? null);
      await gitConfig(['sequence.editor', `"${cliPath()}" --wait`]);
      void vscode.window.showInformationMessage(
        'Rebaser is now your git rebase editor. Run `git rebase -i` to use it.',
      );
    }),

    vscode.commands.registerCommand('rebaser.disable', async () => {
      const previous = context.globalState.get<string | null>(PREV_KEY, null);
      if (previous) {
        await gitConfig(['sequence.editor', previous]);
      } else {
        await gitConfig(['--unset', 'sequence.editor']).catch(() => undefined);
      }
      await context.globalState.update(PREV_KEY, undefined);
      void vscode.window.showInformationMessage('Rebaser disabled; previous rebase editor restored.');
    }),
  );
}
