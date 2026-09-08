import type { EditorAdapter, EditorChangeEvent } from './editor-adapter';
import {
  diffText,
  rebaseSnapshots,
  type DocumentView,
  type EditorMutationContext,
  type TextEdit,
  type TransactionOptions,
  type UpdateOrigin,
  type WorkingInputOptions,
  type WorkingJournalEntry,
  type WikiDocumentConflict,
  type WikiDocumentModel,
  type WikiDocumentTransaction,
} from './wiki-document-model';
import { WikiDocumentModel as DocumentModel } from './wiki-document-model';

export interface DocumentSyncOptions {
  debug?: boolean;
  initialRevision?: number;
  savedRevision?: number;
  initialSequence?: number;
  savedSequence?: number;
}

export interface SyncApplyOptions {
  origin: UpdateOrigin;
  view?: DocumentView;
  transactionId?: string;
  baseRevision?: number;
  /** Foreground working-copy sequence represented by this snapshot. */
  workingSeq?: number;
  /** Generation of the live visual DOM that produced this snapshot. */
  startVisualRevision?: number;
  startInputEpoch?: number;
  /** True when the foreground visual DOM already contains this snapshot. */
  suppressPreviewRender?: boolean;
  /** False means the visual DOM changed while async work was in flight. */
  isVisualRevisionCurrent?: () => boolean;
}

export interface SyncApplyResult {
  status: 'applied' | 'noop' | 'conflict';
  transaction?: WikiDocumentTransaction;
  conflict?: WikiDocumentConflict;
  rebase: boolean;
}

export interface SyncDiagnostics {
  transactionId: string;
  origin: UpdateOrigin;
  baseRevision: number;
  resultingRevision: number;
  currentRevision: number;
  queueLength: number;
  stale: boolean;
  rebase: boolean;
  conflict: boolean;
  startVisualRevision?: number;
  startInputEpoch?: number;
  workingSeq?: number;
  currentSeq: number;
  modelSeq: number;
  ackSeq: number;
  renderedSeq: number;
  savedSeq: number;
  inFlightProjection: string | null;
  latestPendingProjection: string | null;
  obsoleteProjectionCount: number;
  queueCoalesceCount: number;
  livenessRecoveryCount: number;
  projectionErrorCount: number;
  deferredProjectionSeq: number | null;
}

export type DocumentSyncEventType = 'transaction' | 'projection' | 'external' | 'rebase' | 'conflict';

export interface DocumentSyncEvent {
  type: DocumentSyncEventType;
  origin: UpdateOrigin;
  transactionId?: string;
  transaction?: WikiDocumentTransaction;
  conflict?: WikiDocumentConflict;
  diagnostics: SyncDiagnostics;
  startVisualRevision?: number;
  startInputEpoch?: number;
  workingSeq?: number;
  projectionApplied?: boolean;
}

export type DocumentSyncListener = (event: DocumentSyncEvent) => void;

export interface ProjectionTask {
  transactionId: string;
  targetRevision: number;
  baseRevision?: number;
  targetSeq?: number;
  origin?: UpdateOrigin;
  run: () => void | Promise<void>;
}

/**
 * A latest-wins background queue. The operation journal remains lossless in
 * the model, while the projection layer keeps at most one in-flight task and
 * one replaceable pending task.
 */
export class SerialProjectionQueue {
  private inFlight: {
    task: ProjectionTask;
    resolve: () => void;
    reject: (error: unknown) => void;
  } | null = null;
  private pending: {
    task: ProjectionTask;
    resolve: () => void;
    reject: (error: unknown) => void;
  } | null = null;
  private idlePromise: Promise<void> = Promise.resolve();
  private resolveIdle: (() => void) | null = null;
  private _coalesceCount = 0;
  private _obsoleteCount = 0;

  get length(): number {
    return (this.inFlight ? 1 : 0) + (this.pending ? 1 : 0);
  }

  get inFlightTask(): ProjectionTask | null {
    return this.inFlight?.task ?? null;
  }

  get pendingTask(): ProjectionTask | null {
    return this.pending?.task ?? null;
  }

  get coalesceCount(): number {
    return this._coalesceCount;
  }

  get obsoleteCount(): number {
    return this._obsoleteCount;
  }

  enqueue(task: ProjectionTask): Promise<void> {
    const promise = new Promise<void>((resolve, reject) => {
      const entry = { task, resolve, reject };
      if (this.inFlight) {
        if (this.pending) {
          this._obsoleteCount += 1;
          this.pending.resolve();
        }
        this._coalesceCount += 1;
        this.pending = entry;
        return;
      }

      this.inFlight = entry;
      this.idlePromise = new Promise<void>((resolveIdle) => {
        this.resolveIdle = resolveIdle;
      });
      // Yield once so same-turn local edits can replace the pending slot before
      // any native projection is allowed to start.
      void Promise.resolve().then(() => this.runInFlight());
    });
    return promise;
  }

  whenIdle(): Promise<void> {
    return this.idlePromise;
  }

  private async runInFlight(): Promise<void> {
    const entry = this.inFlight;
    if (!entry) return;
    try {
      await entry.task.run();
      entry.resolve();
    } catch (error) {
      entry.reject(error);
    } finally {
      this.inFlight = null;
      if (this.pending) {
        this.inFlight = this.pending;
        this.pending = null;
        void this.runInFlight();
      } else {
        this.resolveIdle?.();
        this.resolveIdle = null;
      }
    }
  }
}

interface ProjectionMetadata {
  transactionId: string;
  baseRevision: number;
  targetRevision: number;
  startVisualRevision?: number;
  startInputEpoch?: number;
  workingSeq?: number;
}

interface ProjectionToken extends ProjectionMetadata {
  expectedBefore: string;
  expectedAfter: string;
}

interface ProjectionSnapshot extends ProjectionMetadata {
  markdown: string;
}

export class WikiDocumentSync {
  readonly model: WikiDocumentModel;
  readonly projectionQueue = new SerialProjectionQueue();

  private readonly listeners = new Set<DocumentSyncListener>();
  private readonly debug: boolean;
  private readonly diagnosticEntries: SyncDiagnostics[] = [];
  private readonly unsubscribeAdapter: () => void;
  private lastNativeMarkdown: string;
  private lastNativeRevision: number;
  private projectionToken: ProjectionToken | null = null;
  private readonly projectionGuards = new Map<string, () => boolean>();
  private readonly projectionWorkingSequences = new Map<string, number>();
  private readonly projectionSnapshots = new Map<string, ProjectionSnapshot>();
  private readonly progressWaiters = new Set<() => void>();
  private workingCopyRecovery: (() => void) | null = null;
  private _obsoleteProjectionCount = 0;
  private _livenessRecoveryCount = 0;
  private _projectionErrorCount = 0;
  private _deferredProjectionSeq: number | null = null;
  private livenessCheckQueued = false;
  private projectionRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private projectionFailureStreak = 0;
  private stopped = false;

