import { EditorState, Compartment, RangeSetBuilder } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine,
  dropCursor, highlightActiveLineGutter, rectangularSelection, crosshairCursor,
  Decoration, ViewPlugin,
} from '@codemirror/view';
import {
  defaultKeymap, history, historyKeymap, indentWithTab,
  addCursorAbove, addCursorBelow,
} from '@codemirror/commands';
import {
  syntaxHighlighting, defaultHighlightStyle,
  indentOnInput, bracketMatching, foldGutter,
} from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import {
  closeBrackets, autocompletion,
  closeBracketsKeymap, completionKeymap,
} from '@codemirror/autocomplete';
import { oneDark } from '@codemirror/theme-one-dark';
import { json } from '@codemirror/lang-json';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { html } from '@codemirror/lang-html';
import { sql } from '@codemirror/lang-sql';
import { markdown } from '@codemirror/lang-markdown';
import { css } from '@codemirror/lang-css';
import { yaml } from '@codemirror/lang-yaml';
import { StreamLanguage } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { MergeView } from '@codemirror/merge';

// ── Multi-cursor highlight ──────────────────────────────────────────────────

const multiCursorMark = Decoration.mark({ class: 'cm-multi-cursor-col' });

const multiCursorPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.build(view); }
  update(update) {
    if (update.selectionSet || update.docChanged) {
      this.decorations = this.build(update.view);
    }
  }
  build(view) {
    const sel = view.state.selection;
    if (sel.ranges.length <= 1) return Decoration.none;
    const builder = new RangeSetBuilder();
    const sorted = [...sel.ranges].sort((a, b) => a.head - b.head);
    for (const range of sorted) {
      const from = range.from;
      const to = range.to;
      if (from < to) builder.add(from, to, multiCursorMark);
      else {
        // collapsed cursor — mark just one char
        const line = view.state.doc.lineAt(from);
        const end = Math.min(from + 1, line.to);
        if (from < end) builder.add(from, end, multiCursorMark);
      }
    }
    return builder.finish();
  }
}, { decorations: v => v.decorations });

const multiCursorTheme = EditorView.baseTheme({
  '.cm-multi-cursor-col': {
    backgroundColor: 'rgba(255, 210, 30, 0.55)',
    borderRadius: '2px',
  },
});

// ── Theme ───────────────────────────────────────────────────────────────────

const lightTheme = EditorView.theme({
  '&': { background: '#ffffff', color: '#1e1e1e' },
  '.cm-content': { caretColor: '#1e1e1e' },
  '.cm-cursor': { borderLeftColor: '#1e1e1e' },
  '.cm-gutters': { background: '#f5f5f5', color: '#999', border: 'none', borderRight: '1px solid #e0e0e0' },
  '.cm-activeLineGutter': { background: '#e8f0fe' },
  '.cm-activeLine': { background: '#e8f0fe' },
  '.cm-selectionBackground, ::selection': { background: '#b3d4ff !important' },
  '.cm-matchingBracket': { background: '#c8e6c9', outline: 'none' },
  '.cm-foldPlaceholder': { background: '#e0e0e0', border: 'none' },
  '.cm-tooltip': { background: '#f5f5f5', border: '1px solid #ddd' },
  '.cm-searchMatch': { background: '#fff176' },
}, { dark: false });

const lightHighlight = syntaxHighlighting(defaultHighlightStyle);

let isDark = true;
const themeCompartment = new Compartment();

function currentThemeExtension() {
  return isDark ? oneDark : [lightTheme, lightHighlight];
}

// ── Language detection ──────────────────────────────────────────────────────

