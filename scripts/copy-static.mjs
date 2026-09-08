import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');

// Keep the asset walk explicit. Some Windows Node 22 installations crash in
// cpSync's recursive native path when the workspace contains CJK characters.
function copyAssetTree(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = resolve(source, entry.name);
    const to = resolve(destination, entry.name);
    if (entry.isDirectory()) copyAssetTree(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
  }
}

if (!existsSync(dist)) mkdirSync(dist, { recursive: true });
const env = loadEnv('production', root, 'VITE_');
const wikiOrigin = (env.VITE_WIKI_ORIGIN?.trim() || 'https://wiki.example.invalid').replace(/\/$/, '');
let origin;
try {
  origin = new URL(wikiOrigin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash) throw new Error();
} catch {
  throw new Error('VITE_WIKI_ORIGIN 必須是有效、無路徑參數的 HTTPS origin。');
}
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
const match = `${origin.origin}/*`;
manifest.host_permissions = [
  match,
  ...manifest.host_permissions.filter((permission) => permission !== 'https://wiki.example.invalid/*'),
];
manifest.content_scripts = manifest.content_scripts.map((script) => ({ ...script, matches: [match] }));
manifest.web_accessible_resources = manifest.web_accessible_resources.map((resource) => ({ ...resource, matches: [match] }));
writeFileSync(resolve(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log('[copy-static] manifest.json -> dist/manifest.json');
copyFileSync(resolve(root, 'scripts/Configure-Wiki.ps1'), resolve(dist, 'Configure-Wiki.ps1'));
console.log('[copy-static] Configure-Wiki.ps1 -> dist/Configure-Wiki.ps1');

// Pet assets (pet.json + spritesheet.webp per pet folder under src/pet/<id>/)
// are static binary resources, not JS/TS — copied verbatim rather than
// routed through Vite's import/asset pipeline, and referenced at runtime via
// chrome.runtime.getURL(). src/pet/pet-widget.ts (the component itself) is
// bundled into content.js separately and must NOT be copied here.
const petSrc = resolve(root, 'src/pet');
if (existsSync(petSrc)) {
  for (const entry of readdirSync(petSrc, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    copyAssetTree(resolve(petSrc, entry.name), resolve(dist, 'pet', entry.name));
  }
  console.log('[copy-static] src/pet/*/ -> dist/pet/');
}

const iconsSrc = resolve(root, 'src/icons');
if (existsSync(iconsSrc)) {
  copyAssetTree(iconsSrc, resolve(dist, 'icons'));
  console.log('[copy-static] src/icons/ -> dist/icons/');
}
