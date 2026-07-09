// Webview UI: commit-lijst + detail-paneel. Vanilla DOM zonder innerHTML:
// alle tekst gaat via textContent, dus XSS-veilig by construction. Elke
// mutatie gaat als volledige entry-lijst terug naar de extension host.

import type {
  CommitDetails, FileChange, FromWebview, RepoInfo, ToWebview, TodoAction, TodoEntry,
} from '../src/shared/messages';

interface ViewState { detailsW?: number; newestFirst?: boolean }
declare function acquireVsCodeApi(): {
  postMessage(msg: FromWebview): void;
  getState(): ViewState | undefined;
  setState(state: ViewState): void;
};
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

const DETAILS_MIN = 240;
const DETAILS_MAX = 640;

let entries: TodoEntry[] = [];
let repo: RepoInfo | undefined;
let selected = -1;
let dragFrom = -1;
let abortArmed = false;
let abortTimer: ReturnType<typeof setTimeout> | undefined;
let detailsW = vscode.getState?.()?.detailsW ?? 340;
let newestFirst = vscode.getState?.()?.newestFirst ?? false;
const details = new Map<string, CommitDetails>();
const detailErrors = new Map<string, string>();

function saveState(): void {
  vscode.setState?.({ detailsW, newestFirst });
}

/* Squash/fixup smelt in de vorige commit (in todo-volgorde); drops vallen
 * weg als doelwit. Zonder eerder niet-gedropt commit is de actie ongeldig
 * en zou git afbreken met "cannot 'squash' without a previous commit". */
function hasMeldTarget(index: number): boolean {
  for (let j = 0; j < index; j++) {
    const e = entries[j];
    if (e.kind === 'action' && e.action !== 'drop') return true;
  }
  return false;
}

function isInvalidMeld(index: number): boolean {
  const e = entries[index];
  return e?.kind === 'action'
    && (e.action === 'squash' || e.action === 'fixup')
    && !hasMeldTarget(index);
}

function firstInvalidMeld(): number {
  return entries.findIndex((_, i) => isInvalidMeld(i));
}

const app = document.getElementById('app')!;
document.documentElement.style.setProperty('--details-w', `${detailsW}px`);

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
const COPY_D = 'M5 2h8l1 1v8h-1V3H5V2zM3 5h8l1 1v8l-1 1H3l-1-1V6l1-1zm0 1v8h8V6H3z';
const LINK_D = 'M9 2h5v5h-1V3.7L7.85 8.85l-.7-.7L12.3 3H9V2zM3.5 4H7v1H4v8h8V9h1v4.5l-.5.5h-9l-.5-.5v-9l.5-.5z';
const TERMINAL_D = 'M2.5 3h11l.5.5v9l-.5.5h-11l-.5-.5v-9l.5-.5zM3 12h10V4H3v8zm2.3-6.3l2 2v.6l-2 2-.6-.6L6.4 8 4.7 6.3l.6-.6zM8 10h3v1H8v-1z';
const CHEV_D = 'M3.9 5.7l.7-.7L8 8.4l3.4-3.4.7.7L8 9.8 3.9 5.7z';
const CHECK_D = 'M13.5 4.6l-7 7-3.6-3.6.7-.7 2.9 2.9 6.3-6.3.7.7z';

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

// ---------- custom action-menu ----------

let menuEl: HTMLElement | null = null;

function closeMenu(): void {
  menuEl?.remove();
  menuEl = null;
}

