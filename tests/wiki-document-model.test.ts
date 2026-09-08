import { describe, expect, it } from 'vitest';
import {
  applyTextEdits,
  diffText,
  rebaseSnapshots,
  StaleTransactionError,
  WikiDocumentModel,
} from '../src/content/wiki-document-model';

describe('WikiDocumentModel', () => {
  it('commits a transaction with a monotonic revision and pending state', () => {
    const model = new WikiDocumentModel('Ticket', { initialRevision: 104 });
    const transaction = model.applyLocal(
      [{ from: 6, to: 6, insert: 's' }],
      { origin: 'future', view: 'future', baseRevision: 104 },
    );

    expect(transaction).toMatchObject({
      id: transaction?.transactionId,
      baseRevision: 104,
      origin: 'future',
      resultingRevision: 105,
    });
    expect(model.markdown).toBe('Tickets');
    expect(model.revision).toBe(105);
    expect(model.dirty).toBe(true);
    expect(model.pendingTransactions.map((item) => item.transactionId)).toEqual([transaction?.transactionId]);
  });

  it('rejects a transaction that was based on an old revision', () => {
    const model = new WikiDocumentModel('A');
    model.applyLocal([{ from: 1, to: 1, insert: '1' }], { origin: 'native' });

    expect(() =>
      model.applyLocal(
        [{ from: 0, to: 0, insert: 'old' }],
        { origin: 'future', baseRevision: 0 },
      ),
    ).toThrow(StaleTransactionError);
    expect(model.markdown).toBe('A1');
  });

  it('rebases non-overlapping local and external changes', () => {
    const result = rebaseSnapshots('abcd', 'abXcd', 'abcd!');

    expect(result).toEqual({
      ok: true,
      markdown: 'abXcd!',
      localEdit: { from: 2, to: 2, insert: 'X' },
      externalEdit: { from: 4, to: 4, insert: '!' },
    });
  });

  it('reports an overlap as a conflict instead of choosing a winner', () => {
    const result = rebaseSnapshots('Ticket', 'Tickets', 'Task');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.localEdit).toEqual({ from: 6, to: 6, insert: 's' });
      expect(result.externalEdit).toEqual({ from: 1, to: 6, insert: 'ask' });
    }
  });

  it('keeps the text-edit helpers deterministic for multiple ranges', () => {
    const edits = [
      { from: 0, to: 1, insert: 'A' },
      { from: 3, to: 3, insert: '!' },
    ];
    expect(applyTextEdits('abc', edits)).toBe('Abc!');
    expect(diffText('abc', 'Abc!')).toEqual({ from: 0, to: 3, insert: 'Abc!' });
  });
});
