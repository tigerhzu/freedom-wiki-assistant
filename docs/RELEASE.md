# 發行指南

發行包是可載入的擴充功能檔案，加上不需 Node.js 的網域設定腳本。Source code 則保留 TypeScript、測試、文件與品牌 SVG；`dist/` 不作為主要原始碼維護。

## 版本與輸出

`package.json`、`package-lock.json` 的根版本與 `manifest.json` 必須一致，目前為 `0.3.4`。GitHub Release 的 tag、說明與安裝 ZIP 也應對應相同版本。文件中的 [CHANGELOG](CHANGELOG.md) 提供精簡變更說明。

## 建置公開安裝包

先執行型別檢查、lint 與完整測試，再以示範設定覆寫本機建置環境：

```powershell
npm ci
npm run typecheck
npm run lint
npm test
$env:VITE_WIKI_ORIGIN = 'https://wiki.example.invalid'
$env:VITE_CUSTOMER_BASE_PATH = '/docs/clients'
npm run build
Remove-Item Env:VITE_WIKI_ORIGIN
Remove-Item Env:VITE_CUSTOMER_BASE_PATH
```

正式打包腳本應以 `try/finally` 還原原本環境值。Vite 與 `copy-static.mjs` 會讀取 production 環境；直接執行 build 可能把私人 `.env` 的網站值寫入輸出，因此不能跳過示範環境覆寫。AI 預設 origin 為 `https://ornith.example.invalid`，API Key 應維持空白。

將 **dist 內部檔案**放入 `Freedom-Wiki-Assistant-v<version>.zip`，讓解壓縮根目錄直接包含：

```text
manifest.json
Configure-Wiki.ps1
background.js
content.js
page-bridge.js
assets/
chunks/
icons/
pet/
src/settings/
src/onboarding/
```

可另附使用說明、授權／來源聲明及 SHA-256 校驗檔。不要將 `.env`、`.memory`、瀏覽器資料、含 Key 備份、公司文章、未清理的截圖、node_modules 或其他專案暫存目錄放入安裝包。

## 離線設定腳本驗證

在公開 `dist/` 的副本測試 `Configure-Wiki.ps1`，避免將測試網址寫入最終發行包：

1. 以自訂 Wiki origin 執行，確認 manifest 的 host permission、content script matches、web accessible resource matches 一致更新。
2. 同時指定 Ornith origin，確認只有該單一服務權限被替換，Azure 範圍保持原值。
3. 檢查編譯 `.js` 的舊 origin 已被精準更新，並確認可重新設定新 origin。
4. 確認 HTTP、路徑、帳密、查詢、fragment、萬用字元和服務 origin 碰撞會被拒絕，且拒絕時不修改檔案。
5. 確認最終發行來源仍是未設定的示範 `dist/`。

此腳本的作用是部署目標設定，不會更動瀏覽器內既有 Provider 設定或登入資料。

## GitHub 檢閱

核對 README 的圖片與相對連結、Mermaid 架構圖、Release ZIP 的內部結構、manifest 參照檔案，以及版本／校驗碼。GitHub 自動生成的 Source code ZIP 不等於預先建置的安裝包，Release 說明應清楚區分。

測試說明需區分本機單元／DOM 測試、瀏覽器範例驗證與真實 Wiki.js 整合。只有在實際完成對應流程後，才宣稱正式登入、圖片上傳、AI 呼叫或伺服器儲存已驗證。
