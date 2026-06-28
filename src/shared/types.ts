export type ProviderType = "openai-compatible" | "libretranslate" | "mymemory";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TranslationProvider {
  id: string;
  name: string;
  type: ProviderType;
  enabled: boolean;
  baseUrl: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  temperature?: number;
}

export interface AppConfig {
  version: 1;
  hotkey: string;
  sourceLanguage: string;
  targetLanguage: string;
  promptTemplate: string;
  activeProviderId: string;
  providers: TranslationProvider[];
  ocr: {
    languages: string;
  };
  windowBehavior: {
    alwaysOnTop: boolean;
  };
}

export interface RuntimeConfig extends AppConfig {
  userDataPath: string;
  encryptionAvailable: boolean;
}

export interface CapturedImage {
  displayId: string;
  bounds: Rect;
  dataUrl: string;
  png: Buffer;
}

export interface OcrResult {
  text: string;
  latencyMs: number;
}

export interface TranslationResult {
  translatedText: string;
  providerId: string;
  providerName: string;
  model?: string;
  latencyMs: number;
}

export type ResultPhase = "idle" | "capturing" | "ocr" | "translating" | "done" | "error";

export interface ResultState {
  phase: ResultPhase;
  sourceText: string;
  translatedText: string;
  providerId?: string;
  providerName?: string;
  model?: string;
  latencyMs?: number;
  error?: string;
}
