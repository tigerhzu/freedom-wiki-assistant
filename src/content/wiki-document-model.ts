/**
 * Session-level document state for the Markdown editor views.
 *
 * Wiki.js still owns the persisted document, but the extension must not use
 * the native editor or the rendered DOM as an implicit synchronization bus.
 * This model is the in-memory canonical state for one edit session. Every
 * user-originated change enters here as a transaction before it is projected
 * to another view.
 */

export type UpdateOrigin =
  | 'native'
  | 'classic-preview'
  | 'future'
  | 'formatting'
  | 'image-upload'
  | 'ai-layout'
  | 'template'
  | 'external'
  | 'system'
  | 'projection';

export type DocumentView =
  | 'native'
  | 'classic-preview'
  | 'future'
  | 'raw'
  | 'formatting'
  | 'image-upload'
  | 'ai-layout'
  | 'template'
  | 'system';

export interface EditorMutationContext {
  origin: UpdateOrigin;
  transactionId: string;
  /**
   * A visual editor projection has already updated the foreground preview.
   * Wiki.js must update its native Markdown state without running the reverse
   * preview renderer for that same transaction.
   */
  suppressPreviewRender?: boolean;
}

export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

export interface TransactionOptions {
  origin: UpdateOrigin;
  view?: DocumentView;
  transactionId?: string;
  baseRevision?: number;
  rebasedFrom?: readonly string[];
  startVisualRevision?: number;
  startInputEpoch?: number;
  /** Foreground working-copy sequence represented by this transaction. */
  workingSeq?: number;
  /** True only when the foreground visual DOM already contains this change. */
  suppressPreviewRender?: boolean;
}

export interface WorkingInputOptions {
  origin: UpdateOrigin;
  view?: DocumentView;
  transactionId?: string;
  startVisualRevision?: number;
  startInputEpoch?: number;
  /** Optional opaque foreground snapshot (for example a visual DOM snapshot). */
  snapshot?: string;
}

export interface WorkingJournalEntry {
  id: string;
  sequence: number;
  baseRevision: number;
  origin: UpdateOrigin;
  view?: DocumentView;
  startVisualRevision?: number;
  startInputEpoch?: number;
  snapshot?: string;
}

export interface WikiDocumentTransaction {
  /** Kept as `id` as well as `transactionId` for easy diagnostic inspection. */
  id: string;
  transactionId: string;
  baseRevision: number;
  origin: UpdateOrigin;
  view?: DocumentView;
  edits: readonly TextEdit[];
  resultingRevision: number;
  beforeMarkdown: string;
  afterMarkdown: string;
  rebasedFrom?: readonly string[];
  startVisualRevision?: number;
  startInputEpoch?: number;
  workingSeq: number;
  /** True only when the foreground visual DOM already contains this change. */
  suppressPreviewRender?: boolean;
}

export interface WikiDocumentConflict {
  id: string;
  baseRevision: number;
  /** Markdown snapshot shared by the local and external candidates. */
  baseMarkdown: string;
  localRevision: number;
  /** Revision observed on the external side when the conflict was created. */
  externalRevision: number;
  localMarkdown: string;
  externalMarkdown: string;
  pendingTransactions: readonly WikiDocumentTransaction[];
  origin: 'external';
  startVisualRevision?: number;
  startInputEpoch?: number;
}

export interface RebaseSuccess {
  ok: true;
  markdown: string;
  localEdit: TextEdit | null;
  externalEdit: TextEdit | null;
}

export interface RebaseConflict {
  ok: false;
  localEdit: TextEdit | null;
  externalEdit: TextEdit | null;
}

export type RebaseResult = RebaseSuccess | RebaseConflict;

