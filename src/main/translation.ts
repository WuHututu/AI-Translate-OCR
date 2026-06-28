import type { AppConfig, TranslationProvider, TranslationResult } from "../shared/types";

interface JsonValue {
  [key: string]: unknown;
}

type StreamUpdate = (delta: string, accumulated: string) => void;

export async function translateText(text: string, config: AppConfig, providerId?: string): Promise<TranslationResult> {
  return translateTextStream(text, config, providerId);
}

export async function translateTextStream(
  text: string,
  config: AppConfig,
  providerId?: string,
  onUpdate?: StreamUpdate
): Promise<TranslationResult> {
  const cleanText = text.trim();
  if (!cleanText) {
    throw new Error("No translatable text was recognized");
  }

  const provider = resolveProvider(config, providerId);
  const started = Date.now();

  if (provider.type === "openai-compatible") {
    const translatedText = await translateWithOpenAiCompatibleStream(cleanText, config, provider, onUpdate);
    return toResult(provider, translatedText, Date.now() - started);
  }

  if (provider.type === "libretranslate") {
    const translatedText = await translateWithLibreTranslate(cleanText, config, provider);
    return toResult(provider, translatedText, Date.now() - started);
  }

  const translatedText = await translateWithMyMemory(cleanText, config, provider);
  return toResult(provider, translatedText, Date.now() - started);
}

const DEFAULT_PROMPT_TEMPLATE = "Translate from {sourceLanguage} to {targetLanguage}. Return only the translated text. Preserve line breaks.";

export function renderPrompt(template: string, sourceLanguage: string, targetLanguage: string): string {
  const replacements: Record<string, string> = {
    sourcelanguage: sourceLanguage,
    source_language: sourceLanguage,
    "source-language": sourceLanguage,
    source: sourceLanguage,
    from: sourceLanguage,
    源语言: sourceLanguage,
    原语言: sourceLanguage,
    原文语言: sourceLanguage,
    targetlanguage: targetLanguage,
    target_language: targetLanguage,
    "target-language": targetLanguage,
    target: targetLanguage,
    to: targetLanguage,
    目标语言: targetLanguage,
    译文语言: targetLanguage
  };

  return (template?.trim() ? template : DEFAULT_PROMPT_TEMPLATE).replace(
    /\{\{\s*([^{}]+?)\s*\}\}|\{\s*([^{}]+?)\s*\}/g,
    (match, doubleKey: string | undefined, singleKey: string | undefined) => {
      const key = normalizePromptKey(doubleKey ?? singleKey ?? "");
      return replacements[key] ?? match;
    }
  );
}

function normalizePromptKey(key: string): string {
  return key.trim().replace(/\s+/g, "").toLowerCase();
}
function resolveProvider(config: AppConfig, providerId?: string): TranslationProvider {
  const requested = providerId ? config.providers.find((provider) => provider.id === providerId) : undefined;
  const active = config.providers.find((provider) => provider.id === config.activeProviderId);
  const provider = requested ?? active ?? config.providers[0];

  if (!provider) {
    throw new Error("No translation provider is configured");
  }

  if (!provider.enabled) {
    throw new Error(`Translation provider is disabled: ${provider.name}`);
  }

  return provider;
}

async function translateWithOpenAiCompatibleStream(
  text: string,
  config: AppConfig,
  provider: TranslationProvider,
  onUpdate?: StreamUpdate
): Promise<string> {
  if (!provider.model) {
    throw new Error("AI compatible provider is missing a model name");
  }

  const endpoint = `${trimSlash(provider.baseUrl)}/chat/completions`;
  const targetLanguage = languageLabel(config.targetLanguage);
  const sourceLanguage = config.sourceLanguage === "auto" ? "auto-detected source language" : languageLabel(config.sourceLanguage);
  const prompt = renderPrompt(config.promptTemplate, sourceLanguage, targetLanguage);
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      accept: "text/event-stream",
      "content-type": "application/json",
      ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {})
    },
    body: JSON.stringify({
      model: provider.model,
      temperature: provider.temperature ?? 0.1,
      stream: true,
      messages: [
        {
          role: "system",
          content: prompt
        },
        {
          role: "user",
          content: text
        }
      ]
    })
  }, provider.timeoutMs);

  if (!response.body) {
    const fallback = await response.text();
    throw new Error(fallback || "AI provider returned no streaming body");
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(readErrorMessage(body, response.status));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let accumulated = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf("\n");

    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");

      const payload = readStreamPayload(line);
      if (!payload) {
        continue;
      }

      const delta = readStreamingDelta(payload);
      if (delta) {
        accumulated += delta;
        onUpdate?.(delta, accumulated);
        if (onUpdate) {
          await yieldToRenderer();
        }
      }
    }
  }

  buffer += decoder.decode();
  const remaining = readSsePayloads(buffer);
  const fallbackPayloads = remaining.length ? remaining : [buffer.trim()].filter(Boolean);
  for (const payload of fallbackPayloads) {
    const delta = readStreamingDelta(payload);
    if (delta) {
      accumulated += delta;
      onUpdate?.(delta, accumulated);
      if (onUpdate) {
        await yieldToRenderer();
      }
    }
  }

  if (!accumulated.trim()) {
    throw new Error("AI provider returned no translated text");
  }

  return accumulated;
}