  constructor(
    private readonly adapter: EditorAdapter,
    options: DocumentSyncOptions = {},
  ) {
    const initialMarkdown = adapter.getValue();
    this.model = new DocumentModel(initialMarkdown, {
      initialRevision: options.initialRevision,
      savedRevision: options.savedRevision,
      initialSequence: options.initialSequence,
      savedSequence: options.savedSequence,
    });
    this.debug = options.debug === true;
    this.lastNativeMarkdown = initialMarkdown;
    this.lastNativeRevision = this.model.revision;
    this.unsubscribeAdapter = adapter.subscribe(this.onAdapterChange);
  }

  get markdown(): string {
    return this.model.markdown;
  }

  get revision(): number {
    return this.model.revision;
  }

  get dirty(): boolean {
    return this.model.dirty;
  }

  get currentSeq(): number {
    return this.model.currentSeq;
  }

  get modelSeq(): number {
    return this.model.modelSeq;
  }

  get ackSeq(): number {
    return this.model.ackSeq;
  }

  get renderedSeq(): number {
    return this.model.renderedSeq;
  }

  get savedSeq(): number {
    return this.model.savedSeq;
  }

  get obsoleteProjectionCount(): number {
    return this._obsoleteProjectionCount + this.projectionQueue.obsoleteCount;
  }

  get queueCoalesceCount(): number {
    return this.projectionQueue.coalesceCount;
  }

  get livenessRecoveryCount(): number {
    return this._livenessRecoveryCount;
  }

  get projectionErrorCount(): number {
    return this._projectionErrorCount;
  }

  get deferredProjectionSeq(): number | null {
    return this._deferredProjectionSeq;
  }

  get diagnostics(): readonly SyncDiagnostics[] {
    return this.diagnosticEntries;
  }

  get lastDiagnostic(): SyncDiagnostics | null {
    return this.diagnosticEntries.at(-1) ?? null;
  }

  get queueLength(): number {
    return this.projectionQueue.length;
  }

  get hasConflict(): boolean {
    return this.model.conflict !== null;
  }

  get hasPendingProjection(): boolean {
    return this.model.pendingTransactions.length > 0 ||
      this.projectionQueue.length > 0 ||
      this._deferredProjectionSeq !== null;
  }

  subscribe(listener: DocumentSyncListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setActiveEditor(editor: DocumentView | null): void {
    this.model.setActiveEditor(editor);
  }

  /**
   * Let a visual owner re-arm serialization when its DOM journal is ahead of
   * the Markdown model. The callback is deliberately outside the projection
   * queue: DocumentSync cannot serialize HTML by itself, but it can detect
   * that the foreground working copy has made the queue appear idle.
   */
  setWorkingCopyRecovery(recover: (() => void) | null): void {
    this.workingCopyRecovery = recover;
  }

  beginWorkingInput(options: WorkingInputOptions): WorkingJournalEntry {
    const entry = this.model.beginWorkingInput(options);
    this.notifyProgress();
    this.scheduleProjectionLiveness();
    return entry;
  }

  updateWorkingSnapshot(sequence: number, snapshot: string): void {
    this.model.updateWorkingSnapshot(sequence, snapshot);
    this.notifyProgress();
    this.scheduleProjectionLiveness();
  }

  markRendered(sequence: number): void {
    this.model.markRendered(sequence);
    this.notifyProgress();
  }

  /**
   * Clear a previously recorded conflict and immediately let the latest model
   * snapshot re-enter the background projection pipeline. Callers that need
   * to choose a conflict resolution should update the model first; this
   * method only releases the safety barrier and never discards journaled work.
   */
  clearConflict(): void {
    this.model.clearConflict();
    this._deferredProjectionSeq = null;
    this.scheduleProjectionLiveness();
    this.notifyProgress();
  }

  applyEdits(edits: readonly TextEdit[], options: SyncApplyOptions): SyncApplyResult {
    if (this.model.conflict) {
      this.rememberDeferredProjection();
      const conflict = this.model.conflict;
      this.emitConflict(conflict, options.origin, true, options);
      return { status: 'conflict', conflict, rebase: false };
    }

    const transactionOptions: TransactionOptions = {
      origin: options.origin,
      view: options.view,
      transactionId: options.transactionId,
      baseRevision: options.baseRevision,
      workingSeq: options.workingSeq,
      startVisualRevision: options.startVisualRevision,
      startInputEpoch: options.startInputEpoch,
      suppressPreviewRender: options.suppressPreviewRender,
    };
    const transaction = this.model.applyLocal(edits, transactionOptions);
    if (!transaction) return { status: 'noop', rebase: false };
    this.model.updateConflictLocal();
    this.emit('transaction', transaction.origin, transaction, false, false);
    this.enqueueProjection(transaction, options.isVisualRevisionCurrent);
    return { status: 'applied', transaction, rebase: false };
  }

  applySnapshot(baseMarkdown: string, nextMarkdown: string, options: SyncApplyOptions): SyncApplyResult {
    if (baseMarkdown === nextMarkdown) return { status: 'noop', rebase: false };

    if (this.model.conflict) {
      // Continue recording the user's local DOM/Raw candidate without
      // changing the external side selected as the model snapshot. This is a
      // conflict update, not a silently discarded edit.
      this.model.updateConflictLocal(nextMarkdown);
      const resolved = this.tryResolveConflict(options);
      if (resolved) return resolved;
      this.rememberDeferredProjection();
      const conflict = this.model.conflict;
      this.emitConflict(conflict, options.origin, true, options);
      return { status: 'conflict', conflict, rebase: false };
    }

    if (baseMarkdown === this.model.markdown) {
      const edit = diffText(baseMarkdown, nextMarkdown);
      if (!edit) return { status: 'noop', rebase: false };
      return this.applyEdits([edit], options);
    }

    const rebased = rebaseSnapshots(baseMarkdown, nextMarkdown, this.model.markdown);
    if (!rebased.ok) {
      const conflict = this.model.enterConflict(
        this.lastNativeRevision,
        nextMarkdown,
        this.model.markdown,
        this.model.revision,
        {
          startVisualRevision: options.startVisualRevision,
          startInputEpoch: options.startInputEpoch,
        },
        baseMarkdown,
      );
      this.rememberDeferredProjection();
      this.emitConflict(conflict, options.origin, true, options);
      return { status: 'conflict', conflict, rebase: false };
    }

    if (rebased.markdown === this.model.markdown) return { status: 'noop', rebase: true };
    const rebasedFrom = this.model.pendingTransactions.map((transaction) => transaction.transactionId);
    const transaction = this.model.applyRebased(
      rebased.markdown,
      {
        origin: options.origin,
        view: options.view,
        transactionId: options.transactionId,
        workingSeq: options.workingSeq,
        startVisualRevision: options.startVisualRevision,
        startInputEpoch: options.startInputEpoch,
        suppressPreviewRender: options.suppressPreviewRender,
      },
      rebasedFrom,
    );
    if (!transaction) return { status: 'noop', rebase: true };
    this.model.updateConflictLocal();
    this.emit('rebase', transaction.origin, transaction, true, true);
    this.enqueueProjection(transaction, options.isVisualRevisionCurrent);
    return { status: 'applied', transaction, rebase: true };
  }

  replaceRange(start: number, end: number, value: string, options: SyncApplyOptions): SyncApplyResult {
    return this.applyEdits([{ from: start, to: end, insert: value }], options);
  }

  replaceSelection(value: string, options: SyncApplyOptions): SyncApplyResult {
    const selection = this.adapter.getSelection();
    return this.replaceRange(selection.start, selection.end, value, options);
  }

  insertAtCursor(value: string, options: SyncApplyOptions): SyncApplyResult {
    return this.replaceSelection(value, options);
  }

  setValue(value: string, options: SyncApplyOptions): SyncApplyResult {
    return this.applySnapshot(this.model.markdown, value, options);
  }

  /**
   * Native undo/redo remains the native editor's history in Phase 1. Its
   * resulting document change still enters this model as an external/native
   * transaction so it cannot bypass revision and conflict handling.
   */
  undoNative(): boolean {
    return this.runNativeHistory('undo');
  }

  redoNative(): boolean {
    return this.runNativeHistory('redo');
  }

  captureSaveTarget(): { revision: number; sequence: number } {
    return {
      revision: this.model.revision,
      sequence: this.model.currentSeq,
    };
  }

  async prepareWikiSave(target = this.captureSaveTarget()): Promise<{ revision: number; sequence: number } | null> {
    for (;;) {
      if (this.model.conflict) return null;

      // A visual serializer may still be converting the current foreground
      // DOM into a Markdown transaction. Waiting here never blocks the editor;
      // it only keeps the Save action pending until the target sequence exists.
      if (this.model.modelSeq < target.sequence) {
        await this.waitForProgress();
        continue;
      }

      if (this.model.ackSeq < target.sequence || this.adapter.getValue() !== this.model.markdown) {
        this.enqueueCurrentProjection();
        await this.projectionQueue.whenIdle();
        continue;
      }

      const revision = this.model.revisionAtSequence(target.sequence) ?? target.revision;
      return { revision, sequence: target.sequence };
    }
  }

  markWikiSaved(revision: number, sequence = this.model.currentSeq): boolean {
    const marked = this.model.markSaved(revision, sequence);
    this.notifyProgress();
    return marked;
  }

  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribeAdapter();
    if (this.projectionRecoveryTimer !== undefined) clearTimeout(this.projectionRecoveryTimer);
    this.projectionRecoveryTimer = undefined;
    this.livenessCheckQueued = false;
    this.notifyProgress();
    this.listeners.clear();
    this.projectionGuards.clear();
    this.projectionWorkingSequences.clear();
    this.projectionSnapshots.clear();
    this.workingCopyRecovery = null;
    this._deferredProjectionSeq = null;
  }

