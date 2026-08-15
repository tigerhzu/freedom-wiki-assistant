import type { AiLayoutRequestMessage } from '../shared/messages';
import type { AiLayoutResponse, AiLayoutResult, AiLayoutUsage } from '../shared/ai-layout-types';
import type { SelectionInfo } from '../shared/types';
import type { EditorAdapter } from './editor-adapter';
import { AI_CHUNK_CHARS, splitMarkdownForAi } from './markdown-chunk';
import { diffLines, isDiffFeasible } from './text-diff';
import { el, openModal, showLoadingToast, showToast } from './ui';

/**
 * AI 排版把內容送到背景 service worker（唯一持有 Azure
 *    OpenAI API key 的地方），文章過長時先切塊循序處理。
 *
 * 兩者都讀編輯器的內容（CodeMirror 的 document，不是頁面文字），也都
 * 永不自動儲存：套用只更新編輯器內的值，跟模板的「插入／取代全文」一樣，
 * 使用者還是得自己按 Wiki 的 Save。
 *
 * 有選取文字時只處理選取範圍，並且只把結果替換回那個範圍；沒有選取時
 * 處理整篇文章。
 */

// Longer than the background's own 60s Azure OpenAI timeout so we don't give
// up on the response the background is still waiting to return. This is a
// per-chunk timeout — a chunked run legitimately takes longer in total.
const CLIENT_TIMEOUT_MS = 75000;

function sendAiLayoutRequest(content: string, chunkIndex: number, chunkTotal: number): Promise<AiLayoutResponse> {
  return new Promise((resolve, reject) => {
    if (!chrome?.runtime?.sendMessage) {
      reject(new Error('擴充套件背景服務無法連線（chrome.runtime 不可用）'));
      return;
    }

    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`AI 排版逾時（超過 ${CLIENT_TIMEOUT_MS / 1000} 秒）`));
    }, CLIENT_TIMEOUT_MS);

    const message: AiLayoutRequestMessage = {
      type: 'fwa:ai-layout-request',
      content,
      chunkIndex,
      chunkTotal,
    };
    try {
      chrome.runtime.sendMessage(message, (response: AiLayoutResponse | undefined) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        const lastErr = chrome.runtime.lastError;
        if (lastErr) {
          reject(new Error(lastErr.message || '背景服務無回應'));
          return;
        }
        if (!response) {
          reject(new Error('背景服務無回應'));
          return;
        }
        resolve(response);
      });
    } catch (err) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * 結果要寫回哪裡。選取模式記下當初的範圍與原文，套用時據此驗證位置
 * ——AI 呼叫可能要等數十秒，期間使用者可能已經移動游標或改過內容。
 */
type ApplyTarget = { mode: 'document' } | { mode: 'selection'; start: number; end: number; text: string };

interface LayoutSource {
  /**
   * 要排版並顯示在 Diff 左側的原文，換行已正規化為 \n。
   * 注意這不等於 target.text —— 後者必須保持編輯器裡的原字串，重新定位時
   * 要拿它去比對編輯器內容。
   */
  text: string;
  target: ApplyTarget;
}

/** 換行正規化：Diff 與「有沒有變動」的比較都要在同一種換行下進行。 */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.trim() !== ''))];
}

function sumUsage(list: AiLayoutUsage[]): AiLayoutUsage | null {
  if (list.length === 0) return null;
  return {
    promptTokens: list.reduce((n, u) => n + u.promptTokens, 0),
    cachedTokens: list.reduce((n, u) => n + u.cachedTokens, 0),
    completionTokens: list.reduce((n, u) => n + u.completionTokens, 0),
    totalTokens: list.reduce((n, u) => n + u.totalTokens, 0),
    cacheReported: list.every((u) => u.cacheReported),
  };
}

/**
 * 頁面 console 的用量記錄（背景 service worker 另有每次呼叫的逐筆記錄）。
 * cached input 是 Azure 的 prompt cache 命中量：System Prompt 與規則固定不變、
 * 文章內容放在最後，就是為了讓這個數字盡量大。
 */
