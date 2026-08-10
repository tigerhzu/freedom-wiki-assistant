import { describe, expect, it } from 'vitest';
import {
  attachPageTopology,
  buildFallbackTextEvents,
  buildPageTopology,
  canonicalPageUrl,
  removeTopologyDescendants,
  wouldCreateTopologyCycle,
  type TopologySourceEvent,
} from '../src/content/page-topology';

describe('buildPageTopology', () => {
  it('builds heading hierarchy and attaches links to the current section', () => {
    const events: TopologySourceEvent[] = [
      { kind: 'heading', label: 'Account Info', level: 2 },
      { kind: 'link', label: 'Plan', href: 'https://wiki.example/plan' },
      { kind: 'heading', label: 'SOP', level: 2 },
      { kind: 'heading', label: 'Onboarding', level: 3 },
      { kind: 'link', label: 'Checklist', href: 'https://wiki.example/checklist' },
    ];
    const graph = buildPageTopology('ExampleCo', events);

    expect(graph.nodes.map((node) => [node.id, node.label, node.type])).toEqual([
      ['root', 'ExampleCo', 'root'],
      ['section-1', 'Account Info', 'section'],
      ['page-2', 'Plan', 'page'],
      ['section-3', 'SOP', 'section'],
      ['section-4', 'Onboarding', 'section'],
      ['page-5', 'Checklist', 'page'],
    ]);
    expect(graph.edges).toEqual([
      { from: 'root', to: 'section-1' },
      { from: 'section-1', to: 'page-2' },
      { from: 'root', to: 'section-3' },
      { from: 'section-3', to: 'section-4' },
      { from: 'section-4', to: 'page-5' },
    ]);
  });

  it('attaches links before the first heading directly to the page root', () => {
    const graph = buildPageTopology('Home', [
      { kind: 'link', label: 'Customer list', href: 'https://wiki.example/customers' },
    ]);
    expect(graph.edges).toEqual([{ from: 'root', to: 'page-1' }]);
  });

  it('keeps a linked heading as an expandable page parent', () => {
    const graph = buildPageTopology('ExampleCo', [
      { kind: 'heading', label: 'SOP', level: 2, href: 'https://wiki.example/sop' },
      {
        kind: 'link',
        label: 'ExampleCo_review',
        href: 'https://wiki.example/review',
      },
    ]);
    expect(graph.nodes.map((node) => [node.label, node.type, node.href])).toEqual([
      ['ExampleCo', 'root', undefined],
      ['SOP', 'page', 'https://wiki.example/sop'],
      ['ExampleCo_review', 'page', 'https://wiki.example/review'],
    ]);
    expect(graph.edges).toEqual([
      { from: 'root', to: 'section-1' },
      { from: 'section-1', to: 'page-2' },
    ]);
  });

  it('caps very large pages and reports truncation', () => {
    const events: TopologySourceEvent[] = Array.from({ length: 10 }, (_, index) => ({
      kind: 'heading',
      label: `Section ${index + 1}`,
      level: 2,
    }));
    const graph = buildPageTopology('Large page', events, 5);
    expect(graph.nodes).toHaveLength(5);
    expect(graph.truncated).toBe(true);
  });
});

describe('expandable page topology', () => {
  it('keeps pages usable when Markdown heading markers were removed', () => {
    expect(
      buildFallbackTextEvents(
        ['新進人員 SOP', '', '帳號建立流程', '帳號建立流程', '設備交付清單'],
        '新進人員 SOP',
      ),
    ).toEqual([
      { kind: 'heading', label: '帳號建立流程', level: 2 },
      { kind: 'heading', label: '設備交付清單', level: 2 },
    ]);
  });

  it('normalizes hashes and trailing slashes for cache and cycle checks', () => {
    expect(canonicalPageUrl('https://wiki.example/clients/example-client/#SOP')).toBe(
      'https://wiki.example/clients/example-client',
    );
  });

  it('attaches and removes a linked page branch without replacing the current graph', () => {
    const parent = buildPageTopology(
      'ExampleCo',
      [{ kind: 'link', label: 'SOP', href: 'https://wiki.example/sop' }],
      140,
      'https://wiki.example/example-client',
    );
    const child = buildPageTopology(
      'SOP',
      [
        { kind: 'heading', label: '人員異動', level: 2 },
        { kind: 'link', label: '人員到職', href: 'https://wiki.example/onboarding' },
      ],
      140,
      'https://wiki.example/sop',
    );

    const expanded = attachPageTopology(parent, 'page-1', child);
    expect(expanded.nodes.map((node) => [node.id, node.label])).toEqual([
      ['root', 'ExampleCo'],
      ['page-1', 'SOP'],
      ['page-1::section-1', '人員異動'],
      ['page-1::page-2', '人員到職'],
    ]);
    expect(expanded.edges).toEqual([
      { from: 'root', to: 'page-1' },
      { from: 'page-1', to: 'page-1::section-1' },
      { from: 'page-1::section-1', to: 'page-1::page-2' },
    ]);
    expect(removeTopologyDescendants(expanded, 'page-1')).toEqual(parent);
  });

  it('stops a nested link from expanding back to an ancestor page', () => {
    const parent = buildPageTopology(
      'ExampleCo',
      [{ kind: 'link', label: 'SOP', href: 'https://wiki.example/sop' }],
      140,
      'https://wiki.example/example-client',
    );
    const child = buildPageTopology(
      'SOP',
      [{ kind: 'link', label: '返回 ExampleCo', href: 'https://wiki.example/example-client/' }],
      140,
      'https://wiki.example/sop',
    );
    const expanded = attachPageTopology(parent, 'page-1', child);

    expect(
      wouldCreateTopologyCycle(
        expanded,
        'page-1::page-1',
        'https://wiki.example/example-client#top',
      ),
    ).toBe(true);
  });
});
