import { useEffect, useState } from "react";
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
} from "lucide-react";

interface HealthInfo {
  status:              string;
  version:             string;
  ocr_models_dir:      string;
  translate_models_dir: string;
  deepl_available:     boolean;
}

function StatusBadge({ ok, label }: { ok: boolean | null; label: string }) {
  if (ok === null)
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
        <CircleDashed className="h-3 w-3 animate-spin" />
        {label}
      </span>
    );
  return ok ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">
      <CheckCircle className="h-3 w-3" />
      {label}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-600">
      <XCircle className="h-3 w-3" />
      {label}
    </span>
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
];

const METHOD_STYLE: Record<string, string> = {
  GET:  "bg-sky-50 text-sky-700",
  POST: "bg-violet-50 text-violet-700",
};

export function Dashboard() {
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [err,    setErr]    = useState<string | null>(null);

  useEffect(() => {
    fetch("/health")
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<HealthInfo>;
      })
      .then(setHealth)
      .catch(e => setErr(String(e)));
  }, []);

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-10">
      <div className="mx-auto max-w-2xl space-y-8">

        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-white p-2 shadow-sm ring-1 ring-slate-200">
            <Code2 className="h-6 w-6 text-slate-700" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-slate-800">Web OCR Server</h1>
            <p className="text-sm text-slate-500">ASP.NET Core · Manga-OCR · Opus-MT</p>
          </div>
          <div className="ml-auto">
            <StatusBadge
              ok={err ? false : (health && health.status === "ok") ? true : null}
              label={err ? "error" : health ? health.status : "connecting"}
            />
          </div>
        </div>

        {/* Server info card */}
        <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
          <div className="border-b border-slate-100 px-5 py-3">
            <span className="text-sm font-medium text-slate-600">Server info</span>
          </div>
          {err ? (
            <div className="flex items-center gap-2 px-5 py-4 text-sm text-red-600">
              <ShieldAlert className="h-4 w-4 shrink-0" />
              {err}
            </div>
          ) : health ? (
            <dl className="divide-y divide-slate-50 text-sm">
              <div className="flex items-center gap-3 px-5 py-3">
                <dt className="w-36 shrink-0 text-slate-500">Version</dt>
                <dd className="font-medium text-slate-800">{health.version}</dd>
              </div>
              <div className="flex items-start gap-3 px-5 py-3">
                <dt className="flex w-36 shrink-0 items-center gap-1 text-slate-500">
                  <FolderOpen className="h-3.5 w-3.5" /> OCR models
                </dt>
                <dd className="break-all font-mono text-xs text-slate-600">{health.ocr_models_dir}</dd>
              </div>
              <div className="flex items-start gap-3 px-5 py-3">
                <dt className="flex w-36 shrink-0 items-center gap-1 text-slate-500">
                  <FolderOpen className="h-3.5 w-3.5" /> Translate
                </dt>
                <dd className="break-all font-mono text-xs text-slate-600">{health.translate_models_dir}</dd>
              </div>
              <div className="flex items-center gap-3 px-5 py-3">
                <dt className="flex w-36 shrink-0 items-center gap-1 text-slate-500">
                  <Globe className="h-3.5 w-3.5" /> DeepL
                </dt>
                <dd>
                  <StatusBadge
                    ok={health.deepl_available}
                    label={health.deepl_available ? "configured" : "not configured"}
                  />
                </dd>
              </div>
            </dl>
          ) : (
            <div className="px-5 py-4 text-sm text-slate-400">Loading…</div>
          )}
        </div>

        {/* Endpoints */}
        <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
          <div className="border-b border-slate-100 px-5 py-3">
            <span className="text-sm font-medium text-slate-600">API Endpoints</span>
          </div>
          <ul className="divide-y divide-slate-50">
            {ENDPOINTS.map(({ method, path, desc, Icon, color }) => (
              <li key={path} className="flex items-center gap-4 px-5 py-3.5 text-sm">
                <span className={`w-12 shrink-0 rounded px-1.5 py-0.5 text-center text-xs font-semibold ${METHOD_STYLE[method] ?? ""}`}>
                  {method}
                </span>
                <code className="w-28 shrink-0 text-slate-700">{path}</code>
                <span className={`shrink-0 ${color}`}>
                  <Icon className="h-4 w-4" />
                </span>
                <span className="text-slate-500">{desc}</span>
              </li>
            ))}
          </ul>
        </div>

      </div>
    </div>
  );
}