const LANG_MAP = {
  '.json': { factory: () => json(),                                        label: 'JSON' },
  '.js':   { factory: () => javascript(),                                  label: 'JavaScript' },
  '.mjs':  { factory: () => javascript(),                                  label: 'JavaScript' },
  '.cjs':  { factory: () => javascript(),                                  label: 'JavaScript' },
  '.ts':   { factory: () => javascript({ typescript: true }),              label: 'TypeScript' },
  '.tsx':  { factory: () => javascript({ jsx: true, typescript: true }),   label: 'TSX' },
  '.jsx':  { factory: () => javascript({ jsx: true }),                     label: 'JSX' },
  '.py':   { factory: () => python(),                                      label: 'Python' },
  '.html': { factory: () => html(),                                        label: 'HTML' },
  '.htm':  { factory: () => html(),                                        label: 'HTML' },
  '.sql':  { factory: () => sql(),                                         label: 'SQL' },
  '.md':   { factory: () => markdown(),                                    label: 'Markdown' },
  '.css':  { factory: () => css(),                                         label: 'CSS' },
  '.yaml': { factory: () => yaml(),                                        label: 'YAML' },
  '.yml':  { factory: () => yaml(),                                        label: 'YAML' },
  '.sh':   { factory: () => StreamLanguage.define(shell),                  label: 'Shell' },
  '.bash': { factory: () => StreamLanguage.define(shell),                  label: 'Shell' },
  '.zsh':  { factory: () => StreamLanguage.define(shell),                  label: 'Shell' },
};

function getExt(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}
function langExtension(filename) {
  return LANG_MAP[getExt(filename)]?.factory() ?? [];
}
function getLangLabel(filename) {
  return LANG_MAP[getExt(filename)]?.label ?? 'Plain Text';
}

// ── Global state ────────────────────────────────────────────────────────────

const tabs = new Map();
let activeTabId = null;
let diffView = null;
let tabCounter = 0;

// ── DOM refs ────────────────────────────────────────────────────────────────

const tabsContainer    = document.getElementById('tabs-container');
const editorContainer  = document.getElementById('editor-container');
const diffContainer    = document.getElementById('diff-container');
const langLabel        = document.getElementById('lang-label');
const statusPath       = document.getElementById('status-path');
const statusPos        = document.getElementById('status-pos');
const statusChars      = document.getElementById('status-chars');
const btnCloseDiff     = document.getElementById('btn-close-diff');
const statusEncoding   = document.getElementById('status-encoding');
const statusLineEnding = document.getElementById('status-line-ending');

// ── Editor factory ──────────────────────────────────────────────────────────

function createEditorView(content, tabId) {
  const tab = tabs.get(tabId);
  const langComp = new Compartment();
  tab.langCompartment = langComp;

  const extensions = [
    EditorState.allowMultipleSelections.of(true),
    lineNumbers(),
    highlightActiveLineGutter(),
    foldGutter(),
    dropCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    history(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    rectangularSelection({ eventFilter: e => e.altKey && e.button === 0 }),
    crosshairCursor(),
    multiCursorPlugin,
    multiCursorTheme,
    themeCompartment.of(currentThemeExtension()),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...completionKeymap,
      indentWithTab,
      { key: 'Ctrl-Shift-l', run: addCursorBelow },
      { key: 'Ctrl-Shift-k', run: addCursorAbove },
    ]),
    langComp.of(langExtension(tab.title)),
    EditorView.contentAttributes.of({ spellcheck: 'false' }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) handleDocChange(tabId, update.state);
      if (update.selectionSet || update.docChanged) updateStatusBar(tabId, update.state);
    }),
  ];

  const wrapper = document.createElement('div');
  wrapper.className = 'editor-wrapper';
  wrapper.dataset.tabId = tabId;
  editorContainer.appendChild(wrapper);

  const view = new EditorView({
    state: EditorState.create({ doc: content, extensions }),
    parent: wrapper,
  });

  return view;
}

// ── Tab lifecycle ───────────────────────────────────────────────────────────

async function createTab({ title, content, explicitPath, id, encoding, lineEnding } = {}) {
  tabCounter++;
  const tabId = id || ('tab-' + Date.now() + '-' + tabCounter);
  const tabTitle = title || 'Untitled';

  const autosavePath = await window.api.autosavePath(tabId);

  tabs.set(tabId, {
    id: tabId,
    title: tabTitle,
    autosavePath,
    explicitPath: explicitPath || null,
    isDirty: false,
    autosaveTimer: null,
    langCompartment: null,
    view: null,
    encoding: encoding || 'UTF-8',
    lineEnding: lineEnding || 'LF',
  });

  const view = createEditorView(content || '', tabId);
  tabs.get(tabId).view = view;

  appendTabButton(tabId, tabTitle);
  activateTab(tabId);
  await persistState();
}

