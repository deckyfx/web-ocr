import { createSignal, onMount, For, Show } from "solid-js";
import {
  Activity,
  BookOpen,
  CheckCircle,
  CircleDashed,
  Monitor,
  FolderOpen,
  Globe,
  Languages,
  ScanText,
  ShieldAlert,
  XCircle,
} from "lucide-solid";

// ── Types ────────────────────────────────────────────────────────────────────

interface ModelStatus {
  name:    string;
  ready:   boolean;
  enabled: boolean;
}

interface HealthInfo {
  status:                       string;
  version:                      string;
  data_dir:                     string;
  deepl_available:              boolean;
  preferred_translation_engine: string;
  models:                       Record<string, ModelStatus>;
}

interface AllModelSettings {
  ocr:       ModelEntry;
  translate: ModelEntry;
  inpaint:   ModelEntry;
  bubble:    ModelEntry;
  preferred_translation_engine: string;
}

interface ModelEntry {
  repo:    string;
  dir:     string;
  enabled: boolean;
  files:   string;
}

// ── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge(props: { ok: boolean | null; label: string }) {
  return (
    <Show
      when={props.ok !== null}
      fallback={
        <span class="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
          <CircleDashed class="h-3 w-3 animate-spin" />
          {props.label}
        </span>
      }
    >
      <Show
        when={props.ok}
        fallback={
          <span class="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-600">
            <XCircle class="h-3 w-3" />
            {props.label}
          </span>
        }
      >
        <span class="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">
          <CheckCircle class="h-3 w-3" />
          {props.label}
        </span>
      </Show>
    </Show>
  );
}

// ── Constants ────────────────────────────────────────────────────────────────

const MODEL_META: Record<string, { label: string; Icon: typeof ScanText }> = {
  ocr:        { label: "OCR",        Icon: ScanText },
  translate:  { label: "Translate",  Icon: Languages },
  dictionary: { label: "Dictionary", Icon: BookOpen },
  inpaint:    { label: "Inpaint",    Icon: Monitor },
  bubble:     { label: "Bubble",     Icon: Activity },
};


// ── Dashboard (exported as ServerStatusPage alias) ───────────────────────────

