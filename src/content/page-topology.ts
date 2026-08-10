import { wikiConfig } from '../config/wiki-config';
import { bridgeCallAsync } from './bridge';
import { el, openModal } from './ui';

export type TopologyNodeType = 'root' | 'section' | 'page';

export interface TopologySourceEvent {
  kind: 'heading' | 'link';
  label: string;
  level?: number;
  href?: string;
}

export interface TopologyNode {
  id: string;
  label: string;
  type: TopologyNodeType;
  href?: string;
  /** Page whose rendered article content produced this node. */
  sourceUrl?: string;
}

export interface PageTopology {
  nodes: TopologyNode[];
  edges: Array<{ from: string; to: string }>;
  truncated: boolean;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_NODES = 140;

/** Removes hash/trailing-slash differences before cache and cycle comparisons. */
export function canonicalPageUrl(value: string, base = wikiConfig.origin): string {
  const url = new URL(value, base);
  url.hash = '';
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
}

/**
 * Converts article-order headings and links into a hierarchy. Heading levels
 * determine section parents; links attach to the nearest preceding section.
 */
export function buildPageTopology(
  title: string,
  events: TopologySourceEvent[],
  maxNodes = MAX_NODES,
  sourceUrl = '',
): PageTopology {
  const normalizedSource = sourceUrl ? canonicalPageUrl(sourceUrl) : '';
  const nodes: TopologyNode[] = [
    {
      id: 'root',
      label: title || '目前頁面',
      type: 'root',
      ...(normalizedSource ? { sourceUrl: normalizedSource } : {}),
    },
  ];
  const edges: PageTopology['edges'] = [];
  const headingStack: Array<{ id: string; level: number }> = [];
  let truncated = false;

  for (const event of events) {
    if (nodes.length >= maxNodes) {
      truncated = true;
      break;
    }

    if (event.kind === 'heading') {
      const level = Math.min(6, Math.max(1, event.level ?? 2));
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop();
      }
      const id = `section-${nodes.length}`;
      const parent = headingStack[headingStack.length - 1]?.id ?? 'root';
      nodes.push({
        id,
        label: event.label,
        type: event.href ? 'page' : 'section',
        ...(event.href ? { href: event.href } : {}),
        ...(normalizedSource ? { sourceUrl: normalizedSource } : {}),
      });
      edges.push({ from: parent, to: id });
      headingStack.push({ id, level });
      continue;
    }

    const id = `page-${nodes.length}`;
    const parent = headingStack[headingStack.length - 1]?.id ?? 'root';
    nodes.push({
      id,
      label: event.label,
      type: 'page',
      href: event.href,
      ...(normalizedSource ? { sourceUrl: normalizedSource } : {}),
    });
    edges.push({ from: parent, to: id });
  }

  return { nodes, edges, truncated };
}

/**
 * Grafts a fetched page below the clicked link node. Namespaced ids keep
 * repeated section names and repeated links independent in the visible graph.
 */
export function attachPageTopology(
  current: PageTopology,
  parentNodeId: string,
  child: PageTopology,
  maxNodes = MAX_NODES,
): PageTopology {
  const withoutOldBranch = removeTopologyDescendants(current, parentNodeId);
  const available = Math.max(0, maxNodes - withoutOldBranch.nodes.length);
  const childNodes = child.nodes.filter((node) => node.id !== 'root');
  const included = childNodes.slice(0, available);
  const idMap = new Map<string, string>([['root', parentNodeId]]);

  for (const node of included) idMap.set(node.id, `${parentNodeId}::${node.id}`);

  const nodes = [
    ...withoutOldBranch.nodes,
    ...included.map((node) => ({ ...node, id: idMap.get(node.id) as string })),
  ];
  const edges = [
    ...withoutOldBranch.edges,
    ...child.edges.flatMap((edge) => {
      const from = idMap.get(edge.from);
      const to = idMap.get(edge.to);
      return from && to ? [{ from, to }] : [];
    }),
  ];
  return {
    nodes,
    edges,
    truncated:
      withoutOldBranch.truncated ||
      child.truncated ||
      included.length < childNodes.length,
  };
}

export function removeTopologyDescendants(topology: PageTopology, parentNodeId: string): PageTopology {
  const prefix = `${parentNodeId}::`;
  const nodes = topology.nodes.filter((node) => !node.id.startsWith(prefix));
  const ids = new Set(nodes.map((node) => node.id));
  return {
    nodes,
    edges: topology.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
    truncated: topology.truncated,
  };
}