function appendTabButton(tabId, title) {
  const btn = document.createElement('button');
  btn.className = 'tab-btn';
  btn.dataset.tabId = tabId;

  const dot = document.createElement('span');
  dot.className = 'dirty-dot';
  dot.style.display = 'none';

  const lbl = document.createElement('span');
  lbl.className = 'tab-title';
  lbl.textContent = title;

  const close = document.createElement('button');
  close.className = 'tab-close';
  close.textContent = '×';
  close.title = 'Close tab';
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(tabId);
  });

  btn.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    const currentLbl = btn.querySelector('.tab-title');
    if (currentLbl) startRenameTab(tabId, currentLbl);
  });

  btn.appendChild(dot);
  btn.appendChild(lbl);
  btn.appendChild(close);
  btn.addEventListener('click', (e) => {
    if (btn.querySelector('.tab-rename-input')) return;
    activateTab(tabId);
  });
  tabsContainer.appendChild(btn);
}

function startRenameTab(tabId, lbl) {
  const tab = tabs.get(tabId);
  if (!tab || lbl.tagName === 'INPUT') return;

  const input = document.createElement('input');
  input.className = 'tab-rename-input';
  input.value = tab.title;
  input.style.width = Math.max(lbl.offsetWidth, 80) + 'px';

  lbl.replaceWith(input);
  input.focus();
  input.select();

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter')  { e.preventDefault(); finishRename(true); }
    if (e.key === 'Escape') { finishRename(false); }
  });
  input.addEventListener('keyup',    (e) => e.stopPropagation());
  input.addEventListener('keypress', (e) => e.stopPropagation());
  input.addEventListener('input', () => {
    input.style.width = Math.max(input.value.length * 8, 80) + 'px';
  });
  input.addEventListener('blur', () => finishRename(true));

  let finished = false;
  async function finishRename(save) {
    if (finished) return;
    finished = true;
    const newTitle = save ? (input.value.trim() || tab.title) : tab.title;
    tab.title = newTitle;
    const newLbl = document.createElement('span');
    newLbl.className = 'tab-title';
    newLbl.textContent = newTitle;
    input.replaceWith(newLbl);
    if (tabId === activeTabId) {
      langLabel.textContent = getLangLabel(newTitle);
      statusPath.textContent = tab.explicitPath || newTitle;
    }
    tab.view.dispatch({
      effects: tab.langCompartment.reconfigure(langExtension(newTitle)),
    });
    await persistState();
  }
}

function activateTab(tabId) {
  if (!tabs.has(tabId)) return;

  for (const wrapper of editorContainer.querySelectorAll('.editor-wrapper')) {
    wrapper.classList.remove('active');
  }
  const wrapper = editorContainer.querySelector(`[data-tab-id="${tabId}"]`);
  if (wrapper) wrapper.classList.add('active');

  for (const btn of tabsContainer.querySelectorAll('.tab-btn')) {
    btn.classList.toggle('active', btn.dataset.tabId === tabId);
  }

  activeTabId = tabId;
  const tab = tabs.get(tabId);

  langLabel.textContent = getTabLangLabel(tabId);
  statusPath.textContent = tab.explicitPath || tab.title;
  updateStatusBar(tabId, tab.view.state);
  updateStatusBarMeta(tabId);

  tab.view.focus();
}

function getTabLangLabel(tabId) {
  const tab = tabs.get(tabId);
  return tab ? getLangLabel(tab.title) : 'Plain Text';
}

async function closeTab(tabId) {
  if (!tabs.has(tabId)) return;

  if (tabs.size === 1) await createTab();

  const ids = [...tabs.keys()];
  const idx = ids.indexOf(tabId);
  const nextId = ids[idx + 1] || ids[idx - 1];

  const tab = tabs.get(tabId);
  clearTimeout(tab.autosaveTimer);
  tab.view.destroy();

  editorContainer.querySelector(`[data-tab-id="${tabId}"]`)?.remove();
  tabsContainer.querySelector(`[data-tab-id="${tabId}"]`)?.remove();

  tabs.delete(tabId);

  if (nextId && nextId !== tabId) activateTab(nextId);
  await persistState();
}

function updateTabLabel(tabId, newTitle) {
  const btn = tabsContainer.querySelector(`[data-tab-id="${tabId}"]`);
  if (btn) btn.querySelector('.tab-title').textContent = newTitle;
}

function updateDirtyDot(tabId, dirty) {
  const btn = tabsContainer.querySelector(`[data-tab-id="${tabId}"]`);
  if (!btn) return;
  btn.querySelector('.dirty-dot').style.display = dirty ? 'block' : 'none';
}

