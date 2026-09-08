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

interface EditorMutationContext {
  origin?: string;
  transactionId?: string;
  suppressPreviewRender?: boolean;
}

interface EditorOps {
  getValue(): string;
  setValue(v: string, context?: EditorMutationContext): void;
  getSelection(): Selection3;
  setSelection(start: number, end: number): void;
  replaceRange(start: number, end: number, v: string, context?: EditorMutationContext): void;
  replaceSelection(v: string, context?: EditorMutationContext): void;
  insertAtCursor(v: string, context?: EditorMutationContext): void;
  undo(): void;
  redo(): void;
  focus(): void;
}

let activeChangeContext: EditorMutationContext | null = null;

const PREVIEW_RENDER_GUARD_MS = 2500;
const previewRenderGuards = new WeakMap<HTMLElement, { suppressUntil: number }>();
let activePreviewRenderGuard: { root: HTMLElement; guard: { suppressUntil: number } } | null = null;
const codeMirrorScrollGuards = new WeakMap<object, {
  suppressUntil: number;
  originalSomethingSelected: (...args: any[]) => any;
}>();

function findPropertyDescriptor(target: object | null, property: PropertyKey): PropertyDescriptor | null {
  let current: object | null = target;
  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, property);
    if (descriptor) return descriptor;
    current = Object.getPrototypeOf(current);
  }
  return null;
}

/**
 * Wiki.js' editor-markdown component keeps the preview root element but writes
 * a new innerHTML into it from its debounced Markdown watcher. A visual
 * transaction already has the correct DOM in that element, so let Wiki.js
 * update its Markdown store while making that one reverse render a no-op.
 * This is a page-world boundary guard, not a caret restoration: the live
 * foreground DOM is never replaced in the first place.
 */
function suppressWikiPreviewRender(cm: any): void {
  const root = document.querySelector<HTMLElement>('.editor-markdown-preview-content > div');
  if (root) {
    let guard = previewRenderGuards.get(root);
    if (!guard) {
      const descriptor = findPropertyDescriptor(root, 'innerHTML');
      if (descriptor?.set) {
        guard = { suppressUntil: 0 };
        try {
          Object.defineProperty(root, 'innerHTML', {
            configurable: true,
            enumerable: descriptor.enumerable ?? false,
            get: descriptor.get
              ? function(this: HTMLElement): string {
                  return descriptor.get!.call(this) as string;
                }
              : undefined,
            set: function(this: HTMLElement, value: string): void {
              if (guard!.suppressUntil > Date.now()) return;
              descriptor.set!.call(this, value);
            },
          });
          previewRenderGuards.set(root, guard);
          activePreviewRenderGuard = { root, guard };
        } catch {
          guard = undefined;
        }
      }
    }
    if (guard) {
      guard.suppressUntil = Date.now() + PREVIEW_RENDER_GUARD_MS;
      activePreviewRenderGuard = { root, guard };
    }
  }

  // Wiki.js also schedules scrollSync from CodeMirror cursorActivity. Its
  // component instance is production-private on this installation, but the
  // public CodeMirror object is available here. Make only scrollSync observe
  // a temporary "selection" during this projection window; native editing
  // releases the guard immediately in watchEditorChanges().
  scrollSyncSuppressedUntil = Date.now() + PREVIEW_RENDER_GUARD_MS;
  if (!cm || typeof cm.somethingSelected !== 'function') return;
  let scrollGuard = codeMirrorScrollGuards.get(cm);
  if (!scrollGuard) {
    const originalSomethingSelected = cm.somethingSelected;
    scrollGuard = {
      suppressUntil: 0,
      originalSomethingSelected,
    };
    try {
      cm.somethingSelected = function(this: any, ...args: any[]): any {
        return scrollGuard!.suppressUntil > Date.now()
          ? true
          : scrollGuard!.originalSomethingSelected.apply(this, args);
      };
      codeMirrorScrollGuards.set(cm, scrollGuard);
    } catch {
      scrollGuard = undefined;
    }
  }
  if (scrollGuard) scrollGuard.suppressUntil = Date.now() + PREVIEW_RENDER_GUARD_MS;
}