function logUsageTotal(usage: AiLayoutUsage | null, chunkTotal: number): void {
  const where = chunkTotal > 1 ? `${chunkTotal} 段合計` : '單次';
  if (!usage) {
    console.info(`[FWA] AI 排版完成（${where}）— Azure 沒有回傳 usage，無法記錄 token 用量`);
    return;
  }
  const cached = usage.cacheReported ? `${usage.cachedTokens}` : '未回報';
  const hitRate = usage.cacheReported && usage.promptTokens > 0
    ? ` (${Math.round((usage.cachedTokens / usage.promptTokens) * 100)}%)`
    : '';
  console.info(
    `[FWA] AI 排版完成（${where}）— input ${usage.promptTokens} / cached input ${cached}${hitRate} / output ${usage.completionTokens} / total ${usage.totalTokens}`,
  );
  if (!usage.cacheReported) {
    console.info(
      '[FWA] 此 deployment 沒有回傳 usage.prompt_tokens_details.cached_tokens；Azure 的 Prompt Cache 需要 GPT-4o 或更新的模型，且提示長度要超過 1024 tokens。',
    );
  }
}

export class AiLayoutFeature {
  constructor(
    private readonly adapter: EditorAdapter,
    private readonly prepareEditor: () => boolean = () => true,
    private readonly getVisualSelection: () => SelectionInfo | null = () => null,
  ) {}

  detach(): void {
    document.getElementById('fwa-ai-layout-modal-host')?.remove();
  }

  /** 有選取就只處理選取範圍，否則處理整篇文章。 */
  private resolveSource(visualSelection: SelectionInfo | null): LayoutSource | null {
    const whole = this.adapter.getValue();
    let selection = visualSelection ?? this.adapter.getSelection();

    if (visualSelection && whole.slice(selection.start, selection.end) !== selection.text) {
      const relocated = whole.indexOf(selection.text);
      if (relocated < 0 || relocated !== whole.lastIndexOf(selection.text)) return null;
      selection = { start: relocated, end: relocated + selection.text.length, text: selection.text };
    }
    if (selection.text.trim() !== '') {
      return {
        text: normalizeNewlines(selection.text),
        target: { mode: 'selection', start: selection.start, end: selection.end, text: selection.text },
      };
    }
    if (whole.trim() === '') return null;
    return { text: normalizeNewlines(whole), target: { mode: 'document' } };
  }

  /* ────────────────────────────── AI 排版 ────────────────────────────── */

  async openAi(): Promise<void> {
    const visualSelection = this.getVisualSelection();
    if (!this.prepareEditor()) return;
    const source = this.resolveSource(visualSelection);
    if (!source) {
      showToast('目前頁面沒有內容可以排版', 'error');
      return;
    }

    const chunks = splitMarkdownForAi(source.text, AI_CHUNK_CHARS);
    if (chunks.length === 0) {
      showToast('目前頁面沒有內容可以排版', 'error');
      return;
    }

    const scope = source.target.mode === 'selection' ? '選取範圍' : '整篇文章';
    const loading = showLoadingToast(`AI 正在排版${scope}，請稍候…`);

    const formatted: string[] = [];
    const changes: string[] = [];
    const warnings: string[] = [];
    const usages: AiLayoutUsage[] = [];

    for (let i = 0; i < chunks.length; i++) {
      if (chunks.length > 1) {
        loading.setMessage(`AI 正在排版${scope}（第 ${i + 1}/${chunks.length} 段），請稍候…`);
      }

      let response: AiLayoutResponse;
      try {
        response = await sendAiLayoutRequest(chunks[i], i + 1, chunks.length);
      } catch (err) {
        loading.close();
        showToast(`AI 排版失敗：${err instanceof Error ? err.message : String(err)}`, 'error');
        return;
      }
      if (!response.ok) {
        loading.close();
        const where = chunks.length > 1 ? `（第 ${i + 1}/${chunks.length} 段）` : '';
        showToast(`AI 排版失敗${where}：${response.error}`, 'error');
        return;
      }

      const label = chunks.length > 1 ? `第 ${i + 1} 段：` : '';
      formatted.push(response.result.formatted_content);
      changes.push(...response.result.changes.map((c) => `${label}${c}`));
      warnings.push(...response.result.warnings.map((w) => `${label}${w}`));
      if (response.result.usage) usages.push(response.result.usage);
    }

    loading.close();
    logUsageTotal(sumUsage(usages), chunks.length);

    if (chunks.length > 1) {
      warnings.push(
        `⚠ 內容較長，已切成 ${chunks.length} 段分別排版。每段看不到其他段落，跨章節的標題層級一致性請自行確認。`,
      );
    }

    this.showReviewModal({
      title: `AI 排版預覽（${scope}；確認後才會寫入編輯器，不會自動儲存）`,
      original: source.text,
      target: source.target,
      result: {
        formatted_content: formatted.join('\n\n'),
        changes: uniqueStrings(changes),
        warnings: uniqueStrings(warnings),
      },
    });
  }