// ── Auto-save ───────────────────────────────────────────────────────────────

function handleDocChange(tabId, state) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  tab.isDirty = true;
  updateDirtyDot(tabId, true);

  clearTimeout(tab.autosaveTimer);
  tab.autosaveTimer = setTimeout(async () => {
    const content = applyLineEnding(state.doc.toString(), tab.lineEnding);
    await window.api.writeFile(tab.autosavePath, content);
    if (tab.explicitPath) {
      await window.api.writeFile(tab.explicitPath, content);
    }
    tab.isDirty = false;
    updateDirtyDot(tabId, false);
  }, 500);
}

// ── Status bar ──────────────────────────────────────────────────────────────

function updateStatusBar(tabId, state) {
  if (tabId !== activeTabId) return;
  const cursor = state.selection.main.head;
  const line = state.doc.lineAt(cursor);
  const col = cursor - line.from + 1;
  statusPos.textContent = `Ln ${line.number}, Col ${col}`;
  statusChars.textContent = `${state.doc.length} chars`;
}

function updateStatusBarMeta(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  statusEncoding.textContent = tab.encoding;
  statusLineEnding.textContent = tab.lineEnding;
}

// ── Encoding / Line ending ──────────────────────────────────────────────────

function applyLineEnding(content, lineEnding) {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return lineEnding === 'CRLF' ? normalized.replace(/\n/g, '\r\n') : normalized;
}

function normalizeOnLoad(content) {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function detectLineEnding(content) {
  if (content.includes('\r\n')) return 'CRLF';
  return 'LF';
}

function cycleEncoding(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const options = ['UTF-8', 'Latin-1'];
  const idx = options.indexOf(tab.encoding);
  tab.encoding = options[(idx + 1) % options.length];
  if (tabId === activeTabId) statusEncoding.textContent = tab.encoding;
  persistState();
}

function cycleLineEnding(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  tab.lineEnding = tab.lineEnding === 'LF' ? 'CRLF' : 'LF';
  if (tabId === activeTabId) statusLineEnding.textContent = tab.lineEnding;
  persistState();
}

// ── Explicit save ───────────────────────────────────────────────────────────

async function saveTab(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  if (tab.explicitPath) {
    const content = applyLineEnding(tab.view.state.doc.toString(), tab.lineEnding);
    await window.api.writeFile(tab.explicitPath, content);
    tab.isDirty = false;
    updateDirtyDot(tabId, false);
  } else {
    await saveAsTab(tabId);
  }
}

async function saveAsTab(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const chosen = await window.api.saveAs(tab.title);
  if (!chosen) return;

  const content = applyLineEnding(tab.view.state.doc.toString(), tab.lineEnding);
  await window.api.writeFile(chosen, content);
  tab.explicitPath = chosen;
  tab.isDirty = false;
  updateDirtyDot(tabId, false);

  const newTitle = chosen.split('/').pop();
  tab.title = newTitle;
  updateTabLabel(tabId, newTitle);

  tab.view.dispatch({
    effects: tab.langCompartment.reconfigure(langExtension(newTitle)),
  });

  if (tabId === activeTabId) {
    langLabel.textContent = getLangLabel(newTitle);
    statusPath.textContent = chosen;
  }

  await persistState();
}

// ── State persistence ───────────────────────────────────────────────────────

async function persistState() {
  await window.api.writeState({
    version: 2,
    activeTabId,
    isDark,
    tabs: [...tabs.values()].map((t) => ({
      id: t.id,
      title: t.title,
      autosavePath: t.autosavePath,
      explicitPath: t.explicitPath,
      encoding: t.encoding,
      lineEnding: t.lineEnding,
    })),
  });
}

async function restoreState() {
  const state = await window.api.readState();
  if (!state?.tabs?.length) return false;

  if (state.isDark === false) {
    isDark = false;
    applyUITheme();
  }

  for (const t of state.tabs) {
    let content = '';
    try { content = await window.api.readFile(t.autosavePath); } catch { /* new tab */ }
    await createTab({
      title: t.title,
      content: normalizeOnLoad(content),
      explicitPath: t.explicitPath,
      id: t.id,
      encoding: t.encoding || 'UTF-8',
      lineEnding: t.lineEnding || detectLineEnding(content),
    });
  }

  const idToActivate =
    state.activeTabId && tabs.has(state.activeTabId)
      ? state.activeTabId
      : tabs.keys().next().value;
  activateTab(idToActivate);
  return true;
}

// ── Theme toggle ─────────────────────────────────────────────────────────────

function applyUITheme() {
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
  const btn = document.getElementById('btn-theme');
  if (btn) btn.textContent = isDark ? '☀ Light' : '☾ Dark';
}

async function toggleTheme() {
  isDark = !isDark;
  applyUITheme();
  const newTheme = currentThemeExtension();
  for (const tab of tabs.values()) {
    tab.view.dispatch({
      effects: themeCompartment.reconfigure(newTheme),
    });
  }
  await persistState();
}

// ── JSON formatter ────────────────────────────────────────────────────────────

function formatJSON() {
  const tab = tabs.get(activeTabId);
  if (!tab) return;
  const raw = tab.view.state.doc.toString();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    statusPath.textContent = 'Invalid JSON: ' + e.message;
    setTimeout(() => {
      statusPath.textContent = tab.explicitPath || tab.title;
    }, 3000);
    return;
  }
  const pretty = JSON.stringify(parsed, null, 2);
  tab.view.dispatch({
    changes: { from: 0, to: tab.view.state.doc.length, insert: pretty },
  });
}

