import { wikiConfig } from '../config/wiki-config';
import type { Settings } from '../shared/types';
import {
  applyBoxPatch,
  applyCustomColor,
  applyBox,
  changeIndent,
  removeBox,
  setBlockAlign,
  stripHtml,
  toggleBlockquote,
} from './block-format';
import type { EditorAdapter } from './editor-adapter';
import { WikiDocumentSync } from './document-sync';
import { BOX_PRESETS, DEFAULT_BOX } from './html-style';
import {
  clearImageSize,
  describeImage,
  findImageAt,
  removeImageStyle,
  restoreMarkdownImage,
  setImageAlign,
  setImageSize,
  toCssLength,
  toggleImageBorder,
  toggleImageRadius,
  type ImageToken,
  type SizeUnit,
} from './markdown-image';
import {
  applyColor,
  applySize,
  clearFormatting,
  minimalDiff,
  toggleBold,
  toggleHighlight,
  toggleInlineCode,
  toggleItalic,
  toggleStrike,
  toggleUnderline,
  type EditResult,
} from './markdown-format';
import { createShadowHost, el } from './ui';

type EditFn = (text: string, start: number, end: number) => EditResult;

interface MenuContext {
  hasSelection: boolean;
  image: ImageToken | null;
}

/**
 * Custom right-click formatting menu.
 *
 *  - Shown when text is selected inside the editor, or when the caret/selection
 *    is on a Markdown or HTML image (so 「調整圖片大小」 works without having to
 *    highlight the whole syntax). Otherwise the browser's native context menu is
 *    untouched (requirement 8).
 *  - Rendered inside a Shadow DOM root; a single second-level panel
 *    (.fwa-submenu) opens beside it for settings that would clutter the first
 *    level, flipping to the left when there is no room on the right.
 *  - Closes on outside click and Escape.
 *  - Edits are applied as a minimal replacement through the EditorAdapter so
 *    the caret/undo history survive, then the selection is restored.
 */