function releaseWikiProjectionGuards(cm?: any): void {
  scrollSyncSuppressedUntil = 0;
  if (activePreviewRenderGuard) {
    activePreviewRenderGuard.guard.suppressUntil = 0;
    activePreviewRenderGuard = null;
  }
  if (cm) {
    const guard = codeMirrorScrollGuards.get(cm);
    if (guard) guard.suppressUntil = 0;
  }
  // Do not restore DOM setters here: their normal path is already the native
  // setter, and leaving the tiny wrapper installed lets a later visual
  // projection guard the same Wiki.js root without racing component updates.
}

function withChangeContext<T>(context: EditorMutationContext | undefined, callback: () => T): T {
  const previous = activeChangeContext;
  activeChangeContext = context ?? null;
  try {
    return callback();
  } finally {
    activeChangeContext = previous;
  }
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
    setValue: (v, context) => withChangeContext(context, () => cm.setValue(v)),
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
    replaceRange: (s, e, v, context) => {
      const d = doc();
      if (context?.suppressPreviewRender) suppressWikiPreviewRender(cm);
      // This is a background source update from the visual editor. Replacing
      // the range directly keeps the user's native Markdown selection and
      // viewport intact; selecting the range first makes CodeMirror jump to
      // the edited line on every visual commit.
      // Install/arm the Wiki.js guard before replaceRange emits CodeMirror's
      // synchronous change event. Waiting for a later change listener leaves
      // a race where Wiki.js can run scrollSync first.
      try {
        guardWikiScrollSync();
      } catch {
        // Non-Wiki.js CodeMirror hosts have no Vue scrollSync to guard.
      }
      suppressWikiScrollSync();
      withChangeContext(context, () => {
        d.replaceRange(v, d.posFromIndex(s), d.posFromIndex(e), context ? 'fwa' : 'fwa-native');
      });
    },
    replaceSelection: (v, context) => withChangeContext(context, () => doc().replaceSelection(v, 'end')),
    insertAtCursor: (v, context) => withChangeContext(context, () => doc().replaceSelection(v, 'end')),
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
    setValue: (v, context) =>
      withChangeContext(context, () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } })),
    getSelection: () => {
      const main = view.state.selection.main;
      return { start: main.from, end: main.to, text: view.state.sliceDoc(main.from, main.to) };
    },
    setSelection: (s, e) => view.dispatch({ selection: { anchor: s, head: e } }),
    replaceRange: (s, e, v, context) =>
      withChangeContext(context, () => view.dispatch({ changes: { from: s, to: e, insert: v } })),
    replaceSelection: (v, context) => withChangeContext(context, () => view.dispatch(view.state.replaceSelection(v))),
    insertAtCursor: (v, context) => withChangeContext(context, () => view.dispatch(view.state.replaceSelection(v))),
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
    setValue: (v, context) => withChangeContext(context, () => model().setValue(v)),
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
    replaceRange: (s, e, v, context) => {
      const m = model();
      const sp = m.getPositionAt(s);
      const ep = m.getPositionAt(e);
      withChangeContext(context, () => ed.executeEdits('fwa', [{
          range: {
            startLineNumber: sp.lineNumber,
            startColumn: sp.column,
            endLineNumber: ep.lineNumber,
            endColumn: ep.column,
          },
          text: v,
        }]));
    },
    replaceSelection: (v, context) => withChangeContext(context, () => ed.executeEdits('fwa', [{ range: ed.getSelection(), text: v }])),
    insertAtCursor: (v, context) => withChangeContext(context, () => ed.executeEdits('fwa', [{ range: ed.getSelection(), text: v }])),
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
    setValue: (v, context) => withChangeContext(context, () => ed.setValue(v, -1)),
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
    replaceRange: (s, e, v, context) => {
      const sp = indexToPos(s);
      const ep = indexToPos(e);
      // Session-level replacement avoids focusing Ace or moving its current
      // selection while the visual editor flushes a background source edit.
      withChangeContext(context, () => session().replace({ start: sp, end: ep }, v));
    },
    replaceSelection: (v, context) => withChangeContext(context, () => ed.insert(v)),
    insertAtCursor: (v, context) => withChangeContext(context, () => ed.insert(v)),
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

