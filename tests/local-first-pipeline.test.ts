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

class DeferredAdapter implements EditorAdapter {
  readonly kind = 'textarea' as const;
  readonly rootElement = document.createElement('textarea');
  private readonly listeners = new Set<EditorChangeListener>();
  private deferFirstProjection = true;
  private releaseDeferredProjection: (() => void) | null = null;
  private startedResolve: () => void = () => undefined;
  readonly firstProjectionStarted: Promise<void>;
  readonly projectedValues: string[] = [];

  constructor(private value: string) {
    this.firstProjectionStarted = new Promise<void>((resolve) => {
      this.startedResolve = resolve;
    });
  }

  getValue(): string { return this.value; }

  setValue(value: string, context?: EditorMutationContext): void {
    this.value = value;
    this.emit(context);
  }

  getSelection() {
    return { start: 0, end: 0, text: '' };
  }

  setSelection(): void {}

  replaceRange(start: number, end: number, value: string, context?: EditorMutationContext): void | Promise<void> {
    const projected = this.value.slice(0, start) + value + this.value.slice(end);
    if (context?.origin === 'projection' && this.deferFirstProjection) {
      this.deferFirstProjection = false;
      this.startedResolve();
      return new Promise<void>((resolve) => {
        this.releaseDeferredProjection = () => {
          this.releaseDeferredProjection = null;
          this.value = projected;
          this.projectedValues.push(projected);
          this.emit(context);
          resolve();
        };
      });
    }
    this.value = projected;
    this.projectedValues.push(projected);
    this.emit(context);
  }

  replaceSelection(value: string, context?: EditorMutationContext): void | Promise<void> {
    return this.replaceRange(0, this.value.length, value, context);
  }

  insertAtCursor(value: string, context?: EditorMutationContext): void | Promise<void> {
    return this.replaceSelection(value, context);
  }

  undo(): boolean { return false; }
  redo(): boolean { return false; }
  focus(): void {}
  notifyChange(context?: EditorMutationContext): void { this.emit(context); }