// ── Open file ───────────────────────────────────────────────────────────────

async function openFileFromDialog() {
  const result = await window.api.openFile();
  if (!result) return;
  const title = result.path.split('/').pop();
  const lineEnding = detectLineEnding(result.content);
  await createTab({
    title,
    content: normalizeOnLoad(result.content),
    explicitPath: result.path,
    lineEnding,
  });
}

// ── Find & Replace panel ────────────────────────────────────────────────────

let findReplaceOpen = false;

function openFindReplace() {
  const panel = document.getElementById('find-replace-panel');
  if (!findReplaceOpen) {
    panel.hidden = false;
    findReplaceOpen = true;
    document.getElementById('fr-find').focus();
    document.getElementById('fr-find').select();
  } else {
    document.getElementById('fr-find').focus();
    document.getElementById('fr-find').select();
  }
}

function closeFindReplace() {
  document.getElementById('find-replace-panel').hidden = true;
  findReplaceOpen = false;
  const tab = tabs.get(activeTabId);
  if (tab) tab.view.focus();
}

function buildRegex(pattern, useRegex, caseSensitive) {
  try {
    const flags = caseSensitive ? 'g' : 'gi';
    const source = useRegex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

function doFind(direction = 'next') {
  const tab = tabs.get(activeTabId);
  if (!tab) return;

  const pattern = document.getElementById('fr-find').value;
  if (!pattern) return;

  const useRegex = document.getElementById('fr-regex').checked;
  const caseSensitive = document.getElementById('fr-case').checked;
  const re = buildRegex(pattern, useRegex, caseSensitive);
  if (!re) return;

  const doc = tab.view.state.doc.toString();
  const cursor = tab.view.state.selection.main;
  const startPos = direction === 'next' ? cursor.to : cursor.from - 1;

  const matches = [...doc.matchAll(re)];
  if (!matches.length) return;

  let match;
  if (direction === 'next') {
    match = matches.find(m => m.index >= startPos) || matches[0];
  } else {
    const before = matches.filter(m => m.index < startPos);
    match = before.length ? before[before.length - 1] : matches[matches.length - 1];
  }

  if (!match) return;

  tab.view.dispatch({
    selection: { anchor: match.index, head: match.index + match[0].length },
    scrollIntoView: true,
  });
}

function doReplace() {
  const tab = tabs.get(activeTabId);
  if (!tab) return;

  const pattern = document.getElementById('fr-find').value;
  const replacement = document.getElementById('fr-replace').value;
  if (!pattern) return;

  const useRegex = document.getElementById('fr-regex').checked;
  const caseSensitive = document.getElementById('fr-case').checked;
  const re = buildRegex(pattern, useRegex, caseSensitive);
  if (!re) return;

  const sel = tab.view.state.selection.main;
  const selected = tab.view.state.doc.sliceString(sel.from, sel.to);

  const singleRe = buildRegex(pattern, useRegex, caseSensitive);
  if (singleRe && singleRe.test(selected)) {
    const newText = selected.replace(singleRe, replacement);
    tab.view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: newText },
    });
  }
  doFind('next');
}

