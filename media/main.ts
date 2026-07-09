// Webview UI: commit-lijst + detail-paneel. Vanilla DOM zonder innerHTML:
// alle tekst gaat via textContent, dus XSS-veilig by construction. Elke
// mutatie gaat als volledige entry-lijst terug naar de extension host.

import type {
  CommitDetails, FileChange, FromWebview, RepoInfo, ToWebview, TodoAction, TodoEntry,
} from '../src/shared/messages';

declare function acquireVsCodeApi(): { postMessage(msg: FromWebview): void };
const vscode = acquireVsCodeApi();

const ACTIONS: TodoAction[] = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'];
const ACTION_KEYS: Record<string, TodoAction> = { p: 'pick', r: 'reword', e: 'edit', s: 'squash', f: 'fixup', d: 'drop' };
const ACTION_HINTS: Record<TodoAction, string> = {
  pick: 'use commit as-is',
  reword: 'edit the commit message',
  edit: 'stop to amend this commit',
  squash: 'meld into previous, keep both messages',
  fixup: 'meld into previous, discard this message',
  drop: 'remove commit',
};

let entries: TodoEntry[] = [];
let repo: RepoInfo | undefined;
let selected = -1;
let dragFrom = -1;
let abortArmed = false;
let abortTimer: ReturnType<typeof setTimeout> | undefined;
const details = new Map<string, CommitDetails>();

const app = document.getElementById('app')!;

// ---------- DOM helpers (geen innerHTML) ----------

type Child = Node | string | null | undefined;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgIcon(pathD: string, size = 14): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', pathD);
  svg.append(path);
  return svg;
}

const GRIP_D = 'M6 3.5a1 1 0 110-2 1 1 0 010 2zm4 0a1 1 0 110-2 1 1 0 010 2zM6 9a1 1 0 110-2 1 1 0 010 2zm4 0a1 1 0 110-2 1 1 0 010 2zm-4 5.5a1 1 0 110-2 1 1 0 010 2zm4 0a1 1 0 110-2 1 1 0 010 2z';
const TERMINAL_D = 'M2.5 3h11l.5.5v9l-.5.5h-11l-.5-.5v-9l.5-.5zM3 12h10V4H3v8zm2.3-6.3l2 2v.6l-2 2-.6-.6L6.4 8 4.7 6.3l.6-.6zM8 10h3v1H8v-1z';

function post(msg: FromWebview): void {
  vscode.postMessage(msg);
}

function relativeDate(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 60) return `${Math.max(mins, 0)}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.round(months / 12)}y`;
}

// ---------- rendering ----------

function render(): void {
  app.replaceChildren(topbar(), panes(), statusbar());
}

function topbar(): HTMLElement {
  const actionCount = entries.filter((e) => e.kind === 'action').length;

  const info = el('span', 'topbar__info', el('code', undefined, repo?.branch ?? 'HEAD'));
  if (repo?.onto) {
    const onto = el('span', 'topbar__onto', 'onto ', el('code', undefined, repo.onto));
    onto.title = repo.ontoSubject ?? '';
    info.append(' ', onto);
  }
  info.append(` · ${actionCount} commits`);

  const abortBtn = el('button', `btn btn--ghost${abortArmed ? ' btn--danger' : ''}`,
    abortArmed ? 'Confirm abort' : 'Abort');
  abortBtn.addEventListener('click', () => {
    if (abortArmed) {
      post({ type: 'abort' });
      return;
    }
    abortArmed = true;
    render();
    clearTimeout(abortTimer);
    abortTimer = setTimeout(() => { abortArmed = false; render(); }, 3000);
  });

  const startBtn = el('button', 'btn btn--primary', 'Start rebase');
  startBtn.addEventListener('click', () => post({ type: 'start' }));

  return el('header', 'topbar',
    el('span', 'topbar__brand', 'Rebaser'),
    info,
    el('span', 'topbar__spacer'),
    abortBtn,
    startBtn,
  );
}