export class FormattingMenu {
  private menuEl: HTMLElement | null = null;
  private subEl: HTMLElement | null = null;
  private subAnchor: HTMLElement | null = null;
  private readonly onContextMenu = (e: MouseEvent) => this.handleContextMenu(e);
  private readonly onDocMouseDown = (e: MouseEvent) => this.handleOutside(e);
  private readonly onDocKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    if (this.subEl) {
      e.stopPropagation();
      this.closeSubmenu();
    } else if (this.menuEl) {
      e.stopPropagation();
      this.close();
    }
  };

  constructor(
    private readonly adapter: EditorAdapter,
    private readonly settings: Settings,
    private readonly documentSync = new WikiDocumentSync(adapter),
  ) {}

  attach(): void {
    this.adapter.rootElement.addEventListener('contextmenu', this.onContextMenu);
    document.addEventListener('mousedown', this.onDocMouseDown, true);
    document.addEventListener('keydown', this.onDocKeyDown, true);
  }

  detach(): void {
    this.adapter.rootElement.removeEventListener('contextmenu', this.onContextMenu);
    document.removeEventListener('mousedown', this.onDocMouseDown, true);
    document.removeEventListener('keydown', this.onDocKeyDown, true);
    this.close();
  }

  private handleContextMenu(e: MouseEvent): void {
    let hasSelection = false;
    let image: ImageToken | null = null;
    try {
      const selection = this.adapter.getSelection();
      hasSelection = selection.text.length > 0;
      image = findImageAt(this.documentSync.markdown, selection.start, selection.end);
    } catch {
      return; // bridge failure → keep native menu
    }
    if (!hasSelection && !image) {
      this.close();
      return; // nothing to act on → native context menu
    }
    e.preventDefault();
    e.stopPropagation();
    this.open(e.clientX, e.clientY, { hasSelection, image });
  }

  private handleOutside(e: MouseEvent): void {
    if (!this.menuEl) return;
    const path = e.composedPath();
    if (path.includes(this.menuEl)) return;
    if (this.subEl && path.includes(this.subEl)) return;
    this.close();
  }

  close(): void {
    this.closeSubmenu();
    this.menuEl?.remove();
    this.menuEl = null;
  }

  private closeSubmenu(): void {
    this.subEl?.remove();
    this.subEl = null;
    this.subAnchor?.classList.remove('is-open');
    this.subAnchor = null;
  }

  private open(x: number, y: number, ctx: MenuContext): void {
    this.close();
    const { root } = createShadowHost('fwa-menu-host');

    const menu = el('div', { class: 'fwa-menu' });
    if (ctx.hasSelection) {
      this.buildTextSections(menu);
      this.buildParagraphSection(menu);
      this.buildBoxSection(menu);
      this.buildCustomColorSection(menu);
    }
    if (ctx.image) {
      if (menu.childElementCount > 0) menu.append(el('div', { class: 'fwa-divider' }));
      this.buildImageSection(menu, ctx.image);
    }

    root.appendChild(menu);
    this.menuEl = menu;

    // Keep the menu inside the viewport.
    const rect = menu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 8);
    const top = Math.min(y, window.innerHeight - rect.height - 8);
    menu.style.left = `${Math.max(4, left)}px`;
    menu.style.top = `${Math.max(4, top)}px`;
  }

  /* ───────────────── 文字顏色 / 文字大小 / 其他格式 ───────────────── */

  private buildTextSections(menu: HTMLElement): void {
    /* colors */
    const colorRow = el('div', { class: 'fwa-swatch-row' });
    const swatchColors = [
      ...wikiConfig.formatting.presetColors.map((c) => c.value),
      ...this.settings.customSwatches,
    ];
    for (const color of swatchColors) {
      const btn = el('button', {
        class: 'fwa-swatch',
        style: `background:${color}`,
        title: color,
      });
      btn.addEventListener('click', () => this.run((t, s, e2) => applyColor(t, s, e2, color)));
      colorRow.appendChild(btn);
    }
    const hexInput = el('input', {
      class: 'fwa-hex-input',
      placeholder: '#a1b2c3',
      maxlength: '7',
    });
    const hexApply = el('button', { class: 'fwa-btn', text: '套用' });
    hexApply.addEventListener('click', () => {
      const v = hexInput.value.trim();
      if (/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(v)) {
        this.run((t, s, e2) => applyColor(t, s, e2, v.toLowerCase()));
      } else {
        hexInput.style.borderColor = '#cf222e';
      }
    });
    hexInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') hexApply.click();
    });
    colorRow.append(hexInput, hexApply);

    menu.append(section('文字顏色', colorRow), el('div', { class: 'fwa-divider' }));

    /* sizes */
    const sizeRow = el('div', { class: 'fwa-btn-row' });
    const strategy = wikiConfig.formatting.fontSizeStrategy;
    const sizeEntries: Array<{ label: string; value: string | null }> = [
      { label: wikiConfig.formatting.fontSizes.small.label, value: sizeValue('small') },
      { label: '一般', value: null },
      { label: wikiConfig.formatting.fontSizes.medium.label, value: sizeValue('medium') },
      { label: wikiConfig.formatting.fontSizes.large.label, value: sizeValue('large') },
      { label: wikiConfig.formatting.fontSizes.xlarge.label, value: sizeValue('xlarge') },
    ];
    function sizeValue(key: keyof typeof wikiConfig.formatting.fontSizes): string {
      const cfg = wikiConfig.formatting.fontSizes[key];
      return strategy === 'span-style' ? cfg.spanStyle : cfg.fontAttr;
    }
    for (const s of sizeEntries) {
      const btn = el('button', { class: 'fwa-btn', text: s.label });
      btn.addEventListener('click', () =>
        this.run((t, st, en) => applySize(t, st, en, s.value, strategy)),
      );
      sizeRow.appendChild(btn);
    }
    menu.append(section('文字大小', sizeRow), el('div', { class: 'fwa-divider' }));

    /* other formats */
    const fmtRow = el('div', { class: 'fwa-btn-row' });
    const formats: Array<{ label: string; fn: EditFn }> = [
      { label: '粗體', fn: toggleBold },
      { label: '斜體', fn: toggleItalic },
      {
        label: '底線',
        fn: (t, s, e2) => toggleUnderline(t, s, e2, wikiConfig.formatting.underlineTag),
      },
      { label: '刪除線', fn: toggleStrike },
      {
        label: '背景標記',
        fn: (t, s, e2) => toggleHighlight(t, s, e2, wikiConfig.formatting.highlightTag),
      },
      { label: '程式碼', fn: toggleInlineCode },
      { label: '清除格式', fn: clearFormatting },
    ];
    for (const f of formats) {
      const btn = el('button', { class: 'fwa-btn', text: f.label });
      btn.addEventListener('click', () => this.run(f.fn));
      fmtRow.appendChild(btn);
    }
    menu.append(section('其他格式', fmtRow), el('div', { class: 'fwa-divider' }));
  }

  /* ───────────────────────────── 段落排版 ───────────────────────────── */

  private buildParagraphSection(menu: HTMLElement): void {
    const row = el('div', { class: 'fwa-btn-row' });
    const items: Array<{ label: string; fn: EditFn }> = [
      { label: '引用區塊', fn: toggleBlockquote },
      { label: '置左', fn: (t, s, e) => setBlockAlign(t, s, e, 'left') },
      { label: '置中', fn: (t, s, e) => setBlockAlign(t, s, e, 'center') },
      { label: '置右', fn: (t, s, e) => setBlockAlign(t, s, e, 'right') },
      { label: '取消對齊', fn: (t, s, e) => setBlockAlign(t, s, e, null) },
      { label: '增加縮排', fn: (t, s, e) => changeIndent(t, s, e, 1) },
      { label: '減少縮排', fn: (t, s, e) => changeIndent(t, s, e, -1) },
      { label: '清除 HTML', fn: stripHtml },
    ];
    for (const item of items) {
      const btn = el('button', { class: 'fwa-btn', text: item.label });
      btn.addEventListener('click', () => this.run(item.fn));
      row.appendChild(btn);
    }
    menu.append(section('段落排版', row), el('div', { class: 'fwa-divider' }));
  }

  /* ────────────────────────────── 文字框 ────────────────────────────── */

  private buildBoxSection(menu: HTMLElement): void {
    const mainRow = el('div', { class: 'fwa-btn-row' });

    const boxBtn = el('button', { class: 'fwa-btn', text: '文字框' });
    boxBtn.addEventListener('click', () => this.run((t, s, e) => applyBox(t, s, e, DEFAULT_BOX)));

    const settingsBtn = el('button', { class: 'fwa-btn fwa-btn-more', text: '文字框設定' });
    settingsBtn.addEventListener('click', () => this.toggleBoxSettings(settingsBtn));

    const removeBtn = el('button', { class: 'fwa-btn fwa-btn-danger', text: '移除文字框' });
    removeBtn.addEventListener('click', () => this.run(removeBox));

    mainRow.append(boxBtn, settingsBtn, removeBtn);

    const presetRow = el('div', { class: 'fwa-btn-row' });
    for (const preset of BOX_PRESETS) {
      const btn = el('button', { class: 'fwa-btn', text: preset.label });
      btn.addEventListener('click', () => this.run((t, s, e) => applyBox(t, s, e, preset.spec)));
      presetRow.appendChild(btn);
    }

    menu.append(
      section('文字框', mainRow),
      section('快速框線樣式', presetRow),
      el('div', { class: 'fwa-divider' }),
    );
  }

  private toggleBoxSettings(anchor: HTMLElement): void {
    this.toggleSubmenu(anchor, '文字框設定', (panel) => {
      panel.append(
        subLabel('框線顏色'),
        this.colorRow(['#cccccc', '#0d6efd', '#ffc107', '#dc3545', '#198754', '#6c757d'], (color) =>
          this.run((t, s, e) => applyBoxPatch(t, s, e, { color }), true),
        ),
        subLabel('框線粗細'),
        buttonRow(
          [
            ['1px', '1px'],
            ['2px', '2px'],
            ['3px', '3px'],
          ],
          (width) => this.run((t, s, e) => applyBoxPatch(t, s, e, { width }), true),
        ),
        subLabel('框線樣式'),
        buttonRow(
          [
            ['實線', 'solid'],
            ['虛線', 'dashed'],
            ['點線', 'dotted'],
          ],
          (style) => this.run((t, s, e) => applyBoxPatch(t, s, e, { style }), true),
        ),
        subLabel('圓角'),
        buttonRow(
          [
            ['無', ''],
            ['4px', '4px'],
            ['8px', '8px'],
            ['12px', '12px'],
          ],
          (radius) => this.run((t, s, e) => applyBoxPatch(t, s, e, { radius }), true),
        ),
        subLabel('內距'),
        buttonRow(
          [
            ['小', '6px 8px'],
            ['中', '10px 12px'],
            ['大', '16px 18px'],
          ],
          (padding) => this.run((t, s, e) => applyBoxPatch(t, s, e, { padding }), true),
        ),
        subLabel('背景顏色'),
        this.colorRow(['#f0f7ff', '#fffbf0', '#fff5f5', '#f2fbf5', '#f6f8fa'], (background) =>
          this.run((t, s, e) => applyBoxPatch(t, s, e, { background }), true),
        ),
        buttonRow([['無背景', '']], (background) =>
          this.run((t, s, e) => applyBoxPatch(t, s, e, { background }), true),
        ),
        el('div', { class: 'fwa-divider' }),
      );
      const remove = el('button', { class: 'fwa-btn fwa-btn-danger fwa-btn-wide', text: '移除文字框' });
      remove.addEventListener('click', () => this.run(removeBox));
      panel.append(remove);
    });
  }

  /* ───────────────────────────── 自訂顏色 ───────────────────────────── */

  private buildCustomColorSection(menu: HTMLElement): void {
    const row = el('div', { class: 'fwa-btn-row' });

    const textBtn = el('button', { class: 'fwa-btn fwa-btn-more', text: '自訂文字顏色' });
    textBtn.addEventListener('click', () => this.toggleColorPanel(textBtn, 'color', '自訂文字顏色'));

    const bgBtn = el('button', { class: 'fwa-btn fwa-btn-more', text: '自訂背景顏色' });
    bgBtn.addEventListener('click', () =>
      this.toggleColorPanel(bgBtn, 'background-color', '自訂背景顏色'),
    );

    row.append(textBtn, bgBtn);
    menu.append(section('自訂顏色', row), el('div', { class: 'fwa-divider' }));
  }

  private toggleColorPanel(
    anchor: HTMLElement,
    prop: 'color' | 'background-color',
    title: string,
  ): void {
    const presets =
      prop === 'color'
        ? ['#1f2328', '#cf222e', '#0969da', '#1a7f37', '#9a6700', '#8250df']
        : ['#fff5f5', '#fffbf0', '#f0f7ff', '#f2fbf5', '#f6f8fa', '#ffe9b3'];
    this.toggleSubmenu(anchor, title, (panel) => {
      panel.append(
        subLabel('選擇顏色'),
        this.colorRow(presets, (color) =>
          this.run((t, s, e) => applyCustomColor(t, s, e, prop, color), true),
        ),
      );
      const clear = el('button', { class: 'fwa-btn fwa-btn-wide', text: '移除此顏色' });
      clear.addEventListener('click', () => this.run((t, s, e) => applyCustomColor(t, s, e, prop, '')));
      panel.append(clear);
    });
  }

  /* ────────────────────────────── 圖片 ────────────────────────────── */

  private buildImageSection(menu: HTMLElement, image: ImageToken): void {
    const sizeRow = el('div', { class: 'fwa-btn-row' });
    const sizeBtn = el('button', { class: 'fwa-btn fwa-btn-more', text: '調整圖片大小' });
    sizeBtn.addEventListener('click', () => this.toggleImageSizePanel(sizeBtn));
    const originalBtn = el('button', { class: 'fwa-btn', text: '原始尺寸' });
    originalBtn.addEventListener('click', () => this.run(clearImageSize));
    sizeRow.append(sizeBtn, originalBtn);

    const toolRow = el('div', { class: 'fwa-btn-row' });
    const tools: Array<{ label: string; fn: EditFn }> = [
      { label: '置左', fn: (t, s, e) => setImageAlign(t, s, e, 'left') },
      { label: '置中', fn: (t, s, e) => setImageAlign(t, s, e, 'center') },
      { label: '置右', fn: (t, s, e) => setImageAlign(t, s, e, 'right') },
      { label: '取消對齊', fn: (t, s, e) => setImageAlign(t, s, e, null) },
      { label: '圓角', fn: toggleImageRadius },
      { label: '框線', fn: toggleImageBorder },
      { label: '移除尺寸設定', fn: removeImageStyle },
      { label: '還原 Markdown', fn: restoreMarkdownImage },
    ];
    for (const tool of tools) {
      const btn = el('button', { class: 'fwa-btn', text: tool.label });
      btn.addEventListener('click', () => this.run(tool.fn));
      toolRow.appendChild(btn);
    }

    menu.append(
      section(`圖片：${describeImage(image)}`, sizeRow),
      el('div', { class: 'fwa-menu-section' }, [toolRow]),
    );
  }

  private toggleImageSizePanel(anchor: HTMLElement): void {
    this.toggleSubmenu(anchor, '調整圖片大小', (panel) => {
      panel.append(
        subLabel('快速尺寸'),
        buttonRow(
          [
            ['25%', '25%'],
            ['50%', '50%'],
            ['75%', '75%'],
            ['100%', '100%'],
            ['200px', '200px'],
            ['400px', '400px'],
            ['600px', '600px'],
          ],
          (width) => this.run((t, s, e) => setImageSize(t, s, e, width), true),
        ),
        el('div', { class: 'fwa-divider' }),
        subLabel('自訂尺寸'),
      );

      const widthInput = el('input', { class: 'fwa-num', placeholder: '寬度' });
      const heightInput = el('input', { class: 'fwa-num', placeholder: '高度' });
      const unitSelect = el('select', { class: 'fwa-select' });
      for (const unit of ['px', '%']) {
        unitSelect.appendChild(el('option', { value: unit, text: unit }));
      }
      const ratio = el('input', { type: 'checkbox', class: 'fwa-check' });
      ratio.checked = true;
      ratio.addEventListener('change', () => {
        heightInput.disabled = ratio.checked;
        if (ratio.checked) heightInput.value = '';
      });
      heightInput.disabled = true;

      const apply = el('button', { class: 'fwa-btn fwa-btn-primary', text: '套用' });
      apply.addEventListener('click', () => {
        const unit = unitSelect.value as SizeUnit;
        const width = toCssLength(widthInput.value, unit);
        const height = ratio.checked ? '' : toCssLength(heightInput.value, unit);
        if (!width && !height) {
          widthInput.style.borderColor = '#cf222e';
          return;
        }
        widthInput.style.borderColor = '';
        this.run((t, s, e) => setImageSize(t, s, e, width, height), true);
      });

      for (const input of [widthInput, heightInput]) {
        input.addEventListener('keydown', (e) => {
          if (e.key !== 'Escape') e.stopPropagation();
          if (e.key === 'Enter') apply.click();
        });
      }

      panel.append(
        el('div', { class: 'fwa-field' }, [el('label', { text: '寬度' }), widthInput, unitSelect]),
        el('div', { class: 'fwa-field' }, [el('label', { text: '高度' }), heightInput]),
        el('label', { class: 'fwa-check-row' }, [ratio, '維持圖片比例（高度 auto）']),
        el('div', { class: 'fwa-field' }, [apply]),
      );
    });
  }

  /* ─────────────────────────── submenu plumbing ─────────────────────────── */

  private toggleSubmenu(anchor: HTMLElement, title: string, build: (panel: HTMLElement) => void): void {
    if (this.subAnchor === anchor) {
      this.closeSubmenu();
      return;
    }
    this.openSubmenu(anchor, title, build);
  }

  /** Second-level panel, placed beside the main menu (left side if needed). */
  private openSubmenu(anchor: HTMLElement, title: string, build: (panel: HTMLElement) => void): void {
    this.closeSubmenu();
    const menu = this.menuEl;
    if (!menu) return;
    const root = menu.getRootNode();
    if (!(root instanceof ShadowRoot)) return;

    const panel = el('div', { class: 'fwa-submenu' }, [
      el('div', { class: 'fwa-submenu-title', text: title }),
    ]);
    build(panel);
    root.appendChild(panel);
    this.subEl = panel;
    this.subAnchor = anchor;
    anchor.classList.add('is-open');

    const menuRect = menu.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const rect = panel.getBoundingClientRect();
    let left = menuRect.right + 6;
    if (left + rect.width > window.innerWidth - 4) left = menuRect.left - rect.width - 6;
    if (left < 4) left = Math.max(4, window.innerWidth - rect.width - 4);
    const top = Math.min(anchorRect.top, window.innerHeight - rect.height - 4);
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(Math.max(4, top))}px`;
  }

  /** Preset swatches + native picker + hex field, all feeding `onPick`. */
  private colorRow(presets: string[], onPick: (color: string) => void): HTMLElement {
    const row = el('div', { class: 'fwa-swatch-row' });
    for (const color of presets) {
      const swatch = el('button', {
        class: 'fwa-swatch',
        style: `background:${color}`,
        title: color,
      });
      swatch.addEventListener('click', () => onPick(color));
      row.appendChild(swatch);
    }
    const picker = el('input', { type: 'color', class: 'fwa-color-input', value: presets[0] ?? '#cccccc' });
    picker.addEventListener('change', () => onPick(picker.value));
    const hex = el('input', { class: 'fwa-hex-input', placeholder: '#a1b2c3', maxlength: '7' });
    const apply = el('button', { class: 'fwa-btn', text: '套用' });
    apply.addEventListener('click', () => {
      const value = hex.value.trim().toLowerCase();
      if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/.test(value)) {
        hex.style.borderColor = '';
        onPick(value);
      } else {
        hex.style.borderColor = '#cf222e';
      }
    });
    hex.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') e.stopPropagation();
      if (e.key === 'Enter') apply.click();
    });
    row.append(picker, hex, apply);
    return row;
  }

  /**
   * Apply a pure edit function through the adapter, preserving the caret.
   * `keepOpen` leaves the menu (and its settings panel) up so several settings
   * can be tried in a row — the selection restored below keeps every following
   * edit anchored to the same content.
   */
  private run(fn: EditFn, keepOpen = false): void {
    try {
      const oldText = this.documentSync.markdown;
      const sel = this.adapter.getSelection();
      const result = fn(oldText, sel.start, sel.end);
      if (result.text === oldText) return;

      const diff = minimalDiff(oldText, result.text);
      const syncResult = this.documentSync.replaceRange(diff.from, diff.to, diff.insert, {
        origin: 'formatting',
        view: 'formatting',
      });
      if (syncResult.status === 'conflict') return;
      this.adapter.setSelection(result.start, result.end);
      this.adapter.focus();
    } finally {
      if (!keepOpen) this.close();
    }
  }
}

function section(label: string, content: HTMLElement): HTMLElement {
  return el('div', { class: 'fwa-menu-section' }, [
    el('div', { class: 'fwa-menu-label', text: label }),
    content,
  ]);
}

function subLabel(text: string): HTMLElement {
  return el('div', { class: 'fwa-menu-label', text });
}

/** Row of equally sized buttons mapping a label to the value passed to `onPick`. */
function buttonRow(entries: Array<[string, string]>, onPick: (value: string) => void): HTMLElement {
  const row = el('div', { class: 'fwa-btn-row' });
  for (const [label, value] of entries) {
    const btn = el('button', { class: 'fwa-btn', text: label });
    btn.addEventListener('click', () => onPick(value));
    row.appendChild(btn);
  }
  return row;
}
