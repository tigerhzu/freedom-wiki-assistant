/**
 * Where the generated layout-rules block lives, and how it is spliced in.
 *
 * Deliberately side-effect free and separate from gen-layout-rules.mjs: the
 * drift test in tests/layout-rules.test.ts imports this, and importing the
 * generator itself would rewrite the file the test is supposed to be checking
 * (turning a failing drift check into a silent auto-fix).
 */

export const SKILL_REFERENCE_PATH = '.claude/skills/wiki-layout-extension/references/color-annotation.md';
export const BEGIN_MARKER = '<!-- BEGIN GENERATED: layout-rules — 由 npm run gen:layout-rules 產生，請勿手改 -->';
export const END_MARKER = '<!-- END GENERATED: layout-rules -->';

/** Returns `existing` with the region between the markers replaced by `generated`. */
export function spliceGeneratedBlock(existing: string, generated: string): string {
  const start = existing.indexOf(BEGIN_MARKER);
  const end = existing.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`找不到 GENERATED 標記（${SKILL_REFERENCE_PATH}），請確認檔案沒有被手動改壞。`);
  }
  const head = existing.slice(0, start + BEGIN_MARKER.length);
  const tail = existing.slice(end);
  return `${head}\n\n${generated}\n\n${tail}`;
}
