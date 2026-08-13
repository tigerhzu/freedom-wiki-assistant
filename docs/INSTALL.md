# 安裝與建置

## 給一般使用者：安裝發行版

1. 到 GitHub 專案的 **Releases** 下載最新版 `Freedom-Wiki-Assistant-v*.zip`。
2. 將 ZIP 解壓縮到不會被移動的位置。
3. 在 Microsoft Edge 開啟 `edge://extensions`，或在 Google Chrome 開啟 `chrome://extensions`。
4. 開啟「開發人員模式」。
5. 按「載入解壓縮檔」。
6. 選取剛才解壓縮後、內含 `manifest.json` 的資料夾。
7. 進入公司 Wiki 的編輯頁，確認原生頂部列出現 `Classic` 與 `Future`。

日後更新時，下載新版本並解壓縮到新資料夾，再於擴充功能頁按「載入解壓縮檔」選取新資料夾；舊版本可在確認新版本正常後移除。

## 給開發者：從原始碼建置

### 需求

- Node.js 18 以上
- npm
- Microsoft Edge 或 Google Chrome
- 可登入的 Wiki.js 2.x 網站

### 設定與建置

```powershell
npm install
Copy-Item .env.example .env
```

編輯 `.env`：

```dotenv
VITE_WIKI_ORIGIN=https://wiki.example.invalid
VITE_CUSTOMER_BASE_PATH=/docs/clients
```

`VITE_WIKI_ORIGIN` 必須是目標 Wiki 的 HTTPS 網域，不要加上結尾 `/` 或頁面路徑。

```powershell
npm run build
```

建置完成後，在 `edge://extensions` 或 `chrome://extensions` 使用「載入解壓縮檔」並選取 `dist/`。

### 驗證

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

不要把 `.env`、網站登入資訊或 API Key 提交到 Git。
