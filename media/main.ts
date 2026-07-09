// Webview UI: commit-lijst + detail-paneel. Vanilla DOM zonder innerHTML:
// alle tekst gaat via textContent, dus XSS-veilig by construction. Elke
// mutatie gaat als volledige entry-lijst terug naar de extension host.

import type {
  ActionEntry, CommitDetails, FileChange, FromWebview, RepoInfo, ToWebview, TodoAction, TodoEntry,
} from '../src/shared/messages';

interface ViewState { detailsW?: number; newestFirst?: boolean; detailsOpen?: boolean }
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
let selected = -1;          // anchor: bepaalt het detail-paneel
let lead = -1;              // focus-einde voor shift-bereiken
let selectedSet = new Set<number>();
let dragFrom = -1;
let abortArmed = false;
let abortTimer: ReturnType<typeof setTimeout> | undefined;
let detailsW = vscode.getState?.()?.detailsW ?? 340;
let newestFirst = vscode.getState?.()?.newestFirst ?? false;
let detailsOpen = vscode.getState?.()?.detailsOpen ?? true;
let confirmAbort = true;
let showBaseCommit = true;
let editingIndex: number | null = null;
const details = new Map<string, CommitDetails>();
const detailErrors = new Map<string, string>();

function saveState(): void {
  vscode.setState?.({ detailsW, newestFirst, detailsOpen });
}

function toggleDetails(open: boolean): void {
  detailsOpen = open;
  saveState();
  render();
}

function viewOrder(): number[] {
  const order = entries.map((_, i) => i);
  if (newestFirst) order.reverse();
  return order;
}

function toggleSelect(i: number): void {
  if (selectedSet.has(i) && selectedSet.size > 1) {
    selectedSet.delete(i);
    if (selected === i) selected = Array.from(selectedSet)[0];
  } else {
    selectedSet.add(i);
    selected = i;
  }
  lead = i;
  render();
}

function rangeSelect(i: number): void {
  const order = viewOrder();
  const a = order.indexOf(selected < 0 ? i : selected);
  const b = order.indexOf(i);
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  selectedSet = new Set(order.slice(lo, hi + 1));
  lead = i;
  render();
}

function canEditMessage(entry: TodoEntry | undefined): entry is ActionEntry {
  return entry?.kind === 'action' && entry.action !== 'fixup' && entry.action !== 'drop';
}

