// ── Guard ─────────────────────────────────────────────────────────────────────

type SocrWindow = Window & { __socrLoaded?: boolean };
const _w = window as SocrWindow;

if (!_w.__socrLoaded) {
  _w.__socrLoaded = true;
  init();
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface TokenInfo {
  surface: string;
  dictionary_form: string;
  reading: string;
  pos: string;
  pos_detail: string;
  conjugation_type: string;
  conjugation_form: string;
  is_unknown: boolean;
}

interface JishoEntry {
  word: string;
  reading: string;
  romaji: string;
  meanings: string[];
  jlpt: string | null;
  is_common: boolean;
}

interface StartSelectionMsg  { type: "start-selection" }
interface OcrResultMsg       { type: "ocr-result"; text: string; translation: string | null; elapsed_ms: number }
interface OcrErrorMsg        { type: "ocr-error"; message: string }
interface ExplainResultMsg   { type: "explain-result"; tokens: TokenInfo[]; definitions: (JishoEntry | null)[]; mode: "local" | "jisho" }
interface ExplainErrorMsg    { type: "explain-error"; message: string }
type InboundMsg = StartSelectionMsg | OcrResultMsg | OcrErrorMsg | ExplainResultMsg | ExplainErrorMsg;

interface SelectionCompleteMsg {
  type: "selection-complete";
  rect: { x: number; y: number; w: number; h: number; dpr: number };
}
interface ExplainRequestMsg { type: "explain-request"; text: string }

// ── State ─────────────────────────────────────────────────────────────────────

let selectionRect: { x: number; y: number; w: number; h: number } | null = null;
let resultPanelEl: HTMLElement | null = null;
let overlayEl: HTMLElement | null = null;
let keydownListener: ((e: KeyboardEvent) => void) | null = null;

type ExplainItem = { token: TokenInfo; def: JishoEntry };
let explainItems: ExplainItem[] = [];
let explainPage = 0;
let explainMode: "local" | "jisho" = "jisho";
let lastOcrResult: OcrResultMsg | null = null;
const EXPLAIN_PAGE_SIZE = 3;

// ── Init ──────────────────────────────────────────────────────────────────────

function init(): void {
  chrome.runtime.onMessage.addListener((msg: InboundMsg) => {
    if      (msg.type === "start-selection") startSelection();
    else if (msg.type === "ocr-result")      showResult(msg);
    else if (msg.type === "ocr-error")       showError(msg.message);
    else if (msg.type === "explain-result")  showExplain(msg.tokens, msg.definitions, msg.mode);
    else if (msg.type === "explain-error")   showExplainError(msg.message);
  });
}

// ── Selection UI ──────────────────────────────────────────────────────────────

function startSelection(): void {
  cleanup();

  const overlay = document.createElement("div");
  overlay.id = "socr-overlay";

  const backdrop = document.createElement("div");
  backdrop.id = "socr-backdrop";

  const hint = document.createElement("div");
  hint.id = "socr-hint";
  hint.textContent = "Click and drag to select a region — Esc to cancel";

  const selBox = document.createElement("div");
  selBox.id = "socr-selection";

  overlay.appendChild(hint);
  overlay.appendChild(selBox);
  document.body.appendChild(backdrop);
  document.body.appendChild(overlay);
  overlayEl = overlay;

  let startX = 0;
  let startY = 0;
  let dragging = false;

  function updateSelBox(x: number, y: number, w: number, h: number): void {
    selBox.style.cssText = `
      display: block !important;
      left: ${x}px !important;
      top: ${y}px !important;
      width: ${w}px !important;
      height: ${h}px !important;
    `;
  }

  function onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    hint.style.display = "none";
    backdrop.style.display = "none";
    updateSelBox(startX, startY, 0, 0);
  }

  function onMouseMove(e: MouseEvent): void {
    if (!dragging) return;
    e.preventDefault();
    const x = Math.min(e.clientX, startX);
    const y = Math.min(e.clientY, startY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);
    updateSelBox(x, y, w, h);
  }

  function onMouseUp(e: MouseEvent): void {
    if (!dragging) return;
    dragging = false;

    const x = Math.min(e.clientX, startX);
    const y = Math.min(e.clientY, startY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);

    removeOverlay();

    if (w < 8 || h < 8) return;

    selectionRect = { x, y, w, h };
    showLoading(x, y, w, h);

    const msg: SelectionCompleteMsg = {
      type: "selection-complete",
      rect: { x, y, w, h, dpr: window.devicePixelRatio },
    };
    chrome.runtime.sendMessage(msg).catch(console.error);
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") cleanup();
  };

  keydownListener = onKeyDown;
  document.addEventListener("keydown", onKeyDown);
  overlay.addEventListener("mousedown", onMouseDown);
  overlay.addEventListener("mousemove", onMouseMove);
  overlay.addEventListener("mouseup", onMouseUp);
}