  detach(): void {
    this.dispose();
  }

  private readonly onAdapterChange = (event?: EditorChangeEvent): void => {
    if (this.stopped) return;
    const change = event ?? { origin: 'native' as const, value: this.adapter.getValue() };
    const nativeMarkdown = change.value;
    const projection = this.projectionToken;
    const knownProjection = this.findProjectionSnapshot(nativeMarkdown);
    const projectionMatches = Boolean(
      projection &&
        nativeMarkdown === projection.expectedAfter &&
        (!change.transactionId || change.transactionId === projection.transactionId),
    );

    const projectionEchoWhileConflicted = Boolean(
      this.model.conflict &&
        (projectionMatches || knownProjection),
    );
    if (this.model.conflict && (change.origin === 'projection' || projectionEchoWhileConflicted)) {
      this.rememberDeferredProjection();
      this.recordDiagnostics({
        transactionId: change.transactionId ?? projection?.transactionId ?? 'projection-conflict',
        origin: 'projection',
        baseRevision: (projection ?? knownProjection)?.baseRevision ?? this.model.revision,
        resultingRevision: (projection ?? knownProjection)?.targetRevision ?? this.model.revision,
        stale: true,
        rebase: false,
        conflict: true,
        startVisualRevision: projection?.startVisualRevision,
        startInputEpoch: projection?.startInputEpoch,
        workingSeq: projection?.workingSeq,
      });
      return;
    }

    const isExpectedProjection = projectionMatches || knownProjection !== null;
    if (isExpectedProjection || nativeMarkdown === this.model.markdown) {
      // Prefer the token only when it actually matches this snapshot. A
      // delayed/untagged older projection may be known while another token is
      // already active; acknowledging the active token in that case would
      // manufacture a false revision advance.
      const acknowledgedProjection = projectionMatches ? projection : knownProjection;
      const targetRevision = acknowledgedProjection?.targetRevision ?? this.model.revision;
      const targetSeq = acknowledgedProjection?.workingSeq ?? this.model.modelSeq;
      this.model.acknowledgeThrough(targetRevision);
      this.model.markProjected(targetSeq);
      this.lastNativeMarkdown = nativeMarkdown;
      this.lastNativeRevision = targetRevision;
      const stale = targetRevision !== this.model.revision;
      const transactionId = change.transactionId ?? acknowledgedProjection?.transactionId ?? `revision-${targetRevision}`;
      this.projectionToken = null;
      this.projectionGuards.delete(transactionId);
      this.projectionWorkingSequences.delete(transactionId);
      this.forgetProjectionSnapshot(nativeMarkdown, acknowledgedProjection?.transactionId);
      this.projectionFailureStreak = 0;
      this.emitProjection(transactionId, targetRevision, stale, acknowledgedProjection, true, undefined, undefined, targetSeq);
      if (stale || nativeMarkdown !== this.model.markdown || this.model.ackSeq < this.model.modelSeq) {
        if (!this.hasLatestProjectionQueued()) this.enqueueCurrentProjection();
      }
      this.scheduleProjectionLiveness();
      return;
    }

    if (change.origin === 'projection') {
      // A projection-origin event that does not match its expected snapshot
      // is stale/obsolete work, not an external user edit. Treating it as an
      // external edit can manufacture a conflict during ordinary lag.
      this.lastNativeMarkdown = nativeMarkdown;
      this.lastNativeRevision = projection?.targetRevision ?? this.lastNativeRevision;
      this.projectionToken = null;
      this.forgetProjectionSnapshot(nativeMarkdown);
      this.recordDiagnostics({
        transactionId: change.transactionId ?? projection?.transactionId ?? `projection-${this.model.revision}`,
        origin: 'projection',
        baseRevision: projection?.baseRevision ?? this.model.revision,
        resultingRevision: projection?.targetRevision ?? this.model.revision,
        stale: true,
        rebase: false,
        conflict: false,
        startVisualRevision: projection?.startVisualRevision,
        startInputEpoch: projection?.startInputEpoch,
        workingSeq: projection?.workingSeq,
      });
      this.scheduleProjectionLiveness();
      return;
    }

    // Textarea adapters emit a custom projection event followed by a native
    // input/change event for the same value. The second event is not new
    // document work and must not create another synchronization echo.
    if (!projection && !knownProjection && nativeMarkdown === this.lastNativeMarkdown) return;

    // A native editor keystroke is a real native-origin transaction. Only an
    // untagged, unknown snapshot is classified as external. Known projection
    // snapshots are handled above even when an adapter dropped its context.
    this.reconcileExternal(
      nativeMarkdown,
      change.origin,
    );
  };