function startEdit(index: number): void {
  const entry = entries[index];
  if (!canEditMessage(entry)) return;
  if (!detailsOpen) {
    detailsOpen = true;
    saveState();
  }
  selected = index;
  editingIndex = index;
  render();
  const area = document.querySelector<HTMLTextAreaElement>('.msgedit__area');
  area?.focus();
  area?.setSelectionRange(0, 0);
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
const CLOSE_D = 'M4.3 3.6L8 7.3l3.7-3.7.7.7L8.7 8l3.7 3.7-.7.7L8 8.7l-3.7 3.7-.7-.7L7.3 8 3.6 4.3l.7-.7z';
const PENCIL_D = 'M11.7 1.9l2.4 2.4-1.1 1.1-2.4-2.4 1.1-1.1zM9.9 3.7l2.4 2.4-7.1 7.1-3.2.8.8-3.2 7.1-7.1z';
const UNDO_D = 'M6.4 3.2L3 6.6l3.4 3.4.7-.7-2.2-2.2H9a3.5 3.5 0 010 7H6.5v1H9a4.5 4.5 0 000-9H4.9l2.2-2.2-.7-.7z';

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
let menuAnchor: HTMLElement | null = null;

function closeMenu(): void {
  menuEl?.remove();
  menuEl = null;
  menuAnchor?.setAttribute('aria-expanded', 'false');
  menuAnchor = null;
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
  menuAnchor = anchor;
  anchor.setAttribute('aria-expanded', 'true');
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

  const branchCode = el('code', undefined, repo?.branch ?? 'HEAD');
  branchCode.title = 'The branch being rebased';
  const info = el('span', 'topbar__info', branchCode);
  if (repo?.onto) {
    const onto = el('span', 'topbar__onto', 'onto ', el('code', undefined, repo.onto));
    onto.title = repo.ontoSubject ?? '';
    info.append(' ', onto);
  }
  info.append(` · ${actionCount} commits`);

  const abortBtn = el('button', `btn btn--ghost${abortArmed ? ' btn--danger' : ''}`,
    abortArmed ? 'Confirm abort' : 'Abort');
  abortBtn.title = abortArmed
    ? 'Click again to confirm: the rebase is cancelled and nothing changes'
    : 'Cancel the rebase; your branch stays exactly as it was';
  abortBtn.addEventListener('click', () => {
    if (abortArmed || !confirmAbort) {
      post({ type: 'abort' });
      return;
    }
    abortArmed = true;
    render();
    clearTimeout(abortTimer);
    abortTimer = setTimeout(() => { abortArmed = false; render(); }, 3000);
  });

  const startBtn = el('button', 'btn btn--primary', 'Start rebase');
  startBtn.title = 'Apply this plan: git rebases the commits top to bottom (oldest first)';
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

  const headLabel = el('span', undefined, newestFirst ? 'applied bottom to top' : 'applied top to bottom');
  headLabel.title = 'The direction in which git will apply these commits during the rebase';
  const list = el('section', `list${newestFirst ? ' list--newest' : ''}`,
    el('div', 'list__head', headLabel, orderBtn));
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Rebase todo list');
  const order = entries.map((_, i) => i);
  if (newestFirst) order.reverse();
  const base = showBaseCommit && repo?.onto ? baseRow() : null;
  // Newest-first: basis onderaan (fundament); oldest-first: basis bovenaan.
  if (base && !newestFirst) list.append(base);
  for (const i of order) list.append(row(entries[i], i));
  if (base && newestFirst) list.append(base);
  list.addEventListener('scroll', closeMenu);

  if (!detailsOpen) {
    const rail = el('button', 'details__reopen');
    rail.title = 'Show commit details';
    rail.setAttribute('aria-label', 'Show commit details');
    rail.append(svgIcon(CHEV_D, 12));
    rail.addEventListener('click', () => toggleDetails(true));
    return el('main', 'panes panes--closed', list, splitter(), rail);
  }

  const aside = el('aside', 'details');
  const closeBtn = el('button', 'details__close iconbtn');
  closeBtn.title = 'Hide commit details';
  closeBtn.setAttribute('aria-label', 'Hide commit details');
  closeBtn.append(svgIcon(CLOSE_D, 13));
  closeBtn.addEventListener('click', () => toggleDetails(false));
  aside.append(closeBtn, ...detailsChildren());
  return el('main', 'panes', list, splitter(), aside);
}

function splitter(): HTMLElement {
  const bar = el('div', 'splitter');
  bar.title = 'Drag to resize · double-click to toggle';
  bar.addEventListener('dblclick', () => toggleDetails(!detailsOpen));
  bar.addEventListener('mousedown', (e) => {
    if (!detailsOpen) return;
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

function baseRow(): HTMLElement {
  const node = el('div', 'row row--base',
    el('span', 'row__grip'),
    el('span', 'row__base-tag', 'base'),
    el('code', 'row__sha', (repo?.onto ?? '').slice(0, 7)),
    el('span'),
    el('span', 'row__subject', repo?.ontoSubject ?? ''),
    el('span', 'row__meta', 'your changes land on top'),
  );
  node.title = 'The commit your rebase is applied onto (read-only)';
  return node;
}

function row(entry: TodoEntry, i: number): HTMLElement {
  const grip = el('span', 'row__grip');
  grip.title = 'Drag to reorder';
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

    const edited = entry.editedMessage !== undefined;
    const subjectText = edited
      ? entry.editedMessage!.split('\n')[0]
      : (meta?.subject ?? entry.subject);
    const subjectEl = el('span', `row__subject${edited ? ' row__subject--edited' : ''}`, subjectText);
    if (edited) subjectEl.title = 'Message edited: rewritten during the rebase';
    if (canEditMessage(entry)) {
      subjectEl.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startEdit(i);
      });
    }

    node = el('div',
      `row row--action${joined ? ' row--joined' : ''}${dropped ? ' row--dropped' : ''}`,
      grip,
      el('span', 'row__connector'),
      actionBtn,
      el('code', 'row__sha', entry.sha.slice(0, 7)),
      copyBtn,
      subjectEl,
      el('span', 'row__meta', meta ? `${meta.author} · ${relativeDate(meta.date)}` : ''),
    );
  }

  const inSelection = selectedSet.has(i) || i === selected;
  if (inSelection) node.classList.add('row--selected');
  node.setAttribute('role', 'option');
  node.setAttribute('aria-selected', String(inSelection));
  node.dataset.i = String(i);
  node.draggable = true;
  node.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey) {
      toggleSelect(i);
      return;
    }
    if (e.shiftKey) {
      rangeSelect(i);
      return;
    }
    // Een klik op een commit is een expliciete details-intentie: heropen het
    // paneel als het dicht was (pijltjes-navigatie doet dat bewust niet).
    if (!detailsOpen) {
      detailsOpen = true;
      saveState();
    }
    selectedSet = new Set([i]);
    lead = i;
    select(i);
  });
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
    if (dragFrom < 0 || dragFrom === i || selectedSet.has(i)) return;
    if (selectedSet.size > 1 && selectedSet.has(dragFrom)) {
      moveBlock(Array.from(selectedSet), i);
    } else {
      move(dragFrom, i);
    }
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

  const chip = el('span', `chip chip--${entry.action}`, entry.action);
  chip.title = ACTION_HINTS[entry.action];
  const header = el('div', 'details__header', chip, shaCode, copyBtn);

  if (repo?.commitUrlBase) {
    const linkBtn = el('button', 'iconbtn');
    linkBtn.title = 'Open commit on remote';
    linkBtn.append(svgIcon(LINK_D, 13));
    linkBtn.addEventListener('click', () => post({ type: 'openCommit', sha: entry.sha }));
    header.append(linkBtn);
  }

  const edited = entry.editedMessage !== undefined;
  if (edited) {
    const editedChip = el('span', 'chip chip--edited', 'edited');
    editedChip.title = 'The commit message will be rewritten during the rebase';
    const undoBtn = el('button', 'iconbtn');
    undoBtn.title = 'Revert to the original commit message';
    undoBtn.append(svgIcon(UNDO_D, 13));
    undoBtn.addEventListener('click', () => post({ type: 'revertMessage', index: selected }));
    header.append(editedChip, undoBtn);
  }

  const nodes: Node[] = [header];

  if (selectedSet.size > 1) {
    nodes.push(el('div', 'details__multiselect',
      `${selectedSet.size} commits selected · actions and drag apply to all`));
  }

  if (editingIndex === selected && canEditMessage(entry)) {
    nodes.push(messageEditor(entry, meta));
  } else {
    const shown = entry.editedMessage ?? '';
    const [subjectText, ...bodyParts] = edited ? shown.split('\n') : [meta.subject];
    const bodyText = edited ? bodyParts.join('\n').trim() : (meta.body ?? '');

    const subjectRow = el('div', 'details__subjectrow');
    const subject = el('h2', `details__subject${edited ? ' details__subject--edited' : ''}`, subjectText || meta.subject);
    subjectRow.append(subject);
    if (canEditMessage(entry)) {
      subject.title = 'Double-click to edit the commit message';
      subject.addEventListener('dblclick', () => startEdit(selected));
      const pencil = el('button', 'iconbtn details__pencil');
      pencil.title = 'Edit the commit message (rewords during the rebase)';
      pencil.append(svgIcon(PENCIL_D, 12));
      pencil.addEventListener('click', () => startEdit(selected));
      subjectRow.append(pencil);
    }
    nodes.push(subjectRow,
      el('div', 'details__byline', `${meta.author} <${meta.email}> · ${dateFmt}`));
    if (bodyText) {
      const body = el('pre', 'details__body', bodyText);
      if (canEditMessage(entry)) body.addEventListener('dblclick', () => startEdit(selected));
      nodes.push(body);
    }
  }

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

