import type { AiProvider, Settings } from './types';

export class AiProviderSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiProviderSettingsError';
  }
}

function isAiProvider(value: unknown): value is AiProvider {
  return value === '' || value === 'ornith' || value === 'azure';
}

export function hasAzureApiKey(settings: Pick<Settings, 'azureApiKey'>): boolean {
  return settings.azureApiKey.trim().length > 0;
}

export function hasOrnithApiKey(settings: Pick<Settings, 'ornithApiKey'>): boolean {
  return settings.ornithApiKey.trim().length > 0;
}

/**
 * Produces the only state that may be persisted or used for a request.
 * Existing installations predate aiProvider, so they are migrated to Azure.
 */
export function normalizeAiProviderSettings(
  settings: Settings,
  options: { legacyAzureDefault?: boolean; clearConflictingKeys?: boolean } = {},
): Settings {
  const azureConfigured = hasAzureApiKey(settings);
  const ornithConfigured = hasOrnithApiKey(settings);

  if (azureConfigured && ornithConfigured) {
    if (options.clearConflictingKeys) {
      return { ...settings, aiProvider: '', azureApiKey: '', ornithApiKey: '' };
    }
    throw new AiProviderSettingsError(
      'Ornith 與 Azure OpenAI API Key 不可同時儲存；請先移除目前 Provider 設定。',
    );
  }

  let aiProvider: AiProvider = isAiProvider(settings.aiProvider) ? settings.aiProvider : '';
  const keyWithoutProvider = !aiProvider && (azureConfigured || ornithConfigured);
  if (keyWithoutProvider) {
    // Only the old Azure-only schema may infer a provider. An explicit blank
    // provider is a fail-closed state, and Ornith never existed in that schema.
    if (options.legacyAzureDefault && azureConfigured && !ornithConfigured) {
      aiProvider = 'azure';
    } else if (options.clearConflictingKeys) {
      return { ...settings, aiProvider: '', azureApiKey: '', ornithApiKey: '' };
    } else {
      throw new AiProviderSettingsError('API Key 已存在但尚未選擇 Provider；請先移除設定後重新選擇。');
    }
  }

  const mismatchedKey =
    (azureConfigured && aiProvider === 'ornith') ||
    (ornithConfigured && aiProvider === 'azure');
  if (mismatchedKey) {
    if (options.clearConflictingKeys) {
      return { ...settings, aiProvider: '', azureApiKey: '', ornithApiKey: '' };
    }
    throw new AiProviderSettingsError('目前 Provider 與已儲存的 API Key 不一致；請先移除目前設定。');
  }

  if (azureConfigured && aiProvider === 'azure') aiProvider = 'azure';
  else if (ornithConfigured && aiProvider === 'ornith') aiProvider = 'ornith';
  else if (options.legacyAzureDefault) aiProvider = 'azure';

  return { ...settings, aiProvider };
}

/** Fail closed before any provider request is attempted. */
export function resolveActiveAiProvider(settings: Settings): Exclude<AiProvider, ''> {
  const normalized = normalizeAiProviderSettings(settings);
  if (!normalized.aiProvider) {
    throw new AiProviderSettingsError('請先至擴充套件設定頁選擇 Local Ornith 或 Azure OpenAI。');
  }
  return normalized.aiProvider;
}