  subscribe(listener: EditorChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  releaseProjection(): void {
    this.releaseDeferredProjection?.();
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

function applyWorkingSnapshot(
  sync: WikiDocumentSync,
  gate: VisualRevisionGate,
  before: string,
  after: string,
): void {
  const generation = gate.beginInput();
  const operation = sync.beginWorkingInput({
    origin: 'future',
    view: 'future',
    startVisualRevision: generation.startVisualRevision,
    startInputEpoch: generation.startInputEpoch,
  });
  const result = sync.applySnapshot(before, after, {
    origin: 'future',
    view: 'future',
    transactionId: operation.id,
    workingSeq: operation.sequence,
    startVisualRevision: generation.startVisualRevision,
    startInputEpoch: generation.startInputEpoch,
    isVisualRevisionCurrent: () => gate.isCurrent(generation),
  });
  expect(result.status).toBe('applied');
}

describe('Phase 1.3 local-first background pipeline', () => {
  it('accepts S2-S100 immediately while a five-second-equivalent projection is in flight', async () => {
    const adapter = new DeferredAdapter('S0');
    const sync = new WikiDocumentSync(adapter);
    const gate = new VisualRevisionGate();

    applyWorkingSnapshot(sync, gate, 'S0', 'S1');
    await adapter.firstProjectionStarted;

    let previous = 'S1';
    for (let sequence = 2; sequence <= 100; sequence += 1) {
      const next = `S${sequence}`;
      applyWorkingSnapshot(sync, gate, previous, next);
      previous = next;
      expect(sync.currentSeq).toBe(sequence);
      expect(sync.model.markdown).toBe(next);
      expect(sync.projectionQueue.length).toBeLessThanOrEqual(2);
    }

    // The foreground accepted every operation before the deferred projection
    // was released; no background promise was part of that input path.
    expect(sync.currentSeq).toBe(100);
    expect(sync.ackSeq).toBe(0);
    adapter.releaseProjection();
    await sync.projectionQueue.whenIdle();

    expect(adapter.getValue()).toBe('S100');
    expect(sync.markdown).toBe('S100');
    expect(sync.ackSeq).toBe(100);
    expect(sync.model.pendingTransactions).toHaveLength(0);
    sync.dispose();
  });

  it('keeps only the latest pending projection while S101-S500 build a large lag', async () => {
    const adapter = new DeferredAdapter('S100');
    const sync = new WikiDocumentSync(adapter, { initialRevision: 100, initialSequence: 100 });
    const gate = new VisualRevisionGate();

    applyWorkingSnapshot(sync, gate, 'S100', 'S101');
    await adapter.firstProjectionStarted;

    let previous = 'S101';
    for (let sequence = 102; sequence <= 500; sequence += 1) {
      const next = `S${sequence}`;
      applyWorkingSnapshot(sync, gate, previous, next);
      previous = next;
      expect(sync.currentSeq).toBe(sequence);
      expect(sync.model.markdown).toBe(next);
      expect(sync.projectionQueue.length).toBeLessThanOrEqual(2);
    }

    expect(sync.currentSeq).toBe(500);
    expect(sync.ackSeq).toBe(100);
    expect(sync.hasConflict).toBe(false);
    expect(sync.queueLength).toBe(2);
    expect(sync.queueCoalesceCount).toBeGreaterThan(390);

    adapter.releaseProjection();
    await sync.projectionQueue.whenIdle();

    expect(adapter.getValue()).toBe('S500');
    expect(sync.model.markdown).toBe('S500');
    expect(sync.currentSeq).toBe(500);
    expect(sync.ackSeq).toBe(500);
    expect(sync.model.pendingTransactions).toHaveLength(0);
    expect(sync.queueLength).toBe(0);
    expect(sync.hasConflict).toBe(false);
    sync.dispose();
  });

  it('coalesces S11-S15 into the latest pending projection', async () => {
    const adapter = new DeferredAdapter('S9');
    const sync = new WikiDocumentSync(adapter, { initialRevision: 9, initialSequence: 9 });

    sync.applySnapshot('S9', 'S10', { origin: 'future', view: 'future' });
    await adapter.firstProjectionStarted;
    for (let sequence = 11; sequence <= 15; sequence += 1) {
      const before = `S${sequence - 1}`;
      sync.applySnapshot(before, `S${sequence}`, { origin: 'future', view: 'future' });
    }

    expect(sync.projectionQueue.length).toBeLessThanOrEqual(2);
    expect(sync.queueCoalesceCount).toBeGreaterThan(0);
    adapter.releaseProjection();
    await sync.projectionQueue.whenIdle();

    expect(adapter.getValue()).toBe('S15');
    expect(adapter.projectedValues).toEqual(['S10', 'S15']);
    expect(sync.ackSeq).toBe(15);
    sync.dispose();
  });

  it('keeps the save target at S100 while S101-S103 continue in the foreground', async () => {
    const adapter = new DeferredAdapter('S99');
    const sync = new WikiDocumentSync(adapter, { initialRevision: 99, initialSequence: 99 });

    sync.applySnapshot('S99', 'S100', { origin: 'future', view: 'future' });
    await adapter.firstProjectionStarted;
    const target = sync.captureSaveTarget();
    const saveReady = sync.prepareWikiSave(target);

    sync.applySnapshot('S100', 'S101', { origin: 'future', view: 'future' });
    sync.applySnapshot('S101', 'S102', { origin: 'future', view: 'future' });
    sync.applySnapshot('S102', 'S103', { origin: 'future', view: 'future' });
    expect(sync.currentSeq).toBe(103);

    adapter.releaseProjection();
    const prepared = await saveReady;
    expect(prepared).toEqual({ revision: 100, sequence: 100 });
    expect(adapter.getValue()).toBe('S103');
    expect(sync.markWikiSaved(prepared!.revision, prepared!.sequence)).toBe(true);
    expect(sync.savedSeq).toBe(100);
    expect(sync.currentSeq).toBe(103);
    expect(sync.dirty).toBe(true);
    sync.dispose();
  });

  it('marks an old visual render obsolete without changing the foreground sequence', () => {
    const adapter = new DeferredAdapter('S20');
    const sync = new WikiDocumentSync(adapter, { initialRevision: 20, initialSequence: 20 });
    const gate = new VisualRevisionGate();
    const events: Array<{ stale: boolean; projectionApplied?: boolean }> = [];
    sync.subscribe((event) => {
      if (event.type === 'projection') {
        events.push({ stale: event.diagnostics.stale, projectionApplied: event.projectionApplied });
      }
    });

    const s1 = gate.beginInput();
    const op1 = sync.beginWorkingInput({ origin: 'future', view: 'future', ...s1 });
    sync.applySnapshot('S20', 'S20-1', {
      origin: 'future',
      view: 'future',
      transactionId: op1.id,
      workingSeq: op1.sequence,
      ...s1,
      isVisualRevisionCurrent: () => gate.isCurrent(s1),
    });
    const s2 = gate.beginInput();
    const op2 = sync.beginWorkingInput({ origin: 'future', view: 'future', ...s2 });
    sync.applySnapshot('S20-1', 'S20-2', {
      origin: 'future',
      view: 'future',
      transactionId: op2.id,
      workingSeq: op2.sequence,
      ...s2,
      isVisualRevisionCurrent: () => gate.isCurrent(s2),
    });

    expect(sync.currentSeq).toBe(22);
    expect(sync.markdown).toBe('S20-2');
    expect(gate.isCurrent(s1)).toBe(false);
    expect(events.length).toBe(0);
    sync.dispose();
  });
});