function panes(): HTMLElement {
  const list = el('section', 'list',
    el('div', 'list__head', el('span', undefined, 'applied top to bottom · oldest first')));
  entries.forEach((entry, i) => list.append(row(entry, i)));

  const aside = el('aside', 'details');
  aside.append(...detailsChildren());
  return el('main', 'panes', list, aside);
}

function row(entry: TodoEntry, i: number): HTMLElement {
  const grip = el('span', 'row__grip');
  grip.append(svgIcon(GRIP_D));

  let node: HTMLElement;
  if (entry.kind === 'raw') {
    const icon = el('span', 'row__rawicon');
    icon.append(svgIcon(TERMINAL_D));
    node = el('div', 'row row--raw', grip, icon, el('code', 'row__rawtext', entry.text));
  } else {
    const meta = details.get(entry.sha);
    const joined = entry.action === 'squash' || entry.action === 'fixup';
    const dropped = entry.action === 'drop';

    const select = el('select', `action action--${entry.action}`) as HTMLSelectElement;
    select.title = ACTION_HINTS[entry.action];
    for (const action of ACTIONS) {
      const option = el('option', undefined, action) as HTMLOptionElement;
      option.value = action;
      option.selected = action === entry.action;
      select.append(option);
    }
    select.addEventListener('click', (e) => e.stopPropagation());
    select.addEventListener('change', () => setAction(i, select.value as TodoAction));

    node = el('div',
      `row row--action${joined ? ' row--joined' : ''}${dropped ? ' row--dropped' : ''}`,
      grip,
      el('span', 'row__connector'),
      select,
      el('code', 'row__sha', entry.sha.slice(0, 7)),
      el('span', 'row__subject', meta?.subject ?? entry.subject),
      el('span', 'row__meta', meta ? `${meta.author} · ${relativeDate(meta.date)}` : ''),
    );
  }

  if (i === selected) node.classList.add('row--selected');
  node.dataset.i = String(i);
  node.draggable = true;
  node.addEventListener('click', () => select(i));
  node.addEventListener('dragstart', (e) => {
    dragFrom = i;
    e.dataTransfer?.setData('text/plain', String(i));
    node.classList.add('row--dragging');
  });
  node.addEventListener('dragend', () => {
    dragFrom = -1;
    document.querySelectorAll('.row').forEach((r) => r.classList.remove('row--dragging', 'row--dropline'));
  });
  node.addEventListener('dragover', (e) => {
    e.preventDefault();
    document.querySelectorAll('.row').forEach((r) => r.classList.remove('row--dropline'));
    node.classList.add('row--dropline');
  });
  node.addEventListener('drop', (e) => {
    e.preventDefault();
    if (dragFrom >= 0 && dragFrom !== i) move(dragFrom, i);
  });
  return node;
}