/**
 * Wiki.js' editor-markdown component scroll-syncs its preview container to
 * the CodeMirror cursor line after every content change and on cursor
 * activity. Background source writes from the visual editor carry the 'fwa'
 * change origin, and syncing on those yanks the rendered document away from
 * where the user is typing. Wrap the component's scrollSync so it ignores
 * calls made shortly after an extension-originated change, while keeping the
 * native follow-the-cursor behaviour for the user's own CodeMirror edits.
 */
const SCROLL_SYNC_GUARD_MS = 2000;
let scrollSyncSuppressedUntil = 0;

function suppressWikiScrollSync(): void {
  scrollSyncSuppressedUntil = Date.now() + SCROLL_SYNC_GUARD_MS;
}

function findMarkdownEditorVm(vm: any, depth = 0): any {
  if (!vm || depth > 20) return null;
  if (typeof vm.scrollSync === 'function' && vm.cm) return vm;
  for (const child of vm.$children ?? []) {
    const found = findMarkdownEditorVm(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function guardWikiScrollSync(): void {
  const appEl = document.getElementById('app') as (HTMLElement & { __vue__?: any }) | null;
  const vm = findMarkdownEditorVm(appEl?.__vue__);
  if (!vm) throw new Error('Wiki.js markdown editor component not found');
  if (vm.__fwaScrollSyncGuarded) return;
  vm.__fwaScrollSyncGuarded = true;

  vm.cm.on('change', (_cm: unknown, change: any) => {
    if (change?.origin === 'fwa') suppressWikiScrollSync();
  });
  const original = vm.scrollSync.bind(vm);
  vm.scrollSync = (...args: unknown[]) => {
    if (Date.now() < scrollSyncSuppressedUntil) return;
    original(...args);
  };
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

function emitEditorChange(target: HTMLElement, context: EditorMutationContext | undefined = activeChangeContext ?? undefined): void {
  const detail = {
    origin: context?.origin ?? 'native',
    transactionId: context?.transactionId,
  };
  target.dispatchEvent(new CustomEvent('fwa:editor-change', { bubbles: true, detail }));
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
       cm.on('change', (_cm: unknown, change: any) => {
         const context = activeChangeContext;
         if (change?.origin !== 'fwa' || !context?.suppressPreviewRender) {
           releaseWikiProjectionGuards(cm);
         }
         emitEditorChange(target, context ?? (change?.origin === 'fwa' ? { origin: 'projection' } : undefined));
       });
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
    if (req.op === 'guardScrollSync') {
      guardWikiScrollSync();
      sendResponse(node, { id, ok: true, value: null });
      return;
    }
     const { kind, value, start, end, context } = req.args ?? {};
    const ops = opsFor(String(kind));
    let result: unknown;
    switch (req.op) {
      case 'getValue':
        result = ops.getValue();
        break;
      case 'setValue':
         ops.setValue(String(value), context);
        break;
      case 'getSelection':
        result = ops.getSelection();
        break;
      case 'setSelection':
        ops.setSelection(Number(start), Number(end));
        break;
      case 'replaceRange':
         ops.replaceRange(Number(start), Number(end), String(value), context);
        break;
      case 'replaceSelection':
         ops.replaceSelection(String(value), context);
        break;
      case 'insertAtCursor':
         ops.insertAtCursor(String(value), context);
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

// Keep the page bridge importable by the type-checker and integration tests.
// Vite still emits this entry as an IIFE for the injected page-world script.
export {};
