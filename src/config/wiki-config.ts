import type { EditorKind, UploadApiConfig } from '../shared/types';

/**
 * ─────────────────────────────────────────────────────────────────────────
 *  所有「跟公司 Wiki 網站本身有關」的設定都集中在這個檔案。
 *
 *  ⚠️ 標記 TODO(DISCOVERY) 的欄位，必須依 docs/DISCOVERY.md 的第一階段
 *     調查結果填入，不可以用猜的。在填入之前，相關功能會走安全的
 *     fallback（generic 編輯器偵測、開啟原站 Assets 管理頁、顯示資料夾
 *     選擇器等）。
 * ─────────────────────────────────────────────────────────────────────────
 */

/**
 * 公司 Wiki（Wiki.js 2.x）。修改網域時必須同步修改根目錄 manifest.json 的：
 *   - host_permissions
 *   - content_scripts[0].matches
 *   - web_accessible_resources[0].matches
 */
/**
 * Wiki origin is injected at build time from VITE_WIKI_ORIGIN. The checked-in
 * fallback is deliberately non-routable so an unconfigured build cannot send
 * requests to an unintended site.
 */
export const WIKI_ORIGIN = (import.meta.env.VITE_WIKI_ORIGIN?.trim() || 'https://wiki.example.invalid').replace(/\/$/, '');

/**
 * Base path for newly created customer shortcuts. It is injected at build
 * time so installations with a different Wiki hierarchy do not need a code
 * change. A leading slash is required; the checked-in fallback is generic.
 */
const configuredCustomerBasePath = import.meta.env.VITE_CUSTOMER_BASE_PATH?.trim().replace(/\/+$/, '');
const CUSTOMER_BASE_PATH = configuredCustomerBasePath?.startsWith('/') ? configuredCustomerBasePath : '/docs/clients';

export interface EditorSelectorCandidate {
  selector: string;
  kind: EditorKind;
}

/**
 * Split a slash-separated path into safe segments: trims whitespace, drops
 * empty parts (repeated "//"), and drops "." / ".." so a hostile or malformed
 * path can never walk outside the Assets tree or produce an encoding oddity.
 * Shared by every folder-path derivation below — the single place that owns
 * "what counts as a safe path segment".
 */
export function sanitizePathSegments(path: string): string[] {
  return path
    .split('/')
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0 && seg !== '.' && seg !== '..');
}

