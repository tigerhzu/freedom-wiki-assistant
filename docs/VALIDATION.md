# 0.3.4 公開發行驗證

驗證日期：2026-09-08。環境：Windows、Node.js 22.23.2、npm 10.9.8。

| 檢查 | 結果 |
| --- | --- |
| `npm run typecheck` | 通過 |
| `npm run lint` | 通過 |
| `npm test` | 40 個測試檔通過；510 項通過、1 項條件式略過 |
| `npm run build` | 三階段 Vite 建置、靜態資產複製與 manifest 權限驗證通過 |
| 公開建置設定 | Wiki origin 為 `https://wiki.example.invalid`，客戶基底路徑為 `/docs/clients` |
| 離線設定腳本 | Wiki 單獨設定、含埠設定、Wiki／Ornith 同時更新、重複設定皆通過 |
| 設定失敗保護 | HTTP、路徑、帳密、query、fragment、萬用字元、反斜線及 origin 碰撞均拒絕；檢查無效 Wiki 輸入前後檔案雜湊一致 |
| 發行來源隔離 | 腳本驗證在 `dist/` 副本進行，公開輸出保留示範 origin |
| 文件連結 | 公開 Markdown 文件的本機相對引用檢查通過 |

第一次在含其他專案 Release 暫存目錄的工作區執行 Vitest 時，測試發現範圍包含了其他專案，造成不相容的測試套件載入。新增 `vitest.config.ts` 限定本專案 `tests/**/*.test.ts` 後，標準 `npm test` 通過；未放寬測試斷言。

這次證據涵蓋型別、靜態檢查、單元／DOM 回歸、公開建置與離線設定檔修改。圖片與 AI 網路流程使用測試替身，沒有據此宣稱任何私人 Wiki、AI endpoint 或正式伺服器儲存已驗證。瀏覽器實際整合仍需在目標環境確認。