  private reconcileExternal(nativeMarkdown: string, origin: UpdateOrigin): void {
    if (nativeMarkdown === this.lastNativeMarkdown) return;

    if (this.model.conflict) {
      this.lastNativeMarkdown = nativeMarkdown;
      this.model.updateConflictExternal(nativeMarkdown);
      this.lastNativeRevision = this.model.conflict?.externalRevision ?? this.lastNativeRevision;
      // This was a real native change, not an echo of the in-flight
      // projection. The old token must not claim ownership of later edits.
      this.projectionToken = null;
      const resolved = this.tryResolveConflict({ origin: 'external', view: 'native' });
      if (resolved) return;
      this.rememberDeferredProjection();
      this.emitConflict(this.model.conflict, 'external', true);
      return;
    }

    const base = this.lastNativeMarkdown;
    const local = this.model.markdown;
    if (local === base) {
      const edit = diffText(base, nativeMarkdown);
      const transaction = edit
        ? this.model.applyExternal([edit], {
            origin,
            view: 'native',
            baseRevision: this.model.revision,
          })
        : null;
      this.lastNativeMarkdown = nativeMarkdown;
      if (transaction) {
        // The native adapter already contains this snapshot. It is therefore
        // acknowledged immediately; only the rendered visual projection is
        // still allowed to lag behind it.
        this.model.markProjected(transaction.workingSeq);
        this.lastNativeRevision = transaction.resultingRevision;
        this.emit('external', origin, transaction, false, false);
      } else {
        this.lastNativeRevision = this.model.revision;
      }
      return;
    }

    const rebased = rebaseSnapshots(base, local, nativeMarkdown);
    if (!rebased.ok) {
      const conflict = this.model.enterConflict(
        this.lastNativeRevision,
        local,
        nativeMarkdown,
        this.model.revision + 1,
        undefined,
        base,
      );
      this.lastNativeMarkdown = nativeMarkdown;
      this.lastNativeRevision = conflict.externalRevision;
      this.rememberDeferredProjection();
      this.emitConflict(conflict, 'external', true);
      return;
    }

    const pendingIds = this.model.pendingTransactions.map((transaction) => transaction.transactionId);
    const transaction = this.model.applyRebased(
      rebased.markdown,
      { origin: 'external', view: 'native' },
      pendingIds,
    );
    this.lastNativeMarkdown = nativeMarkdown;
    this.lastNativeRevision = transaction?.baseRevision ?? this.model.revision;
    if (!transaction) return;
    this.emit('rebase', 'external', transaction, true, true);
    this.enqueueProjection(transaction);
  }

  private enqueueProjection(
    transaction: WikiDocumentTransaction,
    visualGuard?: () => boolean,
  ): void {
    this.forgetProjectionByTransactionId(this.projectionQueue.pendingTask?.transactionId);
    if (visualGuard) this.projectionGuards.set(transaction.transactionId, visualGuard);
    this.projectionWorkingSequences.set(transaction.transactionId, transaction.workingSeq);
    this.rememberProjectionSnapshot({
      markdown: transaction.afterMarkdown,
      transactionId: transaction.transactionId,
      baseRevision: transaction.baseRevision,
      targetRevision: transaction.resultingRevision,
      workingSeq: transaction.workingSeq,
      startVisualRevision: transaction.startVisualRevision,
      startInputEpoch: transaction.startInputEpoch,
    });
    const startVisualRevision = transaction.startVisualRevision;
    const startInputEpoch = transaction.startInputEpoch;
    const promise = this.projectionQueue.enqueue({
      transactionId: transaction.transactionId,
      baseRevision: transaction.baseRevision,
      targetRevision: transaction.resultingRevision,
      targetSeq: transaction.workingSeq,
      origin: transaction.origin,
      run: () => this.projectCurrent({
        transactionId: transaction.transactionId,
        baseRevision: transaction.baseRevision,
        targetRevision: transaction.resultingRevision,
        targetSeq: transaction.workingSeq,
        startVisualRevision,
        startInputEpoch,
        suppressPreviewRender: transaction.suppressPreviewRender,
        isVisualRevisionCurrent: this.projectionGuards.get(transaction.transactionId),
      }),
    });
    void promise.then(
      () => {
        this.projectionGuards.delete(transaction.transactionId);
        this.projectionWorkingSequences.delete(transaction.transactionId);
        this.forgetProjectionSnapshot(transaction.afterMarkdown, transaction.transactionId);
        this.scheduleProjectionLiveness();
      },
      (error: unknown) => {
        this.projectionGuards.delete(transaction.transactionId);
        this.projectionWorkingSequences.delete(transaction.transactionId);
        this.forgetProjectionSnapshot(transaction.afterMarkdown, transaction.transactionId);
        this._projectionErrorCount += 1;
        this.recordDiagnostics({
          transactionId: transaction.transactionId,
          origin: 'projection',
          baseRevision: transaction.baseRevision,
          resultingRevision: transaction.resultingRevision,
          stale: false,
          rebase: Boolean(transaction.rebasedFrom?.length),
          conflict: this.model.conflict !== null,
          startVisualRevision,
          startInputEpoch,
          workingSeq: transaction.workingSeq,
        });
        if (this.debug) console.debug('[FWA sync] projection failed', error);
        const delay = this.projectionFailureStreak === 0
          ? 0
          : Math.min(2000, 50 * 2 ** Math.min(this.projectionFailureStreak - 1, 5));
        this.projectionFailureStreak += 1;
        this.scheduleProjectionLiveness(delay);
      },
    );
  }

