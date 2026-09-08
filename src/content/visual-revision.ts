/**
 * Generation state for the live Classic/Future visual surface.
 *
 * Document revisions describe Markdown snapshots. These counters describe the
 * DOM draft and its asynchronous lifecycle, so a late serializer/render
 * callback cannot mistake an older visual surface for the current one.
 */
export interface VisualRevisionToken {
  startVisualRevision: number;
  startInputEpoch: number;
}

export class VisualRevisionGate {
  private visualRevision = 0;
  private inputEpoch = 0;

  get currentVisualRevision(): number {
    return this.visualRevision;
  }

  get currentInputEpoch(): number {
    return this.inputEpoch;
  }

  /** Mark a user-visible visual draft mutation and return its generation. */
  beginInput(): VisualRevisionToken {
    this.visualRevision += 1;
    this.inputEpoch += 1;
    return this.snapshot();
  }

  snapshot(): VisualRevisionToken {
    return {
      startVisualRevision: this.visualRevision,
      startInputEpoch: this.inputEpoch,
    };
  }

  isCurrent(token: VisualRevisionToken): boolean {
    return token.startVisualRevision === this.visualRevision && token.startInputEpoch === this.inputEpoch;
  }
}
