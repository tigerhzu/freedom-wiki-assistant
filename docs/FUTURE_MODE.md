# Future 模式指南

Future 是 Freedom Wiki Assistant 的視覺化編輯模式。它讓你直接在 Wiki 頁面外觀上輸入與調整內容，並即時同步為 Wiki.js 可保存的 Markdown。你不需要手動撰寫 Markdown；按下儲存時只會接續 Wiki.js 的原生保存流程。

## 30 秒開始使用

1. 開啟 Wiki.js 的**編輯頁**。
2. 在原生 `SAVE / PAGE / CLOSE` 操作列左側按 `Future`。
3. 像平常編輯網頁一樣直接點選文字、輸入內容，或在圖片上按右鍵調整樣式。
4. 按原生 `SAVE` 儲存。修改內容已經即時同步至 Markdown。

如果沒有看到 `Classic` 與 `Future`，請到 Edge 或 Chrome 的擴充功能頁重新載入擴充功能，再重新整理 Wiki 編輯頁。

## 進入與離開

- 在 Wiki.js 編輯頁的原生頂部操作列，按 `Future` 進入。
- 按 `Classic` 回到原生雙欄 Markdown 編輯器。
- 原生 `SAVE / PAGE / CLOSE` 始終保留；Future 中仍使用原生 `SAVE` 儲存。

## 儲存方式

Future 不會另建一份文件。編輯期間，擴充功能會：

1. 將 Classic 左側、Classic 右側與 Future 共用同一份原生 Markdown。
2. 在每次文字、貼上、圖片或圖片樣式修改後即時同步內容。
3. 按下 `SAVE` 時保留 Wiki.js 原本的儲存流程，由 Wiki.js 保存頁面與更新狀態。

切換到 Classic 修改左側原生 Markdown 後，Future 會等待 Wiki.js 預覽更新，再重新同步視覺編輯區；請等畫面更新完成後再繼續輸入。

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
