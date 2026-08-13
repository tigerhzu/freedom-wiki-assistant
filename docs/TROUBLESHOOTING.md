# 疑難排解

## 擴充功能沒有出現在 Wiki 編輯頁

1. 確認已在 `edge://extensions` 或 `chrome://extensions` 啟用擴充功能。
2. 若從原始碼建置，確認 `.env` 的 `VITE_WIKI_ORIGIN` 與實際 Wiki 網域相同，然後重新執行 `npm run build`。
3. 在擴充功能頁面按重新載入，再重新整理 Wiki 編輯頁。
4. 確認網址為 Wiki.js 編輯頁，例如 `/e/en/...`。

## 看不到 Classic / Future 按鈕

按重新載入擴充功能後，重新整理 Wiki 編輯頁。按鈕會放在 Wiki.js 原生 `SAVE / PAGE / CLOSE` 操作列前方；若網站更新了編輯器版面，請回報目前畫面與網址格式。

## Future 中按 Save 沒有保存

Future 會使用 Wiki.js 原生 `SAVE` 按鈕保存。請確認：

- 仍在編輯頁而不是閱讀頁。
- 沒有圖片正在上傳。
- 沒有同時在左側 Markdown 編輯器修改內容；若同時修改，為避免覆寫，Future 會停止同步。

可以先切回 Classic 確認 Markdown 是否已更新，再按原生 `SAVE`。

## Future 的 emoji 或圖片大小不正確

請先更新到最新版擴充功能並重新載入頁面。Future 會把 Wiki.js 顯示用的 Twemoji SVG 還原為 Unicode emoji；若舊內容已儲存成 `/_assets/svg/twemoji/` 圖片，進入 Future 後重新儲存一次即可修復。

一般圖片可在 Future 中對圖片按右鍵，使用「原始尺寸」或選擇新的尺寸。

## 貼上圖片變成很長的 Base64 文字

確認設定頁的「圖片剪貼簿上傳」已啟用。Future 與 Classic 都會用 Wiki.js Assets 上傳流程處理圖片。若仍出現 Base64，請重新載入擴充功能並確認該圖片格式為 PNG、JPG、JPEG、WEBP 或 GIF。

## 圖片上傳失敗

確認目前帳號有 Wiki.js Assets 的建立資料夾與上傳權限。第一次上傳時會依設定建議目前頁面對應的資料夾；你可以改用選擇資料夾按鈕指定目標。

## Future 的右鍵選單沒有出現

文字功能需要先反白文字再按右鍵；圖片功能則直接在圖片上按右鍵。未選取任何內容時，保留瀏覽器原生右鍵選單。
