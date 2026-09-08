import { createShadowHost, el } from '../content/ui';
import { getSettings, saveSettings } from '../shared/storage';

const GRID_COLS = 8;
const GRID_ROWS = 9;
const DISPLAY_WIDTH = 72;
const IDLE_FPS = 6;
const DRAG_THRESHOLD_PX = 4;

interface PetManifest {
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

/** Atlas rows pack used frames first; skip trailing transparent frames. */
function countUsedFrames(img: HTMLImageElement, cellW: number, cellH: number): number {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return 1;
  ctx.drawImage(img, 0, 0);
  let count = 0;
  for (let col = 0; col < GRID_COLS; col++) {
    const { data } = ctx.getImageData(Math.round(col * cellW), 0, Math.round(cellW), Math.round(cellH));
    let hasPixel = false;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 0) { hasPixel = true; break; }
    }
    if (!hasPixel) break;
    count = col + 1;
  }
  return Math.max(1, count);
}

/** A movable customer shortcut. Sprite failures never disable its button. */
export class PetWidget {
  private petEl: HTMLButtonElement | null = null;
  private spriteEl: HTMLElement | null = null;
  private drag: DragState | null = null;
  private suppressNextClick = false;
  private hasInteracted = false;
  private visible = true;
  private generation = 0;
  private frame = 0;
  private frameCount = 1;
  private idleTimer: number | null = null;
  private objectUrl: string | null = null;
  private spriteRequest: AbortController | null = null;
  private reducedMotion: MediaQueryList | null = null;
  private readonly positionListeners = new Set<() => void>();
  private onClick: (() => void) | null = null;

  constructor(private readonly petId = 'claude-crab') {}

  attach(onClick: () => void): void {
    // Rebinding a live shortcut must not replace its decoded sprite with the fallback.
    if (this.petEl?.isConnected) { this.onClick = onClick; return; }
    this.detach();
    this.onClick = onClick;
    const generation = this.generation;
    const { root } = createShadowHost('fwa-pet-host');
    // Keep the loading surface empty. Rendering a mascot-shaped fallback here
    // briefly showed a crab before the real sprite finished decoding.
    const sprite = el('span', { class: 'fwa-pet-sprite', 'aria-hidden': 'true', 'data-state': 'loading' });
    const pet = el('button', {
      type: 'button', class: 'fwa-pet',
      'aria-label': 'Pet：開啟客戶目錄，可拖曳移動', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
      title: '客戶目錄 · 拖曳移動 Pet',
    }, [sprite]);
    pet.hidden = !this.visible;
    pet.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    pet.addEventListener('mousedown', (event) => event.stopPropagation());
    pet.addEventListener('click', (event) => {
      event.stopPropagation();
      if (this.suppressNextClick) { this.suppressNextClick = false; return; }
      this.onClick?.();
    });
    root.appendChild(pet);
    this.petEl = pet;
    this.spriteEl = sprite;
    window.addEventListener('resize', this.clampToViewport);
    document.addEventListener('visibilitychange', this.updateAnimation);
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.reducedMotion.addEventListener('change', this.updateAnimation);
    void this.restorePosition(generation);
    void this.loadSprite(generation);
  }

  detach(): void {
    this.generation++;
    this.spriteRequest?.abort();
    this.spriteRequest = null;
    this.stopAnimation();
    this.clearDrag();
    window.removeEventListener('resize', this.clampToViewport);
    document.removeEventListener('visibilitychange', this.updateAnimation);
    this.reducedMotion?.removeEventListener('change', this.updateAnimation);
    this.reducedMotion = null;
    const root = this.petEl?.getRootNode();
    if (root instanceof ShadowRoot) root.host.remove();
    this.petEl = null;
    this.spriteEl = null;
    this.onClick = null;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.frame = 0;
    this.frameCount = 1;
    this.hasInteracted = false;
    this.suppressNextClick = false;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (this.petEl) this.petEl.hidden = !visible;
    if (!visible) this.clearDrag();
    else this.clampToViewport();
    this.updateAnimation();
    this.positionListeners.forEach((listener) => listener());
  }

