/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import type {
  EditorAdapter,
  EditorChangeEvent,
  EditorChangeListener,
} from '../src/content/editor-adapter';
import { WikiDocumentSync } from '../src/content/document-sync';
import type { EditorMutationContext } from '../src/content/wiki-document-model';
import { VisualRevisionGate } from '../src/content/visual-revision';

class MemoryAdapter implements EditorAdapter {
  readonly kind = 'textarea' as const;
  readonly rootElement = document.createElement('textarea');
  readonly projectionContexts: EditorMutationContext[] = [];
  private readonly listeners = new Set<EditorChangeListener>();
  private selection = { start: 0, end: 0 };

  constructor(private value: string) {}

  getValue(): string { return this.value; }
  setValue(value: string, context?: EditorMutationContext): void {
    this.value = value;
    this.emit(context);
  }
  getSelection() {
    return { start: this.selection.start, end: this.selection.end, text: this.value.slice(this.selection.start, this.selection.end) };
  }
  setSelection(start: number, end: number): void { this.selection = { start, end }; }
  replaceRange(start: number, end: number, value: string, context?: EditorMutationContext): void {
    if (context?.origin === 'projection') this.projectionContexts.push(context);
    this.value = this.value.slice(0, start) + value + this.value.slice(end);
    this.emit(context);
  }
  replaceSelection(value: string, context?: EditorMutationContext): void {
    this.replaceRange(this.selection.start, this.selection.end, value, context);
  }
  insertAtCursor(value: string, context?: EditorMutationContext): void {
    this.replaceSelection(value, context);
  }
  undo(): boolean { return false; }
  redo(): boolean { return false; }
  focus(): void {}
  notifyChange(context?: EditorMutationContext): void { this.emit(context); }
  subscribe(listener: EditorChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  externalChange(value: string): void {
    this.value = value;
    this.emit();
  }

  private emit(context?: EditorMutationContext): void {
    const event: EditorChangeEvent = {
      origin: context?.origin ?? 'native',
      transactionId: context?.transactionId,
      value: this.value,
    };
    this.listeners.forEach((listener) => listener(event));
  }
}

/** Delivers the first projection only after an external edit has arrived. */
class LateProjectionAdapter extends MemoryAdapter {
  private deferNextProjection = true;
  private releaseDeferredProjection: (() => void) | null = null;
  private startedResolve: () => void = () => undefined;
  readonly firstProjectionStarted: Promise<void>;

  constructor(value: string) {
    super(value);
    this.firstProjectionStarted = new Promise<void>((resolve) => {
      this.startedResolve = resolve;
    });
  }

  override replaceRange(
    start: number,
    end: number,
    value: string,
    context?: EditorMutationContext,
  ): Promise<void> {
    if (!this.deferNextProjection) {
      super.replaceRange(start, end, value, context);
      return Promise.resolve();
    }

    this.deferNextProjection = false;
    const before = this.getValue();
    const projected = before.slice(0, start) + value + before.slice(end);
    this.startedResolve();
    return new Promise<void>((resolve) => {
      this.releaseDeferredProjection = () => {
        this.releaseDeferredProjection = null;
        super.setValue(projected, context);
        resolve();
      };
    });
  }

  releaseProjection(): void {
    this.releaseDeferredProjection?.();
  }
}

/** Rejects one in-flight projection and leaves recovery to the sync owner. */
class RejectableProjectionAdapter extends MemoryAdapter {
  private rejectFirstProjection: ((error: Error) => void) | null = null;
  private failNextProjection = true;
  private startedResolve: () => void = () => undefined;
  readonly firstProjectionStarted: Promise<void>;

  constructor(value: string) {
    super(value);
    this.firstProjectionStarted = new Promise<void>((resolve) => {
      this.startedResolve = resolve;
    });
  }

