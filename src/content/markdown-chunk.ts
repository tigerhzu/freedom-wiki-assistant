import { splitMarkdownBlocks } from './quick-format';

/**
 * 把過長的 Markdown 切成多次 Azure OpenAI 呼叫的區塊。
 *
 * 為什麼需要切塊：AI 排版要求模型回傳「排版後的完整內容」，所以輸出長度與
 * 輸入同一個量級（再加上顏色標記與 JSON escape 的膨脹）。呼叫端的
 * max_tokens 是 4096，輸入若吃到上限，回傳的 JSON 就會被截斷成不合法的
 * 內容，使用者只會看到「AI 回傳內容不是有效的 JSON」而且重試也不會好。
 *
 * 切塊只在超過安全長度時才啟動（見 splitMarkdownForAi 的第一個 early
 * return）—— 一般長度的文章與選取範圍仍然是單次呼叫。
 */

/** 單次呼叫的目標長度（字元）。中文約 1 字 ≈ 1 token，留給輸出足夠餘裕。 */
export const AI_CHUNK_CHARS = 2400;

/**
 * 依區塊邊界切塊，絕不切開程式碼區塊、表格、清單或 HTML 包裝區塊
 * （邊界由 quick-format.ts 的 splitMarkdownBlocks 決定，兩邊共用同一份
 * 區塊定義）。標題是優先的切點，讓每一塊盡量對齊章節。
 *
 * 單一區塊本身就超過上限時（例如一個很長的程式碼區塊）不硬切，整塊送出，
 * 由背景的長度檢查決定是否要回報錯誤 —— 硬切程式碼區塊會產生不成對的
 * fence，比直接失敗更糟。
 */
export function splitMarkdownForAi(text: string, maxChars: number = AI_CHUNK_CHARS): string[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  if (normalized.trim() === '') return [];
  if (normalized.length <= maxChars) return [normalized];

  const chunks: string[] = [];
  let current: string[] = [];
  let length = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    chunks.push(current.join('\n\n'));
    current = [];
    length = 0;
  };

  for (const block of splitMarkdownBlocks(normalized.split('\n'))) {
    const blockText = block.lines.join('\n');
    if (blockText.trim() === '') continue;

    const cost = blockText.length + (current.length > 0 ? 2 : 0);
    const startsNewSection = block.kind === 'heading' && length >= maxChars / 2;
    if (current.length > 0 && (length + cost > maxChars || startsNewSection)) flush();

    current.push(blockText);
    length += blockText.length + (current.length > 1 ? 2 : 0);
  }
  flush();

  return chunks.length > 0 ? chunks : [normalized];
}