function doReplaceAll() {
  const tab = tabs.get(activeTabId);
  if (!tab) return;

  const pattern = document.getElementById('fr-find').value;
  const replacement = document.getElementById('fr-replace').value;
  if (!pattern) return;

  const useRegex = document.getElementById('fr-regex').checked;
  const caseSensitive = document.getElementById('fr-case').checked;
  const re = buildRegex(pattern, useRegex, caseSensitive);
  if (!re) return;

  const doc = tab.view.state.doc.toString();
  const newDoc = doc.replace(re, replacement);
  tab.view.dispatch({
    changes: { from: 0, to: tab.view.state.doc.length, insert: newDoc },
  });
}

// ── Find in all tabs ────────────────────────────────────────────────────────

let findAllOpen = false;

function openFindAll() {
  const panel = document.getElementById('find-all-panel');
  panel.hidden = false;
  findAllOpen = true;
  document.getElementById('fa-query').focus();
}

function closeFindAll() {
  document.getElementById('find-all-panel').hidden = true;
  findAllOpen = false;
  const tab = tabs.get(activeTabId);
  if (tab) tab.view.focus();
}

function doFindAll() {
  const query = document.getElementById('fa-query').value.trim();
  const useRegex = document.getElementById('fa-regex').checked;
  const caseSensitive = document.getElementById('fa-case').checked;
  const resultsEl = document.getElementById('fa-results');
  resultsEl.innerHTML = '';

  if (!query) return;

  const re = buildRegex(query, useRegex, caseSensitive);
  if (!re) {
    resultsEl.textContent = 'Invalid regex.';
    return;
  }

  let total = 0;

  for (const [tabId, tab] of tabs) {
    const doc = tab.view.state.doc;
    const text = doc.toString();
    const matches = [...text.matchAll(re)];
    if (!matches.length) continue;

    const groupEl = document.createElement('div');
    groupEl.className = 'fa-group';

    const header = document.createElement('div');
    header.className = 'fa-group-header';
    header.textContent = `${tab.title} (${matches.length})`;
    groupEl.appendChild(header);

    for (const match of matches) {
      const line = doc.lineAt(match.index);
      const lineNum = line.number;
      const lineText = line.text.trim().slice(0, 80);

      const row = document.createElement('div');
      row.className = 'fa-result';
      row.innerHTML = `<span class="fa-line">Ln ${lineNum}</span><span class="fa-preview">${escapeHtml(lineText)}</span>`;
      row.addEventListener('click', () => {
        activateTab(tabId);
        tab.view.dispatch({
          selection: { anchor: match.index, head: match.index + match[0].length },
          scrollIntoView: true,
        });
        tab.view.focus();
      });
      groupEl.appendChild(row);
      total++;
    }

    resultsEl.appendChild(groupEl);
  }

  if (!total) resultsEl.textContent = 'No results.';
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Diff / Compare ──────────────────────────────────────────────────────────

function showCompareModal() {
  if (tabs.size < 2) { alert('You need at least 2 tabs to compare.'); return; }
  const selA = document.getElementById('compare-a');
  const selB = document.getElementById('compare-b');
  selA.innerHTML = '';
  selB.innerHTML = '';

  for (const [id, t] of tabs) {
    const mkOpt = () => {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = t.title;
      return o;
    };
    selA.appendChild(mkOpt());
    selB.appendChild(mkOpt());
  }

  const ids = [...tabs.keys()];
  selA.value = ids[0];
  selB.value = ids[1];
  document.getElementById('compare-modal').hidden = false;
}

function openDiff(idA, idB) {
  closeDiff();
  const tabA = tabs.get(idA);
  const tabB = tabs.get(idB);

  editorContainer.hidden = true;
  diffContainer.hidden = false;
  diffContainer.innerHTML = '';
  btnCloseDiff.hidden = false;
  btnCloseDiff.textContent = `✕ Close Diff  (${tabA.title}  ↔  ${tabB.title})`;

  diffView = new MergeView({
    a: {
      doc: tabA.view.state.doc.toString(),
      extensions: [oneDark, EditorView.editable.of(false), lineNumbers()],
    },
    b: {
      doc: tabB.view.state.doc.toString(),
      extensions: [oneDark, EditorView.editable.of(false), lineNumbers()],
    },
    parent: diffContainer,
    gutter: true,
    highlightChanges: true,
    collapseUnchanged: { margin: 3, minSize: 4 },
  });
}

function closeDiff() {
  if (diffView) { diffView.destroy(); diffView = null; }
  diffContainer.hidden = true;
  diffContainer.innerHTML = '';
  editorContainer.hidden = false;
  btnCloseDiff.hidden = true;
  if (activeTabId) activateTab(activeTabId);
}

// ── Keyboard shortcuts ──────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (findReplaceOpen) { closeFindReplace(); return; }
    if (findAllOpen)     { closeFindAll(); return; }
  }

  if (!e.metaKey) return;
  const k = e.key.toLowerCase();

  if (k === 't')                      { e.preventDefault(); createTab(); }
  if (k === 'w')                      { e.preventDefault(); closeTab(activeTabId); }
  if (k === 's' && !e.shiftKey)       { e.preventDefault(); saveTab(activeTabId); }
  if (k === 's' && e.shiftKey)        { e.preventDefault(); saveAsTab(activeTabId); }
  if (k === 'f' && e.shiftKey)        { e.preventDefault(); formatJSON(); }
  if (k === 'o')                      { e.preventDefault(); openFileFromDialog(); }
  if (k === 'h')                      { e.preventDefault(); openFindReplace(); }
  if (k === 'f' && !e.shiftKey)       { e.preventDefault(); openFindReplace(); }
  if (k === 'f' && e.shiftKey && e.altKey) { e.preventDefault(); openFindAll(); }

  if (k >= '1' && k <= '9') {
    e.preventDefault();
    const arr = [...tabs.keys()];
    const t = arr[parseInt(k) - 1];
    if (t) activateTab(t);
  }
});

