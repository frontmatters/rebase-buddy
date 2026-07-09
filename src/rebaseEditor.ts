import { lstatSync, readFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitService } from './gitService';
import { abortTodo, foldOwnExecLines, parseTodo, serializeTodo } from './todoParser';
import type { FileChange, FromWebview, ToWebview, TodoEntry } from './shared/messages';

export const DIFF_SCHEME = 'rebaser-git';

/** SHA's uit de webview stromen door naar git-argumenten; valideer het
 * formaat zodat ze nooit als git-optie geïnterpreteerd kunnen worden
 * (defense-in-depth naast --end-of-options in GitService). */
function isValidSha(sha: unknown): sha is string {
  return typeof sha === 'string' && /^[0-9a-f]{4,40}$/i.test(sha);
}

const ACTION_SET = new Set(['pick', 'reword', 'edit', 'squash', 'fixup', 'drop']);

/** Levert bestandsinhoud op een revisie voor de native diff-editor. */
export class GitContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly services: Map<string, GitService>) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    try {
      const { root, rev, file } = JSON.parse(uri.query) as { root: string; rev: string; file: string };
      if (!rev || typeof file !== 'string') return '';
      const service = this.services.get(root);
      return service ? await service.fileAt(rev, file) : '';
    } catch {
      return '';
    }
  }
}

