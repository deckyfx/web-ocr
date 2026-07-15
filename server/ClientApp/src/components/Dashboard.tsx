import { createSignal, onMount, For, Show } from "solid-js";
import {
  Activity,
  BookOpen,
  CheckCircle,
  CircleDashed,
  Code2,
  FolderOpen,
  Globe,
  Languages,
  ScanText,
  ShieldAlert,
  XCircle,
} from "lucide-solid";

interface HealthInfo {
  status:               string;
  version:              string;
  ocr_models_dir:       string;
  translate_models_dir: string;
  deepl_available:      boolean;
}

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

const ENDPOINTS = [
  {
    method: "GET",
    path:   "/health",
    desc:   "Server status, version, model paths",
    Icon:   Activity,
    color:  "text-sky-600",
  },
  {
    method: "POST",
    path:   "/ocr",
    desc:   "Base64 image → Japanese text",
    Icon:   ScanText,
    color:  "text-violet-600",
  },
  {
    method: "POST",
    path:   "/translate",
    desc:   "Japanese → English (local Opus-MT or DeepL)",
    Icon:   Languages,
    color:  "text-amber-600",
  },
  {
    method: "POST",
    path:   "/analyze",
    desc:   "Tokenise text + dictionary lookup",
    Icon:   BookOpen,
    color:  "text-emerald-600",
  },
] as const;

const METHOD_STYLE: Record<string, string> = {
  GET:  "bg-sky-50 text-sky-700",
  POST: "bg-violet-50 text-violet-700",
};

export function Dashboard() {
  const [health, setHealth] = createSignal<HealthInfo | null>(null);
  const [err, setErr]       = createSignal<string | null>(null);

  onMount(() => {
    fetch("/health")
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<HealthInfo>;
      })
      .then(setHealth)
      .catch((e: unknown) => setErr(String(e)));
  });

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

  return (
    <div class="min-h-screen bg-slate-50 px-4 py-10">
      <div class="mx-auto max-w-2xl space-y-8">

        {/* Header */}
        <div class="flex items-center gap-3">
          <div class="rounded-xl bg-white p-2 shadow-sm ring-1 ring-slate-200">
            <Code2 class="h-6 w-6 text-slate-700" />
          </div>
          <div>
            <h1 class="text-xl font-semibold text-slate-800">Web OCR Server</h1>
            <p class="text-sm text-slate-500">ASP.NET Core · Manga-OCR · Opus-MT</p>
          </div>
          <div class="ml-auto">
            <StatusBadge ok={statusOk()} label={statusLabel()} />
          </div>
        </div>

        {/* Server info card */}
        <div class="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
          <div class="border-b border-slate-100 px-5 py-3">
            <span class="text-sm font-medium text-slate-600">Server info</span>
          </div>
          <Show
            when={!err()}
            fallback={
              <div class="flex items-center gap-2 px-5 py-4 text-sm text-red-600">
                <ShieldAlert class="h-4 w-4 shrink-0" />
                {err()}
              </div>
            }
          >
            <Show
              when={health()}
              fallback={<div class="px-5 py-4 text-sm text-slate-400">Loading…</div>}
            >
              {(h) => (
                <dl class="divide-y divide-slate-50 text-sm">
                  <div class="flex items-center gap-3 px-5 py-3">
                    <dt class="w-36 shrink-0 text-slate-500">Version</dt>
                    <dd class="font-medium text-slate-800">{h().version}</dd>
                  </div>
                  <div class="flex items-start gap-3 px-5 py-3">
                    <dt class="flex w-36 shrink-0 items-center gap-1 text-slate-500">
                      <FolderOpen class="h-3.5 w-3.5" /> OCR models
                    </dt>
                    <dd class="break-all font-mono text-xs text-slate-600">{h().ocr_models_dir}</dd>
                  </div>
                  <div class="flex items-start gap-3 px-5 py-3">
                    <dt class="flex w-36 shrink-0 items-center gap-1 text-slate-500">
                      <FolderOpen class="h-3.5 w-3.5" /> Translate
                    </dt>
                    <dd class="break-all font-mono text-xs text-slate-600">{h().translate_models_dir}</dd>
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
              )}
            </Show>
          </Show>
        </div>

        {/* Endpoints */}
        <div class="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
          <div class="border-b border-slate-100 px-5 py-3">
            <span class="text-sm font-medium text-slate-600">API Endpoints</span>
          </div>
          <ul class="divide-y divide-slate-50">
            <For each={ENDPOINTS}>
              {({ method, path, desc, Icon, color }) => (
                <li class="flex items-center gap-4 px-5 py-3.5 text-sm">
                  <span class={`w-12 shrink-0 rounded px-1.5 py-0.5 text-center text-xs font-semibold ${METHOD_STYLE[method] ?? ""}`}>
                    {method}
                  </span>
                  <code class="w-28 shrink-0 text-slate-700">{path}</code>
                  <span class={`shrink-0 ${color}`}>
                    <Icon class="h-4 w-4" />
                  </span>
                  <span class="text-slate-500">{desc}</span>
                </li>
              )}
            </For>
          </ul>
        </div>

      </div>
    </div>
  );
}
