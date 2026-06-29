type ProviderType = "openai-compatible" | "libretranslate" | "mymemory";
type ResultPhase = "idle" | "capturing" | "ocr" | "translating" | "done" | "error";
const DEFAULT_PROMPT_TEMPLATE = "Translate from {sourceLanguage} to {targetLanguage}. Return only the translated text. Preserve line breaks.";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

interface TranslationProvider {
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

interface AppConfig {
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

interface RuntimeConfig extends AppConfig {
  userDataPath: string;
  encryptionAvailable: boolean;
}

interface ResultState {
  phase: ResultPhase;
  sourceText: string;
  translatedText: string;
  providerId?: string;
  providerName?: string;
  model?: string;
  latencyMs?: number;
  error?: string;
}

interface TranslatorApi {
  getConfig: () => Promise<RuntimeConfig>;
  saveConfig: (config: AppConfig) => Promise<RuntimeConfig>;
  startCapture: () => Promise<void>;
  cancelCapture: () => Promise<void>;
  finishSelection: (selection: Rect) => Promise<void>;
  retryTranslation: (providerId?: string) => Promise<void>;
  translateText: (text: string, providerId?: string) => Promise<void>;
  resultReady: () => Promise<void>;
  openSettings: () => Promise<void>;
  closeWindow: () => Promise<void>;
  copyText: (text: string) => Promise<void>;
  onResultState: (callback: (state: ResultState) => void) => () => void;
  onConfigUpdated: (callback: (config: RuntimeConfig) => void) => () => void;
}

interface Window {
  translator: TranslatorApi;
}

const appRoot = document.querySelector<HTMLElement>("#app");
const params = new URLSearchParams(location.search);
const mode = params.get("window") ?? "result";

if (!appRoot) {
  throw new Error("Missing app root");
}

const appElement = appRoot;

if (mode === "overlay") {
  renderOverlay();
} else if (mode === "settings") {
  void renderSettings();
} else {
  void renderResult();
}

function renderOverlay(): void {
  document.body.className = "overlay-body";
  document.body.tabIndex = 0;
  document.body.focus();

  const originX = Number(params.get("x") ?? "0");
  const originY = Number(params.get("y") ?? "0");
  const minSize = 6;
  type OverlayMode = "idle" | "draw" | "move" | "resize";

  let mode: OverlayMode = "idle";
  let dragStart: Point | null = null;
  let baseSelection: Rect | null = null;
  let activeHandle = "";
  let selection: Rect | null = null;
  let selectionBox: HTMLElement | null = null;
  let sizeLabel: HTMLElement | null = null;

  const getPoint = (event: MouseEvent): Point => clampPoint({ x: event.clientX, y: event.clientY });

  const ensureSelectionElements = (): void => {
    if (selectionBox && sizeLabel) {
      return;
    }

    selectionBox = document.createElement("div");
    sizeLabel = document.createElement("div");
    selectionBox.className = "selection-box";
    sizeLabel.className = "selection-size";

    for (const handle of ["n", "ne", "e", "se", "s", "sw", "w", "nw"]) {
      const handleElement = document.createElement("div");
      handleElement.className = "selection-handle";
      handleElement.dataset.handle = handle;
      selectionBox.append(handleElement);
    }

    const actions = document.createElement("div");
    actions.className = "selection-actions";
    const confirmButton = document.createElement("button");
    confirmButton.className = "selection-action primary-tool";
    confirmButton.title = "\u786e\u8ba4";
    confirmButton.setAttribute("aria-label", "\u786e\u8ba4");
    confirmButton.innerHTML = icon("check");
    const cancelButton = document.createElement("button");
    cancelButton.className = "selection-action";
    cancelButton.title = "\u53d6\u6d88";
    cancelButton.setAttribute("aria-label", "\u53d6\u6d88");
    cancelButton.innerHTML = icon("close");
    actions.append(confirmButton, cancelButton);
    selectionBox.append(actions);
    document.body.append(selectionBox, sizeLabel);

    confirmButton.addEventListener("mousedown", (event) => event.stopPropagation());
    confirmButton.addEventListener("click", (event) => {
      event.stopPropagation();
      confirmSelection();
    });
    cancelButton.addEventListener("mousedown", (event) => event.stopPropagation());
    cancelButton.addEventListener("click", (event) => {
      event.stopPropagation();
      void window.translator.cancelCapture();
    });
  };

  const updateSelection = (rect: Rect): void => {
    ensureSelectionElements();
    selection = clampSelectionRect(rect, window.innerWidth, window.innerHeight, minSize);
    updateSelectionBox(selection, selectionBox!, sizeLabel!);
  };

  const clearSelection = (): void => {
    selection = null;
    selectionBox?.remove();
    sizeLabel?.remove();
    selectionBox = null;
    sizeLabel = null;
  };

  function confirmSelection(): void {
    if (!selection || selection.width < minSize || selection.height < minSize) {
      return;
    }

    void window.translator.finishSelection({
      x: Math.round(selection.x + originX),
      y: Math.round(selection.y + originY),
      width: Math.round(selection.width),
      height: Math.round(selection.height)
    });
  }

  window.addEventListener("contextmenu", (event) => event.preventDefault());

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      void window.translator.cancelCapture();
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      confirmSelection();
    }
  });

  window.addEventListener("mousedown", (event) => {
    if (event.button !== 0) {
      return;
    }

    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest(".selection-action")) {
      return;
    }

    const point = getPoint(event);
    const handle = target?.closest(".selection-handle") as HTMLElement | null;
    if (handle && selection) {
      mode = "resize";
      activeHandle = handle.dataset.handle ?? "";
      dragStart = point;
      baseSelection = { ...selection };
      event.preventDefault();
      return;
    }

    if (target?.closest(".selection-box") && selection) {
      mode = "move";
      dragStart = point;
      baseSelection = { ...selection };
      event.preventDefault();
      return;
    }

    mode = "draw";
    activeHandle = "";
    dragStart = point;
    baseSelection = null;
    updateSelection({ x: point.x, y: point.y, width: minSize, height: minSize });
    selectionBox?.classList.add("is-drawing");
    event.preventDefault();
  });

  window.addEventListener("mousemove", (event) => {
    if (mode === "idle" || !dragStart) {
      return;
    }

    const point = getPoint(event);
    if (mode === "draw") {
      updateSelection(normalizeRect(dragStart, point));
      return;
    }

    if (mode === "move" && baseSelection) {
      updateSelection({
        ...baseSelection,
        x: baseSelection.x + point.x - dragStart.x,
        y: baseSelection.y + point.y - dragStart.y
      });
      return;
    }

    if (mode === "resize" && baseSelection) {
      updateSelection(resizeSelectionRect(baseSelection, activeHandle, point));
    }
  });

  window.addEventListener("mouseup", (event) => {
    if (event.button !== 0 || mode === "idle") {
      return;
    }

    if (mode === "draw" && dragStart) {
      const local = normalizeRect(dragStart, getPoint(event));
      if (local.width < minSize || local.height < minSize) {
        clearSelection();
      }
    }

    mode = "idle";
    dragStart = null;
    baseSelection = null;
    activeHandle = "";
    selectionBox?.classList.remove("is-drawing");
  });

  window.addEventListener("dblclick", (event) => {
    if ((event.target as HTMLElement | null)?.closest(".selection-box")) {
      confirmSelection();
    }
  });
}
async function renderResult(): Promise<void> {
  appElement.innerHTML = `
    <section class="result-shell">
      <header class="compact-titlebar">
        <div class="title"><span class="mark">${icon("translate")}</span><span>\u622a\u56fe\u7ffb\u8bd1</span></div>
        <div class="window-actions">
          <button class="icon-button danger" id="closeButton" title="\u5173\u95ed" aria-label="\u5173\u95ed">${icon("close")}</button>
        </div>
      </header>
      <div class="status-line compact-status" id="statusLine"><span id="statusText">\u5f85\u547d</span><span id="metaText"></span></div>
      <div class="result-workspace" id="resultWorkspace">
        <section class="text-pane source-pane" id="sourcePane">
          <button class="pane-toggle" id="toggleSourceButton" title="\u6536\u8d77\u539f\u6587" aria-label="\u6536\u8d77\u539f\u6587">\u539f\u6587</button>
          <textarea id="sourceText" spellcheck="false"></textarea>
        </section>
        <div class="splitter" id="splitter" title="\u62d6\u52a8\u8c03\u6574\u8fb9\u754c"></div>
        <section class="text-pane translation-pane" id="translationPane">
          <button class="pane-toggle" id="toggleTranslationButton" title="\u6536\u8d77\u8bd1\u6587" aria-label="\u6536\u8d77\u8bd1\u6587">\u8bd1\u6587</button>
          <textarea id="translatedText" spellcheck="false"></textarea>
          <div class="floating-tools">
            <button class="tool-icon" id="providerButton" title="\u6a21\u578b" aria-label="\u6a21\u578b">${icon("model")}</button>
            <button class="tool-icon" id="retryButton" title="\u91cd\u8bd5" aria-label="\u91cd\u8bd5">${icon("retry")}</button>
            <button class="tool-icon primary-tool" id="copyTranslationButton" title="\u590d\u5236\u8bd1\u6587" aria-label="\u590d\u5236\u8bd1\u6587">${icon("copy")}</button>
          </div>
          <div class="provider-menu" id="providerMenu" hidden></div>
        </section>
      </div>
    </section>
  `;

  let config = await window.translator.getConfig();
  let activeProviderId = config.activeProviderId;
  let lastState: ResultState | null = null;
  const sourceText = byId<HTMLTextAreaElement>("sourceText");
  const translatedText = byId<HTMLTextAreaElement>("translatedText");
  const workspace = byId("resultWorkspace");
  const providerMenu = byId("providerMenu");

  const selectProvider = (providerId: string): void => {
    activeProviderId = providerId;
    config.activeProviderId = providerId;
    renderProviderMenu(providerMenu, config, activeProviderId, selectProvider);
    providerMenu.hidden = true;
    void translateCurrentSource(activeProviderId);
  };

  renderProviderMenu(providerMenu, config, activeProviderId, selectProvider);

  byId("closeButton").addEventListener("click", () => {
    void window.translator.closeWindow();
  });
  byId("providerButton").addEventListener("click", () => {
    providerMenu.hidden = !providerMenu.hidden;
  });
  byId("retryButton").addEventListener("click", () => {
    void translateCurrentSource(activeProviderId);
  });
  byId("copyTranslationButton").addEventListener("click", () => {
    void window.translator.copyText(translatedText.value);
  });
  byId("toggleSourceButton").addEventListener("click", () => {
    workspace.classList.toggle("source-collapsed");
  });
  byId("toggleTranslationButton").addEventListener("click", () => {
    workspace.classList.toggle("translation-collapsed");
  });
  setupSplitter(workspace, byId("splitter"));

  window.addEventListener("click", (event) => {
    const target = event.target as Node;
    if (!providerMenu.contains(target) && !byId("providerButton").contains(target)) {
      providerMenu.hidden = true;
    }
  });

  window.translator.onConfigUpdated((nextConfig) => {
    config = nextConfig;
    if (!config.providers.some((provider) => provider.id === activeProviderId)) {
      activeProviderId = config.activeProviderId;
    }
    renderProviderMenu(providerMenu, config, activeProviderId, selectProvider);
  });

  window.translator.onResultState((state) => {
    lastState = state;
    updateResultView(state, activeProviderId);
    const incomingSource = state.sourceText ?? "";
    if (document.activeElement !== sourceText && sourceText.value !== incomingSource) {
      sourceText.value = incomingSource;
    }
    const incomingTranslation = state.translatedText ?? "";
    if ((state.phase === "translating" || document.activeElement !== translatedText) && translatedText.value !== incomingTranslation) {
      translatedText.value = incomingTranslation;
    }
  });

  void window.translator.resultReady();

  async function translateCurrentSource(providerId?: string): Promise<void> {
    const text = sourceText.value.trim();
    if (!text) {
      updateResultView({
        phase: "error",
        sourceText: sourceText.value,
        translatedText: translatedText.value,
        error: "\u539f\u6587\u4e3a\u7a7a"
      }, activeProviderId);
      return;
    }
    translatedText.value = "";
    await window.translator.translateText(text, providerId);
  }
}

