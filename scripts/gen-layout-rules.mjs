import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderColorAnnotationMarkdown } from '../src/shared/layout-rules.ts';
import { SKILL_REFERENCE_PATH, spliceGeneratedBlock } from './layout-rules-target.ts';

/**
 * Regenerates the GENERATED block of the /wiki-layout-extension Skill's colour
 * reference from src/shared/layout-rules.ts — the single source shared with the
 * extension's own "AI 排版" SYSTEM_PROMPT.
 *
 * Run with:  npm run gen:layout-rules      (vite-node, so the .ts import works)
 *
 * Everything outside the markers is hand-written and left untouched.
 * tests/layout-rules.test.ts fails if the checked-in block is stale.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, SKILL_REFERENCE_PATH);

const existing = readFileSync(target, 'utf8');
const next = spliceGeneratedBlock(existing, renderColorAnnotationMarkdown());

if (next === existing) {
  console.log(`[gen-layout-rules] 已是最新，未變更 ${SKILL_REFERENCE_PATH}`);
} else {
  writeFileSync(target, next);
  console.log(`[gen-layout-rules] 已更新 ${SKILL_REFERENCE_PATH}`);
}
