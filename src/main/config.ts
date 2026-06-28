import { app, safeStorage } from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppConfig, RuntimeConfig, TranslationProvider } from "../shared/types";

const CONFIG_FILE = "settings.json";
const ENCRYPTED_PREFIX = "safe:";
export const DEFAULT_PROMPT_TEMPLATE = "Translate from {sourceLanguage} to {targetLanguage}. Return only the translated text. Preserve line breaks.";

export const defaultProviders: TranslationProvider[] = [
  {
    id: "openai-compatible",
    name: "AI compatible API",
    type: "openai-compatible",
    enabled: false,
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    timeoutMs: 45000,
    temperature: 0.1
  },
  {
    id: "libretranslate",
    name: "LibreTranslate",
    type: "libretranslate",
    enabled: false,
    baseUrl: "https://libretranslate.com",
    timeoutMs: 30000
  },
  {
    id: "mymemory",
    name: "MyMemory free API",
    type: "mymemory",
    enabled: true,
    baseUrl: "https://api.mymemory.translated.net",
    timeoutMs: 30000
  }
];

export const defaultConfig: AppConfig = {
  version: 1,
  hotkey: "CommandOrControl+Shift+T",
  sourceLanguage: "auto",
  targetLanguage: "zh-CN",
  promptTemplate: DEFAULT_PROMPT_TEMPLATE,
  activeProviderId: "mymemory",
  providers: defaultProviders,
  ocr: {
    languages: "eng+chi_sim"
  },
  windowBehavior: {
    alwaysOnTop: true
  }
};

export function getConfigPath(): string {
  return path.join(app.getPath("userData"), CONFIG_FILE);
}

export function loadConfig(): AppConfig {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return cloneConfig(defaultConfig);
  }

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as Partial<AppConfig>;
    return sanitizeConfig(decryptConfig(raw));
  } catch (error) {
    console.error("Failed to read settings.json", error);
    return cloneConfig(defaultConfig);
  }
}

export function saveConfig(config: AppConfig): AppConfig {
  const clean = sanitizeConfig(config);
  const encrypted = encryptConfig(clean);
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  fs.writeFileSync(getConfigPath(), `${JSON.stringify(encrypted, null, 2)}\n`, "utf8");
  return clean;
}

export function toRuntimeConfig(config: AppConfig): RuntimeConfig {
  return {
    ...cloneConfig(config),
    userDataPath: app.getPath("userData"),
    encryptionAvailable: safeStorage.isEncryptionAvailable()
  };
}

function sanitizeConfig(input: Partial<AppConfig>): AppConfig {
  const merged: AppConfig = {
    ...cloneConfig(defaultConfig),
    ...input,
    ocr: {
      ...defaultConfig.ocr,
      ...(input.ocr ?? {})
    },
    windowBehavior: {
      ...defaultConfig.windowBehavior,
      ...(input.windowBehavior ?? {})
    },
    providers: sanitizeProviders(input.providers)
  };

  if (!merged.hotkey.trim()) {
    merged.hotkey = defaultConfig.hotkey;
  }

  if (!merged.sourceLanguage.trim()) {
    merged.sourceLanguage = defaultConfig.sourceLanguage;
  }

  if (!merged.targetLanguage.trim()) {
    merged.targetLanguage = defaultConfig.targetLanguage;
  }

  if (!merged.promptTemplate.trim()) {
    merged.promptTemplate = defaultConfig.promptTemplate;
  }

  if (!merged.ocr.languages.trim()) {
    merged.ocr.languages = defaultConfig.ocr.languages;
  }

  if (!merged.providers.some((provider) => provider.id === merged.activeProviderId)) {
    merged.activeProviderId = merged.providers.find((provider) => provider.enabled)?.id ?? merged.providers[0]?.id ?? "mymemory";
  }

  return merged;
}

function sanitizeProviders(providers: TranslationProvider[] | undefined): TranslationProvider[] {
  const source = providers?.length ? providers : defaultProviders;
  const seen = new Set<string>();

  return source.map((provider) => {
    const id = provider.id?.trim() || randomUUID();
    const uniqueId = seen.has(id) ? randomUUID() : id;
    seen.add(uniqueId);

    return {
      id: uniqueId,
      name: provider.name?.trim() || provider.type,
      type: provider.type,
      enabled: Boolean(provider.enabled),
      baseUrl: provider.baseUrl?.trim() || defaultBaseUrl(provider.type),
      apiKey: provider.apiKey?.trim() || undefined,
      model: provider.model?.trim() || undefined,
      timeoutMs: Number.isFinite(provider.timeoutMs) ? provider.timeoutMs : 30000,
      temperature: Number.isFinite(provider.temperature) ? provider.temperature : 0.1
    };
  });
}

function defaultBaseUrl(type: TranslationProvider["type"]): string {
  if (type === "libretranslate") {
    return "https://libretranslate.com";
  }
  if (type === "mymemory") {
    return "https://api.mymemory.translated.net";
  }
  return "https://api.openai.com/v1";
}

function encryptConfig(config: AppConfig): AppConfig {
  const copy = cloneConfig(config);
  copy.providers = copy.providers.map((provider) => ({
    ...provider,
    apiKey: encryptSecret(provider.apiKey)
  }));
  return copy;
}

function decryptConfig(config: Partial<AppConfig>): Partial<AppConfig> {
  const copy = cloneConfig(config);
  copy.providers = copy.providers?.map((provider) => ({
    ...provider,
    apiKey: decryptSecret(provider.apiKey)
  }));
  return copy;
}

function encryptSecret(secret: string | undefined): string | undefined {
  if (!secret || secret.startsWith(ENCRYPTED_PREFIX) || !safeStorage.isEncryptionAvailable()) {
    return secret;
  }

  return `${ENCRYPTED_PREFIX}${safeStorage.encryptString(secret).toString("base64")}`;
}

function decryptSecret(secret: string | undefined): string | undefined {
  if (!secret?.startsWith(ENCRYPTED_PREFIX) || !safeStorage.isEncryptionAvailable()) {
    return secret;
  }

  try {
    return safeStorage.decryptString(Buffer.from(secret.slice(ENCRYPTED_PREFIX.length), "base64"));
  } catch (error) {
    console.error("Failed to decrypt provider secret", error);
    return undefined;
  }
}

function cloneConfig<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