/** Prevents A → B → A (or deeper) expansion loops while still showing the link. */
export function wouldCreateTopologyCycle(
  topology: PageTopology,
  nodeId: string,
  targetHref: string,
): boolean {
  const target = canonicalPageUrl(targetHref);
  const byId = new Map(topology.nodes.map((node) => [node.id, node]));
  const parentById = new Map(topology.edges.map((edge) => [edge.to, edge.from]));
  let currentId: string | undefined = nodeId;

  while (currentId) {
    const source = byId.get(currentId)?.sourceUrl;
    if (source && canonicalPageUrl(source) === target) return true;
    currentId = parentById.get(currentId);
  }
  return false;
}

function cleanText(value: string | null | undefined): string {
  return (value ?? '').replace(/^\s*¶\s*/, '').replace(/\s+/g, ' ').trim();
}

/**
 * Turns useful plain-text blocks into root-level sections when a page has no
 * Markdown heading or internal-link structure. This keeps a page expandable
 * after its `#` / `##` markers are removed, without adding paragraph noise to
 * pages that still have a real hierarchy.
 */
export function buildFallbackTextEvents(
  values: string[],
  pageTitle = '',
  maxEvents = 32,
): TopologySourceEvent[] {
  const title = cleanText(pageTitle);
  const seen = new Set<string>();
  const events: TopologySourceEvent[] = [];

  for (const value of values) {
    let label = cleanText(value);
    if (!label || label === title || label.length < 2 || seen.has(label)) continue;
    if (label.length > 120) label = `${label.slice(0, 119)}…`;
    if (seen.has(label)) continue;
    seen.add(label);
    events.push({ kind: 'heading', label, level: 2 });
    if (events.length >= maxEvents) break;
  }
  return events;
}

function fallbackLinkLabel(url: URL): string {
  const lastPart = url.pathname.split('/').filter(Boolean).at(-1) ?? url.pathname;
  try {
    return decodeURIComponent(lastPart) || url.pathname;
  } catch {
    return lastPart || url.pathname;
  }
}