async function renderSettings(): Promise<void> {
  let config = await window.translator.getConfig();

  const draw = (): void => {
    appElement.innerHTML = `
      <section class="settings-shell">
        <header class="titlebar">
          <div class="title"><span class="mark">${icon("translate")}</span><span>\u8bbe\u7f6e</span></div>
          <div class="window-actions">
            <button class="icon-button danger" id="closeButton" title="\u5173\u95ed" aria-label="\u5173\u95ed">${icon("close")}</button>
          </div>
        </header>
        <div class="settings-content">
          <section class="settings-section">
            <div class="section-heading"><h2>\u57fa\u7840</h2></div>
            <div class="form-grid">
              <label>\u5feb\u6377\u952e<input id="hotkeyInput" value="${escapeAttr(config.hotkey)}" /></label>
              <label>\u76ee\u6807\u8bed\u8a00<input id="targetLanguageInput" value="${escapeAttr(config.targetLanguage)}" /></label>
              <label>\u6e90\u8bed\u8a00<input id="sourceLanguageInput" value="${escapeAttr(config.sourceLanguage)}" /></label>
              <label>OCR \u8bed\u8a00<input id="ocrLanguagesInput" value="eng+chi_sim" disabled /></label>
              <label>\u9ed8\u8ba4\u63a5\u53e3<select id="activeProviderSelect"></select></label>
              <label class="check-line"><input id="alwaysOnTopInput" type="checkbox" ${config.windowBehavior.alwaysOnTop ? "checked" : ""} />\u7ed3\u679c\u7a97\u7f6e\u9876</label>
            </div>
            <label class="prompt-field">Prompt
              <textarea id="promptTemplateInput" spellcheck="false">${escapeText(config.promptTemplate || DEFAULT_PROMPT_TEMPLATE)}</textarea>
            </label>
            <div class="prompt-actions">
              <button id="restorePromptButton" type="button">\u6062\u590d\u9ed8\u8ba4 Prompt</button>
            </div>
          </section>
          <section class="settings-section">
            <div class="section-heading">
              <h2>\u7ffb\u8bd1\u63a5\u53e3</h2>
              <div class="provider-actions">
                <button id="addAiButton">\u6dfb\u52a0 AI</button>
                <button id="addLibreButton">\u6dfb\u52a0 Libre</button>
                <button id="addMyMemoryButton">\u6dfb\u52a0 MyMemory</button>
              </div>
            </div>
            <div class="provider-list" id="providerList"></div>
          </section>
        </div>
        <footer class="settings-footer">
          <span class="save-status" id="saveStatus">${config.encryptionAvailable ? "API Key \u5c06\u5728\u7cfb\u7edf\u652f\u6301\u65f6\u52a0\u5bc6\u4fdd\u5b58" : "API Key \u4ec5\u4fdd\u5b58\u5728\u672c\u673a\u914d\u7f6e"}</span>
          <div class="settings-actions">
            <button id="captureButton">\u622a\u56fe</button>
            <button class="primary" id="saveButton">\u4fdd\u5b58</button>
          </div>
        </footer>
      </section>
    `;

    byId("closeButton").addEventListener("click", () => {
      void window.translator.closeWindow();
    });
    byId("captureButton").addEventListener("click", () => {
      void window.translator.startCapture();
    });
    byId("restorePromptButton").addEventListener("click", () => {
      byId<HTMLTextAreaElement>("promptTemplateInput").value = DEFAULT_PROMPT_TEMPLATE;
    });
    byId("saveButton").addEventListener("click", async () => {
      config = await window.translator.saveConfig(collectSettings(config));
      byId("saveStatus").textContent = "\u5df2\u4fdd\u5b58";
      draw();
    });
    byId("addAiButton").addEventListener("click", () => {
      config.providers.push(createProvider("openai-compatible"));
      draw();
    });
    byId("addLibreButton").addEventListener("click", () => {
      config.providers.push(createProvider("libretranslate"));
      draw();
    });
    byId("addMyMemoryButton").addEventListener("click", () => {
      config.providers.push(createProvider("mymemory"));
      draw();
    });

    populateActiveProviderSelect(config);
    renderProviderCards(config, draw);
  };

  draw();

  window.translator.onConfigUpdated((nextConfig) => {
    config = nextConfig;
    draw();
  });
}

