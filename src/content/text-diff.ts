export type DiffLineType = 'equal' | 'add' | 'remove';

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

/**
 * Above this many (before-lines × after-lines) the O(n·m) LCS table would
 * cost too much memory/time for an in-page diff preview. Wiki pages/SOPs
 * comfortably fit under this; anything bigger falls back to a plain
 * before/after view (see ai-layout.ts) instead of a line diff.
 */
export const DIFF_CELL_LIMIT = 4_000_000;

export function isDiffFeasible(before: string, after: string): boolean {
  const n = before.split('\n').length;
  const m = after.split('\n').length;
  return n * m <= DIFF_CELL_LIMIT;
}

/** Classic LCS-based line diff. Pure and side-effect free. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      result.push({ type: 'equal', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: 'remove', text: a[i] });
      i++;
    } else {
      result.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) {
    result.push({ type: 'remove', text: a[i] });
    i++;
  }
  while (j < m) {
    result.push({ type: 'add', text: b[j] });
    j++;
  }
  return result;
}
