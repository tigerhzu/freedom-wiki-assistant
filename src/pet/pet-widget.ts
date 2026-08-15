import { createShadowHost, el } from '../content/ui';
import { getSettings, saveSettings } from '../shared/storage';

/**
 * Floating, draggable feature-menu entry point. It renders a static brand logo
 * when pet.json provides `logoPath`; otherwise it falls back to the existing
 * animated spritesheet convention. Both variants keep the same click, drag,
 * menu, and saved-position behaviour.
 *
 * Sprite atlas convention (Codex pet spec): 8 columns × 9 rows, row 0 is the
 * "idle" animation. Cell size is derived from the loaded image's own
 * dimensions (naturalWidth/8, naturalHeight/9) rather than hardcoded, so any
 * differently-scaled pet atlas dropped into src/pet/<id>/ still slices
 * correctly. Unused trailing cells in a row are fully transparent (spec
 * allows any pet to use fewer than 8 frames), so the actual idle frame count
 * is detected from the image itself — cycling through undetected blank cells
 * is what caused visible flicker.
 */

const GRID_COLS = 8;
const GRID_ROWS = 9;
const IDLE_ROW = 0;
const DISPLAY_WIDTH = 72;
const IDLE_FPS = 6;
/** Pointer movement below this, in CSS px, is treated as a click rather than a drag. */
const DRAG_THRESHOLD_PX = 4;

interface PetManifest {
  id: string;
  displayName: string;
  description: string;
  /** Optional static brand image used in preference to the animated sprite. */
  logoPath?: string;
  spritesheetPath: string;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  originLeft: number;
  originTop: number;
  moved: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Scans a spritesheet row left-to-right and counts non-transparent cells,
 * stopping at the first fully transparent one (Codex pet packing
 * convention: used frames are packed from column 0). The image was loaded
 * from a blob: URL (see loadSprite), so the canvas is never tainted and
 * getImageData is always safe here.
 */
function countUsedFrames(img: HTMLImageElement, cellW: number, cellH: number, row: number, maxCols: number): number {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return maxCols;
  ctx.drawImage(img, 0, 0);

  let count = 0;
  for (let col = 0; col < maxCols; col++) {
    const { data } = ctx.getImageData(Math.round(col * cellW), Math.round(row * cellH), Math.round(cellW), Math.round(cellH));
    let hasPixel = false;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 0) {
        hasPixel = true;
        break;
      }
    }
    if (!hasPixel) break;
    count = col + 1;
  }
  return count > 0 ? count : maxCols;
}

export class PetWidget {
  private petEl: HTMLElement | null = null;
  private spriteEl: HTMLElement | null = null;
  private frame = 0;
  private idleFrameCount = GRID_COLS;
  private idleTimer: number | null = null;
  private drag: DragState | null = null;
  private suppressNextClick = false;
  private readonly positionListeners = new Set<() => void>();

  constructor(private readonly petId = 'claude-crab') {}