  private enqueueCurrentProjection(): void {
    if (this.model.conflict) {
      this.rememberDeferredProjection();
      return;
    }
    const latest = this.model.pendingTransactions.at(-1);
    const transactionId = latest?.transactionId ?? `revision-${this.model.revision}`;
    const targetRevision = this.model.revision;
    const targetSeq = this.model.modelSeq;
    const targetMarkdown = this.model.markdown;
    this.forgetProjectionByTransactionId(this.projectionQueue.pendingTask?.transactionId);
    this.rememberProjectionSnapshot({
      markdown: targetMarkdown,
      transactionId,
      baseRevision: latest?.baseRevision ?? Math.max(0, targetRevision - 1),
      targetRevision,
      workingSeq: targetSeq,
      startVisualRevision: latest?.startVisualRevision,
      startInputEpoch: latest?.startInputEpoch,
    });
    const startVisualRevision = latest?.startVisualRevision;
    const startInputEpoch = latest?.startInputEpoch;
    const promise = this.projectionQueue.enqueue({
      transactionId,
      baseRevision: latest?.baseRevision ?? Math.max(0, targetRevision - 1),
      targetRevision,
      targetSeq,
      run: () => this.projectCurrent({
        transactionId,
        baseRevision: latest?.baseRevision ?? Math.max(0, targetRevision - 1),
        targetRevision,
        targetSeq,
        startVisualRevision,
        startInputEpoch,
        suppressPreviewRender: latest?.suppressPreviewRender,
        isVisualRevisionCurrent: this.projectionGuards.get(transactionId),
      }),
    });
    void promise.then(
      () => {
        this.forgetProjectionSnapshot(targetMarkdown, transactionId);
        this.scheduleProjectionLiveness();
      },
      (error: unknown) => {
        this.forgetProjectionSnapshot(targetMarkdown, transactionId);
        this._projectionErrorCount += 1;
        this.recordDiagnostics({
          transactionId,
          origin: 'projection',
          baseRevision: latest?.baseRevision ?? Math.max(0, targetRevision - 1),
          resultingRevision: targetRevision,
          stale: true,
          rebase: false,
          conflict: this.model.conflict !== null,
          startVisualRevision,
          startInputEpoch,
          workingSeq: targetSeq,
        });
        if (this.debug) console.debug('[FWA sync] current projection failed', error);
        const delay = this.projectionFailureStreak === 0
          ? 0
          : Math.min(2000, 50 * 2 ** Math.min(this.projectionFailureStreak - 1, 5));
        this.projectionFailureStreak += 1;
        this.scheduleProjectionLiveness(delay);
      },
    );
  }