function icon(name: "translate" | "close" | "model" | "retry" | "copy" | "check"): string {
  const paths: Record<typeof name, string> = {
    translate: '<path d="m5 8 4 4"/><path d="m4 14 5-10 5 10"/><path d="M13 6h7"/><path d="M16 6c0 4-2 7-5 9"/><path d="M14 11c1 2 3 4 6 5"/>',
    close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    model: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 9h6"/><path d="M9 13h6"/><path d="M9 17h3"/>',
    retry: '<path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M18 12a6 6 0 0 0-10-4.5L4 12"/><path d="M6 12a6 6 0 0 0 10 4.5L20 12"/>',
    copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"/>',
    check: '<path d="M20 6 9 17l-5-5"/>'
  };

  return `<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
}
function updateSelectionBox(rect: Rect, box: HTMLElement, sizeLabel: HTMLElement): void {
  box.style.left = `${rect.x}px`;
  box.style.top = `${rect.y}px`;
  box.style.width = `${rect.width}px`;
  box.style.height = `${rect.height}px`;
  box.dataset.actionsPlacement = rect.y + rect.height + 42 > window.innerHeight && rect.y > 40 ? "top" : "bottom";
  const actionsWidth = 76;
  const actionsLeft = clamp(rect.width - actionsWidth, -rect.x, window.innerWidth - rect.x - actionsWidth);
  box.style.setProperty("--selection-actions-left", `${actionsLeft}px`);

  const labelWidth = 92;
  const labelLeft = clamp(rect.x, 4, Math.max(4, window.innerWidth - labelWidth - 4));
  const labelAbove = rect.y > 30;
  sizeLabel.style.left = `${labelLeft}px`;
  sizeLabel.style.top = labelAbove ? `${rect.y}px` : `${rect.y + rect.height + 8}px`;
  sizeLabel.style.transform = labelAbove ? "translateY(-28px)" : "translateY(0)";
  sizeLabel.textContent = `${Math.round(rect.width)} x ${Math.round(rect.height)}`;
}

function normalizeRect(start: Point, end: Point): Rect {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);
  return { x, y, width, height };
}

function clampPoint(point: Point): Point {
  return {
    x: clamp(point.x, 0, Math.max(0, window.innerWidth)),
    y: clamp(point.y, 0, Math.max(0, window.innerHeight))
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function clampSelectionRect(rect: Rect, maxWidth: number, maxHeight: number, minSize: number): Rect {
  const width = Math.min(Math.max(rect.width, minSize), Math.max(minSize, maxWidth));
  const height = Math.min(Math.max(rect.height, minSize), Math.max(minSize, maxHeight));
  const x = clamp(rect.x, 0, Math.max(0, maxWidth - width));
  const y = clamp(rect.y, 0, Math.max(0, maxHeight - height));
  return { x, y, width: Math.min(width, maxWidth - x), height: Math.min(height, maxHeight - y) };
}

function resizeSelectionRect(base: Rect, handle: string, point: Point): Rect {
  let left = base.x;
  let top = base.y;
  let right = base.x + base.width;
  let bottom = base.y + base.height;

  if (handle.includes("w")) {
    left = point.x;
  }
  if (handle.includes("e")) {
    right = point.x;
  }
  if (handle.includes("n")) {
    top = point.y;
  }
  if (handle.includes("s")) {
    bottom = point.y;
  }

  return normalizeRect({ x: left, y: top }, { x: right, y: bottom });
}

function setupSplitter(workspace: HTMLElement, splitter: HTMLElement): void {
  let dragging = false;

  splitter.addEventListener("mousedown", (event) => {
    dragging = true;
    event.preventDefault();
  });

  window.addEventListener("mousemove", (event) => {
    if (!dragging) {
      return;
    }
    const rect = workspace.getBoundingClientRect();
    const ratio = Math.min(0.78, Math.max(0.22, (event.clientX - rect.left) / rect.width));
    workspace.style.setProperty("--source-ratio", `${ratio}fr`);
    workspace.style.setProperty("--translation-ratio", `${1 - ratio}fr`);
  });

  window.addEventListener("mouseup", () => {
    dragging = false;
  });
}

function renderProviderMenu(
  menu: HTMLElement,
  config: RuntimeConfig,
  activeProviderId: string,
  onSelect: (providerId: string) => void
): void {
  menu.replaceChildren();
  for (const provider of config.providers) {
    const button = document.createElement("button");
    button.className = "provider-menu-item";
    button.dataset.active = provider.id === activeProviderId ? "true" : "false";
    button.disabled = !provider.enabled;
    button.textContent = `${provider.enabled ? "" : "[停用] "}${provider.name}${provider.model ? ` | ${provider.model}` : ""}`;
    button.addEventListener("click", () => onSelect(provider.id));
    menu.append(button);
  }
}

function updateResultView(state: ResultState, activeProviderId: string): void {
  const statusLine = byId("statusLine");
  const statusText = byId("statusText");
  const metaText = byId("metaText");

  const phaseText: Record<ResultPhase, string> = {
    idle: "\u5f85\u547d",
    capturing: "\u622a\u56fe\u5904\u7406\u4e2d",
    ocr: "\u6587\u5b57\u8bc6\u522b\u4e2d",
    translating: "\u7ffb\u8bd1\u4e2d",
    done: state.error ? state.error : "\u5b8c\u6210",
    error: state.error ?? "\u5931\u8d25"
  };

  statusText.textContent = phaseText[state.phase] ?? "\u5f85\u547d";
  statusLine.dataset.tone = state.phase === "error" || state.error ? "error" : state.phase === "done" ? "ok" : "";

  const meta = [
    state.providerName,
    state.model,
    state.latencyMs ? `${(state.latencyMs / 1000).toFixed(1)}s` : ""
  ].filter(Boolean);
  metaText.textContent = meta.join(" | ");
  byId("providerButton").dataset.activeProvider = state.providerId ?? activeProviderId;
}

function populateActiveProviderSelect(config: RuntimeConfig): void {
  const select = byId<HTMLSelectElement>("activeProviderSelect");
  select.replaceChildren();

  for (const provider of config.providers) {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = provider.name;
    select.append(option);
  }

  select.value = config.activeProviderId;
}

function renderProviderCards(config: RuntimeConfig, redraw: () => void): void {
  const list = byId("providerList");
  list.replaceChildren();

  if (!config.providers.length) {
    const empty = document.createElement("div");
    empty.className = "empty-note";
    empty.textContent = "\u6682\u65e0\u63a5\u53e3";
    list.append(empty);
    return;
  }

  config.providers.forEach((provider, index) => {
    const card = document.createElement("section");
    card.className = "provider-card";
    card.dataset.providerId = provider.id;
    card.innerHTML = `
      <div class="provider-head">
        <label class="check-line"><input data-field="enabled" type="checkbox" ${provider.enabled ? "checked" : ""} />\u542f\u7528</label>
        <input data-field="name" value="${escapeAttr(provider.name)}" />
        <select data-field="type">
          <option value="openai-compatible">AI \u517c\u5bb9</option>
          <option value="libretranslate">LibreTranslate</option>
          <option value="mymemory">MyMemory</option>
        </select>
        <button class="danger" data-action="remove">\u5220\u9664</button>
      </div>
      <div class="provider-fields">
        <label>Base URL<input data-field="baseUrl" value="${escapeAttr(provider.baseUrl)}" /></label>
        <label>API Key<input data-field="apiKey" type="password" value="${escapeAttr(provider.apiKey ?? "")}" /></label>
        <label>\u6a21\u578b<input data-field="model" value="${escapeAttr(provider.model ?? "")}" /></label>
        <label>\u8d85\u65f6\u6beb\u79d2<input data-field="timeoutMs" type="number" min="1000" step="1000" value="${provider.timeoutMs ?? 30000}" /></label>
      </div>
    `;

    card.querySelector<HTMLSelectElement>('[data-field="type"]')!.value = provider.type;
    card.querySelector('[data-action="remove"]')!.addEventListener("click", () => {
      config.providers.splice(index, 1);
      if (config.activeProviderId === provider.id) {
        config.activeProviderId = config.providers[0]?.id ?? "";
      }
      redraw();
    });

    list.append(card);
  });
}

function collectSettings(current: RuntimeConfig): AppConfig {
  const providers = Array.from(document.querySelectorAll<HTMLElement>(".provider-card")).map((card) => {
    const id = card.dataset.providerId || uniqueId();
    return {
      id,
      name: readField(card, "name") || "\u7ffb\u8bd1\u63a5\u53e3",
      type: readField(card, "type") as ProviderType,
      enabled: card.querySelector<HTMLInputElement>('[data-field="enabled"]')?.checked ?? false,
      baseUrl: readField(card, "baseUrl"),
      apiKey: readField(card, "apiKey") || undefined,
      model: readField(card, "model") || undefined,
      timeoutMs: Number(readField(card, "timeoutMs")) || 30000,
      temperature: 0.1
    };
  });

  return {
    version: 1,
    hotkey: byId<HTMLInputElement>("hotkeyInput").value.trim(),
    sourceLanguage: byId<HTMLInputElement>("sourceLanguageInput").value.trim() || "auto",
    targetLanguage: byId<HTMLInputElement>("targetLanguageInput").value.trim() || "zh-CN",
    promptTemplate: byId<HTMLTextAreaElement>("promptTemplateInput").value.trim() || DEFAULT_PROMPT_TEMPLATE,
    activeProviderId: byId<HTMLSelectElement>("activeProviderSelect").value || providers[0]?.id || "",
    providers,
    ocr: {
      languages: "eng+chi_sim"
    },
    windowBehavior: {
      alwaysOnTop: byId<HTMLInputElement>("alwaysOnTopInput").checked
    }
  };
}

function createProvider(type: ProviderType): TranslationProvider {
  if (type === "libretranslate") {
    return {
      id: uniqueId(),
      name: "LibreTranslate",
      type,
      enabled: true,
      baseUrl: "https://libretranslate.com",
      timeoutMs: 30000
    };
  }

  if (type === "mymemory") {
    return {
      id: uniqueId(),
      name: "MyMemory",
      type,
      enabled: true,
      baseUrl: "https://api.mymemory.translated.net",
      timeoutMs: 30000
    };
  }

  return {
    id: uniqueId(),
    name: "AI \u517c\u5bb9\u63a5\u53e3",
    type,
    enabled: true,
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    timeoutMs: 45000,
    temperature: 0.1
  };
}

function readField(parent: HTMLElement, field: string): string {
  return parent.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-field="${field}"]`)?.value.trim() ?? "";
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element: ${id}`);
  }
  return element as T;
}

function escapeText(value: string): string {
  return escapeAttr(value);
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function uniqueId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}