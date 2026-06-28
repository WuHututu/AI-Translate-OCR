import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, Menu, nativeImage, Notification, screen, Tray } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { AppConfig, Rect, ResultState } from "../shared/types";
import { captureSelection, getVirtualBounds } from "./capture";
import { loadConfig, saveConfig, toRuntimeConfig } from "./config";
import { recognizeImages, shutdownOcr } from "./ocr";
import { translateTextStream } from "./translation";

let config: AppConfig;
let tray: Tray | null = null;
let overlayWindow: BrowserWindow | null = null;
let resultWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let currentResultState: ResultState = createIdleState();
let resultRendererReady = false;
let resultReadyResolver: (() => void) | null = null;
let resultReadyPromise: Promise<void> | null = null;
let lastJob: { selection?: Rect; sourceText?: string } = {};
let isQuitting = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.setAppUserModelId("com.codex.screenshottranslator");

if (process.env.SCREENSHOT_TRANSLATOR_USER_DATA_DIR) {
  fs.mkdirSync(process.env.SCREENSHOT_TRANSLATOR_USER_DATA_DIR, { recursive: true });
  app.setPath("userData", process.env.SCREENSHOT_TRANSLATOR_USER_DATA_DIR);
}

app.whenReady().then(() => {
  config = loadConfig();
  registerIpc();
  createTray();
  registerConfiguredHotkey();

  const smokeMs = Number(process.env.SCREENSHOT_TRANSLATOR_SMOKE_MS ?? "0");
  if (Number.isFinite(smokeMs) && smokeMs > 0) {
    setTimeout(() => app.quit(), smokeMs);
  }

  app.on("second-instance", () => {
    startCapture();
  });
});

app.on("activate", () => {
  if (!resultWindow && !settingsWindow) {
    startCapture();
  }
});

app.on("window-all-closed", () => {
  // Keep the tray app alive after transient capture/result windows close.
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  void shutdownOcr();
});

function registerIpc(): void {
  ipcMain.handle("config:get", () => toRuntimeConfig(config));

  ipcMain.handle("config:save", (_event, nextConfig: AppConfig) => {
    config = saveConfig(nextConfig);
    registerConfiguredHotkey();
    broadcastConfig();
    return toRuntimeConfig(config);
  });

  ipcMain.handle("capture:start", () => {
    startCapture();
  });

  ipcMain.handle("capture:cancel", () => {
    closeOverlay();
  });

  ipcMain.handle("capture:selection", async (_event, selection: Rect) => {
    await handleSelection(selection);
  });

  ipcMain.handle("translation:retry", async (_event, providerId?: string) => {
    await retryTranslation(providerId);
  });

  ipcMain.handle("translation:translate-text", async (_event, text: string, providerId?: string) => {
    await translateEditedText(text, providerId);
  });

  ipcMain.handle("result:ready", (event) => {
    if (resultWindow?.webContents === event.sender) {
      markResultRendererReady();
    }
  });

  ipcMain.handle("settings:open", () => {
    showSettingsWindow();
  });

  ipcMain.handle("window:close", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  ipcMain.handle("clipboard:write-text", (_event, text: string) => {
    clipboard.writeText(text ?? "");
  });
}

function createTray(): void {
  if (!tray) {
    tray = new Tray(createTrayIcon());
    tray.setToolTip("\u622a\u56fe\u7ffb\u8bd1\u5de5\u5177");
  }

  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: "\u622a\u56fe\u7ffb\u8bd1",
      accelerator: config.hotkey,
      click: () => startCapture()
    },
    {
      label: "\u8bbe\u7f6e",
      click: () => showSettingsWindow()
    },
    { type: "separator" },
    {
      label: "\u9000\u51fa",
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]));
}

function createTrayIcon(): Electron.NativeImage {
  const size = 16;
  const channels = 4;
  const buffer = Buffer.alloc(size * size * channels);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * channels;
      const inBorder = x === 0 || y === 0 || x === size - 1 || y === size - 1;
      const inAccent = (x >= 3 && x <= 12 && y >= 3 && y <= 5) || (x >= 5 && x <= 10 && y >= 8 && y <= 11);
      buffer[offset] = inBorder ? 24 : inAccent ? 255 : 31;
      buffer[offset + 1] = inBorder ? 75 : inAccent ? 255 : 111;
      buffer[offset + 2] = inBorder ? 150 : inAccent ? 255 : 235;
      buffer[offset + 3] = 255;
    }
  }

  const image = nativeImage.createFromBuffer(buffer, {
    width: size,
    height: size,
    scaleFactor: 1
  });
  image.setTemplateImage(false);
  return image;
}

