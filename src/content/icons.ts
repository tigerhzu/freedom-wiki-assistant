/** Small, consistent line icons. SVG content is static and never comes from user input. */
const paths = {
  search: 'M21 21l-5-5M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15',
  close: 'M6 6l12 12M6 18L18 6',
  arrowRight: 'M4 12h16m-6-6 6 6-6 6',
  chevronDown: 'm6 9 6 6 6-6',
  chevronRight: 'm9 6 6 6-6 6',
  book: 'M12 5v16m0-16C8 2 3 3 3 3v16s5-1 9 2c4-3 9-2 9-2V3s-5-1-9 2',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  image: 'M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm-1 13 5-5 4 4 3-3 6 6M8 7h.01',
  network: 'M9 3h6v5H9zM2 16h6v5H2zM16 16h6v5h-6zM12 8v4M5 16v-4h14v4',
  palette: 'M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1.5-3.3 1.6 1.6 0 0 1 1.2-2.7H18a3 3 0 0 0 3-3 9 9 0 0 0-9-9ZM7 10h.01M10 6h.01M15 7h.01M6 14h.01',
  settings: 'm9 3-.5 3-2 1-2.8-1-2 3.5L4 12l-2.3 2.5 2 3.5 2.8-1 2 1 .5 3h6l.5-3 2-1 2.8 1 2-3.5L20 12l2.3-2.5-2-3.5-2.8 1-2-1L15 3Zm6 9a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  sparkles: 'm12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4ZM20 2v4m-2-2h4',
  template: 'M4 3h16v18H4zM4 8h16M10 8v13',
  folder: 'M3 7V4h6l3 3h9v13H3z',
  plus: 'M12 5v14M5 12h14',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  upload: 'M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5',
  check: 'm5 12 4 4L19 6',
  code: 'm8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18',
  edit: 'm16 3 5 5-12 12-6 1 1-6Zm-2 2 5 5',
  keyboard: 'M2 5h20v14H2zM6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M10 13h.01M14 13h.01M18 13h.01M8 16h8',
  bold: 'M6 12h8a4 4 0 0 1 0 8H6V4h7a4 4 0 0 1 0 8',
  italic: 'M10 4h9M5 20h9M15 4 9 20',
  underline: 'M6 3v8a6 6 0 0 0 12 0V3M4 21h16',
  alignLeft: 'M3 5h18M3 10h11M3 15h18M3 20h11',
  alignCenter: 'M3 5h18M7 10h10M3 15h18M7 20h10',
  alignRight: 'M3 5h18M10 10h11M3 15h18M10 20h11',
  quote: 'M3 5h7v8H5c0 3 2 5 4 6M14 5h7v8h-5c0 3 2 5 4 6',
  undo: 'M3 10h11a6 6 0 0 1 0 12M3 10l5-5M3 10l5 5',
  redo: 'M21 10H10a6 6 0 0 0 0 12m11-12-5-5m5 5-5 5',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  copy: 'M9 9h12v12H9zM15 9V3H3v12h6',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
} as const;

export type IconName = keyof typeof paths;

export function icon(name: IconName, size = 18): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({
    viewBox: '0 0 24 24', width: String(size), height: String(size), fill: 'none',
    stroke: 'currentColor', 'stroke-width': '1.65', 'stroke-linecap': 'round',
    'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false',
  })) svg.setAttribute(key, value);
  svg.classList.add('fwa-icon');
  if (name === 'more') {
    // Filled dots stay legible at the small sizes used by overflow controls.
    for (const x of [5, 12, 19]) {
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      for (const [key, value] of Object.entries({ cx: String(x), cy: '12', r: '1.8', fill: 'currentColor', stroke: 'none' })) dot.setAttribute(key, value);
      svg.appendChild(dot);
    }
    return svg;
  }
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', paths[name]);
  svg.appendChild(path);
  return svg;
}
