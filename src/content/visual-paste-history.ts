/** Undo a controlled paste by swapping only its inserted range. Keeping the
 * other DOM nodes alive preserves the browser's earlier typing history. */
export interface VisualPasteEdit {
  root: HTMLElement;
  before: string;
  after: string;
  swap(): boolean;
}

export function visualMarkup(root: HTMLElement): string {
  return root.innerHTML
    .replace(/\s(?:data-fwa-[\w-]+|contenteditable|spellcheck)="[^"]*"/g, '')
    .replace(/ title="(?:圖片內容受保護，可使用圖片功能更換|特殊 Markdown 區塊受保護，請切換 Raw 模式修改)"/g, '');
}

export function createVisualPasteEdit(
  root: HTMLElement,
  before: string,
  inserted: readonly Node[],
  replaced: DocumentFragment,
): VisualPasteEdit {
  const range = document.createRange();
  range.setStartBefore(inserted[0]);
  range.setEndAfter(inserted.at(-1)!);
  let saved = replaced;
  return {
    root, before, after: visualMarkup(root),
    swap() {
      if (!root.contains(range.commonAncestorContainer)) return false;
      const outgoing = range.extractContents();
      range.collapse(true);
      const incoming = Array.from(saved.childNodes);
      range.insertNode(saved);
      if (incoming.length > 0) {
        range.setStartBefore(incoming[0]);
        range.setEndAfter(incoming.at(-1)!);
      }
      saved = outgoing;
      const caret = range.cloneRange();
      caret.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(caret);
      return true;
    },
  };
}
