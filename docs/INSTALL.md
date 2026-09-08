# 安裝與更新

Wiki Studio 是以「載入解壓縮檔」方式安裝的 Chrome／Edge 擴充功能，主要支援 Wiki.js 2.x Markdown 編輯頁。公開 Release 使用示範網域，必須先指定自己的 Wiki 網域。

## 安裝 Release：不需 Node.js

1. 前往 [Releases](https://github.com/tigerhzu/freedom-wiki-assistant/releases/latest)，下載 `Freedom-Wiki-Assistant-v*.zip`。GitHub 自動附加的 **Source code** ZIP 是原始碼，需要自行建置。
2. 將安裝包解壓縮到固定位置，確認資料夾內有 `manifest.json`、`content.js` 與 `Configure-Wiki.ps1`。
3. 在該資料夾開啟 PowerShell，將以下示範網域換成自己的 Wiki 網域：

   ```powershell
   .\Configure-Wiki.ps1 -WikiOrigin https://wiki.example.org
   ```

4. 開啟 `edge://extensions` 或 `chrome://extensions`，啟用「開發人員模式」。
5. 按「載入解壓縮檔」，選擇含 `manifest.json` 的資料夾。
6. 登入目標 Wiki，重新整理 `/e/…` 編輯頁。原生 SAVE 旁會出現擴充功能的編輯模式與工具入口。

`WikiOrigin` 只接受 HTTPS origin，可帶連接埠，不可包含文章路徑、帳密、查詢參數或片段。設定腳本會更新 manifest 的網站匹配與權限，以及編譯 JavaScript 中相同的網站常數；單改 manifest 不足以完成設定。腳本不安裝相依套件、不發送網路請求、不接觸瀏覽器本機設定。

Windows 若因檔案下載標記或執行原則禁止腳本，依裝置管理規則允許這份經檢閱的腳本，或採用下方原始碼建置流程。受組織管理的瀏覽器也可能禁止開發人員模式，需使用該組織允許的擴充功能部署方式。

## 使用 Ornith 或 Azure OpenAI

使用自架 Ornith 時，在載入前同時設定服務 origin：

```powershell
.\Configure-Wiki.ps1 -WikiOrigin https://wiki.example.org -OrnithOrigin https://ornith.example.org
```

此處的 `OrnithOrigin` **不加 `/v1`**。載入後進入「設定 → AI 助手」，選擇 Local Ornith，確認 Base URL 以 `/v1` 結尾，並填入模型名稱與 API Key。Wiki 與 Ornith 需使用不同 origin；既有瀏覽器設定會保留，更換服務後須自行更新設定頁的 Base URL。

Azure OpenAI 使用既有的 `https://*.openai.azure.com/*` 權限。在設定頁選擇 Azure OpenAI，填入 endpoint、deployment、API version 與 API Key。AI 一次只啟用一個 Provider；切換前先按「移除設定」。

若未使用 AI，可略過 Provider 設定。一般編輯、圖片與模板功能不需要 AI Key。

## 更新版本並保留本機設定

先在設定頁匯出「不含 API Key」備份，並儲存需要保留的文章。下載新版本、解壓縮並重新執行網域設定。若更新原本固定的擴充功能資料夾，替換完成後到擴充功能頁按「重新載入」，再重新整理 Wiki。

若選擇改用新資料夾載入，瀏覽器可能建立不同的擴充功能 ID，因此不要假設資料會自動移轉。匯入備份、重新輸入 AI Key，確認後再移除舊版本。備份不包含尚未交由 Wiki.js 儲存的文章草稿。

## 從原始碼建置

需求為 Node.js 20+、npm、Chrome 或 Edge；開發驗證使用 Node.js 22。

```powershell
npm ci
Copy-Item .env.example .env
```

在 `.env` 設定自己的網站，以下只為示範：

```dotenv
VITE_WIKI_ORIGIN=https://wiki.example.org
VITE_CUSTOMER_BASE_PATH=/docs/clients
```

```powershell
npm run build
```

載入 `dist/`。如果需要自架 Ornith 權限，可在建置後執行：

```powershell
.\dist\Configure-Wiki.ps1 -WikiOrigin https://wiki.example.org -OrnithOrigin https://ornith.example.org
```

`.env` 用於建置網站設定；AI API Key 一律由擴充功能設定頁輸入。不要提交 `.env`、瀏覽器資料或含 Key 備份。完整開發流程見 [DEVELOPMENT.md](DEVELOPMENT.md)。