export function Dashboard() {
  const [health, setHealth] = createSignal<HealthInfo | null>(null);
  const [err, setErr]       = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [savedEngine, setSavedEngine] = createSignal<string | null>(null);

  onMount(fetchHealth);

  function fetchHealth() {
    fetch("/health")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<HealthInfo>;
      })
      .then((h) => {
        setHealth(h);
        setSavedEngine(h.preferred_translation_engine);
      })
      .catch((e: unknown) => setErr(String(e)));
  }

  const statusOk = () => {
    if (err()) return false;
    const h = health();
    if (!h) return null;
    return h.status === "ok";
  };

  const statusLabel = () => {
    if (err()) return "error";
    const h = health();
    return h ? h.status : "connecting";
  };

  async function changeEngine(engine: string) {
    const h = health();
    if (!h || saving()) return;
    setSaving(true);
    try {
      // Fetch current settings to avoid overwriting other fields
      const settingsRes = await fetch("/api/settings");
      if (!settingsRes.ok) throw new Error("Failed to load settings");
      const settings = (await settingsRes.json()) as AllModelSettings;
      settings.preferred_translation_engine = engine;

      const putRes = await fetch("/api/settings", {
        method:  "PUT",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(settings),
      });
      if (!putRes.ok) throw new Error("Failed to save settings");
      setSavedEngine(engine);
    } catch (e) {
      console.error("Failed to update translation engine:", e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div class="min-h-screen bg-slate-50 px-4 py-10">
      <div class="mx-auto max-w-2xl space-y-8">

        {/* Header */}
        <div class="flex items-center gap-3">
          <div class="rounded-xl bg-white p-2 shadow-sm ring-1 ring-slate-200">
            <Monitor class="h-6 w-6 text-slate-700" />
          </div>
          <div>
            <h1 class="text-xl font-semibold text-slate-800">Server Status</h1>
            <p class="text-sm text-slate-500">ASP.NET Core · Manga-OCR · Opus-MT</p>
          </div>
          <div class="ml-auto">
            <StatusBadge ok={statusOk()} label={statusLabel()} />
          </div>
        </div>

        {/* Error banner */}
        <Show when={err()}>
          <div class="flex items-center gap-2 rounded-xl bg-red-50 px-5 py-4 text-sm text-red-600 ring-1 ring-red-200">
            <ShieldAlert class="h-4 w-4 shrink-0" />
            {err()}
          </div>
        </Show>

        <Show when={health()}>
          {(h) => (
            <>
              {/* Server info */}
              <div class="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
                <div class="border-b border-slate-100 px-5 py-3">
                  <span class="text-sm font-medium text-slate-600">Server info</span>
                </div>
                <dl class="divide-y divide-slate-50 text-sm">
                  <div class="flex items-center gap-3 px-5 py-3">
                    <dt class="w-36 shrink-0 text-slate-500">Version</dt>
                    <dd class="font-medium text-slate-800">{h().version}</dd>
                  </div>
                  <div class="flex items-start gap-3 px-5 py-3">
                    <dt class="flex w-36 shrink-0 items-center gap-1 text-slate-500">
                      <FolderOpen class="h-3.5 w-3.5" /> Data dir
                    </dt>
                    <dd class="break-all font-mono text-xs text-slate-600">{h().data_dir}</dd>
                  </div>
                  <div class="flex items-center gap-3 px-5 py-3">
                    <dt class="flex w-36 shrink-0 items-center gap-1 text-slate-500">
                      <Globe class="h-3.5 w-3.5" /> DeepL
                    </dt>
                    <dd>
                      <StatusBadge
                        ok={h().deepl_available}
                        label={h().deepl_available ? "configured" : "not configured"}
                      />
                    </dd>
                  </div>
                </dl>
              </div>

              {/* Models */}
              <div class="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
                <div class="border-b border-slate-100 px-5 py-3">
                  <span class="text-sm font-medium text-slate-600">Models</span>
                </div>
                <ul class="divide-y divide-slate-50">
                  <For each={Object.entries(h().models)}>
                    {([key, model]) => {
                      const meta = MODEL_META[key] ?? { label: key, Icon: Activity };
                      const Icon = meta.Icon;
                      return (
                        <li class="flex items-center gap-4 px-5 py-3 text-sm">
                          <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-50 text-slate-500">
                            <Icon class="h-4 w-4" />
                          </span>
                          <span class="w-24 shrink-0 font-medium text-slate-700">{meta.label}</span>
                          <span class="flex-1 truncate font-mono text-xs text-slate-400">{model.name}</span>
                          <Show
                            when={model.enabled}
                            fallback={
                              <span class="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-400">
                                disabled
                              </span>
                            }
                          >
                            <StatusBadge ok={model.ready} label={model.ready ? "ready" : "loading"} />
                          </Show>
                        </li>
                      );
                    }}
                  </For>
                </ul>
              </div>

              {/* Translation engine */}
              <div class="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
                <div class="border-b border-slate-100 px-5 py-3">
                  <span class="text-sm font-medium text-slate-600">Translation engine</span>
                </div>
                <div class="px-5 py-4">
                  <p class="mb-3 text-xs text-slate-400">
                    Default engine used when a request doesn't specify one. Takes effect immediately; no restart needed.
                  </p>
                  <div class="flex flex-wrap gap-2">
                    <For each={[
                      { value: "auto",  label: "Auto",  desc: "DeepL if configured, else local" },
                      { value: "local", label: "Local", desc: "Opus-MT (on-device)" },
                      { value: "deepl", label: "DeepL", desc: "DeepL API" },
                    ]}>
                      {(opt) => {
                        const active = () => savedEngine() === opt.value;
                        const disabled = () => opt.value === "deepl" && !h().deepl_available;
                        return (
                          <button
                            disabled={disabled() || saving()}
                            onClick={() => changeEngine(opt.value)}
                            title={disabled() ? "DeepL API key not configured" : opt.desc}
                            class={`rounded-lg border px-4 py-2 text-sm transition-colors ${
                              active()
                                ? "border-violet-500 bg-violet-50 font-semibold text-violet-700"
                                : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50"
                            } ${disabled() ? "cursor-not-allowed opacity-40" : ""}`}
                          >
                            {opt.label}
                            <Show when={active()}>
                              <span class="ml-1.5 text-xs opacity-60">✓</span>
                            </Show>
                          </button>
                        );
                      }}
                    </For>
                    <Show when={saving()}>
                      <span class="flex items-center gap-1 text-xs text-slate-400">
                        <CircleDashed class="h-3 w-3 animate-spin" /> Saving…
                      </span>
                    </Show>
                  </div>
                </div>
              </div>

            </>
          )}
        </Show>

      </div>
    </div>
  );
}