// ── Menu action handler ─────────────────────────────────────────────────────

window.api.onMenuAction((action) => {
  const map = {
    'new-tab':     () => createTab(),
    'open-file':   () => openFileFromDialog(),
    'save':        () => saveTab(activeTabId),
    'save-as':     () => saveAsTab(activeTabId),
    'close-tab':   () => closeTab(activeTabId),
    'format-json': () => formatJSON(),
    'compare':     () => showCompareModal(),
    'find':        () => openFindReplace(),
    'find-all':    () => openFindAll(),
  };
  map[action]?.();
});

// ── Boot ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const restored = await restoreState();
  if (!restored) await createTab();

  applyUITheme();

  document.getElementById('btn-new-tab').addEventListener('click', () => createTab());
  document.getElementById('btn-format-json').addEventListener('click', () => formatJSON());
  document.getElementById('btn-compare').addEventListener('click', () => showCompareModal());
  document.getElementById('btn-open-file').addEventListener('click', () => openFileFromDialog());
  document.getElementById('btn-theme').addEventListener('click', () => toggleTheme());
  document.getElementById('btn-find').addEventListener('click', () => openFindReplace());
  document.getElementById('btn-find-all').addEventListener('click', () => openFindAll());
  btnCloseDiff.addEventListener('click', () => closeDiff());

  // Find & Replace panel
  document.getElementById('fr-close').addEventListener('click', closeFindReplace);
  document.getElementById('fr-prev').addEventListener('click', () => doFind('prev'));
  document.getElementById('fr-next').addEventListener('click', () => doFind('next'));
  document.getElementById('fr-replace-one').addEventListener('click', doReplace);
  document.getElementById('fr-replace-all').addEventListener('click', doReplaceAll);
  document.getElementById('fr-find').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doFind(e.shiftKey ? 'prev' : 'next'); }
  });

  // Find in all tabs panel
  document.getElementById('fa-close').addEventListener('click', closeFindAll);
  document.getElementById('fa-search').addEventListener('click', doFindAll);
  document.getElementById('fa-query').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doFindAll(); }
  });

  // Status bar: click encoding/line ending to cycle
  statusEncoding.addEventListener('click', () => cycleEncoding(activeTabId));
  statusLineEnding.addEventListener('click', () => cycleLineEnding(activeTabId));

  // Compare modal
  document.getElementById('compare-go').addEventListener('click', () => {
    const a = document.getElementById('compare-a').value;
    const b = document.getElementById('compare-b').value;
    document.getElementById('compare-modal').hidden = true;
    openDiff(a, b);
  });
  document.getElementById('compare-cancel').addEventListener('click', () => {
    document.getElementById('compare-modal').hidden = true;
  });
});