  setExpanded(expanded: boolean): void {
    this.petEl?.setAttribute('aria-expanded', String(expanded));
  }

  onPositionChange(listener: () => void): () => void {
    this.positionListeners.add(listener);
    return () => this.positionListeners.delete(listener);
  }

  getBounds(): DOMRect | null {
    return this.petEl?.isConnected && !this.petEl.hidden ? this.petEl.getBoundingClientRect() : null;
  }

  private async restorePosition(generation: number): Promise<void> {
    try {
      const { petPosition } = await getSettings();
      if (generation !== this.generation || this.hasInteracted) return;
      if (petPosition && Number.isFinite(petPosition.xRatio) && Number.isFinite(petPosition.yRatio)) {
        this.setPosition(petPosition.xRatio * window.innerWidth, petPosition.yRatio * window.innerHeight);
      }
    } catch (error) {
      console.debug('[FWA] Pet position unavailable', error instanceof Error ? error.message : error);
    }
  }

  private setPosition(left: number, top: number): void {
    if (!this.petEl) return;
    const width = this.petEl.offsetWidth || DISPLAY_WIDTH;
    const height = this.petEl.offsetHeight || DISPLAY_WIDTH;
    this.petEl.style.left = `${clamp(left, 8, Math.max(8, window.innerWidth - width - 8))}px`;
    this.petEl.style.top = `${clamp(top, 8, Math.max(8, window.innerHeight - height - 8))}px`;
    this.petEl.style.right = 'auto';
    this.petEl.style.bottom = 'auto';
    this.positionListeners.forEach((listener) => listener());
  }

  private readonly clampToViewport = (): void => {
    const rect = this.getBounds();
    if (rect) this.setPosition(rect.left, rect.top);
  };