function detailsChildren(): Node[] {
  const entry = entries[selected];
  if (!entry || entry.kind !== 'action') {
    return [el('div', 'details__empty',
      el('p', undefined, 'Select a commit to inspect it.'),
      el('p', 'details__empty-sub', 'Reorder with drag & drop, change actions inline, then start the rebase.'),
    )];
  }

  const meta = details.get(entry.sha);
  if (!meta) {
    return [el('div', 'details__empty',
      el('p', undefined, el('code', undefined, entry.sha)),
      el('p', 'details__empty-sub', 'No metadata available for this commit.'),
    )];
  }

  const dateFmt = new Date(meta.date).toLocaleString(undefined, {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  const shaCode = el('code', 'details__sha', meta.shortSha);
  shaCode.title = meta.sha;

  const nodes: Node[] = [
    el('div', 'details__header', el('span', `chip chip--${entry.action}`, entry.action), shaCode),
    el('h2', 'details__subject', meta.subject),
    el('div', 'details__byline', `${meta.author} <${meta.email}> · ${dateFmt}`),
  ];
  if (meta.body) nodes.push(el('pre', 'details__body', meta.body));

  const totals = meta.files.reduce(
    (acc, f) => ({ a: acc.a + (f.added ?? 0), d: acc.d + (f.deleted ?? 0) }), { a: 0, d: 0 });
  nodes.push(el('div', 'details__files-head',
    el('span', undefined, `${meta.files.length} file${meta.files.length === 1 ? '' : 's'}`),
    el('span', 'diffstat',
      el('span', 'diffstat__add', `+${totals.a}`), ' ',
      el('span', 'diffstat__del', `−${totals.d}`)),
  ));

  const fileList = el('div', 'details__files');
  if (meta.files.length === 0) {
    fileList.append(el('div', 'details__loading', 'Loading changes…'));
  } else {
    meta.files.forEach((f) => fileList.append(fileRow(entry.sha, f)));
  }
  nodes.push(fileList);
  return nodes;
}

function fileRow(sha: string, f: FileChange): HTMLElement {
  const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : '';
  const base = f.path.slice(dir.length);

  const stat = el('span', 'file__stat diffstat');
  if (f.added === null) {
    stat.append(el('span', 'diffstat__bin', 'bin'));
  } else {
    stat.append(
      el('span', 'diffstat__add', `+${f.added}`), ' ',
      el('span', 'diffstat__del', `−${f.deleted}`));
  }

  const btn = el('button', 'file',
    el('span', `file__status file__status--${f.status}`, f.status),
    el('span', 'file__path', el('span', 'file__dir', dir), base),
    stat,
  );
  btn.title = 'Open diff';
  btn.addEventListener('click', () => post({ type: 'openDiff', sha, file: f }));
  return btn;
}

function statusbar(): HTMLElement {
  const keys = el('span', 'statusbar__keys');
  const parts: Array<[string, string]> = [['↑↓', 'select'], ['⌥↑↓', 'move'], ['P R E S F D', 'action']];
  parts.forEach(([key, label], i) => {
    if (i > 0) keys.append(' · ');
    keys.append(el('kbd', undefined, key), ` ${label}`);
  });
  return el('footer', 'statusbar',
    el('span', 'statusbar__hint', 'closing this tab starts the rebase with the current state'),
    keys,
  );
}

// ---------- state-mutaties ----------

function select(i: number): void {
  selected = i;
  const entry = entries[i];
  if (entry?.kind === 'action' && !details.get(entry.sha)?.files.length) {
    post({ type: 'requestDetails', sha: entry.sha });
  }
  render();
}

function setAction(i: number, action: TodoAction): void {
  const entry = entries[i];
  if (entry?.kind !== 'action') return;
  entry.action = action;
  if (action !== 'fixup') delete entry.flag;
  selected = i;
  sync();
}

function move(from: number, to: number): void {
  const [moved] = entries.splice(from, 1);
  entries.splice(to, 0, moved);
  selected = to;
  sync();
}

function sync(): void {
  render();
  post({ type: 'setEntries', entries });
}

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLSelectElement) return;
  const action = ACTION_KEYS[e.key.toLowerCase()];

  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const delta = e.key === 'ArrowUp' ? -1 : 1;
    e.preventDefault();
    if (e.altKey && selected >= 0) {
      const to = selected + delta;
      if (to >= 0 && to < entries.length) move(selected, to);
    } else {
      select(Math.min(Math.max(selected + delta, 0), entries.length - 1));
    }
  } else if (action && selected >= 0 && !e.metaKey && !e.ctrlKey && !e.altKey) {
    setAction(selected, action);
  }
});

window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
      entries = msg.entries;
      repo = msg.repo;
      if (selected < 0 && entries.length > 0) selected = 0;
      render();
      break;
    case 'entries':
      entries = msg.entries;
      if (selected >= entries.length) selected = entries.length - 1;
      render();
      break;
    case 'details':
      if (msg.details) {
        const existing = details.get(msg.sha);
        // Een latere payload zonder files mag een rijkere niet overschrijven.
        if (!existing || msg.details.files.length > 0 || existing.files.length === 0) {
          details.set(msg.sha, msg.details);
        }
        render();
      }
      break;
  }
});

post({ type: 'ready' });