export class StaleTransactionError extends Error {
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(expectedRevision: number, actualRevision: number) {
    super(`stale transaction: expected revision ${expectedRevision}, current revision ${actualRevision}`);
    this.name = 'StaleTransactionError';
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

let transactionSequence = 0;

export function nextTransactionId(): string {
  transactionSequence += 1;
  return `fwa-tx-${transactionSequence.toString(36)}`;
}

function assertEdit(edit: TextEdit, length: number): void {
  if (!Number.isInteger(edit.from) || !Number.isInteger(edit.to)) {
    throw new RangeError('text edit offsets must be integers');
  }
  if (edit.from < 0 || edit.to < edit.from || edit.to > length) {
    throw new RangeError(`text edit range is outside the document: ${edit.from}-${edit.to}`);
  }
}

/** Apply edits whose offsets all refer to the same input document. */
export function applyTextEdits(markdown: string, edits: readonly TextEdit[]): string {
  const ordered = [...edits].sort((left, right) => left.from - right.from || left.to - right.to);
  let previousEnd = 0;
  for (const edit of ordered) {
    assertEdit(edit, markdown.length);
    if (edit.from < previousEnd) throw new RangeError('text edits overlap');
    previousEnd = edit.to;
  }

  let result = markdown;
  for (const edit of [...ordered].reverse()) {
    result = result.slice(0, edit.from) + edit.insert + result.slice(edit.to);
  }
  return result;
}

/**
 * Return one conservative changed range. It is deliberately small and
 * deterministic; callers still need a revision check before applying it.
 */
export function diffText(before: string, after: string): TextEdit | null {
  if (before === after) return null;

  let prefix = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (prefix < maxPrefix && before[prefix] === after[prefix]) prefix++;

  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > prefix && afterEnd > prefix && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd--;
    afterEnd--;
  }

  return { from: prefix, to: beforeEnd, insert: after.slice(prefix, afterEnd) };
}

function editsOverlap(left: TextEdit, right: TextEdit): boolean {
  // Treat boundary insertions as conflicts as well. That is conservative, but
  // avoids silently choosing an order for two edits at the same caret.
  if (left.from === left.to && right.from === right.to) return left.from === right.from;
  if (left.from === left.to) return left.from >= right.from && left.from <= right.to;
  if (right.from === right.to) return right.from >= left.from && right.from <= left.to;
  return left.from < right.to && right.from < left.to;
}

function sameEdit(left: TextEdit | null, right: TextEdit | null): boolean {
  return Boolean(
    left &&
      right &&
      left.from === right.from &&
      left.to === right.to &&
      left.insert === right.insert,
  );
}

/**
 * Rebase a local snapshot and an external snapshot that share `base`.
 *
 * This intentionally accepts only non-overlapping single-range changes. A
 * conservative conflict is safer than guessing when Markdown structure or
 * repeated text makes a range ambiguous. More capable multi-range mapping is
 * a later phase concern.
 */
export function rebaseSnapshots(base: string, local: string, external: string): RebaseResult {
  if (local === external) {
    return { ok: true, markdown: local, localEdit: null, externalEdit: null };
  }
  if (local === base) {
    return { ok: true, markdown: external, localEdit: null, externalEdit: diffText(base, external) };
  }
  if (external === base) {
    return { ok: true, markdown: local, localEdit: diffText(base, local), externalEdit: null };
  }

  const localEdit = diffText(base, local);
  const externalEdit = diffText(base, external);
  if (!localEdit || !externalEdit) {
    return { ok: true, markdown: local === base ? external : local, localEdit, externalEdit };
  }
  if (sameEdit(localEdit, externalEdit)) {
    return { ok: true, markdown: local, localEdit, externalEdit };
  }
  if (editsOverlap(localEdit, externalEdit)) return { ok: false, localEdit, externalEdit };

  return {
    ok: true,
    markdown: applyTextEdits(base, [localEdit, externalEdit]),
    localEdit,
    externalEdit,
  };
}

export interface WikiDocumentModelOptions {
  initialRevision?: number;
  savedRevision?: number;
  initialSequence?: number;
  savedSequence?: number;
}

export class WikiDocumentModel {
  private readonly listeners = new Set<(transaction: WikiDocumentTransaction) => void>();
  private _markdown: string;
  private _revision: number;
  private _savedRevision: number;
  private _activeEditor: DocumentView | null = null;
  private _updateOrigin: UpdateOrigin | null = null;
  private _pendingTransactions: WikiDocumentTransaction[] = [];
  private _conflict: WikiDocumentConflict | null = null;
  private _currentSeq: number;
  private _modelSeq: number;
  private _ackSeq: number;
  private _renderedSeq: number;
  private _savedSeq: number;
  private _workingSnapshot: string | null = null;
  private readonly _workingJournal: WorkingJournalEntry[] = [];
  private readonly sequenceRevisions = new Map<number, number>();

  constructor(markdown: string, options: WikiDocumentModelOptions = {}) {
    this._markdown = markdown;
    this._revision = options.initialRevision ?? 0;
    this._savedRevision = options.savedRevision ?? this._revision;
    const initialSequence = options.initialSequence ?? this._revision;
    this._currentSeq = initialSequence;
    this._modelSeq = initialSequence;
    this._ackSeq = initialSequence;
    this._renderedSeq = initialSequence;
    this._savedSeq = options.savedSequence ?? (options.savedRevision ?? this._revision);
    this.sequenceRevisions.set(initialSequence, this._revision);
  }