function yieldToRenderer(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
function readSsePayloads(chunk: string): string[] {
  return chunk
    .split(/\r?\n/)
    .map((line) => readStreamPayload(line.trim()))
    .filter((payload): payload is string => Boolean(payload));
}

function readStreamPayload(line: string): string {
  if (!line || line.startsWith(":")) {
    return "";
  }

  const payload = line.startsWith("data:") ? line.slice(5).trim() : line;
  return payload && payload !== "[DONE]" ? payload : "";
}

function readStreamingDelta(payload: string): string {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(payload) as JsonValue;
  } catch {
    return "";
  }

  return readPath<string>(parsed, ["choices", 0, "delta", "content"])
    ?? readPath<string>(parsed, ["choices", 0, "message", "content"])
    ?? readPath<string>(parsed, ["choices", 0, "text"])
    ?? readPath<string>(parsed, ["output_text"])
    ?? "";
}

async function translateWithLibreTranslate(text: string, config: AppConfig, provider: TranslationProvider): Promise<string> {
  const endpoint = provider.baseUrl.endsWith("/translate") ? provider.baseUrl : `${trimSlash(provider.baseUrl)}/translate`;
  const response = await fetchJson(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      q: text,
      source: config.sourceLanguage === "auto" ? "auto" : normalizeLanguage(config.sourceLanguage),
      target: normalizeLanguage(config.targetLanguage),
      format: "text",
      ...(provider.apiKey ? { api_key: provider.apiKey } : {})
    })
  }, provider.timeoutMs);

  const translated = typeof response.translatedText === "string" ? response.translatedText.trim() : "";
  if (!translated) {
    throw new Error("LibreTranslate returned no translated text");
  }

  return translated;
}

async function translateWithMyMemory(text: string, config: AppConfig, provider: TranslationProvider): Promise<string> {
  const source = config.sourceLanguage === "auto" ? inferSourceForMyMemory(config.targetLanguage) : normalizeLanguage(config.sourceLanguage);
  const target = normalizeLanguage(config.targetLanguage);
  const endpoint = new URL(`${trimSlash(provider.baseUrl)}/get`);
  endpoint.searchParams.set("q", text);
  endpoint.searchParams.set("langpair", `${source}|${target}`);

  if (provider.apiKey) {
    endpoint.searchParams.set("key", provider.apiKey);
  }

  const response = await fetchJson(endpoint.toString(), {
    method: "GET"
  }, provider.timeoutMs);

  const translated = readPath<string>(response, ["responseData", "translatedText"])?.trim();
  if (!translated) {
    const detail = typeof response.responseDetails === "string" ? response.responseDetails : "MyMemory returned no translated text";
    throw new Error(detail);
  }

  return translated;
}

async function fetchJson(url: string, init: RequestInit, timeoutMs = 30000): Promise<JsonValue> {
  const response = await fetchWithTimeout(url, init, timeoutMs);
  const body = await response.text();
  let parsed: JsonValue;

  try {
    parsed = body ? JSON.parse(body) as JsonValue : {};
  } catch {
    parsed = { raw: body };
  }

  if (!response.ok) {
    const message = typeof parsed.error === "string" ? parsed.error : readErrorMessage(body, response.status);
    throw new Error(message);
  }

  return parsed;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 30000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function readErrorMessage(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as JsonValue;
    if (typeof parsed.error === "string") {
      return parsed.error;
    }
    const nestedMessage = readPath<string>(parsed, ["error", "message"]);
    if (nestedMessage) {
      return nestedMessage;
    }
  } catch {
    // Ignore non-JSON error bodies.
  }
  return body || `Request failed: HTTP ${status}`;
}

function toResult(provider: TranslationProvider, translatedText: string, latencyMs: number): TranslationResult {
  return {
    translatedText,
    providerId: provider.id,
    providerName: provider.name,
    model: provider.model,
    latencyMs
  };
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeLanguage(language: string): string {
  const lower = language.toLowerCase();
  if (lower.startsWith("zh")) {
    return "zh";
  }
  if (lower.startsWith("en")) {
    return "en";
  }
  if (lower.startsWith("ja")) {
    return "ja";
  }
  if (lower.startsWith("ko")) {
    return "ko";
  }
  return lower.split("-")[0] || "en";
}

function inferSourceForMyMemory(targetLanguage: string): string {
  return normalizeLanguage(targetLanguage) === "en" ? "zh" : "en";
}

function languageLabel(language: string): string {
  const normalized = normalizeLanguage(language);
  const labels: Record<string, string> = {
    zh: "Simplified Chinese",
    en: "English",
    ja: "Japanese",
    ko: "Korean",
    fr: "French",
    de: "German",
    es: "Spanish",
    ru: "Russian"
  };
  return labels[normalized] ?? language;
}

function readPath<T>(value: unknown, path: Array<string | number>): T | undefined {
  let current = value;
  for (const key of path) {
    if (current === null || current === undefined) {
      return undefined;
    }
    current = (current as Record<string | number, unknown>)[key];
  }
  return current as T | undefined;
}