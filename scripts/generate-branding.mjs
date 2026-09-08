import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run from any directory: node scripts/generate-branding.mjs
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'docs/assets');
const c = JSON.parse(readFileSync(resolve(out, 'brand.json'), 'utf8'));
const xml = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const logo = readFileSync(resolve(root, c.logoSource), 'utf8').replace(/<\?xml[^>]*>/g, '').trim();
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, 'logo.svg'), logo + '\n');
const embeddedLogo = logo.replace(/(<svg[^>]*?)\s(?:width|height)="[^"]*"/g, '$1').replace(/(<svg[^>]*?)\s(?:width|height)="[^"]*"/g, '$1').replace('<svg ', '<svg x="916" y="145" width="160" height="160" ');
const cards = c.chips.map((label, i) => `<rect x="${56+i*176}" y="338" width="160" height="36" rx="18" fill="#ffffff" fill-opacity=".045" stroke="#ffffff" stroke-opacity=".13"/><text x="${136+i*176}" y="361" text-anchor="middle" fill="#c6d0df" font-size="13" font-weight="500">${xml(label)}</text>`).join('');
const base = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="488" viewBox="0 0 1280 488" role="img" aria-labelledby="title desc">
<title id="title">${xml(c.title)} — ${xml(c.subtitle)}</title><desc id="desc">${xml(c.description)}</desc>
<defs>
 <radialGradient id="glow"><stop stop-color="${c.accent}" stop-opacity=".23"/><stop offset="1" stop-color="${c.accent}" stop-opacity="0"/></radialGradient>
 <linearGradient id="edge"><stop stop-color="${c.accent}"/><stop offset="1" stop-color="${c.accent}" stop-opacity="0"/></linearGradient>
 <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32 0H0V32" fill="none" stroke="#a8b6ce" stroke-opacity=".065"/></pattern>
 <clipPath id="bounds"><rect width="1280" height="488" rx="24"/></clipPath>
</defs>
<style>text{font-family:Inter,Segoe UI,Arial,sans-serif}__MOTION__</style>
<g clip-path="url(#bounds)">
 <rect width="1280" height="488" fill="#0b1120"/><rect width="1280" height="488" fill="url(#grid)"/>
 <ellipse class="glow" cx="995" cy="222" rx="350" ry="330" fill="url(#glow)"/>
 <path d="M56 0H1224" stroke="url(#edge)" stroke-width="3"/>
 <circle cx="62" cy="56" r="5" fill="${c.accent}"/><text x="80" y="61" fill="#a7b8cf" font-size="12" letter-spacing="3">TIGER HZU / EVERYDAY TOOLS</text>
 <text x="56" y="160" fill="${c.accent}" font-size="13" letter-spacing="3">${xml(c.eyebrow)}</text>
 <text x="52" y="237" fill="#f2f6ff" font-size="${c.title.length>16?60:70}" font-weight="700" letter-spacing="-3">${xml(c.title)}</text>
 <text x="56" y="284" fill="#aebfd6" font-size="21">${xml(c.subtitle)}</text>
 ${cards}
 <circle cx="996" cy="225" r="145" fill="none" stroke="${c.accent}" stroke-opacity=".18"/>
 <circle class="orbit" cx="996" cy="225" r="176" fill="none" stroke="${c.accent}" stroke-opacity=".28" stroke-dasharray="4 18"/>
 <path d="M790 225H841M1151 225H1202M996 25V70M996 380V409" stroke="${c.accent}" stroke-opacity=".28"/>
 <circle class="pulse" cx="851" cy="225" r="5" fill="${c.accent}"/>
 <circle cx="1141" cy="225" r="5" fill="${c.accent}" fill-opacity=".7"/>
 ${embeddedLogo}
 <path d="M56 423H1224" stroke="#ffffff" stroke-opacity=".13"/>
 <text x="56" y="457" fill="#94a8c5" font-size="12" letter-spacing="2">${xml(c.footer)}</text>
 <text x="1224" y="457" text-anchor="end" fill="${c.accent}" font-size="12" letter-spacing="2">${xml(c.number)} / BUILT FOR THE EVERYDAY</text>
</g></svg>\n`;
const motion = `.orbit{transform-origin:996px 225px;animation:orbit 70s linear infinite}.glow{animation:breathe 7s ease-in-out infinite}.pulse{animation:pulse 4s ease-in-out infinite}@keyframes orbit{to{transform:rotate(360deg)}}@keyframes breathe{50%{opacity:.55}}@keyframes pulse{50%{opacity:.25}}@media(prefers-reduced-motion:reduce){.orbit,.glow,.pulse{animation:none}}`;
writeFileSync(resolve(out, 'hero.svg'), base.replace('__MOTION__', motion));
writeFileSync(resolve(out, 'hero-static.svg'), base.replace('__MOTION__', ''));
console.log('Generated logo.svg, hero.svg and hero-static.svg');