  get markdown(): string {
    return this._markdown;
  }

  get revision(): number {
    return this._revision;
  }

  get savedRevision(): number {
    return this._savedRevision;
  }

  get dirty(): boolean {
    return this._revision !== this._savedRevision || this._currentSeq !== this._savedSeq;
  }

  /** Sequence of the latest foreground working-copy operation. */
  get currentSeq(): number {
    return this._currentSeq;
  }

  /** Sequence represented by the latest transaction accepted by the model. */
  get modelSeq(): number {
    return this._modelSeq;
  }

  /** Sequence confirmed in the native Markdown editor. */
  get ackSeq(): number {
    return this._ackSeq;
  }

  /** Sequence known to have reached the Wiki.js rendered preview. */
  get renderedSeq(): number {
    return this._renderedSeq;
  }

  /** Sequence included in the latest Save request acknowledged by Wiki.js. */
  get savedSeq(): number {
    return this._savedSeq;
  }

  get workingSnapshot(): string | null {
    return this._workingSnapshot;
  }

  get workingJournal(): readonly WorkingJournalEntry[] {
    return this._workingJournal;
  }

  revisionAtSequence(sequence: number): number | null {
    const exact = this.sequenceRevisions.get(sequence);
    if (exact !== undefined) return exact;
    let closest: number | null = null;
    let closestSequence = -Infinity;
    for (const [knownSequence, revision] of this.sequenceRevisions) {
      if (knownSequence <= sequence && knownSequence > closestSequence) {
        closestSequence = knownSequence;
        closest = revision;
      }
    }
    return closest;
  }

  get activeEditor(): DocumentView | null {
    return this._activeEditor;
  }

  get updateOrigin(): UpdateOrigin | null {
    return this._updateOrigin;
  }

  get pendingTransactions(): readonly WikiDocumentTransaction[] {
    return this._pendingTransactions;
  }

  get conflict(): WikiDocumentConflict | null {
    return this._conflict;
  }

  setActiveEditor(editor: DocumentView | null): void {
    this._activeEditor = editor;
  }

  /**
   * Record a foreground input before any serializer or projection runs. The
   * entry is intentionally cheap; callers may later coalesce several entries
   * into one Markdown transaction without losing the ordering information.
   */
  beginWorkingInput(options: WorkingInputOptions): WorkingJournalEntry {
    const entry: WorkingJournalEntry = {
      id: options.transactionId ?? nextTransactionId(),
      sequence: this._currentSeq + 1,
      baseRevision: this._revision,
      origin: options.origin,
      view: options.view,
      startVisualRevision: options.startVisualRevision,
      startInputEpoch: options.startInputEpoch,
      snapshot: options.snapshot,
    };
    this._currentSeq = entry.sequence;
    this._workingJournal.push(entry);
    this._workingSnapshot = options.snapshot ?? this._workingSnapshot;
    this._updateOrigin = options.origin;
    return entry;
  }

  updateWorkingSnapshot(sequence: number, snapshot: string): void {
    this._workingSnapshot = snapshot;
    const entry = this._workingJournal.find((item) => item.sequence === sequence);
    if (entry) entry.snapshot = snapshot;
  }