function registerConfiguredHotkey(): void {
  globalShortcut.unregisterAll();
  const ok = globalShortcut.register(config.hotkey, () => startCapture());

  if (!ok) {
    new Notification({
      title: "\u622a\u56fe\u7ffb\u8bd1\u5de5\u5177",
      body: `\u5feb\u6377\u952e\u6ce8\u518c\u5931\u8d25\uff1a${config.hotkey}`
    }).show();
  }

  createTray();
}

function startCapture(): void {
  closeOverlay();
  const bounds = getVirtualBounds();
  overlayWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    fullscreenable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: "#00000000",
    webPreferences: commonWebPreferences()
  });

  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.loadFile(rendererFile(), {
    query: {
      window: "overlay",
      x: String(bounds.x),
      y: String(bounds.y),
      width: String(bounds.width),
      height: String(bounds.height)
    }
  });
  overlayWindow.once("ready-to-show", () => {
    overlayWindow?.show();
    overlayWindow?.focus();
  });
  overlayWindow.on("closed", () => {
    overlayWindow = null;
  });
}

async function handleSelection(selection: Rect): Promise<void> {
  if (selection.width < 6 || selection.height < 6) {
    closeOverlay();
    return;
  }

  closeOverlay();
  await delay(140);
  lastJob = { selection };
  await showResultWindow(selection);
  await waitForResultRenderer();
  await runJob(selection);
}