function removeOverlay(): void {
  if (keydownListener) {
    document.removeEventListener("keydown", keydownListener);
    keydownListener = null;
  }
  if (overlayEl) {
    overlayEl.remove();
    overlayEl = null;
  }
  document.getElementById("socr-backdrop")?.remove();
}

// ── Panel factory ─────────────────────────────────────────────────────────────

/**
 * Create the panel shell: .socr-result-panel > .socr-panel-inner + .socr-resize-handle.
 * The inner div is the only part replaced by content updates; the handles are stable.
 */
function createPanel(
  selX: number, selY: number, selW: number, selH: number
): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "socr-result-panel";
  repositionPanel(panel, selX, selY, selW, selH);

  const inner = document.createElement("div");
  inner.className = "socr-panel-inner";
  panel.appendChild(inner);

  const resizeHandle = document.createElement("div");
  resizeHandle.className = "socr-resize-handle";
  resizeHandle.setAttribute("aria-hidden", "true");
  panel.appendChild(resizeHandle);

  makeDraggable(panel, inner);
  makeResizable(panel, resizeHandle);

  return panel;
}

/** Replace only the inner content of the panel, leaving drag/resize handles intact. */
function setInnerContent(panel: HTMLElement, html: string): void {
  const inner = panel.querySelector<HTMLElement>(".socr-panel-inner");
  if (inner) inner.innerHTML = html;
}

// ── Loading panel ─────────────────────────────────────────────────────────────

function showLoading(x: number, y: number, w: number, h: number): void {
  removeResultPanel();
  const panel = createPanel(x, y, w, h);
  setInnerContent(panel, `
    <div class="socr-loading">
      <span class="socr-spinner"></span>
      Recognizing…
    </div>
  `);
  document.body.appendChild(panel);
  resultPanelEl = panel;
}

// ── Result panel ──────────────────────────────────────────────────────────────

function showResult(msg: OcrResultMsg): void {
  if (!resultPanelEl || !selectionRect) return;
  lastOcrResult = msg;
  const { x, y, w, h } = selectionRect;

  const hasText = msg.text.trim().length > 0;

  setInnerContent(resultPanelEl, `
    <button class="socr-close" aria-label="Close">×</button>
    <div class="socr-text-label">OCR Text</div>
    <div class="socr-text">${escHtml(msg.text || "(no text recognized)")}</div>
    <div class="socr-actions">
      <button class="socr-copy" data-text="${escAttr(msg.text)}">Copy</button>
      ${hasText ? `<button class="socr-explain" data-text="${escAttr(msg.text)}">Explain</button>` : ""}
    </div>
    ${msg.translation ? `
      <div class="socr-text-label">Translation</div>
      <div class="socr-text">${escHtml(msg.translation)}</div>
      <button class="socr-copy" data-text="${escAttr(msg.translation)}">Copy Translation</button>
    ` : ""}
    <div class="socr-elapsed">${msg.elapsed_ms} ms</div>
  `);

  repositionPanel(resultPanelEl, x, y, w, h);
  wirePanelButtons(resultPanelEl);
}

function showError(message: string): void {
  const rect = selectionRect;
  removeResultPanel();

  let panel: HTMLElement;
  if (rect) {
    panel = createPanel(rect.x, rect.y, rect.w, rect.h);
  } else {
    panel = document.createElement("div");
    panel.className = "socr-result-panel";
    panel.style.cssText = "position:fixed!important;top:20px!important;right:20px!important;";
    const inner = document.createElement("div");
    inner.className = "socr-panel-inner";
    panel.appendChild(inner);
    const rh = document.createElement("div");
    rh.className = "socr-resize-handle";
    rh.setAttribute("aria-hidden", "true");
    panel.appendChild(rh);
    makeDraggable(panel, inner);
    makeResizable(panel, rh);
  }

  setInnerContent(panel, `
    <button class="socr-close" aria-label="Close">×</button>
    <div class="socr-error">${escHtml(message)}</div>
  `);

  document.body.appendChild(panel);
  resultPanelEl = panel;
  wirePanelButtons(panel);
}

// ── Explain panel ─────────────────────────────────────────────────────────────