  attach(onClick: () => void): void {
    const { root } = createShadowHost('fwa-pet-host');
    root.querySelector('.fwa-pet')?.remove();

    const sprite = el('div', { class: 'fwa-pet-sprite' });
    const pet = el('button', { class: 'fwa-pet', 'aria-label': '功能選單', title: '功能選單（可拖曳移動）' }, [
      sprite,
    ]);

    pet.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    pet.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.suppressNextClick) {
        this.suppressNextClick = false;
        return;
      }
      onClick();
    });
    window.addEventListener('resize', () => this.clampToViewport());

    root.appendChild(pet);
    this.petEl = pet;
    this.spriteEl = sprite;

    void this.restorePosition();
    void this.loadSprite();
  }

  /** Lets an anchored overlay follow the pet while it is dragged. */
  onPositionChange(listener: () => void): () => void {
    this.positionListeners.add(listener);
    return () => this.positionListeners.delete(listener);
  }

  getBounds(): DOMRect | null {
    return this.petEl?.isConnected ? this.petEl.getBoundingClientRect() : null;
  }

  private async restorePosition(): Promise<void> {
    const settings = await getSettings();
    if (settings.petPosition) this.applyRatioPosition(settings.petPosition.xRatio, settings.petPosition.yRatio);
  }

  private applyRatioPosition(xRatio: number, yRatio: number): void {
    if (!this.petEl) return;
    const width = this.petEl.offsetWidth || DISPLAY_WIDTH;
    const height = this.petEl.offsetHeight || DISPLAY_WIDTH;
    this.setPosition(xRatio * window.innerWidth, yRatio * window.innerHeight, width, height);
  }

  private setPosition(left: number, top: number, width: number, height: number): void {
    if (!this.petEl) return;
    const clampedLeft = clamp(left, 0, Math.max(0, window.innerWidth - width));
    const clampedTop = clamp(top, 0, Math.max(0, window.innerHeight - height));
    this.petEl.style.left = `${clampedLeft}px`;
    this.petEl.style.top = `${clampedTop}px`;
    this.petEl.style.right = 'auto';
    this.petEl.style.bottom = 'auto';
    this.positionListeners.forEach((listener) => listener());
  }

  /** Keeps the pet reachable if the viewport shrinks (e.g. window resize) after it was dragged. */
  private clampToViewport(): void {
    if (!this.petEl) return;
    const rect = this.petEl.getBoundingClientRect();
    this.setPosition(rect.left, rect.top, rect.width || DISPLAY_WIDTH, rect.height || DISPLAY_WIDTH);
  }

  private onPointerDown(e: PointerEvent): void {
    if (!this.petEl) return;
    const rect = this.petEl.getBoundingClientRect();
    this.drag = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originLeft: rect.left,
      originTop: rect.top,
      moved: false,
    };
    this.petEl.setPointerCapture(e.pointerId);
    this.petEl.addEventListener('pointermove', this.onPointerMove);
    this.petEl.addEventListener('pointerup', this.onPointerUp);
    this.petEl.addEventListener('pointercancel', this.onPointerUp);
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (!this.drag || !this.petEl || e.pointerId !== this.drag.pointerId) return;
    const dx = e.clientX - this.drag.startX;
    const dy = e.clientY - this.drag.startY;
    if (!this.drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    if (!this.drag.moved) {
      this.drag.moved = true;
    }
    this.setPosition(this.drag.originLeft + dx, this.drag.originTop + dy, this.petEl.offsetWidth, this.petEl.offsetHeight);
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (!this.petEl || !this.drag || e.pointerId !== this.drag.pointerId) return;
    this.petEl.releasePointerCapture(e.pointerId);
    this.petEl.removeEventListener('pointermove', this.onPointerMove);
    this.petEl.removeEventListener('pointerup', this.onPointerUp);
    this.petEl.removeEventListener('pointercancel', this.onPointerUp);
    const moved = this.drag.moved;
    this.drag = null;
    if (moved) {
      // A drag ending on the pet still fires a native "click" right after — swallow just that one.
      this.suppressNextClick = true;
      void this.persistPosition();
    }
  };

  private async persistPosition(): Promise<void> {
    if (!this.petEl) return;
    const rect = this.petEl.getBoundingClientRect();
    const settings = await getSettings();
    settings.petPosition = { xRatio: rect.left / window.innerWidth, yRatio: rect.top / window.innerHeight };
    await saveSettings(settings);
  }

  private async loadSprite(): Promise<void> {
    try {
      const base = `pet/${this.petId}/`;
      const manifest = (await (await fetch(chrome.runtime.getURL(`${base}pet.json`))).json()) as PetManifest;
      const visualPath = manifest.logoPath ?? manifest.spritesheetPath;
      const spriteBlob = await (await fetch(chrome.runtime.getURL(`${base}${visualPath}`))).blob();
      const objectUrl = URL.createObjectURL(spriteBlob);

      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('pet sprite decode failed'));
        img.src = objectUrl;
      });

      if (!this.spriteEl) return; // detached while loading
      if (manifest.logoPath) {
        this.spriteEl.style.width = `${DISPLAY_WIDTH}px`;
        this.spriteEl.style.height = `${DISPLAY_WIDTH}px`;
        this.spriteEl.style.backgroundImage = `url(${objectUrl})`;
        this.spriteEl.style.backgroundSize = 'contain';
        this.spriteEl.style.backgroundPosition = 'center';
        return;
      }

      const cellW = img.naturalWidth / GRID_COLS;
      const cellH = img.naturalHeight / GRID_ROWS;
      const scale = DISPLAY_WIDTH / cellW;
      const displayHeight = cellH * scale;

      this.idleFrameCount = countUsedFrames(img, cellW, cellH, IDLE_ROW, GRID_COLS);

      this.spriteEl.style.width = `${DISPLAY_WIDTH}px`;
      this.spriteEl.style.height = `${displayHeight}px`;
      this.spriteEl.style.backgroundImage = `url(${objectUrl})`;
      this.spriteEl.style.backgroundSize = `${DISPLAY_WIDTH * GRID_COLS}px ${displayHeight * GRID_ROWS}px`;

      this.startIdleLoop(displayHeight);
    } catch (err) {
      // Pet is purely cosmetic — never let a missing/broken sprite break the menu button.
      console.debug('[FWA] pet sprite unavailable', err instanceof Error ? err.message : err);
    }
  }

  private startIdleLoop(displayHeight: number): void {
    if (this.idleTimer !== null) window.clearInterval(this.idleTimer);
    this.idleTimer = window.setInterval(() => {
      if (!this.spriteEl) return;
      this.frame = (this.frame + 1) % this.idleFrameCount;
      this.spriteEl.style.backgroundPosition = `${-this.frame * DISPLAY_WIDTH}px ${-IDLE_ROW * displayHeight}px`;
    }, 1000 / IDLE_FPS);
  }

}
