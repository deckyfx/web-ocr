// ── Types ─────────────────────────────────────────────────────────────────────

type TranslationEngine = "none" | "local" | "deepl";

interface SelectionRect {
  x: number; y: number; w: number; h: number; dpr: number;
}

interface TokenInfo {
  surface: string;
  dictionary_form: string;
  reading: string;
  pos: string;
  pos_detail: string;
}

interface JishoEntry {
  word: string;
  reading: string;
  romaji: string;
  meanings: string[];
  jlpt: string | null;
  is_common: boolean;
}

interface SelectionCompleteMsg { type: "selection-complete"; rect: SelectionRect }
interface CancelSelectionMsg   { type: "cancel-selection" }
interface ExplainRequestMsg    { type: "explain-request"; text: string }

interface StartSelectionMsg { type: "start-selection" }
interface OcrResultMsg      { type: "ocr-result"; text: string; translation: string | null; elapsed_ms: number }
interface OcrErrorMsg       { type: "ocr-error"; message: string }
interface ExplainResultMsg  { type: "explain-result"; tokens: TokenInfo[]; definitions: (JishoEntry | null)[]; mode: "local" | "jisho" }
interface ExplainErrorMsg   { type: "explain-error"; message: string }

type ToContentMsg   = StartSelectionMsg | OcrResultMsg | OcrErrorMsg | ExplainResultMsg | ExplainErrorMsg;
type FromContentMsg = SelectionCompleteMsg | CancelSelectionMsg | ExplainRequestMsg;

// ── Lifecycle ─────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
  }
});

// ── Toolbar click ─────────────────────────────────────────────────────────────

chrome.action.onClicked.addListener((tab) => { void handleClick(tab); });

async function handleClick(tab: chrome.tabs.Tab): Promise<void> {
  const tabId = tab.id;
  if (!tabId) return;

  const { serverUrl } = await chrome.storage.sync.get("serverUrl") as { serverUrl?: string };
  if (!serverUrl) {
    await chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
    return;
  }

  try {
    const checkResult = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => Boolean((window as unknown as Record<string, unknown>)["__socrLoaded"]),
    });

    if (!checkResult[0]?.result) {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      await sleep(40);
    }

    chrome.tabs.sendMessage(tabId, { type: "start-selection" } as ToContentMsg);
  } catch (e) {
    console.error("Selfhost OCR: failed to inject content script:", e);
  }
}

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: FromContentMsg, sender) => {
  const tabId = sender.tab?.id;
  if (msg.type === "selection-complete" && tabId !== undefined) {
    void handleSelection(msg.rect, tabId);
  } else if (msg.type === "explain-request" && tabId !== undefined) {
    void handleExplain(msg.text, tabId);
  }
  return false;
});

// ── OCR + translate flow ──────────────────────────────────────────────────────

async function handleSelection(rect: SelectionRect, tabId: number): Promise<void> {
  const settings = await chrome.storage.sync.get(["serverUrl", "translationEngine"]) as {
    serverUrl?: string;
    translationEngine?: TranslationEngine;
  };

  const { serverUrl, translationEngine = "none" } = settings;
  if (!serverUrl) return;

  try {
    const dataUrl = await chrome.tabs.captureVisibleTab({ format: "png" });
    const croppedB64 = await cropToBase64(dataUrl, rect);

    const start = Date.now();

    const res = await fetch(`${serverUrl.replace(/\/$/, "")}/ocr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: `data:image/png;base64,${croppedB64}`,
        translate_engine: translationEngine,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => String(res.status));
      sendToTab(tabId, { type: "ocr-error", message: `Server ${res.status}: ${errText.slice(0, 200)}` });
      return;
    }

    const data = await res.json() as { text: string; translation?: string; elapsed_ms: number };

    sendToTab(tabId, {
      type: "ocr-result",
      text: data.text,
      translation: data.translation ?? null,
      elapsed_ms: Date.now() - start,
    });
  } catch (e) {
    sendToTab(tabId, { type: "ocr-error", message: e instanceof Error ? e.message : String(e) });
  }
}

// ── Explain flow ──────────────────────────────────────────────────────────────

async function handleExplain(text: string, tabId: number): Promise<void> {
  const settings = await chrome.storage.sync.get(["serverUrl", "dictMode"]) as {
    serverUrl?: string;
    dictMode?: "local" | "jisho";
  };
  const { serverUrl, dictMode = "jisho" } = settings;
  if (!serverUrl) return;

  try {
    const res = await fetch(`${serverUrl.replace(/\/$/, "")}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, sanitize: true, mode: dictMode }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => String(res.status));
      sendToTab(tabId, { type: "explain-error", message: `Server ${res.status}: ${errText.slice(0, 200)}` });
      return;
    }

    const data = await res.json() as {
      tokens: TokenInfo[];
      definitions: (JishoEntry | null)[];
    };

    sendToTab(tabId, {
      type: "explain-result",
      tokens: data.tokens,
      definitions: data.definitions,
      mode: dictMode,
    });
  } catch (e) {
    sendToTab(tabId, { type: "explain-error", message: e instanceof Error ? e.message : String(e) });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sendToTab(tabId: number, msg: ToContentMsg): void {
  chrome.tabs.sendMessage(tabId, msg).catch(console.error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function cropToBase64(dataUrl: string, rect: SelectionRect): Promise<string> {
  const comma = dataUrl.indexOf(",");
  const binaryStr = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

  const blob = new Blob([bytes], { type: "image/png" });
  const bitmap = await createImageBitmap(blob);

  const sx = Math.round(rect.x * rect.dpr);
  const sy = Math.round(rect.y * rect.dpr);
  const sw = Math.max(1, Math.round(rect.w * rect.dpr));
  const sh = Math.max(1, Math.round(rect.h * rect.dpr));

  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not acquire 2D context");
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close();

  const outBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
  const buf = await outBlob.arrayBuffer();
  const outBytes = new Uint8Array(buf);

  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < outBytes.byteLength; i += chunk) {
    binary += String.fromCharCode(...outBytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