function messageEditor(entry: ActionEntry, meta: CommitDetails): HTMLElement {
  const initial = entry.editedMessage
    ?? (meta.body ? `${meta.subject}\n\n${meta.body}` : meta.subject);

  const area = el('textarea', 'msgedit__area') as HTMLTextAreaElement;
  area.value = initial;
  area.rows = 1;
  area.spellcheck = false;
  // Auto-fit: krimp naar de inhoud en groei mee tijdens het typen.
  const autosize = () => {
    area.style.height = 'auto';
    area.style.height = `${Math.min(area.scrollHeight + 2, window.innerHeight * 0.5)}px`;
  };
  area.addEventListener('input', autosize);
  requestAnimationFrame(autosize);

  const confirm = () => {
    const text = area.value.trim();
    if (!text) return;
    editingIndex = null;
    post({ type: 'editMessage', index: selected, message: text });
  };
  const cancel = () => {
    editingIndex = null;
    render();
  };

  area.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      confirm();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });

  const saveBtn = el('button', 'btn btn--primary msgedit__btn', 'Save message');
  saveBtn.title = 'Rewrite the commit message during the rebase (⌘⏎)';
  saveBtn.addEventListener('click', confirm);
  const cancelBtn = el('button', 'btn btn--ghost msgedit__btn', 'Cancel');
  cancelBtn.title = 'Keep the current message (Esc)';
  cancelBtn.addEventListener('click', cancel);

  return el('div', 'msgedit',
    area,
    el('div', 'msgedit__hint', 'first line is the subject'),
    el('div', 'msgedit__actions', cancelBtn, saveBtn),
  );
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
  keys.title = 'Keyboard shortcuts — ↑↓: select · ⇧↑↓ / ⇧-click: range · ⌘-click: toggle · ⌘A: select all · '
    + '⌥↑↓: move selection · P: pick · R: reword · E: edit · S: squash · F: fixup · D: drop '
    + '(applies to every selected commit)';
  const parts: Array<[string, string]> = [['↑↓', 'select'], ['⇧/⌘', 'multi'], ['⌥↑↓', 'move'], ['P R E S F D', 'set action']];
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
  if (editingIndex !== null && editingIndex !== i) editingIndex = null;
  selected = i;
  const entry = entries[i];
  if (entry?.kind === 'action' && !details.get(entry.sha)?.files.length) {
    post({ type: 'requestDetails', sha: entry.sha });
  }
  render();
}

