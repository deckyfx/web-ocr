import { createSignal, onMount, Show } from "solid-js";

interface HealthInfo {
  status:  string;
  version: string;
}

export function HomePage() {
  const [health, setHealth] = createSignal<HealthInfo | null>(null);

  onMount(() => {
    fetch("/health")
      .then((r) => (r.ok ? (r.json() as Promise<HealthInfo>) : Promise.reject()))
      .then(setHealth)
      .catch(() => {});
  });

  return (
    <div class="flex min-h-screen flex-col items-center justify-center gap-6 bg-slate-50">
      {/* Logo mark */}
      <div class="flex h-20 w-20 items-center justify-center rounded-2xl bg-violet-600 shadow-lg">
        <span class="text-4xl font-bold text-white">W</span>
      </div>

      {/* Name + sub */}
      <div class="text-center">
        <h1 class="text-3xl font-bold text-slate-800">WebOCR</h1>
        <p class="mt-1 text-sm text-slate-500">Manga OCR · Translation · Typesetting</p>
      </div>

      {/* Version badge */}
      <Show when={health()}>
        {(h) => (
          <span class="rounded-full bg-slate-100 px-4 py-1 text-sm font-medium text-slate-600">
            v{h().version}
          </span>
        )}
      </Show>
    </div>
  );
}