export class RebaseEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly services: Map<string, GitService>,
    private readonly output: vscode.OutputChannel,
  ) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    const service = await GitService.fromTodoPath(document.uri.fsPath);
    this.services.set(service.repoRoot, service);

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    };
    panel.webview.html = this.html(panel.webview);

    let trailer = parseTodo(document.getText()).trailer;
    let applyingEdit = false;
    let generation = 0;
    let commitUrlBase: string | undefined;
    const post = (msg: ToWebview) => panel.webview.postMessage(msg);

    // Message-edits: de host is autoritair. Key = `${sha}#${occurrence}`
    // zodat dezelfde sha vaker in de todo kan staan (dubbele pick).
    const edits = new Map<string, { filename: string; text: string }>();

    const occurrenceOf = (list: TodoEntry[], index: number): number => {
      const target = list[index];
      if (target?.kind !== 'action') return 0;
      let occ = 0;
      for (let i = 0; i < index; i++) {
        const e = list[i];
        if (e.kind === 'action' && e.sha === target.sha) occ++;
      }
      return occ;
    };

    const isRegularFile = (p: string): boolean => {
      try {
        return lstatSync(p).isFile(); // lstat: symlinks tellen niet mee
      } catch {
        return false;
      }
    };

    const isKnownFile = (filename: string): boolean =>
      Array.from(edits.values()).some((e) => e.filename === filename)
      || isRegularFile(service.messageFilePath(filename));

    /** Parse + vouw eigen exec-regels terug + hydrateer editedMessage-tekst. */
    const parseFolded = (): TodoEntry[] => {
      const folded = foldOwnExecLines(parseTodo(document.getText()).entries, isKnownFile);
      const seen = new Map<string, number>();
      for (const e of folded) {
        if (e.kind !== 'action') continue;
        const occ = seen.get(e.sha) ?? 0;
        seen.set(e.sha, occ + 1);
        if (e.editedMessage !== undefined) {
          let text = edits.get(`${e.sha}#${occ}`)?.text;
          if (text === undefined) {
            // Sessie-herstel: bestand bestaat nog, map is leeg — lees terug.
            try {
              const filename = `rb-msg-${e.sha.toLowerCase()}-${occ}`;
              text = readFileSync(service.messageFilePath(filename), 'utf8').trim();
              edits.set(`${e.sha}#${occ}`, { filename, text });
            } catch { text = ''; }
          }
          e.editedMessage = text;
        }
      }
      return folded;
    };

    /** Serialisatie-callback: exec-regel alléén voor entries waarvoor de
     * host een message-bestand beheert — nooit op gezag van de webview. */
    const makeExecFor = (list: TodoEntry[]) => {
      const seen = new Map<string, number>();
      const byIndex = list.map((e) => {
        if (e.kind !== 'action') return undefined;
        const occ = seen.get(e.sha) ?? 0;
        seen.set(e.sha, occ + 1);
        return e.editedMessage !== undefined ? edits.get(`${e.sha}#${occ}`)?.filename : undefined;
      });
      return (_: TodoEntry, i: number) => byIndex[i];
    };

    const rewrite = async (list: TodoEntry[]) => {
      const newText = serializeTodo(list, trailer, makeExecFor(list));
      if (newText === document.getText()) return;
      applyingEdit = true;
      try {
        await this.replaceAll(document, newText);
      } finally {
        applyingEdit = false;
      }
    };

    const sendEntries = async (initial: boolean) => {
      const gen = ++generation;
      const parsed = { entries: parseFolded(), trailer: parseTodo(document.getText()).trailer };
      trailer = parsed.trailer;
      if (initial) {
        const repo = await service.repoInfo();
        commitUrlBase = repo.commitUrlBase;
        const cfg = vscode.workspace.getConfiguration('rebaseBuddy');
        post({
          type: 'init', entries: parsed.entries, repo,
          prefs: {
            defaultOrder: cfg.get('defaultOrder', 'oldest-first'),
            detailsWidth: cfg.get('detailsWidth', 340),
            confirmAbort: cfg.get('confirmAbort', true),
          },
        });
      } else {
        post({ type: 'entries', entries: parsed.entries });
      }
      // Metadata nadruppelen: één batch-call voor alle sha's in de todo.
      const shas = parsed.entries.flatMap((e) => (e.kind === 'action' ? [e.sha] : []));
      const meta = await service.commitMeta(shas);
      if (gen !== generation) return; // nieuwere staat onderweg; deze batch is stale
      for (const [sha, details] of meta) post({ type: 'details', sha, details });
    };

    panel.webview.onDidReceiveMessage(async (msg: FromWebview) => {
      try {
        switch (msg.type) {
          case 'ready':
            await sendEntries(true);
            break;
          case 'setEntries': {
            if (!Array.isArray(msg.entries)) break;
            // Defense-in-depth: de webview mag herordenen en acties kiezen,
            // maar geen nieuwe commando-regels of vreemde sha's introduceren.
            // (Eigen exec-regels zijn op dit punt al teruggevouwen in hun
            // entry; de webview ziet ze nooit als raw regels.)
            const currentRaw = new Set(
              parseFolded().flatMap((e) => (e.kind === 'raw' ? [e.text] : [])),
            );
            const valid = msg.entries.every((e) =>
              e?.kind === 'action'
                ? ACTION_SET.has(e.action) && isValidSha(e.sha)
                  && typeof e.subject === 'string'
                  && (e.flag === undefined || e.flag === '-C' || e.flag === '-c')
                  && (e.editedMessage === undefined || typeof e.editedMessage === 'string')
                : e?.kind === 'raw' && currentRaw.has(e.text));
            if (!valid) {
              this.output.appendLine('[rebase-buddy] rejected setEntries with unknown or malformed entries');
              break;
            }
            await rewrite(msg.entries);
            break;
          }
          case 'editMessage': {
            if (typeof msg.index !== 'number' || typeof msg.message !== 'string') break;
            const text = msg.message.replace(/\r\n/g, '\n').trim();
            if (text === '' || Buffer.byteLength(text, 'utf8') > 64 * 1024) break;
            const list = parseFolded();
            const entry = list[msg.index];
            if (entry?.kind !== 'action' || !isValidSha(entry.sha)) break;
            if (entry.action === 'fixup' || entry.action === 'drop') break;
            const occ = occurrenceOf(list, msg.index);
            const filename = `rb-msg-${entry.sha.toLowerCase()}-${occ}`;
            // rm vóór write: een door een kwaadaardige repo klaargezette
            // symlink kan zo nooit een schrijf-doel buiten rebase-merge worden.
            await rm(service.messageFilePath(filename), { force: true });
            await writeFile(service.messageFilePath(filename), `${text}\n`, { mode: 0o600 });
            edits.set(`${entry.sha}#${occ}`, { filename, text });
            entry.editedMessage = text;
            // Reword zou COMMIT_EDITMSG later alsnog openen: de inline edit
            // vervangt die stop, dus de actie wordt pick.
            if (entry.action === 'reword') entry.action = 'pick';
            await rewrite(list);
            post({ type: 'entries', entries: list });
            break;
          }
          case 'revertMessage': {
            if (typeof msg.index !== 'number') break;
            const list = parseFolded();
            const entry = list[msg.index];
            if (entry?.kind !== 'action' || entry.editedMessage === undefined) break;
            const occ = occurrenceOf(list, msg.index);
            const edit = edits.get(`${entry.sha}#${occ}`);
            if (edit) {
              await rm(service.messageFilePath(edit.filename), { force: true });
              edits.delete(`${entry.sha}#${occ}`);
            }
            delete entry.editedMessage;
            await rewrite(list);
            post({ type: 'entries', entries: list });
            break;
          }
          case 'requestDetails':
            if (!isValidSha(msg.sha)) break;
            post({ type: 'details', sha: msg.sha, details: await service.commitDetails(msg.sha) });
            break;
          case 'openDiff':
            if (!isValidSha(msg.sha) || typeof msg.file?.path !== 'string') break;
            await this.openDiff(service, msg.sha, msg.file);
            break;
          case 'copySha': {
            if (!isValidSha(msg.sha)) break;
            // Kopieer de volledige sha, ook als de todo een verkorte bevat.
            const full = (await service.commitDetails(msg.sha)).sha;
            await vscode.env.clipboard.writeText(full);
            break;
          }
          case 'openCommit':
            if (!isValidSha(msg.sha) || !commitUrlBase) break;
            await vscode.env.openExternal(vscode.Uri.parse(`${commitUrlBase}${msg.sha}`));
            break;
          case 'start':
            await document.save();
            await this.closeTab(document.uri);
            break;
          case 'abort':
            applyingEdit = true;
            try {
              await this.replaceAll(document, abortTodo(document.getText()));
              await document.save();
            } finally {
              applyingEdit = false;
            }
            await this.closeTab(document.uri);
            break;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.output.appendLine(`[rebaser] ${msg.type}: ${message}`);
        if (msg.type === 'requestDetails') {
          post({ type: 'details', sha: msg.sha, details: null, error: message });
        }
      }
    });

    // Externe edits (andere editor, git zelf) — gedebounced terug de webview in.
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString() || applyingEdit) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => void sendEntries(false), 150);
    });

    panel.onDidDispose(() => {
      clearTimeout(debounce);
      changeSub.dispose();
    });
  }

  private async replaceAll(document: vscode.TextDocument, text: string): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(0, 0, document.lineCount, 0);
    edit.replace(document.uri, fullRange, text);
    await vscode.workspace.applyEdit(edit);
  }

  private async openDiff(service: GitService, sha: string, file: FileChange): Promise<void> {
    const left = this.gitUri(service.repoRoot, file.status === 'A' ? '' : `${sha}^`, file.oldPath ?? file.path);
    const right = this.gitUri(service.repoRoot, file.status === 'D' ? '' : sha, file.path);
    const title = `${path.basename(file.path)} (${sha.slice(0, 7)})`;
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
  }

  private gitUri(root: string, rev: string, file: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: DIFF_SCHEME,
      path: `/${file}`,
      query: JSON.stringify({ root, rev, file }),
    });
  }

  private async closeTab(uri: vscode.Uri): Promise<void> {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (input instanceof vscode.TabInputCustom && input.uri.toString() === uri.toString()) {
          await vscode.window.tabGroups.close(tab);
          return;
        }
      }
    }
  }

  private html(webview: vscode.Webview): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'styles.css'));
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
