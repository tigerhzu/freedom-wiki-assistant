# Freedom Wiki Assistant

<p align="center">
  <img width="160" height="160" alt="Freedom Wiki Assistant logo" src="src/icons/wiki_logo_512.png" />
</p>

Freedom Wiki Assistant 是給 Wiki.js Markdown 編輯頁使用的 Chromium 擴充功能。它保留 Wiki.js 原生 Markdown 為唯一資料來源，並提供更方便的文字、圖片、版型與 Future 視覺化編輯功能。

最新安裝包請到 [GitHub Releases](https://github.com/tigerhzu/freedom-wiki-assistant/releases/latest) 下載。

## 0.3.0 版本重點

- 編輯頁新增 `Classic`／`Future` 模式切換、`設定` 快速入口，以及可直接在 Wiki 內容上操作的視覺化編輯介面。
- 客戶目錄支援拖曳排序、重新命名、資料夾分類、匯入／匯出，以及「新增這個介面」快速保存目前 Wiki 頁面。
- 文件模板支援搜尋、分類、預覽、插入、編輯、複製、匯入／匯出與拖曳排序。
- 設定頁改為簡潔卡片式介面，提供側欄色票即時預覽、圖片上傳規則、Azure OpenAI 與完整設定備份。
- 完整設定可一次包含色票、客戶、資料夾、模板、圖片與 AI 設定；另提供不含 API Key 的安全搬移版本。

## 下載與安裝

最簡單的方式是從 GitHub 的 **Releases** 下載最新的 `Freedom-Wiki-Assistant-v*.zip`：

1. 解壓縮下載的 ZIP 檔。
2. 在 Edge 開啟 `edge://extensions`，或在 Chrome 開啟 `chrome://extensions`。
3. 開啟右上角的「開發人員模式」。
4. 按「載入解壓縮檔」，選取解壓縮後的資料夾。
5. 前往公司 Wiki 的任一編輯頁面即可使用。

如果你下載的是原始碼 ZIP，請依照 [安裝與建置說明](docs/INSTALL.md) 建置後再載入 `dist/`。

## 給朋友的快速開始

1. 從 [Releases](https://github.com/tigerhzu/freedom-wiki-assistant/releases/latest) 下載並解壓縮最新版安裝包。
2. 在 `edge://extensions` 或 `chrome://extensions` 開啟「開發人員模式」，按「載入解壓縮檔」，選取解壓縮後含有 `manifest.json` 的資料夾。
3. 開啟 Wiki.js 的任一**編輯頁**，在原生 `SAVE / PAGE / CLOSE` 左側按 `Future`；若要使用原生 Markdown 編輯器則按 `Classic`。
4. 直接在頁面上點選、輸入或貼上內容；不需要手動寫 Markdown。
5. 完成後按 Wiki.js 原生 `SAVE`。Future 會先把視覺修改轉成 Markdown，再交給 Wiki.js 儲存。

首次安裝後若看不到按鈕，回到擴充功能頁按重新載入，再重新整理 Wiki 編輯頁即可。

## Future 視覺化編輯模式

Future 是全螢幕的視覺化編輯模式，讓使用者像直接修改 Wiki 頁面一樣編輯內容；背景會在儲存時自動產生並更新 Markdown。它不是另一個預覽面板：你可以直接在右側頁面內容上修改，不必了解 Markdown 語法。

- 在 Wiki.js 原生 `SAVE / PAGE / CLOSE` 操作列旁，使用 `Classic` 與 `Future` 切換模式。
- `Classic` 保留原生雙欄 Markdown 介面，右側頁面也能直接編輯；離開右側或按下 `SAVE` 時，修改會同步到左側 Markdown。
- `Future` 顯示全螢幕、可直接點選與輸入的頁面內容，但仍保留原生 `SAVE / PAGE / CLOSE`。
- Future 中點選 Wiki.js 原生 `SAVE`，會先同步視覺修改至 Markdown，再使用 Wiki.js 原生儲存流程。
- 文字反白後按右鍵，可設定字色、字級、粗體、斜體、底線、刪除線、背景標記、程式碼、對齊、縮排、引用與資訊框。
- 在圖片上按右鍵，可調整大小、對齊、圓角與框線；圖片樣式會保存成相容的 Markdown／HTML。
- 在 Future 貼上或拖曳圖片，會使用既有 Wiki.js Assets 上傳流程與目前頁面資料夾規則，不會把圖片存成 Base64。
- Unicode emoji 會維持為 emoji，不會因為儲存轉成大型 SVG 圖片。

Future 的詳細操作與限制請見 [Future 模式指南](docs/FUTURE_MODE.md)。

## 客戶與模板管理

在 Wiki.js 編輯頁的擴充功能工具列開啟「客戶」後，可以：

- 拖曳客戶卡片調整順序，並將客戶拖到資料夾分類。
- 用鉛筆按鈕重新命名客戶，或用「新增這個介面」把目前頁面存成客戶捷徑。
- 建立資料夾、匯入／匯出客戶名單，以及保留同一客戶的常用頁面分支。

「模板」面板提供模板拖曳排序、分類、搜尋、預覽、插入、編輯、複製、刪除與 JSON 備份。

## 設定與資料搬移

按 Wiki.js 編輯頁工具列的「設定」可開啟完整設定頁：

- 在「外觀」調整側欄主色與漸層色，並在即時預覽中查看按鈕的互動效果。
- 設定圖片上傳資料夾判斷方式、Markdown 格式與 AI 排版參數。
- 「匯出所有設定（不含 API Key）」適合搬到另一台電腦；匯入後會還原色票、客戶、資料夾、模板與其他設定。
- 「匯出全部設定（含 API Key）」只應在你確認檔案保存風險後使用。

設定與 API Key 儲存在瀏覽器本機，不會自動同步到 GitHub。

## 主要功能

- Markdown 編輯器的文字格式化右鍵選單。
- 圖片貼上／拖放上傳至 Wiki.js Assets，包含資料夾選擇與檔名去重。
- 圖片尺寸、對齊、圓角、框線與還原 Markdown。
- 資訊框、警告框、段落對齊、縮排與區塊引用。
- 文件範本、客戶捷徑、客戶資料夾、頁面拓譜與側欄外觀調整。
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
- Azure OpenAI 設定保存在瀏覽器的 `chrome.storage.local`，不會寫入 Git；發布的 ZIP 也不包含任何 API Key。
- 圖片上傳使用目前已登入 Wiki.js 工作階段的原生 Assets 流程。