export const wikiConfig = {
  origin: WIKI_ORIGIN,

  editor: {
    /**
     * Wiki.js 2.x Markdown 編輯器（依官方原始碼 editor-markdown.vue：
     * CodeMirror 5，CodeMirror.fromTextArea，外層 .editor-markdown）。
     * 已於實站 /en/eng/ExtensionTest 驗證：getValue/setValue、
     * getCursor/indexFromPos/getSelection/replaceSelection 皆正常運作，
     * CM change 事件會自動寫入 Vuex（不需手動觸發）。
     */
    candidateSelectors: [
      { selector: '.editor-markdown .CodeMirror', kind: 'codemirror5' },
    ] as EditorSelectorCandidate[],

    /** 允許 generic 偵測（.cm-content / .CodeMirror / .monaco-editor / .ace_editor / textarea）。 */
    genericDetection: true,

    /**
     * Vuetify 的按鈕 class 是自動產生、不可靠的，儲存按鈕改用文字比對：
     * 編輯頁工具列（header banner）裡文字為 "Save" 或 "Saved" 的按鈕。
     */
    saveButtonSelector: null as string | null,

    /** Verified on Wiki.js 2.x edit pages. The first child is the renderer-owned document wrapper. */
    previewContainerSelector: '.editor-markdown-preview',
    previewContentSelector: '.editor-markdown-preview-content',

    /** The green check action in the editor header is Wiki.js' native save flow. */
    saveButtonIconSelector: 'button .mdi-check',

    /** 編輯頁 URL 規則：/e/<locale>/<path>（實站確認，例：/e/en/eng/ExtensionTest）。 */
    editPagePattern: /^\/e\//,
  },

  formatting: {
    /**
     * 實站 /en/eng/ExtensionTest 預覽器兩種語法皆通過 DOMPurify、正常顯示：
     *   'span-style'     : <span style="font-size:18px">文字</span>
     *   'font-size-attr' : <font size="4">文字</font>
     * 兩者都可用，保留 'span-style' 為預設（CSS px 值較精確）。
     */
    fontSizeStrategy: 'span-style' as 'span-style' | 'font-size-attr',
    fontSizes: {
      small: { label: '小', spanStyle: '12px', fontAttr: '2' },
      medium: { label: '中', spanStyle: '18px', fontAttr: '4' },
      large: { label: '大', spanStyle: '24px', fontAttr: '5' },
      xlarge: { label: '特大', spanStyle: '32px', fontAttr: '6' },
    },
    /** <mark>/<u> 皆已於實站預覽器確認可正常顯示（DOMPurify 允許）。 */
    highlightTag: 'mark',
    underlineTag: 'u',
    presetColors: [
      { label: '紅色', value: 'red' },
      { label: '藍色', value: 'blue' },
      { label: '綠色', value: 'green' },
      { label: '橘色', value: 'orange' },
      { label: '紫色', value: 'purple' },
      { label: '黑色', value: 'black' },
    ],
  },

  assets: {
    /**
     * 上傳模式：
     *  - 'wikijs'  : Wiki.js 2.x 官方上傳流程（POST /u + GraphQL 資料夾解析），
     *                實作見 content/wikijs-upload.ts。
     *  - 'api'     : 一般 config 驅動上傳（uploadApi 必須非 null）。
     *  - 'fallback': 不呼叫任何 API，提示使用者用原站介面上傳。
     *
     * 已於 2026-07-24 在測試頁 /en/eng/ExtensionTest 完整驗證上傳流程
     * （含 GraphQL 資料夾解析、multipart 欄位、"ok" 回應、檔名正規化、
     * 最終網址、同名覆蓋行為、Authorization Bearer 需求），改為 'wikijs'。
     */
    mode: 'wikijs' as 'wikijs' | 'api' | 'fallback',

    /** Wiki.js 2.x 上傳端點與 GraphQL 端點（官方原始碼 upload.js / FilePond 設定）。 */
    wikijs: {
      uploadEndpoint: '/u',
      graphqlEndpoint: '/graphql',
      /** FilePond 檔案欄位與 metadata 欄位同名（server: multer field 'mediaUpload'）。 */
      uploadField: 'mediaUpload',
      /** 官方 UI 限制：單檔 5MB。 */
      maxFileSizeMB: 5,
    },

    /** 'api' 模式的設定（Wiki.js 用不到，保留給日後換系統）。 */
    uploadApi: null as UploadApiConfig | null,

    /**
     * Wiki.js 沒有獨立的 Assets 管理頁（在編輯器 modal 內），
     * fallback 模式僅顯示操作說明 toast。
     */
    assetsManagerUrl: null as string | null,

    /**
     * 依目前頁面路徑推導 Assets 目錄（不寫死任何路徑）：
     *   /e/<locale>/<dir...>/<page>  （編輯頁）
     *   /<locale>/<dir...>/<page>    （檢視頁）
     * → '/<dir...>'；Wiki.js 圖片路徑不含 locale（原始碼 editor-modal-media.vue
     *   insert(): path = '/' + folderSlugs.join('/') + '/' + filename）。
     * 推導出的資料夾仍會經 GraphQL 確認存在，不存在時改用資料夾選擇器。
     * TODO(VERIFY): locale 判斷規則待實站確認。
     */
    deriveFolderFromPath(pathname: string): string | null {
      const segs = pathname.split('/').filter(Boolean);
      if (segs[0] === 'e') segs.shift(); // 編輯頁前綴 /e/
      if (segs.length > 0 && /^[a-z]{2}(-[a-z]{2,4})?$/i.test(segs[0])) segs.shift(); // locale
      segs.pop(); // 文章本身
      return segs.length > 0 ? `/${segs.join('/')}` : null;
    },

    /**
     * 首頁或無路徑頁面（例如 Wiki.js 慣例的單一 "home" path）沒有自己的
     * 目錄結構可對應，改用固定的預設資料夾。
     */
    defaultUploadsFolder: '/uploads',

    /**
     * 「自動使用目前文章路徑」策略：資料夾＝文章本身（含文章名稱這一層）。
     * 輸入為 Wiki.js `page.path`（不含 locale、不含開頭斜線，例如
     * "docs/clients/example-client/SOP/onboarding" — 見 content/page-path.ts）。
     * 已於實站確認 Wiki.js Assets 資料夾支援中文 slug（GraphQL
     * createFolder 直接寫入、上傳、最終網址皆正常，見 DISCOVERY.md），
     * 所以不需要因為 CJK 而預先退回父層。
     */
    folderForArticlePath(articlePath: string): string {
      const segs = sanitizePathSegments(articlePath);
      if (segs.length === 0 || (segs.length === 1 && segs[0].toLowerCase() === 'home')) {
        return this.defaultUploadsFolder;
      }
      return `/${segs.join('/')}`;
    },

    /** 「使用目前文章的父資料夾」策略：資料夾＝文章所在目錄（去掉文章本身）。 */
    parentFolderForArticlePath(articlePath: string): string {
      const segs = sanitizePathSegments(articlePath);
      segs.pop();
      if (segs.length === 0) return this.defaultUploadsFolder;
      return `/${segs.join('/')}`;
    },

    allowedExtensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'],
  },

  customers: {
    /**
     * 客戶頁面實際存放路徑（實站確認：一篇客戶頁面的真實網址例如
     * https://wiki.example.invalid/docs/clients/example-client ，含 locale「en」、
     * 上層目錄「eng」，「Customers」為大寫開頭；不可省略 /eng/，
     * 也不可把 Customers 小寫）。
     */
    basePath: CUSTOMER_BASE_PATH,

    /**
     * 依客戶名稱組出頁面路徑。刻意保留使用者輸入的原始大小寫 —
     * 客戶頁面的 slug 是否大小寫視實際文章而定，不可一律強制轉小寫，
     * 否則會連到不存在的頁面（例如保留原始大小寫的代碼被轉為小寫）。
     * 只移除會破壞路徑結構的「/」，其餘字元交給 URL() 自動編碼。
     * 新增客戶對話框仍可在存檔前手動編輯此建議值。
     */
    defaultPagePathFor(name: string): string {
      const slug = name.trim().replace(/[\\/]+/g, '-');
      return `${this.basePath}/${slug || 'customer'}`;
    },
  },

  user: {
    /**
     * 實站確認：使用者顯示名稱只存在於 Account 選單的 Vuetify v-menu
     * 內容中，且該內容是點開選單時才 lazy-render 進 DOM（關閉時完全
     * 不存在），沒有其他公開、無需互動即可讀到的來源（document.cookie
     * 的 jwt 不算 — 那是 token，不是「公開顯示文字」）。為了不讓
     * {{current_user}} 觸發選單開闔的畫面閃爍副作用，維持 null，
     * 讓 placeholder 顯示空字串。
     */
    resolveCurrentUser: null as (() => string | null) | null,
  },

  pageTitle: {
    /**
     * 實站確認：document.title 是頁面 metadata 的 title 欄位（可能是
     * "Untitled Page"），跟內文 H1 標題不一定相同，所以改抓內文標題
     * `.contents h1.toc-header`。該 h1 開頭有一個 `¶` permalink 錨點
     * （`<a class="toc-anchor">¶</a>`），讀取後由 template-panel.ts
     * 去除。
     */
    selector: '.contents h1.toc-header' as string | null,
  },
} as const;

export type WikiConfig = typeof wikiConfig;
