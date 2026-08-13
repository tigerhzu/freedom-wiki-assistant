# Freedom Wiki Assistant

<p align="center">
  <img width="160" height="160" alt="Freedom Wiki Assistant logo" src="src/icons/wiki_logo_512.png" />
</p>

Freedom Wiki Assistant 是給 Wiki.js Markdown 編輯頁使用的 Chromium 擴充功能。它保留 Wiki.js 原生 Markdown 為唯一資料來源，並提供更方便的文字、圖片、版型與 Future 視覺化編輯功能。

## 下載與安裝

最簡單的方式是從 GitHub 的 **Releases** 下載最新的 `Freedom-Wiki-Assistant-v*.zip`：

1. 解壓縮下載的 ZIP 檔。
2. 在 Edge 開啟 `edge://extensions`，或在 Chrome 開啟 `chrome://extensions`。
3. 開啟右上角的「開發人員模式」。
4. 按「載入解壓縮檔」，選取解壓縮後的資料夾。
5. 前往公司 Wiki 的任一編輯頁面即可使用。

如果你下載的是原始碼 ZIP，請依照 [安裝與建置說明](docs/INSTALL.md) 建置後再載入 `dist/`。

## Future 視覺化編輯模式

Future 是全螢幕的視覺化編輯模式，讓使用者像直接修改 Wiki 頁面一樣編輯內容；背景會在儲存時自動產生並更新 Markdown。

- 在 Wiki.js 原生 `SAVE / PAGE / CLOSE` 操作列旁，使用 `Classic` 與 `Future` 切換模式。
- `Classic` 保留原生雙欄 Markdown 介面。
- `Future` 顯示全螢幕、可直接點選與輸入的頁面內容，但仍保留原生 `SAVE / PAGE / CLOSE`。
- Future 中點選 Wiki.js 原生 `SAVE`，會先同步視覺修改至 Markdown，再使用 Wiki.js 原生儲存流程。
- 文字反白後按右鍵，可設定字色、字級、粗體、斜體、底線、刪除線、背景標記、程式碼、對齊、縮排、引用與資訊框。
- 在圖片上按右鍵，可調整大小、對齊、圓角與框線；圖片樣式會保存成相容的 Markdown／HTML。
- 在 Future 貼上或拖曳圖片，會使用既有 Wiki.js Assets 上傳流程與目前頁面資料夾規則，不會把圖片存成 Base64。
- Unicode emoji 會維持為 emoji，不會因為儲存轉成大型 SVG 圖片。

Future 的詳細操作與限制請見 [Future 模式指南](docs/FUTURE_MODE.md)。

## 主要功能

- Markdown 編輯器的文字格式化右鍵選單。
- 圖片貼上／拖放上傳至 Wiki.js Assets，包含資料夾選擇與檔名去重。
- 圖片尺寸、對齊、圓角、框線與還原 Markdown。
- 資訊框、警告框、段落對齊、縮排與區塊引用。
- 文件範本、客戶捷徑、頁面拓譜與側欄外觀調整。
- Azure OpenAI 排版輔助（設定保存在瀏覽器本機）。

## 開發與驗證

```powershell
npm install
Copy-Item .env.example .env
npm run build
```

完整檢查：

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

環境變數請參考 [.env.example](.env.example)。除非是正式發行版，建置後請載入 `dist/` 目錄。

## 文件

- [安裝與建置](docs/INSTALL.md)
- [Future 模式指南](docs/FUTURE_MODE.md)
- [疑難排解](docs/TROUBLESHOOTING.md)

## 安全性

- 不要提交 `.env`、API Key、Cookie 或任何 Wiki.js 登入資訊。
- Azure OpenAI 設定保存在瀏覽器的 `chrome.storage.local`，不會寫入 Git。
- 圖片上傳使用目前已登入 Wiki.js 工作階段的原生 Assets 流程。