  private onPointerDown(event: PointerEvent): void {
    event.stopPropagation();
    if (!this.petEl || event.button !== 0 || this.drag) return;
    this.hasInteracted = true;
    // A later separate gesture must work if the browser emitted no drag click.
    this.suppressNextClick = false;
    const rect = this.petEl.getBoundingClientRect();
    this.drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originLeft: rect.left, originTop: rect.top, moved: false };
    this.petEl.setPointerCapture(event.pointerId);
    this.petEl.addEventListener('pointermove', this.onPointerMove);
    this.petEl.addEventListener('pointerup', this.onPointerUp);
    this.petEl.addEventListener('pointercancel', this.onPointerUp);
    this.petEl.addEventListener('lostpointercapture', this.onPointerUp);
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.drag || !this.petEl || event.pointerId !== this.drag.pointerId) return;
    const dx = event.clientX - this.drag.startX;
    const dy = event.clientY - this.drag.startY;
    if (!this.drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    this.drag.moved = true;
    this.petEl.classList.add('is-dragging');
    this.setPosition(this.drag.originLeft + dx, this.drag.originTop + dy);
  };

  private clearDrag(): void {
    const pointerId = this.drag?.pointerId;
    this.drag = null;
    this.petEl?.removeEventListener('pointermove', this.onPointerMove);
    this.petEl?.removeEventListener('pointerup', this.onPointerUp);
    this.petEl?.removeEventListener('pointercancel', this.onPointerUp);
    this.petEl?.removeEventListener('lostpointercapture', this.onPointerUp);
    if (pointerId !== undefined && this.petEl?.hasPointerCapture(pointerId)) this.petEl.releasePointerCapture(pointerId);
    this.petEl?.classList.remove('is-dragging');
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    event.stopPropagation();
    if (!this.petEl || !this.drag || event.pointerId !== this.drag.pointerId) return;
    const moved = this.drag.moved;
    this.clearDrag();
    if (moved) {
      this.suppressNextClick = event.type === 'pointerup';
      void this.persistPosition();
    }
  };

  private async persistPosition(): Promise<void> {
    const rect = this.getBounds();
    if (!rect) return;
    const petPosition = { xRatio: rect.left / Math.max(1, window.innerWidth), yRatio: rect.top / Math.max(1, window.innerHeight) };
    try {
      const settings = await getSettings();
      await saveSettings({ ...settings, petPosition });
    } catch (error) {
      console.debug('[FWA] Pet position could not be saved', error instanceof Error ? error.message : error);
    }
  }

  private async loadSprite(generation: number): Promise<void> {
    let objectUrl: string | null = null;
    const request = new AbortController();
    this.spriteRequest = request;
    try {
      const base = `pet/${this.petId}/`;
      const response = await fetch(chrome.runtime.getURL(`${base}pet.json`), { signal: request.signal });
      if (!response.ok) throw new Error('pet manifest unavailable');
      const manifest = await response.json() as PetManifest;
      const visualResponse = await fetch(chrome.runtime.getURL(`${base}${manifest.logoPath ?? manifest.spritesheetPath}`), { signal: request.signal });
      if (!visualResponse.ok) throw new Error('pet image unavailable');
      objectUrl = URL.createObjectURL(await visualResponse.blob());
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(new DOMException('Pet detached', 'AbortError'));
        request.signal.addEventListener('abort', abort, { once: true });
        img.onload = () => { request.signal.removeEventListener('abort', abort); resolve(); };
        img.onerror = () => { request.signal.removeEventListener('abort', abort); reject(new Error('pet image decode failed')); };
        img.src = objectUrl!;
        if (request.signal.aborted) abort();
      });
      if (generation !== this.generation || !this.spriteEl?.isConnected) return;
      const displayHeight = manifest.logoPath ? DISPLAY_WIDTH : (img.naturalHeight / GRID_ROWS) * DISPLAY_WIDTH / (img.naturalWidth / GRID_COLS);
      if (!Number.isFinite(displayHeight) || displayHeight <= 0) throw new Error('pet image dimensions invalid');
      this.frameCount = manifest.logoPath ? 1 : countUsedFrames(img, img.naturalWidth / GRID_COLS, img.naturalHeight / GRID_ROWS);
      this.spriteEl.style.width = `${DISPLAY_WIDTH}px`;
      this.spriteEl.style.height = `${displayHeight}px`;
      this.spriteEl.style.backgroundImage = `url(${objectUrl})`;
      this.spriteEl.style.backgroundSize = manifest.logoPath ? 'contain' : `${DISPLAY_WIDTH * GRID_COLS}px ${displayHeight * GRID_ROWS}px`;
      this.spriteEl.style.backgroundPosition = manifest.logoPath ? 'center' : '0 0';
      this.spriteEl.dataset.state = 'ready';
      this.objectUrl = objectUrl;
      objectUrl = null;
      this.clampToViewport();
      this.updateAnimation();
    } catch (error) {
      if (!request.signal.aborted) {
        // A neutral fallback appears only after a real load failure, never as a
        // transient frame while the bundled sprite is still being decoded.
        if (generation === this.generation && this.spriteEl?.isConnected) {
          this.spriteEl.dataset.state = 'fallback';
          this.spriteEl.replaceChildren(el('span', { class: 'fwa-pet-fallback', text: 'W' }));
        }
        console.debug('[FWA] Pet sprite unavailable', error instanceof Error ? error.message : error);
      }
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (this.spriteRequest === request) this.spriteRequest = null;
    }
  }

  private stopAnimation(): void {
    if (this.idleTimer !== null) window.clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  private readonly updateAnimation = (): void => {
    this.stopAnimation();
    if (!this.visible || !this.spriteEl?.isConnected || this.frameCount < 2 || document.hidden || this.reducedMotion?.matches) return;
    this.idleTimer = window.setInterval(() => {
      this.frame = (this.frame + 1) % this.frameCount;
      if (this.spriteEl) this.spriteEl.style.backgroundPosition = `${-this.frame * DISPLAY_WIDTH}px 0`;
    }, 1000 / IDLE_FPS);
  };
}
