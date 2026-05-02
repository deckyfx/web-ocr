type TranslationEngine = "none" | "local" | "deepl";
type DictMode = "local" | "jisho";

// ── Elements ──────────────────────────────────────────────────────────────────

const serverUrlInput  = document.getElementById("serverUrl") as HTMLInputElement;
const engineSelect    = document.getElementById("translationEngine") as HTMLSelectElement;
const dictModeSelect  = document.getElementById("dictMode") as HTMLSelectElement;
const testBtn         = document.getElementById("testBtn") as HTMLButtonElement;
const saveBtn         = document.getElementById("saveBtn") as HTMLButtonElement;
const statusEl        = document.getElementById("status") as HTMLDivElement;
const noticeEl        = document.getElementById("firstInstallNotice") as HTMLDivElement;

const engineHints: Record<TranslationEngine, HTMLElement> = {
  none:  document.getElementById("engineHint-none") as HTMLElement,
  local: document.getElementById("engineHint-local") as HTMLElement,
  deepl: document.getElementById("engineHint-deepl") as HTMLElement,
};

// ── Engine selector ───────────────────────────────────────────────────────────

function applyEngine(engine: TranslationEngine): void {
  for (const [key, el] of Object.entries(engineHints)) {
    el.style.display = key === engine ? "block" : "none";
  }
}

engineSelect.addEventListener("change", () => {
  applyEngine(engineSelect.value as TranslationEngine);
});

// ── Dict mode selector ────────────────────────────────────────────────────────

const dictHints: Record<DictMode, HTMLElement> = {
  jisho: document.getElementById("dictHint-jisho") as HTMLElement,
  local: document.getElementById("dictHint-local") as HTMLElement,
};

function applyDictMode(mode: DictMode): void {
  for (const [key, el] of Object.entries(dictHints)) {
    el.style.display = key === mode ? "block" : "none";
  }
}

dictModeSelect.addEventListener("change", () => {
  applyDictMode(dictModeSelect.value as DictMode);
});

// ── Load saved settings ───────────────────────────────────────────────────────

chrome.storage.sync
  .get(["serverUrl", "translationEngine", "dictMode", "firstInstall"])
  .then((data) => {
    const s = data as {
      serverUrl?: string;
      translationEngine?: TranslationEngine;
      dictMode?: DictMode;
      firstInstall?: boolean;
    };

    if (s.serverUrl) serverUrlInput.value = s.serverUrl;

    const engine: TranslationEngine = s.translationEngine ?? "none";
    engineSelect.value = engine;
    applyEngine(engine);

    const dictMode: DictMode = s.dictMode ?? "jisho";
    dictModeSelect.value = dictMode;
    applyDictMode(dictMode);

    if (!s.serverUrl || s.firstInstall) {
      noticeEl.style.display = "block";
      chrome.storage.sync.set({ firstInstall: false }).catch(console.error);
    }
  })
  .catch(console.error);

// ── Test connection ───────────────────────────────────────────────────────────

testBtn.addEventListener("click", () => { void testConnection(); });

async function testConnection(): Promise<void> {
  const url = serverUrlInput.value.trim();
  if (!url) { showStatus("Please enter a server URL first.", "error"); return; }

  testBtn.disabled = true;
  testBtn.textContent = "Testing…";

  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json() as { version?: string; deepl_available?: boolean };
      const deepl = data.deepl_available ? " · DeepL ✅" : " · DeepL ✗ (not configured)";
      showStatus(`✅ Connected! Version: ${data.version ?? "unknown"}${deepl}`, "success");
    } else {
      showStatus(`❌ Server returned HTTP ${res.status}`, "error");
    }
  } catch (e) {
    showStatus(`❌ Connection failed: ${e instanceof Error ? e.message : String(e)}`, "error");
  } finally {
    testBtn.disabled = false;
    testBtn.textContent = "Test Connection";
  }
}

// ── Save settings ─────────────────────────────────────────────────────────────

saveBtn.addEventListener("click", () => { void saveSettings(); });

async function saveSettings(): Promise<void> {
  const url = serverUrlInput.value.trim();
  if (!url) { showStatus("Server URL is required.", "error"); return; }

  try { new URL(url); } catch {
    showStatus("Please enter a valid URL (e.g. http://localhost:3579)", "error");
    return;
  }

  await chrome.storage.sync.set({
    serverUrl: url,
    translationEngine: engineSelect.value as TranslationEngine,
    dictMode: dictModeSelect.value as DictMode,
  });

  showStatus("✅ Settings saved!", "success");
}

// ── Status helper ─────────────────────────────────────────────────────────────

function showStatus(msg: string, type: "success" | "error"): void {
  statusEl.textContent = msg;
  statusEl.className = `status-${type}`;
  statusEl.style.display = "block";
  setTimeout(() => { statusEl.style.display = "none"; }, 5000);
}
