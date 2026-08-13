# Future 模式指南

Future 是 Freedom Wiki Assistant 的視覺化編輯模式。它讓你直接在 Wiki 頁面外觀上輸入與調整內容，同時把結果同步為 Wiki.js 可保存的 Markdown。

## 進入與離開

- 在 Wiki.js 編輯頁的原生頂部操作列，按 `Future` 進入。
- 按 `Classic` 回到原生雙欄 Markdown 編輯器。
- 原生 `SAVE / PAGE / CLOSE` 始終保留；Future 中仍使用原生 `SAVE` 儲存。

## 儲存方式

Future 不會另建一份文件。按原生 `SAVE` 時，擴充功能會：

1. 將 Future 視覺內容同步到原生 Markdown。
2. 保留 Wiki.js 原本的儲存流程。
3. 由 Wiki.js 保存頁面與更新狀態。

不要在 Future 編輯期間同時修改左側原生 Markdown；若偵測到來源已變動，Future 會停止同步以避免覆寫內容。

## 文字與段落

反白文字後按右鍵，可使用：

- 文字顏色與自訂字色／背景色。
- 小、一般、中、大、特大字。
- 粗體、斜體、底線、刪除線、背景標記、行內程式碼與清除格式。
- 引用區塊、靠左／置中／靠右、增加／減少縮排與清除 HTML。
- 一般文字框、自訂框線，以及藍色、黃色、紅色、綠色、灰色等資訊框樣式。

## 圖片

直接在圖片上按右鍵，可設定：

- 預設寬度、原始尺寸或自訂寬高。
- 靠左、置中、靠右與取消對齊。
- 圓角、一般框線、粗框線與自訂框線。
- 移除圖片樣式或還原 Markdown 圖片。

在 Future 中貼上或拖放圖片時，圖片會使用原有的 Wiki.js Assets 上傳流程，不會寫入 Base64。上傳未完成前請不要儲存。

## Emoji 與相容性

Wiki.js 將 emoji 顯示成 Twemoji SVG。Future 在儲存時會還原 Unicode emoji，避免 SVG 被寫入 Markdown 後變得過大。

大部分標題、段落、清單、表格、引用、程式碼區塊、連結與混合文字都能安全視覺編輯。複雜的 Wiki.js 特殊語法、巨集或受保護區塊會保持原樣；請在 Classic 模式以 Markdown 修改它們。