function topologyFromDocument(pageDocument: Document, pageUrl: string): PageTopology | null {
  const liveContent =
    pageDocument.querySelector<HTMLElement>('.contents') ??
    pageDocument.querySelector<HTMLElement>('.editor-markdown-preview') ??
    pageDocument.querySelector<HTMLElement>('.editor-markdown-preview-content');
  const pageElement = pageDocument.querySelector<HTMLElement>('page');
  const serverTemplate =
    pageElement?.querySelector<HTMLTemplateElement>('template[slot="contents"]') ??
    pageDocument.querySelector<HTMLTemplateElement>('template[slot="contents"]');
  // Wiki.js server-rendered responses keep page.render inside this template.
  // Vue moves it into `.contents` only after the page's JavaScript mounts.
  const content: ParentNode | null = liveContent ?? serverTemplate?.content ?? null;
  if (!content) return null;

  const normalizedPageUrl = canonicalPageUrl(pageUrl);
  const pageUrlObject = new URL(normalizedPageUrl);
  const firstHeading = content.querySelector<HTMLElement>('h1,h2,h3,h4,h5,h6');
  const configuredSelector = wikiConfig.pageTitle.selector;
  const templateSelector = configuredSelector?.replace(/^\.contents\s+/, '');
  const configuredTitle = configuredSelector
    ? cleanText(
        pageDocument.querySelector<HTMLElement>(configuredSelector)?.textContent ??
          (templateSelector
            ? content.querySelector<HTMLElement>(templateSelector)?.textContent
            : ''),
      )
    : '';
  const title =
    configuredTitle ||
    cleanText(firstHeading?.textContent) ||
    cleanText(pageElement?.getAttribute('title')) ||
    cleanText(pageDocument.title) ||
    '目前頁面';
  const events: TopologySourceEvent[] = [];
  let skippedTitleHeading = false;

  for (const node of content.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6,a[href]')) {
    if (/^H[1-6]$/.test(node.tagName)) {
      const label = cleanText(node.textContent);
      if (!label) continue;
      if (!skippedTitleHeading && node === firstHeading && label === title) {
        skippedTitleHeading = true;
        continue;
      }
      const headingLink = node.querySelector<HTMLAnchorElement>(
        'a[href]:not(.toc-anchor)',
      );
      let headingHref: string | undefined;
      const rawHeadingHref = headingLink?.getAttribute('href');
      if (rawHeadingHref && !rawHeadingHref.startsWith('#')) {
        try {
          const url = new URL(rawHeadingHref, normalizedPageUrl);
          if (
            url.origin === pageUrlObject.origin &&
            canonicalPageUrl(url.toString()) !== normalizedPageUrl
          ) {
            headingHref = canonicalPageUrl(url.toString());
          }
        } catch {
          // Ignore malformed links while keeping the heading itself.
        }
      }
      events.push({
        kind: 'heading',
        label,
        level: Number(node.tagName.slice(1)),
        ...(headingHref ? { href: headingHref } : {}),
      });
      continue;
    }

    if (node.closest('.toc-anchor') || node.classList.contains('toc-anchor')) continue;
    if (node.closest('h1,h2,h3,h4,h5,h6')) continue;
    const rawHref = node.getAttribute('href');
    if (!rawHref || rawHref.startsWith('#')) continue;

    let url: URL;
    try {
      url = new URL(rawHref, normalizedPageUrl);
    } catch {
      continue;
    }
    if (url.origin !== pageUrlObject.origin) continue;
    if (canonicalPageUrl(url.toString()) === normalizedPageUrl) continue;

    const label = cleanText(node.textContent) || fallbackLinkLabel(url);
    const listItem = node.closest('li');
    const hasNestedList =
      listItem &&
      Array.from(listItem.children).some(
        (child) => child.tagName === 'UL' || child.tagName === 'OL',
      );
    if (listItem && hasNestedList) {
      let listDepth = 0;
      let currentListItem: Element | null = listItem;
      while (currentListItem) {
        listDepth += 1;
        currentListItem = currentListItem.parentElement?.closest('li') ?? null;
      }
      events.push({
        kind: 'heading',
        label,
        level: Math.min(6, listDepth + 1),
        href: canonicalPageUrl(url.toString()),
      });
      continue;
    }
    events.push({
      kind: 'link',
      label,
      href: canonicalPageUrl(url.toString()),
    });
  }

  if (events.length === 0) {
    const fallbackValues = Array.from(
      content.querySelectorAll<HTMLElement>('p,li,blockquote,pre,tr'),
      (node) => {
        if (node.tagName === 'TR') {
          return Array.from(node.querySelectorAll<HTMLElement>('th,td'))
            .map((cell) => cleanText(cell.textContent))
            .filter(Boolean)
            .join(' · ');
        }
        return cleanText(node.textContent);
      },
    );
    events.push(...buildFallbackTextEvents(fallbackValues, title));
  }

  return buildPageTopology(title, events, MAX_NODES, normalizedPageUrl);
}

export function collectCurrentPageTopology(): PageTopology | null {
  return topologyFromDocument(document, location.href);
}

async function fetchPageTopology(href: string): Promise<PageTopology> {
  const target = new URL(canonicalPageUrl(href));
  if (target.origin !== location.origin || target.origin !== wikiConfig.origin) {
    throw new Error('只能展開公司 Wiki 內部頁面');
  }

  const response = await bridgeCallAsync<{
    ok: boolean;
    status: number;
    url: string;
    html: string;
  }>('fetchWikiPageHtml', { url: target.toString() });
  if (!response.ok) throw new Error(`讀取頁面失敗（HTTP ${response.status}）`);

  const finalUrl = canonicalPageUrl(response.url || target.toString());
  if (new URL(finalUrl).origin !== wikiConfig.origin) throw new Error('頁面被重新導向到 Wiki 以外');

  const pageDocument = new DOMParser().parseFromString(response.html, 'text/html');
  const topology = topologyFromDocument(pageDocument, finalUrl);
  if (!topology) {
    const responseText = `${pageDocument.title} ${pageDocument.body?.textContent ?? ''}`;
    if (/Unauthorized|You cannot view this page|Login As/i.test(responseText)) {
      throw new Error('目前登入帳號沒有此頁的檢視權限');
    }
    throw new Error('該頁面不存在，或沒有可分析的文章內容');
  }
  return topology;
}

interface LayoutNode extends TopologyNode {
  x: number;
  y: number;
}