function openActionMenu(index: number, anchor: HTMLElement): void {
  const entry = entries[index];
  if (entry?.kind !== 'action') return;
  closeMenu();

  const menu = el('div', 'menu');
  menu.setAttribute('role', 'menu');
  let focusTarget: HTMLElement | null = null;

  for (const action of ACTIONS) {
    const current = action === entry.action;
    const meld = action === 'squash' || action === 'fixup';
    const disabled = meld && !hasMeldTarget(index);
    const item = el('button',
      `menu__item${current ? ' menu__item--current' : ''}${disabled ? ' menu__item--disabled' : ''}`,
      el('span', `menu__label menu__label--${action}`, action),
      el('span', 'menu__hint', disabled ? 'needs an earlier commit to meld into' : ACTION_HINTS[action]),
    );
    item.setAttribute('role', 'menuitem');
    item.setAttribute('aria-disabled', String(disabled));
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      if (disabled) return;
      closeMenu();
      setAction(index, action);
    });
    if (current) focusTarget = item;
    menu.append(item);
  }

  menu.addEventListener('keydown', (e) => {
    const items = Array.from(menu.querySelectorAll<HTMLElement>('.menu__item'));
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown' ? at + 1 : at - 1;
      items[(next + items.length) % items.length]?.focus();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      closeMenu();
      anchor.focus();
    }
  });

  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${rect.left}px`;
  menu.style.top = `${rect.bottom + 2}px`;
  document.body.append(menu);
  const menuRect = menu.getBoundingClientRect();
  if (menuRect.bottom > window.innerHeight - 8) {
    menu.style.top = `${rect.top - menuRect.height - 2}px`;
  }
  if (menuRect.right > window.innerWidth - 8) {
    menu.style.left = `${window.innerWidth - menuRect.width - 8}px`;
  }
  menuEl = menu;
  (focusTarget ?? menu.querySelector<HTMLElement>('.menu__item'))?.focus();
}

document.addEventListener('click', (e) => {
  if (menuEl && !menuEl.contains(e.target as Node)) closeMenu();
});

// ---------- rendering ----------

function render(): void {
  closeMenu();
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
  const invalidAt = firstInvalidMeld();
  if (invalidAt >= 0) {
    startBtn.disabled = true;
    startBtn.title = 'A squash/fixup row has no earlier commit to meld into';
  }
  startBtn.addEventListener('click', () => post({ type: 'start' }));

  return el('header', 'topbar',
    el('span', 'topbar__brand', 'Rebase Buddy'),
    info,
    el('span', 'topbar__spacer'),
    abortBtn,
    startBtn,
  );
}

function panes(): HTMLElement {
  const orderBtn = el('button', 'list__order',
    newestFirst ? 'newest first' : 'oldest first');
  orderBtn.append(svgIcon(CHEV_D, 11));
  orderBtn.title = 'Toggle display order (the rebase itself always applies oldest first)';
  orderBtn.addEventListener('click', () => {
    newestFirst = !newestFirst;
    saveState();
    render();
  });

  const list = el('section', `list${newestFirst ? ' list--newest' : ''}`,
    el('div', 'list__head',
      el('span', undefined, newestFirst ? 'applied bottom to top' : 'applied top to bottom'),
      orderBtn));
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Rebase todo list');
  const order = entries.map((_, i) => i);
  if (newestFirst) order.reverse();
  for (const i of order) list.append(row(entries[i], i));
  list.addEventListener('scroll', closeMenu);

  const aside = el('aside', 'details');
  aside.append(...detailsChildren());
  return el('main', 'panes', list, splitter(), aside);
}

function splitter(): HTMLElement {
  const bar = el('div', 'splitter');
  bar.title = 'Drag to resize';
  bar.addEventListener('mousedown', (e) => {
    e.preventDefault();
    closeMenu();
    bar.classList.add('splitter--active');
    document.body.classList.add('is-resizing');
    const onMove = (ev: MouseEvent) => {
      detailsW = Math.min(DETAILS_MAX, Math.max(DETAILS_MIN, window.innerWidth - ev.clientX - 3));
      document.documentElement.style.setProperty('--details-w', `${detailsW}px`);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      bar.classList.remove('splitter--active');
      document.body.classList.remove('is-resizing');
      saveState();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  return bar;
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

    const invalid = isInvalidMeld(i);
    const actionBtn = el('button', `action action--${entry.action}${invalid ? ' action--invalid' : ''}`,
      el('span', 'action__label', entry.action));
    actionBtn.append(svgIcon(CHEV_D, 12));
    actionBtn.title = invalid
      ? `Invalid: no earlier commit to ${entry.action} into. Pick another action or move this row down.`
      : ACTION_HINTS[entry.action];
    actionBtn.setAttribute('aria-haspopup', 'menu');
    actionBtn.setAttribute('aria-label', `Action: ${entry.action}`);
    actionBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (selected !== i) select(i); // re-rendert; anchor daarna opnieuw opzoeken
      const anchor = document.querySelector<HTMLElement>(`.row[data-i="${i}"] .action`) ?? actionBtn;
      openActionMenu(i, anchor);
    });

    const copyBtn = el('button', 'row__copy');
    copyBtn.title = 'Copy full commit id';
    copyBtn.append(svgIcon(COPY_D, 11));
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      post({ type: 'copySha', sha: entry.sha });
      copyBtn.replaceChildren(svgIcon(CHECK_D, 11));
      copyBtn.classList.add('row__copy--done');
      setTimeout(() => {
        copyBtn.replaceChildren(svgIcon(COPY_D, 11));
        copyBtn.classList.remove('row__copy--done');
      }, 1200);
    });

    node = el('div',
      `row row--action${joined ? ' row--joined' : ''}${dropped ? ' row--dropped' : ''}`,
      grip,
      el('span', 'row__connector'),
      actionBtn,
      el('code', 'row__sha', entry.sha.slice(0, 7)),
      copyBtn,
      el('span', 'row__subject', meta?.subject ?? entry.subject),
      el('span', 'row__meta', meta ? `${meta.author} · ${relativeDate(meta.date)}` : ''),
    );
  }

  if (i === selected) node.classList.add('row--selected');
  node.setAttribute('role', 'option');
  node.setAttribute('aria-selected', String(i === selected));
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
  if (entry?.kind === 'raw') {
    return [el('div', 'details__empty',
      el('p', undefined, el('code', undefined, entry.text)),
      el('p', 'details__empty-sub', 'Command lines run during the rebase and have no commit details.'),
    )];
  }
  if (!entry) {
    return [el('div', 'details__empty',
      el('p', undefined, 'Select a commit to inspect it.'),
      el('p', 'details__empty-sub', 'Reorder with drag & drop, change actions inline, then start the rebase.'),
    )];
  }

  const meta = details.get(entry.sha);
  if (!meta) {
    const error = detailErrors.get(entry.sha);
    return [el('div', 'details__empty',
      el('p', undefined, el('code', undefined, entry.sha)),
      el('p', 'details__empty-sub', error
        ? `Could not load commit details: ${error}`
        : 'No metadata available for this commit.'),
    )];
  }

  const dateFmt = new Date(meta.date).toLocaleString(undefined, {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  const shaCode = el('code', 'details__sha', meta.shortSha);
  shaCode.title = meta.sha;

  const copyBtn = el('button', 'iconbtn');
  copyBtn.title = 'Copy full commit id';
  copyBtn.append(svgIcon(COPY_D, 13));
  copyBtn.addEventListener('click', () => {
    post({ type: 'copySha', sha: entry.sha });
    copyBtn.replaceChildren('copied');
    copyBtn.classList.add('iconbtn--done');
    setTimeout(() => {
      copyBtn.replaceChildren(svgIcon(COPY_D, 13));
      copyBtn.classList.remove('iconbtn--done');
    }, 1500);
  });

  const header = el('div', 'details__header',
    el('span', `chip chip--${entry.action}`, entry.action), shaCode, copyBtn);

  if (repo?.commitUrlBase) {
    const linkBtn = el('button', 'iconbtn');
    linkBtn.title = 'Open commit on remote';
    linkBtn.append(svgIcon(LINK_D, 13));
    linkBtn.addEventListener('click', () => post({ type: 'openCommit', sha: entry.sha }));
    header.append(linkBtn);
  }

  const nodes: Node[] = [
    header,
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
  const invalid = firstInvalidMeld() >= 0;
  return el('footer', 'statusbar',
    el('span', `statusbar__hint${invalid ? ' statusbar__hint--warn' : ''}`, invalid
      ? 'the first commit cannot squash or fixup: there is nothing earlier to meld into'
      : 'closing this tab starts the rebase with the current state'),
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
  if ((action === 'squash' || action === 'fixup') && !hasMeldTarget(i)) return;
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
  if (menuEl) return; // het open menu handelt zijn eigen toetsen af
  const action = ACTION_KEYS[e.key.toLowerCase()];

  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    // Pijltjes werken in beeld-volgorde; bij newest-first is canoniek omgekeerd.
    const delta = (e.key === 'ArrowUp' ? -1 : 1) * (newestFirst ? -1 : 1);
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
        detailErrors.delete(msg.sha);
        const existing = details.get(msg.sha);
        // Een latere payload zonder files mag een rijkere niet overschrijven.
        if (!existing || msg.details.files.length > 0 || existing.files.length === 0) {
          details.set(msg.sha, msg.details);
        }
        render();
      } else if (msg.error) {
        detailErrors.set(msg.sha, msg.error);
        render();
      }
      break;
  }
});

post({ type: 'ready' });
