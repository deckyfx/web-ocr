// ── Guard ─────────────────────────────────────────────────────────────────────

type SocrWindow = Window & { __socrLoaded?: boolean };
const _w = window as SocrWindow;

if (!_w.__socrLoaded) {
  _w.__socrLoaded = true;
  init();
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface StartSelectionMsg  { type: "start-selection" }
interface OcrResultMsg       { type: "ocr-result"; text: string; translation: string | null; elapsed_ms: number }
interface OcrErrorMsg        { type: "ocr-error"; message: string }
type InboundMsg = StartSelectionMsg | OcrResultMsg | OcrErrorMsg;

interface SelectionCompleteMsg {
  type: "selection-complete";
  rect: { x: number; y: number; w: number; h: number; dpr: number };
}

// ── State ─────────────────────────────────────────────────────────────────────

let selectionRect: { x: number; y: number; w: number; h: number } | null = null;
let resultPanelEl: HTMLElement | null = null;
let overlayEl: HTMLElement | null = null;
let keydownListener: ((e: KeyboardEvent) => void) | null = null;

// ── Init ──────────────────────────────────────────────────────────────────────

function init(): void {
  chrome.runtime.onMessage.addListener((msg: InboundMsg) => {
    if      (msg.type === "start-selection") startSelection();
    else if (msg.type === "ocr-result")      showResult(msg);
    else if (msg.type === "ocr-error")       showError(msg.message);
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

    if (w < 8 || h < 8) {
      // Accidental click — treat as cancel
      return;
    }

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

// ── Loading panel ─────────────────────────────────────────────────────────────

function showLoading(x: number, y: number, w: number, h: number): void {
  removeResultPanel();
  const panel = createPanel(x, y, w, h);
  panel.innerHTML = `
    <div class="socr-panel-inner">
      <div class="socr-loading">
        <span class="socr-spinner"></span>
        Recognizing…
      </div>
    </div>
  `;
  document.body.appendChild(panel);
  resultPanelEl = panel;
}

// ── Result panel ──────────────────────────────────────────────────────────────

function showResult(msg: OcrResultMsg): void {
  if (!resultPanelEl || !selectionRect) return;
  const { x, y, w, h } = selectionRect;

  const panel = resultPanelEl;
  panel.innerHTML = `
    <div class="socr-panel-inner">
      <button class="socr-close" aria-label="Close">×</button>
      <div class="socr-text-label">OCR Text</div>
      <div class="socr-text">${escHtml(msg.text || "(no text recognized)")}</div>
      <button class="socr-copy" data-text="${escAttr(msg.text)}">Copy Text</button>
      ${msg.translation ? `
        <div class="socr-text-label">Translation</div>
        <div class="socr-text">${escHtml(msg.translation)}</div>
        <button class="socr-copy" data-text="${escAttr(msg.translation)}">Copy Translation</button>
      ` : ""}
      <div class="socr-elapsed">${msg.elapsed_ms} ms</div>
    </div>
  `;

  repositionPanel(panel, x, y, w, h);
  wirePanelButtons(panel);
}

function showError(message: string): void {
  const rect = selectionRect;
  removeResultPanel();

  const panel = rect
    ? createPanel(rect.x, rect.y, rect.w, rect.h)
    : (() => {
        const p = document.createElement("div");
        p.className = "socr-result-panel";
        p.style.cssText = "position:fixed!important;top:20px!important;right:20px!important;";
        return p;
      })();

  panel.innerHTML = `
    <div class="socr-panel-inner">
      <button class="socr-close" aria-label="Close">×</button>
      <div class="socr-error">${escHtml(message)}</div>
    </div>
  `;

  document.body.appendChild(panel);
  resultPanelEl = panel;
  wirePanelButtons(panel);
}

// ── Panel helpers ─────────────────────────────────────────────────────────────

function createPanel(
  selX: number, selY: number, selW: number, selH: number
): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "socr-result-panel";
  repositionPanel(panel, selX, selY, selW, selH);
  return panel;
}

function repositionPanel(
  panel: HTMLElement,
  selX: number, selY: number, selW: number, selH: number
): void {
  const pw = 360;
  const ph = 240;
  const margin = 10;

  let top = selY + selH + margin;
  if (top + ph > window.innerHeight - margin) top = selY - ph - margin;
  if (top < margin) top = margin;

  let left = selX + selW / 2 - pw / 2;
  if (left + pw > window.innerWidth - margin) left = window.innerWidth - pw - margin;
  if (left < margin) left = margin;

  panel.style.cssText = `
    position: fixed !important;
    top: ${top}px !important;
    left: ${left}px !important;
    width: ${pw}px !important;
    z-index: 2147483647 !important;
  `;
}

function wirePanelButtons(panel: HTMLElement): void {
  panel.querySelector(".socr-close")?.addEventListener("click", () => {
    cleanup();
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
