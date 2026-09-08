import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = loadEnv('production', root, 'VITE_');
const wikiOrigin = (env.VITE_WIKI_ORIGIN?.trim() || 'https://wiki.example.invalid').replace(/\/$/, '');
const expectedPermissions = [
  `${new URL(wikiOrigin).origin}/*`,
  'https://ornith.example.invalid/*',
  'https://*.openai.azure.com/*',
];
const manifest = JSON.parse(readFileSync(resolve(root, 'dist/manifest.json'), 'utf8'));
const actual = Array.isArray(manifest.host_permissions) ? manifest.host_permissions : [];
const missing = expectedPermissions.filter((permission) => !actual.includes(permission));
if (missing.length > 0) {
  throw new Error(`dist/manifest.json 缺少必要 host_permissions: ${missing.join(', ')}`);
}
console.log('[verify-manifest] Wiki, Ornith, and Azure host permissions verified.');