async function runJob(selection: Rect, providerId?: string): Promise<void> {
  try {
    updateResultState({
      phase: "capturing",
      sourceText: "",
      translatedText: "",
      providerId,
      error: undefined
    });

    const images = await captureSelection(selection);
    updateResultState({
      phase: "ocr",
      sourceText: "",
      translatedText: "",
      error: undefined
    });

    const ocr = await recognizeImages(images, "eng+chi_sim");
    lastJob.sourceText = ocr.text;

    if (!ocr.text.trim()) {
      updateResultState({
        phase: "done",
        sourceText: "",
        translatedText: "",
        latencyMs: ocr.latencyMs,
        error: "\u672a\u8bc6\u522b\u5230\u6587\u5b57"
      });
      return;
    }

    updateResultState({
      phase: "translating",
      sourceText: ocr.text,
      translatedText: "",
      error: undefined
    });

    const translated = await translateTextStream(ocr.text, config, providerId, (_delta, accumulated) => {
      updateResultState({
        phase: "translating",
        sourceText: ocr.text,
        translatedText: accumulated,
        error: undefined
      });
    });
    updateResultState({
      phase: "done",
      sourceText: ocr.text,
      translatedText: translated.translatedText,
      providerId: translated.providerId,
      providerName: translated.providerName,
      model: translated.model,
      latencyMs: ocr.latencyMs + translated.latencyMs,
      error: undefined
    });
  } catch (error) {
    updateResultState({
      phase: "error",
      sourceText: currentResultState.sourceText,
      translatedText: currentResultState.translatedText,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function retryTranslation(providerId?: string): Promise<void> {
  if (lastJob.sourceText?.trim()) {
    try {
      updateResultState({
        phase: "translating",
        providerId,
        sourceText: lastJob.sourceText,
        translatedText: "",
        error: undefined
      });
      const translated = await translateTextStream(lastJob.sourceText, config, providerId, (_delta, accumulated) => {
        updateResultState({
          phase: "translating",
          providerId,
          sourceText: lastJob.sourceText ?? "",
          translatedText: accumulated,
          error: undefined
        });
      });
      updateResultState({
        phase: "done",
        sourceText: lastJob.sourceText,
        translatedText: translated.translatedText,
        providerId: translated.providerId,
        providerName: translated.providerName,
        model: translated.model,
        latencyMs: translated.latencyMs,
        error: undefined
      });
    } catch (error) {
      updateResultState({
        phase: "error",
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return;
  }

  if (lastJob.selection) {
    await runJob(lastJob.selection, providerId);
  }
}

async function translateEditedText(text: string, providerId?: string): Promise<void> {
  const sourceText = text.trim();
  lastJob.sourceText = sourceText;

  try {
    updateResultState({
      phase: "translating",
      providerId,
      sourceText,
      translatedText: "",
      error: undefined
    });

    const translated = await translateTextStream(sourceText, config, providerId, (_delta, accumulated) => {
      updateResultState({
        phase: "translating",
        providerId,
        sourceText,
        translatedText: accumulated,
        error: undefined
      });
    });

    updateResultState({
      phase: "done",
      sourceText,
      translatedText: translated.translatedText,
      providerId: translated.providerId,
      providerName: translated.providerName,
      model: translated.model,
      latencyMs: translated.latencyMs,
      error: undefined
    });
  } catch (error) {
    updateResultState({
      phase: "error",
      sourceText,
      translatedText: currentResultState.translatedText,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
async function showResultWindow(selection?: Rect): Promise<void> {
  if (!resultWindow) {
    prepareResultRendererReady();
    resultWindow = new BrowserWindow({
      width: 492,
      height: 388,
      minWidth: 360,
      minHeight: 260,
      frame: false,
      resizable: true,
      show: false,
      alwaysOnTop: config.windowBehavior.alwaysOnTop,
      backgroundColor: "#f7f8fa",
      webPreferences: commonWebPreferences()
    });

    resultWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    resultWindow.loadFile(rendererFile(), {
      query: {
        window: "result"
      }
    });
    resultWindow.once("ready-to-show", () => {
      if (selection) {
        positionResultWindow(resultWindow, selection);
      }
      resultWindow?.show();
      resultWindow?.webContents.send("result:state", currentResultState);
    });
    resultWindow.on("closed", () => {
      resultWindow = null;
      resultRendererReady = false;
      resultReadyResolver = null;
      resultReadyPromise = null;
      currentResultState = createIdleState();
    });
  } else {
    resultRendererReady = true;
    if (selection) {
      positionResultWindow(resultWindow, selection);
    }
    resultWindow.show();
    resultWindow.focus();
  }
}

function showSettingsWindow(): void {
  if (settingsWindow) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 760,
    height: 720,
    minWidth: 680,
    minHeight: 560,
    frame: false,
    resizable: true,
    show: false,
    backgroundColor: "#f7f8fa",
    webPreferences: commonWebPreferences()
  });

  settingsWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  settingsWindow.loadFile(rendererFile(), {
    query: {
      window: "settings"
    }
  });
  settingsWindow.once("ready-to-show", () => {
    settingsWindow?.show();
  });
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

function positionResultWindow(window: BrowserWindow | null, selection: Rect): void {
  if (!window) {
    return;
  }

  const currentBounds = window.getBounds();
  const display = screen.getDisplayNearestPoint({
    x: selection.x + selection.width / 2,
    y: selection.y + selection.height / 2
  });
  const area = display.workArea;
  const gap = 12;
  const x = clamp(selection.x, area.x + gap, area.x + area.width - currentBounds.width - gap);
  const below = selection.y + selection.height + gap;
  const above = selection.y - currentBounds.height - gap;
  const y = below + currentBounds.height <= area.y + area.height - gap
    ? below
    : clamp(above, area.y + gap, area.y + area.height - currentBounds.height - gap);

  window.setPosition(Math.round(x), Math.round(y));
}

function prepareResultRendererReady(): void {
  resultRendererReady = false;
  resultReadyPromise = new Promise((resolve) => {
    resultReadyResolver = resolve;
  });
}

function markResultRendererReady(): void {
  resultRendererReady = true;
  resultReadyResolver?.();
  resultReadyResolver = null;
  resultReadyPromise = null;
  resultWindow?.webContents.send("result:state", currentResultState);
}

async function waitForResultRenderer(): Promise<void> {
  if (resultRendererReady || !resultReadyPromise) {
    return;
  }

  await Promise.race([
    resultReadyPromise,
    delay(1500)
  ]);
}
function updateResultState(partial: Partial<ResultState>): void {
  currentResultState = {
    ...currentResultState,
    ...partial
  };
  resultWindow?.webContents.send("result:state", currentResultState);
}

function broadcastConfig(): void {
  const runtimeConfig = toRuntimeConfig(config);
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("config:updated", runtimeConfig);
  }
}

function closeOverlay(): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.close();
  }
  overlayWindow = null;
}

function commonWebPreferences(): Electron.WebPreferences {
  return {
    preload: path.join(__dirname, "../preload/preload.js"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false
  };
}

function rendererFile(): string {
  return path.join(__dirname, "../renderer/index.html");
}

function createIdleState(): ResultState {
  return {
    phase: "idle",
    sourceText: "",
    translatedText: ""
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}