function showExplain(tokens: TokenInfo[], definitions: (JishoEntry | null)[], mode: "local" | "jisho"): void {
  if (!resultPanelEl) return;

  explainMode = mode;

  // Deduplicate by dictionary_form — keep first occurrence with a definition
  const seen = new Set<string>();
  explainItems = tokens
    .map((token, i) => ({ token, def: definitions[i] ?? null }))
    .filter((x): x is ExplainItem => {
      if (x.def === null) return false;
      const key = x.token.dictionary_form;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  explainPage = 0;
  renderExplainPage();
}

function renderExplainPage(): void {
  if (!resultPanelEl) return;

  const total = explainItems.length;
  const totalPages = Math.ceil(total / EXPLAIN_PAGE_SIZE);

  if (total === 0) {
    setInnerContent(resultPanelEl, `
      <button class="socr-close" aria-label="Close">×</button>
      <div class="socr-text-label">Explain</div>
      <div class="socr-text">No dictionary entries found for this text.</div>
    `);
    wirePanelButtons(resultPanelEl);
    return;
  }

  const start = explainPage * EXPLAIN_PAGE_SIZE;
  const pageItems = explainItems.slice(start, start + EXPLAIN_PAGE_SIZE);

  const cardsHtml = pageItems.map(({ token, def }) => {
    // jlpt / is_common only reliable in jisho mode
    const jlptText = explainMode === "jisho" && def.jlpt ? def.jlpt.replace("jlpt-", "").toUpperCase() : "";
    const jlptBadge = jlptText ? `<span class="socr-token-jlpt">${escHtml(jlptText)}</span>` : "";
    const commonBadge = explainMode === "jisho" && def.is_common ? `<span class="socr-token-common">common</span>` : "";
    const reading = def.romaji
      ? `<span class="socr-token-reading">${escHtml(def.romaji)}</span>`
      : "";

    const meaningsHtml = def.meanings
      .slice(0, 2)
      .map(m => `<div class="socr-token-meaning">${escHtml(formatMeaning(m, explainMode))}</div>`)
      .join("");

    return `<div class="socr-token-card">
      <div class="socr-token-header">
        <span class="socr-token-word">${escHtml(def.word || token.surface)}</span>
        ${reading}${jlptBadge}${commonBadge}
      </div>
      <div class="socr-token-meanings">${meaningsHtml || '<div class="socr-token-meaning socr-muted">—</div>'}</div>
    </div>`;
  }).join("");

  const pagerHtml = totalPages > 1 ? `
    <div class="socr-pager">
      <button class="socr-pager-btn" data-dir="-1"${explainPage === 0 ? " disabled" : ""}>←</button>
      <span class="socr-pager-info">${explainPage + 1} / ${totalPages}</span>
      <button class="socr-pager-btn" data-dir="1"${explainPage >= totalPages - 1 ? " disabled" : ""}>→</button>
    </div>
  ` : "";

  setInnerContent(resultPanelEl, `
    <button class="socr-close" aria-label="Close">×</button>
    <div class="socr-text-label">
      ${lastOcrResult ? `<button class="socr-back">← Back</button>` : ""}
      Explain — ${total} word${total === 1 ? "" : "s"}
    </div>
    <div class="socr-token-list">${cardsHtml}</div>
    ${pagerHtml}
  `);

  wirePanelButtons(resultPanelEl);
}

function showExplainError(message: string): void {
  if (!resultPanelEl) return;
  const btn = resultPanelEl.querySelector<HTMLButtonElement>(".socr-explain");
  if (btn) {
    btn.textContent = "Explain";
    btn.disabled = false;
    const errDiv = document.createElement("div");
    errDiv.className = "socr-explain-error socr-error";
    errDiv.style.cssText = "display:block!important;margin-top:4px!important;";
    errDiv.textContent = message;
    btn.insertAdjacentElement("afterend", errDiv);
    setTimeout(() => errDiv.remove(), 5000);
  }
}

// ── Panel helpers ─────────────────────────────────────────────────────────────

function repositionPanel(
  panel: HTMLElement,
  selX: number, selY: number, selW: number, selH: number
): void {
  const pw = 360;
  const ph = 260;
  const margin = 10;

  let top = selY + selH + margin;
  if (top + ph > window.innerHeight - margin) top = selY - ph - margin;
  if (top < margin) top = margin;

  let left = selX + selW / 2 - pw / 2;
  if (left + pw > window.innerWidth - margin) left = window.innerWidth - pw - margin;
  if (left < margin) left = margin;

  panel.style.setProperty("position", "fixed", "important");
  panel.style.setProperty("top", `${top}px`, "important");
  panel.style.setProperty("left", `${left}px`, "important");
  panel.style.setProperty("width", `${pw}px`, "important");
  panel.style.setProperty("z-index", "2147483647", "important");
}

function wirePanelButtons(panel: HTMLElement): void {
  panel.querySelector(".socr-close")?.addEventListener("click", () => cleanup());

  panel.querySelector<HTMLButtonElement>(".socr-back")?.addEventListener("click", () => {
    if (lastOcrResult) showResult(lastOcrResult);
  });

  panel.querySelectorAll<HTMLButtonElement>(".socr-copy").forEach((btn) => {
    btn.addEventListener("click", () => {
      const text = btn.dataset["text"] ?? "";
      navigator.clipboard.writeText(text).then(() => {
        const orig = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(() => { btn.textContent = orig; }, 1500);
      }).catch(console.error);
    });
  });

  const explainBtn = panel.querySelector<HTMLButtonElement>(".socr-explain");
  if (explainBtn) {
    explainBtn.addEventListener("click", () => {
      const text = explainBtn.dataset["text"] ?? "";
      if (!text.trim()) return;
      explainBtn.textContent = "Loading…";
      explainBtn.disabled = true;
      const reqMsg: ExplainRequestMsg = { type: "explain-request", text };
      chrome.runtime.sendMessage(reqMsg).catch(console.error);
    });
  }

  panel.querySelectorAll<HTMLButtonElement>(".socr-pager-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const dir = parseInt(btn.dataset["dir"] ?? "0", 10);
      const totalPages = Math.ceil(explainItems.length / EXPLAIN_PAGE_SIZE);
      explainPage = Math.max(0, Math.min(totalPages - 1, explainPage + dir));
      renderExplainPage();
    });
  });
}