  /* ───────────────────────────── 預覽與寫回 ───────────────────────────── */

  private showReviewModal(opts: {
    title: string;
    original: string;
    result: AiLayoutResult;
    target: ApplyTarget;
  }): void {
    const { title, original, result, target } = opts;
    const modal = openModal(title, 'fwa-ai-layout-modal-host', 'fwa-modal-wide');

    if (target.mode === 'selection') {
      modal.body.append(
        el('div', { class: 'fwa-ai-changes' }, [
          el('div', { class: 'fwa-ai-box-title', text: '處理範圍' }),
          el('div', { text: '只處理你選取的範圍，套用時也只會替換這一段，文章其他部分不會被動到。' }),
        ]),
      );
    }

    if (result.warnings.length > 0) {
      modal.body.append(
        el('div', { class: 'fwa-ai-warnings' }, [
          el('div', { class: 'fwa-ai-box-title', text: '⚠ 需要人工確認' }),
          el(
            'ul',
            {},
            result.warnings.map((w) => el('li', { text: w })),
          ),
        ]),
      );
    }

    if (result.changes.length > 0) {
      modal.body.append(
        el('div', { class: 'fwa-ai-changes' }, [
          el('div', { class: 'fwa-ai-box-title', text: '整理項目' }),
          el(
            'ul',
            {},
            result.changes.map((c) => el('li', { text: c })),
          ),
        ]),
      );
    }

    modal.body.append(el('div', { class: 'fwa-ai-box-title', text: '內容差異（左：原文刪除／右：排版後新增）' }));
    modal.body.append(this.buildDiffView(original, result.formatted_content));

    const cancel = el('button', { class: 'fwa-btn', text: '取消' });
    const confirm = el('button', { class: 'fwa-btn fwa-btn-primary', text: '套用（尚未儲存）' });
    cancel.addEventListener('click', () => modal.close());
    confirm.addEventListener('click', () => {
      modal.close();
      if (!this.applyResult(target, result.formatted_content)) return;
      this.adapter.focus();
      showToast('已套用排版結果，尚未儲存 — 請確認內容後於 Wiki 按下「Save」', 'success', 6000);
    });
    modal.footer.append(cancel, confirm);
  }

  /**
   * 寫回編輯器。選取模式不盲寫：先確認當初的範圍還在原處，否則用原文重新
   * 定位；找不到或有多處相同內容就中止，讓使用者重新選取，而不是覆蓋到
   * 錯誤的位置。整篇模式沿用 setValue。
   */
  private applyResult(target: ApplyTarget, formatted: string): boolean {
    if (target.mode === 'document') {
      this.adapter.setValue(formatted);
      return true;
    }

    const current = this.adapter.getValue();
    let { start, end } = target;

    if (current.slice(start, end) !== target.text) {
      const first = current.indexOf(target.text);
      if (first < 0 || first !== current.lastIndexOf(target.text)) {
        showToast('編輯器內容在排版期間變動過，找不到原本選取的位置，未套用。請重新選取後再試。', 'error', 7000);
        return false;
      }
      start = first;
      end = first + target.text.length;
    }

    this.adapter.setSelection(start, end);
    this.adapter.replaceSelection(formatted);
    return true;
  }

  private buildDiffView(original: string, formatted: string): HTMLElement {
    if (!isDiffFeasible(original, formatted)) {
      return el('div', { class: 'fwa-diff-fallback' }, [
        el('div', { class: 'fwa-ai-box-title', text: '原始內容' }),
        el('pre', { class: 'preview', text: original }),
        el('div', { class: 'fwa-ai-box-title', text: '排版後' }),
        el('pre', { class: 'preview', text: formatted }),
      ]);
    }

    const lines = diffLines(original, formatted);
    const container = el('pre', { class: 'fwa-diff' });
    for (const line of lines) {
      const prefix = line.type === 'add' ? '+ ' : line.type === 'remove' ? '- ' : '  ';
      container.appendChild(el('div', { class: `fwa-diff-line fwa-diff-${line.type}`, text: prefix + line.text }));
    }
    return container;
  }
}