function layoutTopology(topology: PageTopology): {
  nodes: LayoutNode[];
  width: number;
  height: number;
} {
  const children = new Map<string, string[]>();
  for (const edge of topology.edges) {
    const list = children.get(edge.from) ?? [];
    list.push(edge.to);
    children.set(edge.from, list);
  }

  const positioned = new Map<string, { x: number; y: number }>();
  let leafIndex = 0;
  let maxDepth = 0;

  const visit = (id: string, depth: number): number => {
    maxDepth = Math.max(maxDepth, depth);
    const childIds = children.get(id) ?? [];
    let row: number;
    if (childIds.length === 0) {
      row = leafIndex++;
    } else {
      const childRows = childIds.map((childId) => visit(childId, depth + 1));
      row = childRows.reduce((sum, value) => sum + value, 0) / childRows.length;
    }
    positioned.set(id, { x: 34 + depth * 224, y: 34 + row * 72 });
    return row;
  };

  visit('root', 0);
  const nodes = topology.nodes.map((node) => ({
    ...node,
    ...(positioned.get(node.id) ?? { x: 34, y: 34 }),
  }));
  return {
    nodes,
    width: Math.max(720, 34 + (maxDepth + 1) * 224),
    height: Math.max(420, 68 + Math.max(1, leafIndex) * 72),
  };
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function shortenLabel(label: string, max = 19): string {
  return label.length <= max ? label : `${label.slice(0, max - 1)}…`;
}

interface TopologyRenderState {
  expanded: Set<string>;
  loading: Set<string>;
  messages: Map<string, string>;
  onToggle(node: TopologyNode): void;
  onNavigate(node: TopologyNode): void;
}

function renderTopologySvg(
  topology: PageTopology,
  state: TopologyRenderState,
): {
  svg: SVGSVGElement;
  resetView(): void;
  zoom(factor: number): void;
} {
  const layout = layoutTopology(topology);
  const svg = svgEl('svg', {
    class: 'fwa-topology-svg',
    role: 'img',
    'aria-label': '目前頁面的標題階層與可展開 Wiki 內部連結拓譜圖',
    viewBox: `0 0 ${layout.width} ${layout.height}`,
    preserveAspectRatio: 'xMinYMin meet',
  });
  const title = svgEl('title');
  title.textContent = '目前頁面拓譜圖';
  svg.appendChild(title);

  const graph = svgEl('g');
  svg.appendChild(graph);
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));

  for (const edge of topology.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) continue;
    const startX = from.x + 168;
    const startY = from.y + 22;
    const endX = to.x;
    const endY = to.y + 22;
    const midX = (startX + endX) / 2;
    graph.appendChild(
      svgEl('path', {
        class: 'fwa-topology-edge',
        d: `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`,
      }),
    );
  }

  for (const node of layout.nodes) {
    const isExpanded = state.expanded.has(node.id);
    const isLoading = state.loading.has(node.id);
    const message = state.messages.get(node.id);
    const classes = [
      'fwa-topology-node',
      `fwa-topology-node-${node.type}`,
      isExpanded ? 'is-expanded' : '',
      isLoading ? 'is-loading' : '',
      message ? 'has-message' : '',
    ].filter(Boolean).join(' ');
    const group = svgEl('g', {
      class: classes,
      transform: `translate(${node.x} ${node.y})`,
    });
    group.appendChild(svgEl('rect', { width: '168', height: '44', rx: '9' }));
    const label = svgEl('text', { x: '12', y: '27' });
    label.textContent = shortenLabel(node.label);
    group.appendChild(label);

    if (node.href) {
      const marker = svgEl('text', {
        class: 'fwa-topology-expand-marker',
        x: '151',
        y: '27',
        'text-anchor': 'middle',
        'aria-hidden': 'true',
      });
      marker.textContent = isLoading ? '…' : message ? '!' : isExpanded ? '−' : '+';
      group.appendChild(marker);
    }

    const tooltip = svgEl('title');
    tooltip.textContent = node.href
      ? `${node.label}\n${node.href}\n${
          message || (isExpanded ? '左鍵收合；右鍵前往頁面' : '左鍵原地展開；右鍵前往頁面')
        }`
      : node.label;
    group.appendChild(tooltip);

    if (node.href) {
      const link = svgEl('a', {
        href: node.href,
        'aria-label': `${isExpanded ? '收合' : '展開'} ${node.label}`,
      });
      link.addEventListener('click', (event) => {
        event.preventDefault();
        if (!isLoading) state.onToggle(node);
      });
      link.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        state.onNavigate(node);
      });
      link.appendChild(group);
      graph.appendChild(link);
    } else {
      graph.appendChild(group);
    }
  }

  let view = { x: 0, y: 0, width: layout.width, height: layout.height };
  let drag: { x: number; y: number; viewX: number; viewY: number } | null = null;
  const applyView = () => svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.width} ${view.height}`);
  const zoom = (factor: number) => {
    const nextWidth = Math.min(layout.width * 2, Math.max(260, view.width / factor));
    const nextHeight = Math.min(layout.height * 2, Math.max(180, view.height / factor));
    view.x += (view.width - nextWidth) / 2;
    view.y += (view.height - nextHeight) / 2;
    view.width = nextWidth;
    view.height = nextHeight;
    applyView();
  };
  const resetView = () => {
    view = { x: 0, y: 0, width: layout.width, height: layout.height };
    applyView();
  };

  svg.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      zoom(event.deltaY < 0 ? 1.16 : 1 / 1.16);
    },
    { passive: false },
  );
  svg.addEventListener('pointerdown', (event) => {
    if ((event.target as Element).closest('a')) return;
    drag = { x: event.clientX, y: event.clientY, viewX: view.x, viewY: view.y };
    svg.setPointerCapture(event.pointerId);
    svg.classList.add('is-dragging');
  });
  svg.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const rect = svg.getBoundingClientRect();
    view.x = drag.viewX - ((event.clientX - drag.x) / rect.width) * view.width;
    view.y = drag.viewY - ((event.clientY - drag.y) / rect.height) * view.height;
    applyView();
  });
  const endDrag = (event: PointerEvent) => {
    if (!drag) return;
    drag = null;
    svg.releasePointerCapture(event.pointerId);
    svg.classList.remove('is-dragging');
  };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);

  return { svg, resetView, zoom };
}

export function openCurrentPageTopology(): void {
  const initialTopology = collectCurrentPageTopology();
  const modal = openModal('目前頁面拓譜圖', 'fwa-topology-modal-host', 'fwa-modal-wide fwa-topology-modal');
  if (!initialTopology) {
    modal.body.appendChild(
      el('div', {
        class: 'fwa-topology-empty',
        text: '目前頁面沒有可分析的文章內容。請切換到 Wiki 文章檢視頁或 Markdown 編輯預覽後再試一次。',
      }),
    );
    const close = el('button', { class: 'fwa-btn', text: '關閉' });
    close.addEventListener('click', () => modal.close());
    modal.footer.appendChild(close);
    return;
  }

  let topology = initialTopology;
  const expanded = new Set<string>();
  const expansionHistory: string[] = [];
  const loading = new Set<string>();
  const messages = new Map<string, string>();
  const cache = new Map<string, PageTopology>();
  const summary = el('span', { class: 'fwa-topology-summary' });
  const graphCanvas = el('div', { class: 'fwa-topology-canvas' });
  const zoomOut = el('button', { class: 'fwa-btn', text: '－', 'aria-label': '縮小拓譜圖' });
  const zoomIn = el('button', { class: 'fwa-btn', text: '＋', 'aria-label': '放大拓譜圖' });
  const fit = el('button', { class: 'fwa-btn', text: '適合視窗' });
  const back = el('button', { class: 'fwa-btn', text: '← 上一層', 'aria-label': '收合最近展開的上一層' });
  const fullscreen = el('button', {
    class: 'fwa-btn',
    text: '全螢幕',
    'aria-label': '切換拓譜圖全螢幕',
    'aria-pressed': 'false',
  });
  let rendered: ReturnType<typeof renderTopologySvg> | null = null;
  let isFullscreen = false;

  const updateSummary = (notice = '') => {
    const sectionCount = topology.nodes.filter((node) => node.type === 'section').length;
    const pageCount = topology.nodes.filter((node) => node.type === 'page').length;
    summary.textContent =
      `${sectionCount} 個段落 · ${pageCount} 個內部連結` +
      (topology.truncated ? ' · 已達 140 個節點上限' : '') +
      (notice ? ` · ${notice}` : '');
  };
  const render = (notice = '') => {
    updateSummary(notice);
    back.toggleAttribute('disabled', expansionHistory.length === 0);
    rendered = renderTopologySvg(topology, {
      expanded,
      loading,
      messages,
      onToggle: (node) => void toggleNode(node),
      onNavigate: (node) => {
        if (node.href) window.location.assign(node.href);
      },
    });
    graphCanvas.replaceChildren(rendered.svg);
  };
  const clearDescendantState = (parentId: string) => {
    const prefix = `${parentId}::`;
    for (const id of [...expanded]) if (id.startsWith(prefix)) expanded.delete(id);
    for (const id of [...loading]) if (id.startsWith(prefix)) loading.delete(id);
    for (const id of [...messages.keys()]) if (id.startsWith(prefix)) messages.delete(id);
  };
  const removeHistoryBranch = (parentId: string) => {
    const prefix = `${parentId}::`;
    for (let index = expansionHistory.length - 1; index >= 0; index -= 1) {
      const id = expansionHistory[index];
      if (id === parentId || id.startsWith(prefix)) expansionHistory.splice(index, 1);
    }
  };
  const collapseBranch = (parentId: string, label: string) => {
    topology = removeTopologyDescendants(topology, parentId);
    expanded.delete(parentId);
    clearDescendantState(parentId);
    removeHistoryBranch(parentId);
    render(`已回到「${label}」的上一層`);
  };
  const toggleNode = async (node: TopologyNode) => {
    if (!node.href || loading.has(node.id)) return;
    messages.delete(node.id);

    if (expanded.has(node.id)) {
      collapseBranch(node.id, node.label);
      return;
    }

    if (wouldCreateTopologyCycle(topology, node.id, node.href)) {
      messages.set(node.id, '偵測到循環連結，未繼續展開');
      render(`「${node.label}」會連回上層，已停止展開`);
      return;
    }

    loading.add(node.id);
    render(`正在讀取「${node.label}」…`);
    let notice = '';
    try {
      const cacheKey = canonicalPageUrl(node.href);
      let child = cache.get(cacheKey);
      if (!child) {
        child = await fetchPageTopology(cacheKey);
        cache.set(cacheKey, child);
      }
      if (child.nodes.length <= 1) {
        messages.set(node.id, '此頁沒有下一層標題、內部連結或可辨識段落');
        notice = `「${node.label}」沒有可展開的下一層`;
      } else {
        const attached = attachPageTopology(topology, node.id, child);
        if (attached.nodes.length === topology.nodes.length) {
          messages.set(node.id, '已達 140 個節點上限，請先收合其他分支');
          notice = `已達節點上限，無法展開「${node.label}」`;
        } else {
          topology = attached;
          expanded.add(node.id);
          expansionHistory.push(node.id);
          notice = `已展開「${node.label}」`;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      messages.set(node.id, message);
      notice = `無法展開「${node.label}」：${message}`;
    } finally {
      loading.delete(node.id);
      render(notice);
    }
  };

  const toolbar = el('div', { class: 'fwa-topology-toolbar' }, [
    summary,
    el('span', { class: 'fwa-topology-legend fwa-topology-legend-root', text: '目前頁面' }),
    el('span', { class: 'fwa-topology-legend fwa-topology-legend-section', text: '段落' }),
    el('span', {
      class: 'fwa-topology-legend fwa-topology-legend-page',
      text: '連結頁面（左鍵展開／右鍵前往）',
    }),
    zoomOut,
    zoomIn,
    fit,
    back,
    fullscreen,
  ]);
  zoomOut.addEventListener('click', () => rendered?.zoom(1 / 1.2));
  zoomIn.addEventListener('click', () => rendered?.zoom(1.2));
  fit.addEventListener('click', () => rendered?.resetView());
  back.addEventListener('click', () => {
    while (expansionHistory.length > 0) {
      const nodeId = expansionHistory[expansionHistory.length - 1];
      const node = topology.nodes.find((candidate) => candidate.id === nodeId);
      if (node && expanded.has(nodeId)) {
        collapseBranch(nodeId, node.label);
        return;
      }
      expansionHistory.pop();
    }
    render();
  });
  fullscreen.addEventListener('click', () => {
    isFullscreen = !isFullscreen;
    modal.element.classList.toggle('is-fullscreen', isFullscreen);
    fullscreen.textContent = isFullscreen ? '退出全螢幕' : '全螢幕';
    fullscreen.setAttribute('aria-pressed', String(isFullscreen));
    window.requestAnimationFrame(() => rendered?.resetView());
  });
  modal.body.append(toolbar, graphCanvas);
  const close = el('button', { class: 'fwa-btn', text: '關閉' });
  close.addEventListener('click', () => modal.close());
  modal.footer.appendChild(close);
  render();
}