function removeResultPanel(): void {
  if (resultPanelEl) {
    resultPanelEl.remove();
    resultPanelEl = null;
  }
}

function cleanup(): void {
  removeOverlay();
  removeResultPanel();
  selectionRect = null;
  explainItems = [];
  explainPage = 0;
  lastOcrResult = null;
}

// ── Drag ──────────────────────────────────────────────────────────────────────

function makeDraggable(panel: HTMLElement, dragTarget: HTMLElement): void {
  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;

  dragTarget.style.cursor = "grab";

  dragTarget.addEventListener("mousedown", (e: MouseEvent) => {
    // Don't start drag from buttons or scrollable content
    const t = e.target as Element;
    if (t.closest("button, .socr-text, .socr-token-list, .socr-pager")) return;
    dragging = true;
    offsetX = e.clientX - panel.getBoundingClientRect().left;
    offsetY = e.clientY - panel.getBoundingClientRect().top;
    dragTarget.style.cursor = "grabbing";
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e: MouseEvent) => {
    if (!dragging) return;
    panel.style.setProperty("left", `${e.clientX - offsetX}px`, "important");
    panel.style.setProperty("top", `${e.clientY - offsetY}px`, "important");
  });

  document.addEventListener("mouseup", () => {
    if (dragging) {
      dragging = false;
      dragTarget.style.cursor = "grab";
    }
  });
}

// ── Resize ────────────────────────────────────────────────────────────────────

function makeResizable(panel: HTMLElement, handle: HTMLElement): void {
  let resizing = false;
  let startX = 0, startY = 0;
  let startW = 0, startH = 0;

  handle.addEventListener("mousedown", (e: MouseEvent) => {
    resizing = true;
    startX = e.clientX;
    startY = e.clientY;
    startW = panel.offsetWidth;
    startH = panel.offsetHeight;
    e.preventDefault();
    e.stopPropagation(); // don't trigger drag
  });

  document.addEventListener("mousemove", (e: MouseEvent) => {
    if (!resizing) return;
    const newW = Math.max(280, startW + (e.clientX - startX));
    const newH = Math.max(100, startH + (e.clientY - startY));
    panel.style.setProperty("width", `${newW}px`, "important");
    panel.style.setProperty("max-height", `${newH}px`, "important");
  });

  document.addEventListener("mouseup", () => {
    resizing = false;
  });
}

// ── Utils ─────────────────────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escAttr(s: string): string {
  return escHtml(s).replace(/'/g, "&#39;");
}

/** Format a dictionary meaning string for display. */
function formatMeaning(s: string, mode: "local" | "jisho"): string {
  if (mode === "jisho") {
    // Jisho meanings are already clean — just cap length
    return s.length > 100 ? s.slice(0, 97) + "…" : s;
  }

  // Local (Jitendex) mode: meanings are concatenated blobs — clean up best-effort
  // 1. Strip leading POS label
  s = s.replace(/^(noun|verb|adjective|adverb|suffix|prefix|interjection|particle|auxiliary|conjunction|counter|expression|idiom|phrase|proverb|5-dan|intransitive|transitive|archaic|slang|abbr\.?)\s*/i, "").trimStart();

  // 2. Insert space at camelCase boundaries (e.g. "SeeAlso" → "See Also")
  s = s.replace(/([a-z])([A-Z])/g, "$1 $2");

  // 3. Cut before Japanese characters — they mark the start of example sentences
  const jpIdx = s.search(/[　-鿿豈-﫿぀-ゟ゠-ヿ]/);
  if (jpIdx > 3) s = s.slice(0, jpIdx).replace(/[,;]\s*$/, "").trimEnd();

  // 4. Normalize whitespace
  s = s.replace(/\s+/g, " ").trim();

  return s.length > 100 ? s.slice(0, 97) + "…" : s;
}
