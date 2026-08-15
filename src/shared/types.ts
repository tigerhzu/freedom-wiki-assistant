/** Shared type definitions used across content script, background and settings. */

export type EditorKind =
  | 'textarea'
  | 'contenteditable'
  | 'codemirror5'
  | 'codemirror6'
  | 'monaco'
  | 'ace';

export type EditorMode = 'classic' | 'hybrid' | 'raw';

export interface SelectionInfo {
  text: string;
  start: number;
  end: number;
}

export interface Template {
  id: string;
  name: string;
  category: string;
  description: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A customer directory entry shown in the top-level "客戶" nav drawer.
 * Never hardcoded — stored in chrome.storage.local (see customer-service.ts)
 * so entries added by the user survive reloads.
 */
export interface Customer {
  id: string;
  name: string;
  /** Wiki page path this entry navigates to, e.g. "/docs/clients/example-client". */
  pagePath: string;
  /** Optional user-created folder. Missing values are treated as「未分類」for older data. */
  folderId?: string;
  createdAt: string;
}

/** A user-created folder used to group customer entries in the 客戶 drawer. */
export interface CustomerFolder {
  id: string;
  name: string;
  createdAt: string;
}

/**
 * One user-defined sub-page ("分支") under a customer in the 客戶目錄 drawer,
 * e.g. "Account Info/Plan" or "ChangeJournal". Like Customer these are never
 * hardcoded — see customers/customer-service.ts. Array order *is* the display
 * order (the drawer's ↑/↓ buttons rewrite it).
 */
export interface CustomerBranch {
  id: string;
  /** 顯示名稱, e.g. "SOP". */
  name: string;
  /**
   * Where the branch navigates to: either a wiki-relative path starting with
   * "/" (e.g. "/docs/clients/example-client/SOP") or a full http(s) URL for pages
   * that live outside this wiki.
   */
  target: string;
  createdAt: string;
}

/**
 * Branches grouped by customer code (客戶代號) rather than by customer id, so
 * the buckets stay readable in chrome.storage and survive a customer entry
 * being re-created. Key = customerBranchKey(customer.name).
 */
export type CustomerBranchMap = Record<string, CustomerBranch[]>;

export interface Settings {
  /** Wiki editor presentation. Markdown in the native editor remains the source of truth in every mode. */
  editorMode: EditorMode;
  enableFormattingMenu: boolean;
  enableImageDrop: boolean;
  enableClipboardImage: boolean;
  /** Default assets folder, used when auto-derivation fails; empty = always ask. */
  defaultImageFolder: string;
  /**
   * How the upload target folder is chosen:
   *  - 'currentPath'  : the current article's own path (default) — e.g. an
   *                      article at /docs/clients/example-client/SOP/onboarding uploads
   *                      into a same-named Assets folder.
   *  - 'parentFolder' : the article's containing directory instead.
   *  - 'manual'        : always show the folder picker.
   */
  folderStrategy: 'currentPath' | 'parentFolder' | 'manual';
  /** Markdown produced for uploaded images. Placeholders: {name}, {url}. */
  imageMarkdownFormat: string;
  defaultTextColor: string;
  /** User-defined color swatches (hex strings). */
  customSwatches: string[];
  /**
   * Custom Wiki.js navigation drawer gradient start color as a normalized #rrggbb value.
   * Empty string leaves the site's original theme untouched.
   */
  sidebarColor: string;
  /** Optional gradient end color; empty derives a subtle darker shade automatically. */
  sidebarGradientColor: string;
  /** Folders recently used for uploads (most recent first). */
  recentFolders: string[];
  /** Whether the "客戶" nav drawer was left open — restored after a reload. */
  customersPanelOpen: boolean;
  /**
   * Where the pet widget was last dragged to, as a fraction of the viewport
   * (0–1) so it re-lands sensibly regardless of window size; null = default
   * bottom-right corner.
   */
  petPosition: { xRatio: number; yRatio: number } | null;
  debugMode: boolean;
  /**
   * Azure OpenAI settings for the "AI 排版" feature. Same field shape as the
   * HaloPSA extension's options page (azureEndpoint/azureDeployment/
   * azureApiKey) so the two configs stay recognizable as one pattern, even
   * though each extension keeps its own chrome.storage.local (MV3 extensions
   * cannot share storage across separate extension IDs). Never hardcoded:
   * only ever read from here, which is only ever written by the settings
   * page. The API key must never be bundled at build time or read by the
   * content script — only background/service-worker.ts touches it.
   */
  azureEndpoint: string;
  azureDeployment: string;
  azureApiKey: string;
  azureApiVersion: string;
}

export const DEFAULT_SETTINGS: Settings = {
  editorMode: 'classic',
  enableFormattingMenu: true,
  enableImageDrop: true,
  enableClipboardImage: true,
  defaultImageFolder: '',
  folderStrategy: 'currentPath',
  imageMarkdownFormat: '![{name}]({url})',
  defaultTextColor: 'red',
  customSwatches: [],
  /** Default brand palette for a fresh extension install. */
  sidebarColor: '#a93d3d',
  sidebarGradientColor: '#531abc',
  recentFolders: [],
  customersPanelOpen: false,
  petPosition: null,
  debugMode: false,
  azureEndpoint: '',
  azureDeployment: '',
  azureApiKey: '',
  azureApiVersion: '2024-12-01-preview',
};

/**
 * Upload API description. All values MUST come from the Phase-1 discovery
 * (docs/DISCOVERY.md) — never guess them. While this is `null` in
 * wiki-config.ts the extension uses the fallback flow (open the wiki's own
 * assets manager) instead of calling an unverified endpoint.
 */
export interface UploadApiConfig {
  /** Endpoint path or URL template, e.g. "/api/assets/upload". */
  endpoint: string;
  method: 'POST' | 'PUT';
  /** FormData field name that carries the file. */
  fileField: string;
  /** FormData field name that carries the target folder, if any. */
  folderField?: string;
  /** Additional constant FormData fields. */
  extraFields?: Record<string, string>;
  /** Where the CSRF token comes from, if the wiki requires one. */
  csrf?: {
    source: 'cookie' | 'meta' | 'input';
    /** cookie name / meta name / input selector, depending on `source`. */
    key: string;
    /** HTTP header used to send the token, e.g. "X-CSRF-Token". */
    headerName: string;
  };
  /**
   * Dot-path into the JSON response that yields the final asset URL/path,
   * e.g. "data.path". Empty string means: build the URL from folder + filename.
   */
  responseUrlPath: string;
}

export interface UploadResult {
  /** Final URL/path usable inside Markdown. */
  url: string;
  fileName: string;
}