  override replaceRange(
    start: number,
    end: number,
    value: string,
    context?: EditorMutationContext,
  ): Promise<void> {
    if (context?.origin === 'projection' && this.failNextProjection) {
      this.failNextProjection = false;
      this.startedResolve();
      return new Promise<void>((_resolve, reject) => {
        this.rejectFirstProjection = reject;
      });
    }
    super.replaceRange(start, end, value, context);
    return Promise.resolve();
  }

  rejectProjection(): void {
    const reject = this.rejectFirstProjection;
    this.rejectFirstProjection = null;
    reject?.(new Error('deterministic projection failure'));
  }
}

describe('WikiDocumentSync', () => {
  it('only suppresses reverse preview rendering when the visual DOM already has the change', async () => {
    const adapter = new MemoryAdapter('plain');
    const sync = new WikiDocumentSync(adapter);

    const formatting = sync.applySnapshot('plain', '<font color="red">plain</font>', {
      origin: 'classic-preview',
      view: 'classic-preview',
      startVisualRevision: 0,
      startInputEpoch: 0,
      suppressPreviewRender: false,
      isVisualRevisionCurrent: () => true,
    });
    expect(formatting.status).toBe('applied');
    await sync.projectionQueue.whenIdle();
    expect(adapter.projectionContexts.at(-1)?.suppressPreviewRender).toBe(false);

    const visual = sync.applySnapshot(
      '<font color="red">plain</font>',
      '<font color="red">plain!</font>',
      {
        origin: 'classic-preview',
        view: 'classic-preview',
        startVisualRevision: 1,
        startInputEpoch: 1,
        suppressPreviewRender: true,
        isVisualRevisionCurrent: () => true,
      },
    );
    expect(visual.status).toBe('applied');
    await sync.projectionQueue.whenIdle();
    expect(adapter.projectionContexts.at(-1)?.suppressPreviewRender).toBe(true);
    sync.dispose();
  });

  it('coalesces a queued stale projection onto the newest model revision', async () => {
    const adapter = new MemoryAdapter('A');
    const sync = new WikiDocumentSync(adapter);

    const first = sync.applySnapshot('A', 'A1', { origin: 'future', view: 'future' });
    const second = sync.applySnapshot('A1', 'A12', { origin: 'future', view: 'future' });

    expect(first.status).toBe('applied');
    expect(second.status).toBe('applied');
    expect(sync.markdown).toBe('A12');
    await sync.projectionQueue.whenIdle();

    expect(adapter.getValue()).toBe('A12');
    expect(sync.model.pendingTransactions).toHaveLength(0);
    expect(sync.diagnostics.some((entry) => entry.stale)).toBe(true);
    sync.dispose();
  });

  it('preserves both sides when an external edit overlaps a local revision', async () => {
    const adapter = new MemoryAdapter('Ticket');
    const sync = new WikiDocumentSync(adapter, { initialRevision: 104 });

    const local = sync.applySnapshot('Ticket', 'Tickets', { origin: 'future', view: 'future' });
    expect(local.transaction?.resultingRevision).toBe(105);

    // This is the rev 106 external change arriving before the rev 105
    // projection gets a chance to run.
    adapter.externalChange('Task');

    expect(sync.hasConflict).toBe(true);
    expect(sync.model.conflict).toMatchObject({
      baseRevision: 104,
      externalRevision: 106,
      localMarkdown: 'Tickets',
      externalMarkdown: 'Task',
    });
    expect(sync.markdown).toBe('Tickets');

    await sync.projectionQueue.whenIdle();
    expect(adapter.getValue()).toBe('Task');
    expect(sync.diagnostics.some((entry) => entry.conflict)).toBe(true);

    const continuedLocalEdit = sync.applySnapshot('Tickets', 'Tickets!', {
      origin: 'future',
      view: 'future',
    });
    expect(continuedLocalEdit.status).toBe('conflict');
    expect(sync.markdown).toBe('Tickets');
    expect(sync.model.conflict?.localMarkdown).toBe('Tickets!');
    expect(adapter.getValue()).toBe('Task');
    sync.dispose();
  });

  it('does not let a late rev 105 projection overwrite the rev 106 external snapshot', async () => {
    const adapter = new LateProjectionAdapter('Ticket');
    const sync = new WikiDocumentSync(adapter, { initialRevision: 104 });

    sync.applySnapshot('Ticket', 'Tickets', { origin: 'future', view: 'future' });
    await adapter.firstProjectionStarted;

    // Local transaction is rev 105. The external edit is recorded as rev 106
    // while the rev 105 projection is still in flight.
    adapter.externalChange('Task');
    adapter.releaseProjection();
    await sync.projectionQueue.whenIdle();

    expect(sync.revision).toBe(105);
    expect(sync.model.conflict).toMatchObject({
      localMarkdown: 'Tickets',
      externalMarkdown: 'Task',
      externalRevision: 106,
    });
    expect(adapter.getValue()).toBe('Task');
    expect(sync.diagnostics.some((entry) => entry.stale && entry.conflict)).toBe(true);
    sync.dispose();
  });

  it('does not turn an untagged expected projection echo into a false conflict', async () => {
    const adapter = new LateProjectionAdapter('S0');
    const sync = new WikiDocumentSync(adapter);

    sync.applySnapshot('S0', 'S1', { origin: 'future', view: 'future' });
    await adapter.firstProjectionStarted;

    // Some editor integrations deliver a second, untagged change event after
    // the tagged projection event. The expected snapshot registry must still
    // recognize it as projection-owned while the first write is in flight.
    adapter.externalChange('S1');
    expect(sync.hasConflict).toBe(false);
    expect(sync.ackSeq).toBe(1);

    adapter.releaseProjection();
    await sync.projectionQueue.whenIdle();
    expect(adapter.getValue()).toBe('S1');
    expect(sync.hasConflict).toBe(false);
    expect(sync.ackSeq).toBe(1);
    sync.dispose();
  });

  it('rebases a non-overlapping external change and projects the merged result', async () => {
    const adapter = new MemoryAdapter('abcd');
    const sync = new WikiDocumentSync(adapter, { initialRevision: 104 });

    sync.applySnapshot('abcd', 'abXcd', { origin: 'future', view: 'future' });
    adapter.externalChange('abcd!');

    expect(sync.hasConflict).toBe(false);
    expect(sync.markdown).toBe('abXcd!');
    expect(sync.lastDiagnostic?.rebase).toBe(true);

    await sync.projectionQueue.whenIdle();
    expect(adapter.getValue()).toBe('abXcd!');
    expect(sync.model.pendingTransactions).toHaveLength(0);
    sync.dispose();
  });

  it('acknowledges a clean native snapshot without pretending the visual render is done', () => {
    const adapter = new MemoryAdapter('A');
    const sync = new WikiDocumentSync(adapter);

    adapter.externalChange('AB');

    expect(sync.markdown).toBe('AB');
    expect(sync.currentSeq).toBe(1);
    expect(sync.ackSeq).toBe(1);
    expect(sync.renderedSeq).toBe(0);
    expect(sync.queueLength).toBe(0);
    sync.dispose();
  });

  it('wakes the visual serializer when the foreground journal is ahead of Markdown', async () => {
    const adapter = new MemoryAdapter('A');
    const sync = new WikiDocumentSync(adapter);
    let recoveryRequests = 0;
    sync.setWorkingCopyRecovery(() => {
      recoveryRequests += 1;
    });

    sync.beginWorkingInput({ origin: 'future', view: 'future' });
    await Promise.resolve();

    expect(sync.currentSeq).toBe(1);
    expect(sync.modelSeq).toBe(0);
    expect(sync.ackSeq).toBe(0);
    expect(recoveryRequests).toBeGreaterThan(0);
    sync.dispose();
  });

  it('never rolls the model back when an older queued result finishes after a newer edit', async () => {
    const adapter = new MemoryAdapter('A');
    const sync = new WikiDocumentSync(adapter);

    sync.applySnapshot('A', 'A1', { origin: 'future', view: 'future' });
    sync.applySnapshot('A1', 'A12', { origin: 'future', view: 'future' });
    sync.applySnapshot('A12', 'A123', { origin: 'future', view: 'future' });

    await sync.projectionQueue.whenIdle();

    expect(sync.revision).toBe(3);
    expect(sync.markdown).toBe('A123');
    expect(adapter.getValue()).toBe('A123');
    expect(sync.diagnostics.at(-1)?.currentRevision).toBe(3);
    sync.dispose();
  });

  it('keeps S2 when the S1 visual projection finishes late', async () => {
    const adapter = new LateProjectionAdapter('S0');
    const sync = new WikiDocumentSync(adapter, { initialRevision: 104 });
    const visual = new VisualRevisionGate();

    const s1 = visual.beginInput();
    sync.applySnapshot('S0', 'S1', {
      origin: 'future',
      view: 'future',
      ...s1,
      isVisualRevisionCurrent: () => visual.isCurrent(s1),
    });
    await adapter.firstProjectionStarted;

    // S2 is produced on the live visual DOM while S1 is still in flight.
    const s2 = visual.beginInput();
    sync.applySnapshot('S1', 'S2', {
      origin: 'future',
      view: 'future',
      ...s2,
      isVisualRevisionCurrent: () => visual.isCurrent(s2),
    });

    adapter.releaseProjection();
    await sync.projectionQueue.whenIdle();

    expect(sync.markdown).toBe('S2');
    expect(adapter.getValue()).toBe('S2');
    expect(visual.currentVisualRevision).toBe(2);
    expect(visual.currentInputEpoch).toBe(2);
    expect(visual.isCurrent(s1)).toBe(false);
    expect(visual.isCurrent(s2)).toBe(true);
    expect(sync.diagnostics).toContainEqual(expect.objectContaining({
      startVisualRevision: s1.startVisualRevision,
      startInputEpoch: s1.startInputEpoch,
      stale: true,
    }));
    sync.dispose();
  });

  it('restarts the latest projection after an in-flight error leaves the worker idle', async () => {
    const adapter = new RejectableProjectionAdapter('S99');
    const sync = new WikiDocumentSync(adapter, { initialRevision: 99, initialSequence: 99 });

    const firstOperation = sync.beginWorkingInput({ origin: 'future', view: 'future' });
    sync.applySnapshot('S99', 'S100', {
      origin: 'future',
      view: 'future',
      workingSeq: firstOperation.sequence,
      transactionId: firstOperation.id,
    });
    await adapter.firstProjectionStarted;

    // The visual journal may run ahead of Markdown serialization. At the
    // moment the only projection fails, the foreground is already at S150.
    for (let sequence = 101; sequence <= 150; sequence += 1) {
      sync.beginWorkingInput({ origin: 'future', view: 'future' });
    }
    expect(sync.currentSeq).toBe(150);
    expect(sync.modelSeq).toBe(100);
    expect(sync.ackSeq).toBe(99);

    adapter.rejectProjection();
    // Let the queue settle and let the watchdog re-arm the latest model
    // snapshot before the final S150 serialization is delivered.
    await sync.projectionQueue.whenIdle();
    await Promise.resolve();
    expect(sync.projectionErrorCount).toBe(1);
    expect(sync.livenessRecoveryCount).toBeGreaterThan(0);

    const latest = sync.applySnapshot('S100', 'S150', {
      origin: 'future',
      view: 'future',
      workingSeq: 150,
    });
    expect(latest.status).toBe('applied');
    expect(sync.queueLength).toBeLessThanOrEqual(2);

    await sync.projectionQueue.whenIdle();

    expect(adapter.getValue()).toBe('S150');
    expect(sync.markdown).toBe('S150');
    expect(sync.currentSeq).toBe(150);
    expect(sync.ackSeq).toBe(150);
    expect(sync.hasConflict).toBe(false);
    expect(sync.queueLength).toBe(0);
    sync.dispose();
  });
});
