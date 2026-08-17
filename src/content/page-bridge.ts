/**
 * Page-bridge: runs in the page's MAIN world (injected via a <script> tag
 * pointing at the bundled, locally-packaged page-bridge.js — no remote code).
 *
 * Purpose: editor frameworks (CodeMirror 5/6, Monaco, Ace) keep their
 * instances in page-world JS objects that the content script's isolated
 * world cannot see. This bridge exposes a small synchronous op set over a
 * shared DOM element:
 *
 *   content script                       page bridge
 *   ───────────────                      ───────────
 *   node[data-fwa-req] = {id,op,args}
 *   node.dispatchEvent('fwa:bridge-request')  → listener runs synchronously,
 *                                                executes op via editor API,
 *                                                node[data-fwa-res] = {id,ok,value}
 *   read node[data-fwa-res]
 *
 * Only editor text/selection operations, current article metadata and
 * same-origin Wiki page reads are exposed. The page-read operation exists so
 * authenticated Wiki pages are fetched in the page's own origin/session; no
 * cookies or tokens are ever returned to the extension.
 */

const BRIDGE_ELEMENT_ID = 'fwa-bridge-node';
const TARGET_ATTR = 'data-fwa-editor-target';
const CHANGE_WATCHED_ATTR = 'data-fwa-editor-change-watched';

interface Selection3 {
  text: string;
  start: number;
  end: number;
}

interface EditorOps {
  getValue(): string;
  setValue(v: string): void;
  getSelection(): Selection3;
  setSelection(start: number, end: number): void;
  replaceRange(start: number, end: number, v: string): void;
  replaceSelection(v: string): void;
  insertAtCursor(v: string): void;
  undo(): void;
  redo(): void;
  focus(): void;
}

