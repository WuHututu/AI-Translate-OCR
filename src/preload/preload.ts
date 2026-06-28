import { contextBridge, ipcRenderer } from "electron";
import type { AppConfig, Rect, ResultState, RuntimeConfig } from "../shared/types";

contextBridge.exposeInMainWorld("translator", {
  getConfig: (): Promise<RuntimeConfig> => ipcRenderer.invoke("config:get"),
  saveConfig: (config: AppConfig): Promise<RuntimeConfig> => ipcRenderer.invoke("config:save", config),
  startCapture: (): Promise<void> => ipcRenderer.invoke("capture:start"),
  cancelCapture: (): Promise<void> => ipcRenderer.invoke("capture:cancel"),
  finishSelection: (selection: Rect): Promise<void> => ipcRenderer.invoke("capture:selection", selection),
  retryTranslation: (providerId?: string): Promise<void> => ipcRenderer.invoke("translation:retry", providerId),
  translateText: (text: string, providerId?: string): Promise<void> => ipcRenderer.invoke("translation:translate-text", text, providerId),
  resultReady: (): Promise<void> => ipcRenderer.invoke("result:ready"),
  openSettings: (): Promise<void> => ipcRenderer.invoke("settings:open"),
  closeWindow: (): Promise<void> => ipcRenderer.invoke("window:close"),
  copyText: (text: string): Promise<void> => ipcRenderer.invoke("clipboard:write-text", text),
  onResultState: (callback: (state: ResultState) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: ResultState) => callback(state);
    ipcRenderer.on("result:state", listener);
    return () => ipcRenderer.removeListener("result:state", listener);
  },
  onConfigUpdated: (callback: (config: RuntimeConfig) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, config: RuntimeConfig) => callback(config);
    ipcRenderer.on("config:updated", listener);
    return () => ipcRenderer.removeListener("config:updated", listener);
  }
});