function setAction(i: number, action: TodoAction): void {
  // Hoort de rij bij de actieve selectie, dan geldt de actie voor allemaal.
  const targets = selectedSet.size > 1 && selectedSet.has(i) ? Array.from(selectedSet) : [i];
  let changed = false;
  for (const idx of targets) {
    const entry = entries[idx];
    if (entry?.kind !== 'action') continue;
    // Enkele rij: harde guard zoals voorheen. Bij een multi-apply laten we de
    // zichtbare invalid-state + geblokkeerde Start het uitleggen.
    if (targets.length === 1 && (action === 'squash' || action === 'fixup') && !hasMeldTarget(idx)) return;
    entry.action = action;
    if (action !== 'fixup') delete entry.flag;
    changed = true;
  }
  if (!changed) return;
  selected = i;
  sync();
}

/** Commit een gewenste VIEW-volgorde (objecten, boven→onder) naar entries.
 * entries is altijd canoniek (oldest-first), dus bij newest-first draaien we
 * de view om. Selectie en anchor volgen de verplaatste objecten by identity. */
function commitView(viewObjs: TodoEntry[], movedObjs: TodoEntry[]): void {
  entries = newestFirst ? viewObjs.slice().reverse() : viewObjs.slice();
  selectedSet = new Set(movedObjs.map((o) => entries.indexOf(o)));
  selected = entries.indexOf(movedObjs[0]);
  lead = entries.indexOf(movedObjs[movedObjs.length - 1]);
  sync();
}

/** Sleep-drop: verplaats de canonieke indices als blok, ingevoegd VÓÓR de
 * doelrij in weergave-volgorde (waar de dropline staat). */
