# 疑難排解

## 擴充功能完全沒有反應

1. 確認 `manifest.json` 與 `src/config/wiki-config.ts` 的網域已改成
   公司 Wiki 的真實網域（兩邊必須一致），並重新 build + 重新載入。
2. 確認目前頁面是「編輯頁」且頁面上偵測得到編輯器。
   在設定頁開啟 **Debug Mode** 後，DevTools Console 會出現
   `[FWA] editor detected: <kind>` 之類的生命週期記錄
   （不會輸出文章內容、Cookie 或 Token）。
3. `edge://extensions` → 該擴充功能 → 「錯誤」按鈕，檢查是否有例外。

## 右鍵沒有出現格式化選單

- 選單只在**有反白文字**時出現；沒有選取文字時會保留瀏覽器原生選單（設計如此）。
- 設定頁確認「啟用文字格式化右鍵選單」有勾選。
- 若編輯器是 CodeMirror/Monaco/Ace，需要 `page-bridge.js` 成功注入。
  Console 若出現 `page-bridge.js failed to load`，檢查 manifest 的
  `web_accessible_resources.matches` 網域是否正確。

## 套用格式後「儲存」按鈕沒有感知到變更

編輯器透過框架（Vue/React）綁定時，可能需要額外事件。
`TextareaAdapter.notifyChange()` 目前送出 `input` + `change`；
若仍不足，依 DISCOVERY 調查結果調整該方法（例如改用
`InputEvent` 搭配 `inputType: 'insertText'`）。

## 圖片拖進去只出現「上傳 API 尚未設定」

`wiki-config.ts` 的 `assets.uploadApi` 仍是 `null` —
必須先完成 `docs/DISCOVERY.md` 的上傳 API 調查並填入設定。
在那之前擴充功能不會呼叫任何未經確認的端點。
若已設定 `assets.assetsManagerUrl`，會自動開啟原站 Assets 管理頁作為 fallback。

## 上傳失敗（HTTP 403 / 419）

多半是 CSRF Token 設定不正確：

- 確認 `uploadApi.csrf.source`（cookie / meta / input）與 `key` 正確。
- 在 DevTools Network 比對原站上傳時實際送出的 header 名稱與值來源。

## 上傳成功但 Markdown 圖片路徑錯誤

- 若回應是 JSON：檢查 `uploadApi.responseUrlPath`（dot-path，例如 `data.path`）。
- 若由「資料夾 + 檔名」組合：檢查 `assets.deriveFolderFromPath` 的推導規則。
- 中文檔名會自動做 URL encode；若 Wiki 期待原始字元，需調整
  `sanitize-filename.ts` 的 `encodeAssetPath`。

## 模板變數沒有被替換

- 變數格式必須是 `{{date}}`（雙大括號、無空白）。
- `{{current_user}}` 在 `user.resolveCurrentUser` 未設定前一律為空白（設計如此，不猜測）。
- 未知變數會原樣保留，方便發現拼字錯誤。

## SPA 切換文章後功能消失

`PageObserver` 會在 URL 或 DOM 變動後自動重新偵測編輯器（約 0.4 秒 debounce）。
若特定頁面仍失效，開啟 Debug Mode 觀察是否有 `editor detected` 記錄，
並確認編輯器 selector 是否已加入 `wikiConfig.editor.candidateSelectors`。

## 擴充功能樣式影響到 Wiki 頁面

理論上不會發生：所有 UI 都在 Shadow DOM（`:host { all: initial }`）內。
若仍有干擾，檢查頁面上 `#fwa-*-host` 元素是否被網站腳本移動或修改。