  private async projectCurrent(request: {
    transactionId: string;
    baseRevision?: number;
    targetRevision: number;
    targetSeq?: number;
    startVisualRevision?: number;
    startInputEpoch?: number;
    suppressPreviewRender?: boolean;
    isVisualRevisionCurrent?: () => boolean;
  }): Promise<void> {
    if (this.stopped) return;
    if (this.model.conflict) {
      this.rememberDeferredProjection();
      this.recordDiagnostics({
        transactionId: request.transactionId,
        origin: 'projection',
        baseRevision: request.targetRevision,
        resultingRevision: request.targetRevision,
        stale: request.targetRevision !== this.model.revision,
        rebase: false,
        conflict: true,
        startVisualRevision: request.startVisualRevision,
        startInputEpoch: request.startInputEpoch,
        workingSeq: request.targetSeq,
      });
      return;
    }

    const requestedRevision = request.targetRevision;
    if (request.isVisualRevisionCurrent && !request.isVisualRevisionCurrent()) {
      this._obsoleteProjectionCount += 1;
      this.projectionGuards.delete(request.transactionId);
      this.projectionWorkingSequences.delete(request.transactionId);
      this.recordDiagnostics({
        transactionId: request.transactionId,
        origin: 'projection',
        baseRevision: request.baseRevision ?? requestedRevision,
        resultingRevision: this.model.revision,
        stale: true,
        rebase: false,
        conflict: false,
        startVisualRevision: request.startVisualRevision,
        startInputEpoch: request.startInputEpoch,
        workingSeq: request.targetSeq,
      });
      this.emitProjection(
        request.transactionId,
        this.model.revision,
        true,
        null,
        false,
        request.startVisualRevision,
        request.startInputEpoch,
        request.targetSeq,
        request.baseRevision,
      );
      // A visual input arrived after this projection started. Do not project
      // the old visual snapshot; the input handler owns re-serializing the
      // current DOM and will enqueue the newer transaction.
      return;
    }
    let stale = requestedRevision !== this.model.revision;
    let targetRevision = this.model.revision;
    let targetSeq = this.model.modelSeq;
    let targetMarkdown = this.model.markdown;
    let nativeMarkdown = this.adapter.getValue();

    if (nativeMarkdown !== this.lastNativeMarkdown && nativeMarkdown !== targetMarkdown) {
      const knownProjection = this.findProjectionSnapshot(nativeMarkdown);
      if (knownProjection) {
        // The adapter may deliver the value before its change metadata. Treat
        // a registered snapshot as projection-owned even when another, newer
        // token is already being prepared.
        this.onAdapterChange({
          origin: 'projection',
          transactionId: knownProjection.transactionId,
          value: nativeMarkdown,
        });
      } else {
        this.reconcileExternal(nativeMarkdown, 'external');
      }
      if (this.model.conflict) return;
      targetRevision = this.model.revision;
      targetSeq = this.model.modelSeq;
      targetMarkdown = this.model.markdown;
      nativeMarkdown = this.adapter.getValue();
      stale = true;
    }

    // Let same-turn local edits settle before choosing the source snapshot.
    await Promise.resolve();
    if (this.stopped) return;
    if (this.model.conflict) return;
    if (request.isVisualRevisionCurrent && !request.isVisualRevisionCurrent()) {
      this._obsoleteProjectionCount += 1;
      this.projectionGuards.delete(request.transactionId);
      this.projectionWorkingSequences.delete(request.transactionId);
      this.recordDiagnostics({
        transactionId: request.transactionId,
        origin: 'projection',
        baseRevision: request.baseRevision ?? requestedRevision,
        resultingRevision: this.model.revision,
        stale: true,
        rebase: false,
        conflict: false,
        startVisualRevision: request.startVisualRevision,
        startInputEpoch: request.startInputEpoch,
        workingSeq: targetSeq,
      });
      this.emitProjection(
        request.transactionId,
        this.model.revision,
        true,
        null,
        false,
        request.startVisualRevision,
        request.startInputEpoch,
        targetSeq,
        request.baseRevision,
      );
      return;
    }
    if (targetRevision !== this.model.revision) {
      this.recordDiagnostics({
        transactionId: request.transactionId,
        origin: 'projection',
        baseRevision: request.baseRevision ?? requestedRevision,
        resultingRevision: targetRevision,
        stale: true,
        rebase: false,
        conflict: false,
        startVisualRevision: request.startVisualRevision,
        startInputEpoch: request.startInputEpoch,
        workingSeq: targetSeq,
      });
      if (!this.hasLatestProjectionQueued()) this.enqueueCurrentProjection();
      return;
    }

    targetRevision = this.model.revision;
    targetMarkdown = this.model.markdown;
    nativeMarkdown = this.adapter.getValue();
    const edit = diffText(nativeMarkdown, targetMarkdown);
    if (!edit) {
      this.model.acknowledgeThrough(targetRevision);
      this.model.markProjected(targetSeq);
      this.projectionFailureStreak = 0;
      this.lastNativeMarkdown = nativeMarkdown;
      this.lastNativeRevision = targetRevision;
      this.forgetProjectionSnapshot(nativeMarkdown, request.transactionId);
      this.emitProjection(
        request.transactionId,
        targetRevision,
        stale,
        null,
        true,
        request.startVisualRevision,
        request.startInputEpoch,
        targetSeq,
        request.baseRevision,
      );
      return;
    }

    const context: EditorMutationContext = {
      origin: 'projection',
      transactionId: request.transactionId,
      // Only a DOM-first visual transaction already owns the rendered DOM.
      // Source-only formatting deliberately leaves this false so Wiki.js can
      // render the new markup into the preview.
      suppressPreviewRender: request.suppressPreviewRender === true,
    };
    this.projectionToken = {
      transactionId: request.transactionId,
      baseRevision: request.baseRevision ?? Math.max(0, requestedRevision - 1),
      targetRevision,
      expectedBefore: nativeMarkdown,
      expectedAfter: targetMarkdown,
      startVisualRevision: request.startVisualRevision,
      startInputEpoch: request.startInputEpoch,
      workingSeq: targetSeq,
    };
    this.recordDiagnostics({
      transactionId: request.transactionId,
      origin: 'projection',
      baseRevision: request.baseRevision ?? requestedRevision,
      resultingRevision: targetRevision,
      stale,
      rebase: false,
      conflict: false,
      startVisualRevision: request.startVisualRevision,
      startInputEpoch: request.startInputEpoch,
      workingSeq: targetSeq,
    });

    let result: void | Promise<void>;
    try {
      result = this.adapter.replaceRange(edit.from, edit.to, edit.insert, context);
      if (result instanceof Promise) await result;
    } catch (error) {
      // An adapter can fail after partially applying its range. If the
      // projection token still owns that write, remember the observed native
      // value as the retry base; otherwise the next liveness pass could
      // misclassify the partial projection as a user/external edit and create
      // a false conflict. A real native event clears the token first and is
      // therefore still handled by reconcileExternal().
      const actual = this.adapter.getValue();
      const ownsPartialWrite = this.projectionToken?.transactionId === request.transactionId;
      if (ownsPartialWrite) {
        this.projectionToken = null;
        if (actual !== nativeMarkdown) {
          this.lastNativeMarkdown = actual;
          this.lastNativeRevision = request.baseRevision ?? this.lastNativeRevision;
        }
      }
      throw error;
    }

    if (this.stopped) return;
    const actual = this.adapter.getValue();
    if (this.model.conflict) {
      await this.restoreNativeConflict(request.transactionId, targetMarkdown);
      return;
    }
    const visualProjectionObsolete = Boolean(
      request.isVisualRevisionCurrent && !request.isVisualRevisionCurrent(),
    );
    if (actual === targetMarkdown) {
      this.model.acknowledgeThrough(targetRevision);
      this.model.markProjected(targetSeq);
      this.projectionFailureStreak = 0;
      this.lastNativeMarkdown = actual;
      this.lastNativeRevision = targetRevision;
      const completedProjection = this.projectionToken;
      this.projectionToken = null;
      this.forgetProjectionSnapshot(actual, request.transactionId);
      this.projectionWorkingSequences.delete(request.transactionId);
      const revisionChanged = targetRevision !== this.model.revision || targetSeq < this.model.modelSeq;
      const obsolete = stale || revisionChanged || visualProjectionObsolete;
      if (visualProjectionObsolete) this._obsoleteProjectionCount += 1;
      this.recordDiagnostics({
        transactionId: request.transactionId,
        origin: 'projection',
        baseRevision: request.baseRevision ?? requestedRevision,
        resultingRevision: targetRevision,
        stale: obsolete,
        rebase: false,
        conflict: false,
        startVisualRevision: request.startVisualRevision,
        startInputEpoch: request.startInputEpoch,
        workingSeq: targetSeq,
      });
      this.emitProjection(
        request.transactionId,
        targetRevision,
        obsolete,
        completedProjection,
        true,
        request.startVisualRevision,
        request.startInputEpoch,
        targetSeq,
        request.baseRevision,
      );
      if ((revisionChanged || this.model.pendingTransactions.length > 0) && !this.hasLatestProjectionQueued()) {
        this.enqueueCurrentProjection();
      }
      return;
    }

    if (actual !== nativeMarkdown) {
      const knownProjection = this.findProjectionSnapshot(actual);
      if (knownProjection) {
        this.onAdapterChange({
          origin: 'projection',
          transactionId: knownProjection.transactionId,
          value: actual,
        });
        return;
      }
      this.projectionToken = null;
      this.projectionGuards.delete(request.transactionId);
      this.projectionWorkingSequences.delete(request.transactionId);
      this.reconcileExternal(actual, 'external');
      return;
    }

    // Supported adapters are synchronous. Keep the token if an adapter has
    // not reflected the write yet so a later, correctly tagged echo can still
    // acknowledge it without treating it as an external overwrite.
    this.recordDiagnostics({
      transactionId: request.transactionId,
      origin: 'projection',
      baseRevision: request.baseRevision ?? requestedRevision,
      resultingRevision: targetRevision,
      stale: true,
      rebase: false,
      conflict: false,
      startVisualRevision: request.startVisualRevision,
      startInputEpoch: request.startInputEpoch,
      workingSeq: targetSeq,
    });
  }

