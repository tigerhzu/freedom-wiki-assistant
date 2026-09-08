# 開發與驗證

## 環境與開始方式

使用 Node.js 20+；目前驗證環境為 Node.js 22、npm 10。`happy-dom` 的 Node.js 需求高於 Vite 的最低需求，因此不要只依 Vite 版本選擇 Node.js 18。

```powershell
npm ci
Copy-Item .env.example .env
```

編輯 `.env`，指定 Wiki HTTPS origin 與選用的客戶捷徑基底路徑。AI Key 由擴充功能設定頁輸入，不是建置環境變數。`VITE_` 值會成為輸出程式的一部分；本機私人網域不適合直接放入公開 Release。

## 目錄

```text
src/
  background/    背景訊息與 AI 排版服務
  config/        Wiki 網站、編輯器與圖片規則
  content/       工作台、Bridge、文件模型、同步與視覺編輯
  customers/     客戶目錄、資料夾與分支服務
  templates/     模板與變數
  shared/        型別、storage、AI client 與共同規則
  settings/      獨立設定頁與備份
  onboarding/    使用導覽
  pet/           Pet 元件與角色資產
  styles/        工具、工作區與視覺編輯樣式
tests/           Vitest 測試與本機介面 fixtures
scripts/         建置資產、manifest 驗證、預覽與發行設定
docs/            使用說明、架構、品牌與發行指南
```

## 建置

`npm run build` 依序執行：

1. TypeScript 型別檢查。
2. `vite.config.ts`：輸出 ES module 背景程式，以及設定頁／導覽頁。
3. `vite.content.config.ts`：以 IIFE 輸出 `content.js`。
4. `vite.bridge.config.ts`：以 IIFE 輸出頁面環境的 `page-bridge.js`。
5. `scripts/copy-static.mjs`：產生目標網站 manifest，複製圖片、Pet 與離線設定腳本。
6. `scripts/verify-manifest.mjs`：檢查 Wiki、Ornith 和 Azure host permissions。

輸出在 `dist/`。主建置會清空舊輸出；`npm run dev` 目前與 build 相同，不是常駐 watch server。完成後到瀏覽器擴充功能頁重新載入 `dist/`，並重新整理 Wiki。

## 本機互動預覽

```powershell
npm run preview:studio
```

| 路徑 | 範例 |
| --- | --- |
| `http://127.0.0.1:4187/` | 工作台、文章與編輯介面 |
| `/e/zh/studio-preview?images=1` | 圖片編輯範例 |
| `/src/settings/settings.html?preview=1` | 設定頁 |
| `/src/onboarding/onboarding.html?preview=1` | 使用導覽 |

預覽綁定 `127.0.0.1`，使用獨立的範例與 `sessionStorage` 資料，不呼叫正式 Wiki 上傳或 AI。它掛載實際介面元件，但 renderer 與 Chrome API 為測試替身，不能替代真實 Wiki.js 整合驗證。需要其他埠時可設定 `STUDIO_PREVIEW_PORT`。

## 自動檢查

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

`vitest.config.ts` 限定本專案 `tests/**/*.test.ts`，避免 Release 暫存區中的其他專案被同一測試執行器載入。測試涵蓋文件交易與同步、延遲投影、IME／游標情境、圖片語法與上傳競態、格式工具列、模板、客戶資料、AI Provider 與設定備份。

DOM 測試使用 happy-dom，網路與瀏覽器 API 依情境模擬。測試通過表示對應的單元與回歸案例通過，不等於所有 Wiki.js 版本、所有網站自訂樣式或正式 AI endpoint 已驗證。

本次公開發行的執行結果記錄於 [VALIDATION.md](VALIDATION.md)。

## 修改原則

- 文件修改經過 `WikiDocumentSync`，保留 origin 與版本資訊，避免把 DOM 或原生 editor 當成隱含同步通道。
- 視覺介面元件放在文章序列化容器外，避免工具列文字被存進文章。
- 非同步圖片、AI 與預覽結果，套用前檢查來源是否仍可定位。
- 若改動持久化設定，檢查舊資料合併及備份相容性。
- 先以去識別化 fixtures 驗證，再在有權使用的 Wiki 環境確認登入、Assets 與原生儲存。

進一步閱讀：[架構](ARCHITECTURE.md)、[介面設計](STUDIO_REDESIGN.md)、[Release](RELEASE.md)。