function moveBlock(indices: number[], targetCanonical: number): void {
  const moveSet = new Set(indices.map((ci) => entries[ci]));
  const viewObjs = viewOrder().map((ci) => entries[ci]);
  const moving = viewObjs.filter((o) => moveSet.has(o));
  const target = entries[targetCanonical];
  const rest = viewObjs.filter((o) => !moveSet.has(o));
  let pos = rest.indexOf(target);
  if (pos < 0) pos = rest.length;
  rest.splice(pos, 0, ...moving);
  commitView(rest, moving);
}

function move(from: number, to: number): void {
  moveBlock([from], to);
}

/** ⌥↑/⌥↓: schuif de selectie één plek op in WEERGAVE-richting. */
function nudge(dir: -1 | 1): void {
  const viewObjs = viewOrder().map((ci) => entries[ci]);
  const moveSet = new Set(
    (selectedSet.size > 1 ? Array.from(selectedSet) : [selected]).map((ci) => entries[ci]),
  );
  const moving = viewObjs.filter((o) => moveSet.has(o));
  if (moving.length === 0) return;
  const rest = viewObjs.filter((o) => !moveSet.has(o));
  const firstPos = viewObjs.indexOf(moving[0]);
  const before = rest.filter((o) => viewObjs.indexOf(o) < firstPos).length;
  const insertAt = dir < 0 ? before - 1 : before + 1;
  if (insertAt < 0 || insertAt > rest.length) return; // aan de rand
  rest.splice(insertAt, 0, ...moving);
  commitView(rest, moving);
}

function sync(): void {
  render();
  post({ type: 'setEntries', entries });
}

document.addEventListener('keydown', (e) => {
  if (menuEl) return; // het open menu handelt zijn eigen toetsen af
  if (e.target instanceof HTMLTextAreaElement) return; // message-editor actief
  const action = ACTION_KEYS[e.key.toLowerCase()];

  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    if (entries.length > 0) {
      selectedSet = new Set(entries.map((_, i) => i));
      if (selected < 0) selected = 0;
      lead = entries.length - 1;
      render();
    }
    return;
  }

  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    // Pijltjes werken in beeld-volgorde; bij newest-first is canoniek omgekeerd.
    const delta = (e.key === 'ArrowUp' ? -1 : 1) * (newestFirst ? -1 : 1);
    e.preventDefault();
    if (e.altKey && selected >= 0) {
      // Verplaats in WEERGAVE-richting; nudge() rekent zelf naar canoniek.
      nudge(e.key === 'ArrowUp' ? -1 : 1);
    } else if (e.shiftKey && lead >= 0) {
      const next = Math.min(Math.max(lead + delta, 0), entries.length - 1);
      rangeSelect(next);
    } else {
      const next = Math.min(Math.max((lead >= 0 ? lead : selected) + delta, 0), entries.length - 1);
      selectedSet = new Set([next]);
      lead = next;
      select(next);
    }
  } else if (action && selected >= 0 && !e.metaKey && !e.ctrlKey && !e.altKey) {
    setAction(selected, action);
  }
});

window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init': {
      entries = msg.entries;
      repo = msg.repo;
      // Settings gelden als default; sessie-state (toggle/splitter) wint.
      const state = vscode.getState?.();
      confirmAbort = msg.prefs.confirmAbort;
      showBaseCommit = msg.prefs.showBaseCommit;
      if (state?.newestFirst === undefined) {
        newestFirst = msg.prefs.defaultOrder === 'newest-first';
      }
      if (state?.detailsW === undefined) {
        detailsW = Math.min(640, Math.max(240, msg.prefs.detailsWidth));
        document.documentElement.style.setProperty('--details-w', `${detailsW}px`);
      }
      if (selected < 0 && entries.length > 0) selected = 0;
      selectedSet = new Set(selected >= 0 ? [selected] : []);
      lead = selected;
      render();
      break;
    }
    case 'entries':
      entries = msg.entries;
      if (selected >= entries.length) selected = entries.length - 1;
      selectedSet = new Set(selectedSet.size > 1
        ? Array.from(selectedSet).filter((i) => i < entries.length)
        : (selected >= 0 ? [selected] : []));
      lead = selected;
      editingIndex = null;
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