  /**
   * An adapter is normally synchronous, but the queue contract also permits
   * an asynchronous projection. If a conflict arrives while that projection
   * is in flight, the old write may finish after the external edit. Restore
   * the recorded external snapshot only when the adapter still contains the
   * stale projection result; never overwrite a newer native edit.
   */
  private async restoreNativeConflict(transactionId: string, staleMarkdown: string): Promise<void> {
    const conflict = this.model.conflict;
    if (!conflict || this.stopped) return;

    const nativeMarkdown = this.adapter.getValue();
    const projectionStillOwned = this.projectionToken?.transactionId === transactionId;
    if (nativeMarkdown !== staleMarkdown && !projectionStillOwned) {
      if (nativeMarkdown !== conflict.externalMarkdown) {
        this.lastNativeMarkdown = nativeMarkdown;
        this.lastNativeRevision = conflict.externalRevision + 1;
        this.model.updateConflictExternal(nativeMarkdown, this.lastNativeRevision);
        const currentConflict = this.model.conflict;
        if (currentConflict) this.emitConflict(currentConflict, 'external', true);
      }
      return;
    }

    if (nativeMarkdown === conflict.externalMarkdown) return;
    const edit = diffText(nativeMarkdown, conflict.externalMarkdown);
    if (!edit) return;

    const context: EditorMutationContext = { origin: 'projection', transactionId };
    this.projectionToken = {
      transactionId,
      baseRevision: conflict.localRevision,
      targetRevision: conflict.externalRevision,
      expectedBefore: nativeMarkdown,
      expectedAfter: conflict.externalMarkdown,
    };
    this.recordDiagnostics({
      transactionId,
      origin: 'projection',
      baseRevision: conflict.localRevision,
      resultingRevision: conflict.externalRevision,
      stale: true,
      rebase: false,
      conflict: true,
    });

    const result = this.adapter.replaceRange(edit.from, edit.to, edit.insert, context);
    if (result instanceof Promise) await result;
    if (this.stopped) return;

    const actual = this.adapter.getValue();
    if (actual === conflict.externalMarkdown) {
      this.lastNativeMarkdown = actual;
      this.lastNativeRevision = conflict.externalRevision;
      this.projectionToken = null;
      return;
    }
    if (actual !== nativeMarkdown) {
      this.lastNativeMarkdown = actual;
      this.lastNativeRevision = conflict.externalRevision + 1;
      this.model.updateConflictExternal(actual, this.lastNativeRevision);
      this.projectionToken = null;
      const currentConflict = this.model.conflict;
      if (currentConflict) this.emitConflict(currentConflict, 'external', true);
    }
  }

  private runNativeHistory(direction: 'undo' | 'redo'): boolean {
    const before = this.model.markdown;
    const changed = direction === 'undo' ? this.adapter.undo() : this.adapter.redo();
    const after = this.adapter.getValue();
    if (!changed && after === before) return false;
    if (after !== before && after !== this.model.markdown) {
      this.reconcileExternal(after, 'native');
    }
    return after !== before;
  }

  private rememberProjectionSnapshot(snapshot: ProjectionSnapshot): void {
    this.projectionSnapshots.set(snapshot.markdown, snapshot);
  }

  private findProjectionSnapshot(markdown: string): ProjectionSnapshot | null {
    return this.projectionSnapshots.get(markdown) ?? null;
  }

  private forgetProjectionSnapshot(markdown: string, transactionId?: string): void {
    const current = this.projectionSnapshots.get(markdown);
    if (current && (transactionId === undefined || current.transactionId === transactionId)) {
      this.projectionSnapshots.delete(markdown);
    }
  }

  private forgetProjectionByTransactionId(transactionId: string | undefined): void {
    if (!transactionId) return;
    for (const [markdown, snapshot] of this.projectionSnapshots) {
      if (snapshot.transactionId === transactionId) this.projectionSnapshots.delete(markdown);
    }
  }

  private rememberDeferredProjection(): void {
    if (this.model.currentSeq <= this.model.ackSeq) return;
    this._deferredProjectionSeq = Math.max(
      this._deferredProjectionSeq ?? 0,
      this.model.currentSeq,
    );
  }

  private hasLatestProjectionQueued(): boolean {
    const latestRevision = this.model.revision;
    const latestSeq = this.model.modelSeq;
    const matches = (task: ProjectionTask | null): boolean => Boolean(
      task && task.targetRevision === latestRevision && task.targetSeq === latestSeq,
    );
    return matches(this.projectionQueue.inFlightTask) || matches(this.projectionQueue.pendingTask);
  }

  /**
   * Re-arm a projection after a task was obsolete, coalesced, or rejected.
   * This is intentionally separate from the visual serializer: if the model
   * already has a newer Markdown snapshot, the latest model snapshot is safe
   * to project even when the original task never completed.
   */
  private scheduleProjectionLiveness(delay = 0): void {
    if (this.stopped) return;
    if (delay > 0) {
      if (this.projectionRecoveryTimer !== undefined) return;
      this.projectionRecoveryTimer = setTimeout(() => {
        this.projectionRecoveryTimer = undefined;
        this.scheduleProjectionLiveness();
      }, delay);
      return;
    }
    if (this.livenessCheckQueued) return;
    this.livenessCheckQueued = true;
    void Promise.resolve().then(() => {
      this.livenessCheckQueued = false;
      this.ensureProjectionLiveness();
    });
  }