  subscribe(listener: (transaction: WikiDocumentTransaction) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  applyLocal(edits: readonly TextEdit[], options: TransactionOptions): WikiDocumentTransaction | null {
    return this.commit(edits, options, true);
  }

  applyExternal(edits: readonly TextEdit[], options: TransactionOptions): WikiDocumentTransaction | null {
    return this.commit(edits, options, false);
  }

  applyRebased(
    markdown: string,
    options: TransactionOptions,
    rebasedTransactionIds: readonly string[],
  ): WikiDocumentTransaction | null {
    const edits = diffText(this._markdown, markdown);
    if (!edits) return null;

    const tx = this.commit(
      [edits],
      { ...options, rebasedFrom: rebasedTransactionIds },
      false,
    );
    if (!tx) return null;

    const rebased = new Set(rebasedTransactionIds);
    this._pendingTransactions = this._pendingTransactions.filter((item) => !rebased.has(item.transactionId));
    this._pendingTransactions.push(tx);
    return tx;
  }

  acknowledgeThrough(revision: number): void {
    let acknowledgedSeq = this._ackSeq;
    for (const transaction of this._pendingTransactions) {
      if (transaction.resultingRevision <= revision) acknowledgedSeq = Math.max(acknowledgedSeq, transaction.workingSeq);
    }
    this._pendingTransactions = this._pendingTransactions.filter(
      (transaction) => transaction.resultingRevision > revision,
    );
    this._ackSeq = Math.max(this._ackSeq, acknowledgedSeq);
    this.pruneWorkingJournal();
  }

  markProjected(sequence: number): void {
    this._ackSeq = Math.max(this._ackSeq, Math.min(sequence, this._currentSeq));
    this.pruneWorkingJournal();
  }

  markRendered(sequence: number): void {
    this._renderedSeq = Math.max(this._renderedSeq, Math.min(sequence, this._currentSeq));
  }

  markSaved(revision = this._revision, sequence = this._currentSeq): boolean {
    if (revision > this._revision || sequence > this._currentSeq || sequence < this._savedSeq) return false;
    this._savedRevision = revision;
    this._savedSeq = sequence;
    this.pruneWorkingJournal();
    return true;
  }

  enterConflict(
    baseRevision: number,
    localMarkdown: string,
    externalMarkdown: string,
    externalRevision = this._revision,
    visualRevision?: { startVisualRevision?: number; startInputEpoch?: number },
    baseMarkdown = localMarkdown,
  ): WikiDocumentConflict {
    const conflict: WikiDocumentConflict = {
      id: nextTransactionId(),
      baseRevision,
      baseMarkdown,
      localRevision: this._revision,
      externalRevision,
      localMarkdown,
      externalMarkdown,
      pendingTransactions: [...this._pendingTransactions],
      origin: 'external',
      startVisualRevision: visualRevision?.startVisualRevision,
      startInputEpoch: visualRevision?.startInputEpoch,
    };
    this._conflict = conflict;
    this._updateOrigin = 'external';
    return conflict;
  }

  updateConflictLocal(markdown = this._markdown): void {
    if (!this._conflict) return;
    this._conflict = { ...this._conflict, localMarkdown: markdown, localRevision: this._revision };
  }

  updateConflictExternal(
    markdown: string,
    externalRevision = (this._conflict?.externalRevision ?? this._revision) + 1,
  ): void {
    if (!this._conflict) return;
    this._conflict = { ...this._conflict, externalMarkdown: markdown, externalRevision };
    this._updateOrigin = 'external';
  }

  clearConflict(): void {
    this._conflict = null;
  }

  private commit(
    edits: readonly TextEdit[],
    options: TransactionOptions,
    pending: boolean,
  ): WikiDocumentTransaction | null {
    const baseRevision = this._revision;
    if (options.baseRevision !== undefined && options.baseRevision !== baseRevision) {
      throw new StaleTransactionError(options.baseRevision, baseRevision);
    }
    const beforeMarkdown = this._markdown;
    const afterMarkdown = applyTextEdits(beforeMarkdown, edits);
    if (afterMarkdown === beforeMarkdown) return null;

    const transactionId = options.transactionId ?? nextTransactionId();
    const transaction: WikiDocumentTransaction = {
      id: transactionId,
      transactionId,
      baseRevision,
      origin: options.origin,
      view: options.view,
      edits: [...edits],
      resultingRevision: baseRevision + 1,
      beforeMarkdown,
      afterMarkdown,
      rebasedFrom: options.rebasedFrom,
      startVisualRevision: options.startVisualRevision,
      startInputEpoch: options.startInputEpoch,
      workingSeq: options.workingSeq ?? this._currentSeq + 1,
      suppressPreviewRender: options.suppressPreviewRender,
    };

    this._markdown = afterMarkdown;
    this._revision = transaction.resultingRevision;
    if (options.workingSeq === undefined) this._currentSeq = transaction.workingSeq;
    this._modelSeq = Math.max(this._modelSeq, transaction.workingSeq);
    this.sequenceRevisions.set(transaction.workingSeq, transaction.resultingRevision);
    for (const entry of this._workingJournal) {
      if (entry.sequence <= transaction.workingSeq) {
        this.sequenceRevisions.set(entry.sequence, transaction.resultingRevision);
      }
    }
    this._updateOrigin = options.origin;
    if (pending) this._pendingTransactions.push(transaction);
    this.listeners.forEach((listener) => listener(transaction));
    return transaction;
  }

  private pruneWorkingJournal(): void {
    const acknowledged = this._ackSeq;
    let removable = 0;
    while (removable < this._workingJournal.length && this._workingJournal[removable].sequence <= acknowledged) {
      removable += 1;
    }
    if (removable > 0) this._workingJournal.splice(0, removable);
  }
}