function targetElement(): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[${TARGET_ATTR}]`);
  if (!el) throw new Error('no editor target element marked');
  return el;
}

/* ── CodeMirror 5 ── */
function cm5Ops(target: HTMLElement): EditorOps {
  const cmEl: any = target.classList.contains('CodeMirror')
    ? target
    : (target.closest('.CodeMirror') ?? target.querySelector('.CodeMirror'));
  const cm = cmEl?.CodeMirror;
  if (!cm) throw new Error('CodeMirror 5 instance not found on element');
  const doc = () => cm.getDoc();
  return {
    getValue: () => cm.getValue(),
    setValue: (v) => cm.setValue(v),
    getSelection: () => {
      const d = doc();
      const start = d.indexFromPos(d.getCursor('from'));
      const end = d.indexFromPos(d.getCursor('to'));
      return { start, end, text: d.getSelection() };
    },
    setSelection: (s, e) => {
      const d = doc();
      d.setSelection(d.posFromIndex(s), d.posFromIndex(e));
    },
    replaceRange: (s, e, v) => {
      const d = doc();
      // This is a background source update from the visual editor. Replacing
      // the range directly keeps the user's native Markdown selection and
      // viewport intact; selecting the range first makes CodeMirror jump to
      // the edited line on every visual commit.
      d.replaceRange(v, d.posFromIndex(s), d.posFromIndex(e), 'fwa');
    },
    replaceSelection: (v) => doc().replaceSelection(v, 'end'),
    insertAtCursor: (v) => doc().replaceSelection(v, 'end'),
    undo: () => doc().undo(),
    redo: () => doc().redo(),
    focus: () => cm.focus(),
  };
}

/* ── CodeMirror 6 ── */
function cm6Ops(target: HTMLElement): EditorOps {
  const content: any = target.classList.contains('cm-content')
    ? target
    : (target.querySelector('.cm-content') ?? target.closest('.cm-content'));
  const view = content?.cmView?.view;
  if (!view) throw new Error('CodeMirror 6 EditorView not found (cmView missing)');
  return {
    getValue: () => view.state.doc.toString(),
    setValue: (v) =>
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } }),
    getSelection: () => {
      const main = view.state.selection.main;
      return { start: main.from, end: main.to, text: view.state.sliceDoc(main.from, main.to) };
    },
    setSelection: (s, e) => view.dispatch({ selection: { anchor: s, head: e } }),
    replaceRange: (s, e, v) => view.dispatch({ changes: { from: s, to: e, insert: v } }),
    replaceSelection: (v) => view.dispatch(view.state.replaceSelection(v)),
    insertAtCursor: (v) => view.dispatch(view.state.replaceSelection(v)),
    undo: () => dispatchHistoryKey(view, 'z'),
    redo: () => dispatchHistoryKey(view, 'z', true),
    focus: () => view.focus(),
  };
}

/* ── Monaco ── */
function monacoOps(target: HTMLElement): EditorOps {
  const monaco: any = (window as any).monaco;
  const editors: any[] = monaco?.editor?.getEditors?.() ?? [];
  const ed = editors.find((e) => {
    const dom = e.getDomNode?.();
    return dom && (target.contains(dom) || dom.contains(target));
  });
  if (!ed) throw new Error('Monaco editor instance not found');
  const model = () => ed.getModel();
  return {
    getValue: () => model().getValue(),
    setValue: (v) => model().setValue(v),
    getSelection: () => {
      const sel = ed.getSelection();
      const m = model();
      const start = m.getOffsetAt(sel.getStartPosition());
      const end = m.getOffsetAt(sel.getEndPosition());
      return { start, end, text: m.getValueInRange(sel) };
    },
    setSelection: (s, e) => {
      const m = model();
      const sp = m.getPositionAt(s);
      const ep = m.getPositionAt(e);
      ed.setSelection({
        startLineNumber: sp.lineNumber,
        startColumn: sp.column,
        endLineNumber: ep.lineNumber,
        endColumn: ep.column,
      });
    },
    replaceRange: (s, e, v) => {
      const m = model();
      const sp = m.getPositionAt(s);
      const ep = m.getPositionAt(e);
      ed.executeEdits('fwa', [{
        range: {
          startLineNumber: sp.lineNumber,
          startColumn: sp.column,
          endLineNumber: ep.lineNumber,
          endColumn: ep.column,
        },
        text: v,
      }]);
    },
    replaceSelection: (v) => ed.executeEdits('fwa', [{ range: ed.getSelection(), text: v }]),
    insertAtCursor: (v) => ed.executeEdits('fwa', [{ range: ed.getSelection(), text: v }]),
    undo: () => ed.trigger('fwa', 'undo', null),
    redo: () => ed.trigger('fwa', 'redo', null),
    focus: () => ed.focus(),
  };
}

/* ── Ace ── */
function aceOps(target: HTMLElement): EditorOps {
  const aceEl: any = target.classList.contains('ace_editor')
    ? target
    : (target.closest('.ace_editor') ?? target.querySelector('.ace_editor'));
  const ed = aceEl?.env?.editor;
  if (!ed) throw new Error('Ace editor instance not found');
  const session = () => ed.getSession();
  const doc = () => session().getDocument();
  const posToIndex = (pos: any) => doc().positionToIndex(pos);
  const indexToPos = (i: number) => doc().indexToPosition(i);
  return {
    getValue: () => ed.getValue(),
    setValue: (v) => ed.setValue(v, -1),
    getSelection: () => {
      const range = ed.getSelectionRange();
      return {
        start: posToIndex(range.start),
        end: posToIndex(range.end),
        text: session().getTextRange(range),
      };
    },
    setSelection: (s, e) => {
      const Range = aceEl.env.editor.getSelectionRange().constructor;
      const sp = indexToPos(s);
      const ep = indexToPos(e);
      ed.getSelection().setSelectionRange(new Range(sp.row, sp.column, ep.row, ep.column));
    },
    replaceRange: (s, e, v) => {
      const sp = indexToPos(s);
      const ep = indexToPos(e);
      // Session-level replacement avoids focusing Ace or moving its current
      // selection while the visual editor flushes a background source edit.
      session().replace({ start: sp, end: ep }, v);
    },
    replaceSelection: (v) => ed.insert(v),
    insertAtCursor: (v) => ed.insert(v),
    undo: () => ed.undo(),
    redo: () => ed.redo(),
    focus: () => ed.focus(),
  };
}

/** CodeMirror 6 exposes history through its keymap rather than a public
 * `undo()` method. Dispatching the same keyboard gesture keeps this bridge
 * compatible with whichever history extension Wiki.js configured. */
function dispatchHistoryKey(view: any, key: 'z', shiftKey = false): void {
  view.focus();
  const target = view.contentDOM ?? view.dom;
  const isMac = /Mac|iPhone|iPad|iPod/i.test(
    navigator.platform || navigator.userAgent,
  );
  target?.dispatchEvent(new KeyboardEvent('keydown', {
    key,
    code: 'KeyZ',
    ctrlKey: !isMac,
    metaKey: isMac,
    shiftKey,
    bubbles: true,
    cancelable: true,
  }));
}

interface PagePathResult {
  locale: string;
  path: string;
  isNew: boolean;
}

interface WikiPageFetchResult {
  ok: boolean;
  status: number;
  url: string;
  html: string;
}

async function fetchWikiPageHtml(value: unknown): Promise<WikiPageFetchResult> {
  const target = new URL(String(value ?? ''), location.href);
  if (target.origin !== location.origin) throw new Error('only same-origin Wiki pages are allowed');

  const response = await fetch(target.toString(), {
    method: 'GET',
    credentials: 'include',
    headers: { Accept: 'text/html' },
  });
  const finalUrl = new URL(response.url || target.toString(), location.href);
  if (finalUrl.origin !== location.origin) throw new Error('Wiki page redirected outside its origin');

  return {
    ok: response.ok,
    status: response.status,
    url: finalUrl.toString(),
    html: await response.text(),
  };
}

/**
 * Wiki.js 2.x keeps the current article's canonical path in its own Vuex
 * `page` store module — the exact value Wiki.js itself uses when saving, for
 * both existing pages and a brand-new page that hasn't been saved yet
 * (confirmed on the real site: `page.path` is already populated from the
 * route before any save). Reading it here (MAIN world, where the Vue root's
 * `__vue__` reference lives) avoids ever having to guess the path from
 * document.title or hand-roll locale-stripping from the URL.
 */
function getPagePath(): PagePathResult {
  const appEl = document.getElementById('app') as (HTMLElement & { __vue__?: any }) | null;
  const store = appEl?.__vue__?.$store;
  const page = store?.state?.page;
  if (!page || typeof page.path !== 'string') {
    throw new Error('Wiki.js page store not found (unsupported version, or not on an edit page)');
  }
  return { locale: String(page.locale ?? ''), path: String(page.path ?? ''), isNew: page.id === 0 };
}

function opsFor(kind: string): EditorOps {
  const target = targetElement();
  switch (kind) {
    case 'codemirror5':
      return cm5Ops(target);
    case 'codemirror6':
      return cm6Ops(target);
    case 'monaco':
      return monacoOps(target);
    case 'ace':
      return aceOps(target);
    default:
      throw new Error(`unsupported bridge editor kind: ${kind}`);
  }
}

function emitEditorChange(target: HTMLElement): void {
  target.dispatchEvent(new CustomEvent('fwa:editor-change', { bubbles: true }));
}

/**
 * Install one page-world change hook for the currently marked editor. The
 * isolated content script cannot subscribe to CodeMirror/Monaco/Ace objects
 * directly, so changes cross the world boundary as a normal DOM event.
 */
function watchEditorChanges(kind: string): void {
  const target = targetElement();
  if (target.getAttribute(CHANGE_WATCHED_ATTR) === kind) return;

  switch (kind) {
    case 'codemirror5': {
      const cmEl: any = target.classList.contains('CodeMirror')
        ? target
        : (target.closest('.CodeMirror') ?? target.querySelector('.CodeMirror'));
      const cm = cmEl?.CodeMirror;
      if (!cm) throw new Error('CodeMirror 5 instance not found on element');
      cm.on('change', () => emitEditorChange(target));
      break;
    }
    case 'codemirror6': {
      const content: any = target.classList.contains('cm-content')
        ? target
        : (target.querySelector('.cm-content') ?? target.closest('.cm-content'));
      const view = content?.cmView?.view;
      if (!view) throw new Error('CodeMirror 6 EditorView not found (cmView missing)');
      view.dom.addEventListener('input', () => emitEditorChange(target), true);
      break;
    }
    case 'monaco': {
      const monaco: any = (window as any).monaco;
      const editors: any[] = monaco?.editor?.getEditors?.() ?? [];
      const editor = editors.find((candidate) => {
        const dom = candidate.getDomNode?.();
        return dom && (target.contains(dom) || dom.contains(target));
      });
      const model = editor?.getModel?.();
      if (!model?.onDidChangeContent) throw new Error('Monaco editor instance not found');
      model.onDidChangeContent(() => emitEditorChange(target));
      break;
    }
    case 'ace': {
      const aceEl: any = target.classList.contains('ace_editor')
        ? target
        : (target.closest('.ace_editor') ?? target.querySelector('.ace_editor'));
      const editor = aceEl?.env?.editor;
      if (!editor) throw new Error('Ace editor instance not found');
      editor.getSession().on('change', () => emitEditorChange(target));
      break;
    }
    default:
      break;
  }
  target.setAttribute(CHANGE_WATCHED_ATTR, kind);
}

function sendResponse(
  node: HTMLElement,
  response: { id: number; ok: boolean; value?: unknown; error?: string },
): void {
  node.setAttribute('data-fwa-res', JSON.stringify(response));
  node.dispatchEvent(new CustomEvent('fwa:bridge-response'));
}

async function handleRequest(node: HTMLElement): Promise<void> {
  const raw = node.getAttribute('data-fwa-req');
  if (!raw) return;
  let id = 0;
  try {
    const req = JSON.parse(raw) as { id: number; op: string; args: Record<string, any> };
    id = req.id;
    if (req.op === 'fetchWikiPageHtml') {
      sendResponse(node, {
        id,
        ok: true,
        value: await fetchWikiPageHtml(req.args?.url),
      });
      return;
    }
    if (req.op === 'getPagePath') {
      sendResponse(node, { id, ok: true, value: getPagePath() });
      return;
    }
    if (req.op === 'watchChanges') {
      watchEditorChanges(String(req.args?.kind ?? ''));
      sendResponse(node, { id, ok: true, value: null });
      return;
    }
    const { kind, value, start, end } = req.args ?? {};
    const ops = opsFor(String(kind));
    let result: unknown;
    switch (req.op) {
      case 'getValue':
        result = ops.getValue();
        break;
      case 'setValue':
        ops.setValue(String(value));
        break;
      case 'getSelection':
        result = ops.getSelection();
        break;
      case 'setSelection':
        ops.setSelection(Number(start), Number(end));
        break;
      case 'replaceRange':
        ops.replaceRange(Number(start), Number(end), String(value));
        break;
      case 'replaceSelection':
        ops.replaceSelection(String(value));
        break;
      case 'insertAtCursor':
        ops.insertAtCursor(String(value));
        break;
      case 'undo':
        ops.undo();
        break;
      case 'redo':
        ops.redo();
        break;
      case 'focus':
        ops.focus();
        break;
      default:
        throw new Error(`unknown op: ${req.op}`);
    }
    sendResponse(node, { id, ok: true, value: result ?? null });
  } catch (err) {
    sendResponse(node, {
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

(() => {
  const node = document.getElementById(BRIDGE_ELEMENT_ID);
  if (!node || node.getAttribute('data-fwa-bridge-ready') === '1') return;
  node.setAttribute('data-fwa-bridge-ready', '1');
  node.addEventListener('fwa:bridge-request', () => void handleRequest(node as HTMLElement));
})();