  private ensureProjectionLiveness(): void {
    if (this.stopped) return;
    if (this.model.currentSeq <= this.model.ackSeq) {
      this.projectionFailureStreak = 0;
      this._deferredProjectionSeq = null;
      return;
    }
    if (this.model.conflict) {
      // A true overlap cannot be written safely. Keep the latest sequence as
      // deferred work, but do not spin a retry loop that would overwrite the
      // external side. New local/external input or conflict resolution will
      // call this method again.
      this.rememberDeferredProjection();
      return;
    }
    if (this.projectionQueue.length > 0) return;

    // A visual serializer may have advanced currentSeq before producing its
    // Markdown transaction. Wait for that foreground conversion; if an older
    // model transaction is already ahead of ackSeq, project that snapshot now
    // so the native side cannot remain idle after a dropped task.
    if (
      this.model.modelSeq <= this.model.ackSeq &&
      this.adapter.getValue() === this.model.markdown
    ) {
      this.workingCopyRecovery?.();
      return;
    }

    this._deferredProjectionSeq = null;
    this._livenessRecoveryCount += 1;
    this.recordDiagnostics({
      transactionId: `liveness-${this.model.currentSeq}`,
      origin: 'projection',
      baseRevision: this.model.revision,
      resultingRevision: this.model.revision,
      stale: true,
      rebase: false,
      conflict: false,
      workingSeq: this.model.modelSeq,
    });
    this.enqueueCurrentProjection();
  }

  private tryResolveConflict(options: SyncApplyOptions): SyncApplyResult | null {
    const conflict = this.model.conflict;
    if (!conflict) return null;

    const rebased = rebaseSnapshots(
      conflict.baseMarkdown,
      conflict.localMarkdown,
      conflict.externalMarkdown,
    );
    if (!rebased.ok) {
      this.rememberDeferredProjection();
      return null;
    }

    const rebasedFrom = conflict.pendingTransactions.map((transaction) => transaction.transactionId);
    this.model.clearConflict();
    this._deferredProjectionSeq = null;
    const transaction = this.model.applyRebased(
      rebased.markdown,
      {
        origin: options.origin,
        view: options.view ?? 'native',
        transactionId: options.transactionId,
        workingSeq: options.workingSeq,
        startVisualRevision: options.startVisualRevision,
        startInputEpoch: options.startInputEpoch,
        suppressPreviewRender: options.suppressPreviewRender,
      },
      rebasedFrom,
    );
    if (!transaction) {
      this.enqueueCurrentProjection();
      return { status: 'noop', rebase: true };
    }

    this.emit('rebase', transaction.origin, transaction, true, true);
    this.enqueueProjection(transaction, options.isVisualRevisionCurrent);
    return { status: 'applied', transaction, rebase: true };
  }

  private emitProjection(
    transactionId: string,
    resultingRevision: number,
    stale: boolean,
    projection?: ProjectionMetadata | null,
    projectionApplied = true,
    startVisualRevision = projection?.startVisualRevision,
    startInputEpoch = projection?.startInputEpoch,
    workingSeq = projection?.workingSeq,
    baseRevision = projection?.baseRevision,
  ): void {
    this.emit(
      'projection',
      'projection',
      undefined,
      stale,
      false,
      transactionId,
      resultingRevision,
      undefined,
      startVisualRevision,
      startInputEpoch,
      projectionApplied,
      workingSeq,
      baseRevision,
    );
  }

  private emitConflict(
    conflict: WikiDocumentConflict,
    origin: UpdateOrigin,
    stale: boolean,
    visualMetadata?: Pick<SyncApplyOptions, 'startVisualRevision' | 'startInputEpoch'>,
  ): void {
    this.emit(
      'conflict',
      origin,
      undefined,
      stale,
      false,
      conflict.id,
      conflict.localRevision,
      conflict,
      visualMetadata?.startVisualRevision ?? conflict.startVisualRevision,
      visualMetadata?.startInputEpoch ?? conflict.startInputEpoch,
    );
  }

  private emit(
    type: DocumentSyncEventType,
    origin: UpdateOrigin,
    transaction: WikiDocumentTransaction | undefined,
    stale: boolean,
    rebase: boolean,
    transactionId = transaction?.transactionId ?? `revision-${this.model.revision}`,
    resultingRevision = transaction?.resultingRevision ?? this.model.revision,
    conflict?: WikiDocumentConflict,
    startVisualRevision = transaction?.startVisualRevision,
    startInputEpoch = transaction?.startInputEpoch,
    projectionApplied?: boolean,
    workingSeq = transaction?.workingSeq,
    baseRevision = transaction?.baseRevision,
  ): void {
    const diagnostics = this.recordDiagnostics({
      transactionId,
      origin,
      baseRevision: baseRevision ?? transaction?.baseRevision ?? this.model.revision,
      resultingRevision,
      stale,
      rebase,
      conflict: conflict !== undefined || this.model.conflict !== null,
      startVisualRevision,
      startInputEpoch,
      workingSeq,
    });
    const event: DocumentSyncEvent = {
      type,
      origin,
      transactionId,
      transaction,
      conflict,
      diagnostics,
      startVisualRevision,
      startInputEpoch,
      projectionApplied,
      workingSeq,
    };
    this.listeners.forEach((listener) => listener(event));
    this.notifyProgress();
  }

  private recordDiagnostics(
    input: Omit<
      SyncDiagnostics,
      | 'currentRevision'
      | 'queueLength'
      | 'currentSeq'
      | 'modelSeq'
      | 'ackSeq'
      | 'renderedSeq'
      | 'savedSeq'
      | 'inFlightProjection'
      | 'latestPendingProjection'
      | 'obsoleteProjectionCount'
      | 'queueCoalesceCount'
      | 'livenessRecoveryCount'
      | 'projectionErrorCount'
      | 'deferredProjectionSeq'
    >,
  ): SyncDiagnostics {
    const entry: SyncDiagnostics = {
      ...input,
      currentRevision: this.model.revision,
      queueLength: this.projectionQueue.length,
      currentSeq: this.model.currentSeq,
      modelSeq: this.model.modelSeq,
      ackSeq: this.model.ackSeq,
      renderedSeq: this.model.renderedSeq,
      savedSeq: this.model.savedSeq,
      inFlightProjection: this.projectionQueue.inFlightTask?.transactionId ?? null,
      latestPendingProjection: this.projectionQueue.pendingTask?.transactionId ?? null,
      obsoleteProjectionCount: this.obsoleteProjectionCount,
      queueCoalesceCount: this.queueCoalesceCount,
      livenessRecoveryCount: this._livenessRecoveryCount,
      projectionErrorCount: this._projectionErrorCount,
      deferredProjectionSeq: this._deferredProjectionSeq,
    };
    this.diagnosticEntries.push(entry);
    if (this.diagnosticEntries.length > 250) this.diagnosticEntries.shift();
    if (this.debug) console.debug('[FWA sync]', entry);
    return entry;
  }

  private waitForProgress(): Promise<void> {
    return new Promise<void>((resolve) => this.progressWaiters.add(resolve));
  }

  private notifyProgress(): void {
    const waiters = [...this.progressWaiters];
    this.progressWaiters.clear();
    waiters.forEach((resolve) => resolve());
  }
}
