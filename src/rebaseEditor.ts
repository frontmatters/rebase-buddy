import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitService } from './gitService';
import { abortTodo, parseTodo, serializeTodo } from './todoParser';
import type { FileChange, FromWebview, ToWebview } from './shared/messages';

export const DIFF_SCHEME = 'rebaser-git';

/** SHA's uit de webview stromen door naar git-argumenten; valideer het
 * formaat zodat ze nooit als git-optie geïnterpreteerd kunnen worden
 * (defense-in-depth naast --end-of-options in GitService). */
function isValidSha(sha: unknown): sha is string {
  return typeof sha === 'string' && /^[0-9a-f]{4,40}$/i.test(sha);
}

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
    const post = (msg: ToWebview) => panel.webview.postMessage(msg);

    const sendEntries = async (initial: boolean) => {
      const gen = ++generation;
      const parsed = parseTodo(document.getText());
      trailer = parsed.trailer;
      if (initial) {
        post({ type: 'init', entries: parsed.entries, repo: await service.repoInfo() });
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
            const newText = serializeTodo(msg.entries, trailer);
            if (newText !== document.getText()) {
              applyingEdit = true;
              try {
                await this.replaceAll(document, newText);
              } finally {
                applyingEdit = false;
              }
            }
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
