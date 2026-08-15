/**
 * Markdown 區塊切分工具，供 AI 長文切塊使用。
 *
 * 這個模組的安全保證（也是它刻意接受的限制）：
 *   只調整「區塊與區塊之間的空行」、標題 `#` 後面的空白、以及行尾空白。
 *   不重排段落、不改寫任何一行的行內字元、不調整縮排、不轉換清單符號。
 *
 * 因為行內字元一律不動，URL、IP、圖片路徑、HTML 標籤、行內與區塊程式碼、
 * Wiki.js macro 等特殊語法在結構上就不可能被破壞 —— 不需要 placeholder
 * 替換，也不需要維護一份「保留清單」。想做語意層面的整理（標題層級、SOP
 * 結構、顏色重點）請用 AI 排版，那是另一條路徑。
 *
 * 純函式、無 DOM；只辨識區塊邊界，不修改 Markdown 內容。
 */

export type MdBlockKind = 'heading' | 'fence' | 'html' | 'table' | 'list' | 'quote' | 'paragraph';

export interface MdBlock {
  kind: MdBlockKind;
  /** 區塊內容，逐行原樣保留（不含區塊之間的空行）。 */
  lines: string[];
}

const RE_HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const RE_FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const RE_TABLE = /^ {0,3}\|/;
const RE_LIST = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const RE_QUOTE = /^ {0,3}>/;
const RE_HTML_OPEN = /^ {0,3}<([a-zA-Z][\w:-]*)\b[^>]*>[ \t]*$/;
const RE_INDENTED = /^[ \t]+\S/;

/**
 * 只有這些標籤會被當成「整塊保留」的 HTML 區塊。清單刻意保守：
 * `<div>` 是 block-format.ts 的文字框／對齊／縮排產物，必須原樣保留，
 * 否則在裡面插入空行會改變 markdown-it 的解析方式。
 */
const BLOCK_TAGS = new Set(['div', 'details', 'section', 'figure', 'blockquote', 'table', 'aside']);

/** 是否為「會打斷段落」的區塊起始行（CommonMark 的 interrupt 規則）。 */
function interruptsParagraph(line: string): boolean {
  return RE_HEADING.test(line) || RE_FENCE_OPEN.test(line) || RE_LIST.test(line) || RE_QUOTE.test(line);
}

/**
 * 把 Markdown 切成區塊，每個區塊的內容逐行原樣保留。區塊之間的空行不會
 * 進到任何區塊裡（分隔由呼叫端決定），作為 AI 切塊
 * （markdown-chunk.ts）的共用基礎。
 *
 * 關鍵的保守設計：
 *  - `|` 開頭的行只有在「區塊開頭」才算表格。GFM 的表格無法打斷段落，
 *    若把段落後面緊接的 `|` 行切出來並補上空行，原本不是表格的內容會
 *    突然變成表格 —— 那是改變渲染結果，不是排版。
 *  - 清單與引用會吸收 lazy continuation（緊接著的非空白行），否則插入
 *    空行會把它們從清單項／引用裡切出去。
 */
export function splitMarkdownBlocks(lines: readonly string[]): MdBlock[] {
  const blocks: MdBlock[] = [];
  const n = lines.length;
  let i = 0;

  while (i < n) {
    if (lines[i].trim() === '') {
      i++;
      continue;
    }

    const line = lines[i];

    // ── 程式碼區塊：從開頭的 fence 到對應的結束 fence，內部完全不解讀 ──
    const fence = RE_FENCE_OPEN.exec(line);
    if (fence) {
      const closeRe = fence[1].startsWith('`') ? /^ {0,3}`{3,}[ \t]*$/ : /^ {0,3}~{3,}[ \t]*$/;
      const out = [line];
      i++;
      while (i < n) {
        const closed = closeRe.test(lines[i]);
        out.push(lines[i]);
        i++;
        if (closed) break;
      }
      blocks.push({ kind: 'fence', lines: out });
      continue;
    }

    // ── HTML 區塊（block-format.ts 的 <div> 包裝等）：整塊原樣保留 ──
    const html = RE_HTML_OPEN.exec(line);
    if (html && BLOCK_TAGS.has(html[1].toLowerCase())) {
      const tag = html[1].toLowerCase();
      const openRe = new RegExp(`^ {0,3}<${tag}\\b[^>]*>[ \\t]*$`, 'i');
      const closeRe = new RegExp(`^ {0,3}</${tag}\\s*>[ \\t]*$`, 'i');
      const out: string[] = [];
      let depth = 0;
      let closedAt = -1;
      for (let j = i; j < n; j++) {
        out.push(lines[j]);
        if (openRe.test(lines[j])) depth++;
        else if (closeRe.test(lines[j])) {
          depth--;
          if (depth === 0) {
            closedAt = j;
            break;
          }
        }
      }
      if (closedAt >= 0) {
        blocks.push({ kind: 'html', lines: out });
        i = closedAt + 1;
        continue;
      }
      // 找不到成對的結束標籤：往下當普通段落處理，不要把整篇文章吞成一塊。
    }

    // ── 標題：單獨一行 ──
    if (RE_HEADING.test(line)) {
      blocks.push({ kind: 'heading', lines: [line] });
      i++;
      continue;
    }

    // ── 表格：只有在區塊開頭出現的 `|` 行才算 ──
    if (RE_TABLE.test(line)) {
      const out: string[] = [];
      while (i < n && RE_TABLE.test(lines[i])) out.push(lines[i++]);
      blocks.push({ kind: 'table', lines: out });
      continue;
    }

    // ── 引用區塊：含 lazy continuation ──
    if (RE_QUOTE.test(line)) {
      const out: string[] = [];
      while (i < n && lines[i].trim() !== '') {
        if (out.length > 0 && (RE_HEADING.test(lines[i]) || RE_FENCE_OPEN.test(lines[i]) || RE_LIST.test(lines[i]))) {
          break;
        }
        out.push(lines[i]);
        i++;
      }
      blocks.push({ kind: 'quote', lines: out });
      continue;
    }

    // ── 清單：含縮排子項、lazy continuation，以及 loose list 的內部空行 ──
    if (RE_LIST.test(line)) {
      const out: string[] = [line];
      i++;
      while (i < n) {
        const cur = lines[i];
        if (cur.trim() === '') {
          let j = i;
          while (j < n && lines[j].trim() === '') j++;
          // 空行之後還是清單項或縮排內容 → 同一個 loose list，內部多個空行收斂成一行。
          if (j < n && (RE_LIST.test(lines[j]) || RE_INDENTED.test(lines[j]))) {
            out.push('');
            i = j;
            continue;
          }
          break;
        }
        if (RE_HEADING.test(cur) || RE_FENCE_OPEN.test(cur) || RE_QUOTE.test(cur)) break;
        out.push(cur);
        i++;
      }
      blocks.push({ kind: 'list', lines: out });
      continue;
    }

    // ── 一般段落：到空行或會打斷段落的區塊起始為止 ──
    const out: string[] = [line];
    i++;
    while (i < n && lines[i].trim() !== '' && !interruptsParagraph(lines[i])) {
      out.push(lines[i]);
      i++;
    }
    blocks.push({ kind: 'paragraph', lines: out });
  }

  return blocks;
}
