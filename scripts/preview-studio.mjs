import { createServer } from 'vite';
import { readFile } from 'node:fs/promises';

// Local, isolated sample data. This preview does not connect to a live Wiki.
const server = await createServer({
  appType: 'custom',
  define: { 'import.meta.env.VITE_WIKI_ORIGIN': JSON.stringify(`http://127.0.0.1:${process.env.STUDIO_PREVIEW_PORT || 4187}`) },
  server: { host: '127.0.0.1', port: Number(process.env.STUDIO_PREVIEW_PORT || 4187), strictPort: true },
});
server.middlewares.use(async (req, res, next) => {
  const path = req.url?.split('?')[0];
  if (path === '/tests/fixtures/topbar-preview.html' || path === '/tests/fixtures/ai-review-preview.html') {
    const source = await readFile(new URL(`..${path}`, import.meta.url), 'utf8');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(await server.transformIndexHtml(req.url, source));
    return;
  }
  if (path === '/') {
    res.writeHead(302, { Location: '/e/zh/studio-preview' });
    res.end();
    return;
  }
  if (path === '/e/zh/studio-preview') {
    const source = await readFile(new URL('../tests/fixtures/studio-preview.html', import.meta.url), 'utf8');
    const html = await server.transformIndexHtml(req.url, source);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
    return;
  }
  if ((path === '/src/settings/settings.html' || path === '/src/onboarding/onboarding.html') && req.url?.includes('preview=1')) {
    const source = await readFile(new URL(`..${path}`, import.meta.url), 'utf8');
    const entry = path.replace(/\.html$/, '.ts');
    const preview = source.replace(/<script\b[^>]*type="module"[^>]*>[\s\S]*?<\/script>/, `<script type="module">import { installPreviewChrome } from '/tests/fixtures/preview-chrome.ts'; installPreviewChrome(); await import('${entry}');</script>`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(await server.transformIndexHtml(req.url, preview));
    return;
  }
  next();
});
await server.listen();
server.printUrls();
