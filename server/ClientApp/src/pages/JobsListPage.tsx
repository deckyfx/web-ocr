import { createResource, createSignal, For, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import {
  CheckCircle,
  Clock,
  Image,
  Layers,
  Trash2,
  XCircle,
} from "lucide-solid";
import { deleteJob, jobOriginalUrl, jobResultUrl, listJobs } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import type { PageTranslationJob } from "../types";

// ---------------------------------------------------------------------------
// Status badge (exported for reuse in StudioPage)
// ---------------------------------------------------------------------------

export function StatusBadge(props: { status: PageTranslationJob["status"] }) {
  const cfg = () => {
    switch (props.status) {
      case "done":
        return { cls: "bg-green-100 text-green-700", Icon: CheckCircle, label: "Done" };
      case "processing":
        return { cls: "bg-yellow-100 text-yellow-700", Icon: Clock, label: "Processing" };
      case "error":
        return { cls: "bg-red-100 text-red-700", Icon: XCircle, label: "Error" };
      default:
        return { cls: "bg-slate-100 text-slate-600", Icon: Clock, label: String(props.status) };
    }
  };

  return (
    <span
      class={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${cfg()?.cls ?? ""}`}
    >
      {(() => { const c = cfg(); const Icon = c?.Icon ?? Clock; return <Icon class="h-3 w-3" />; })()}
      {cfg()?.label ?? ""}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Job card
// ---------------------------------------------------------------------------

function JobCard(props: {
  job: PageTranslationJob;
  onClick: () => void;
  onDelete: (e: MouseEvent) => void;
}) {
  const thumbSrc = () =>
    props.job.resultImagePath
      ? jobResultUrl(props.job.id)
      : jobOriginalUrl(props.job.id);

  return (
    // Outer div acts as the group anchor; contains two sibling native buttons so
    // neither is nested inside the other (avoids invalid interactive-in-interactive HTML).
    <div class="group relative flex flex-col overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 transition hover:shadow-md hover:ring-slate-300">
      {/* Delete button — sibling, not nested inside the nav button */}
      <button
        class="absolute left-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-md bg-white/80 text-slate-500 shadow-sm ring-1 ring-slate-200 hover:bg-red-50 hover:text-red-600"
        title="Delete job"
        aria-label="Delete job"
        onClick={props.onDelete}
      >
        <Trash2 class="h-3.5 w-3.5" />
      </button>

      {/* Nav button covers thumbnail + info */}
      <button
        class="flex w-full flex-col text-left focus-visible:outline-2 focus-visible:outline-violet-500"
        onClick={props.onClick}
      >
        {/* Thumbnail */}
        <div class="relative aspect-3/4 w-full overflow-hidden bg-slate-100">
          <img
            src={thumbSrc()}
            alt={props.job.title}
            class="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
            loading="lazy"
          />
          <div class="absolute right-2 top-2">
            <StatusBadge status={props.job.status} />
          </div>
        </div>

        {/* Info */}
        <div class="flex flex-col gap-1 p-3">
          <p class="truncate text-sm font-medium text-slate-800">{props.job.title}</p>
          <div class="flex items-center gap-3 text-xs text-slate-500">
            <span class="flex items-center gap-1">
              <Layers class="h-3 w-3" />
              {props.job.bubbleCount} bubbles
            </span>
            <span class="ml-auto">
              {new Date(props.job.createdAt).toLocaleDateString()}
            </span>
          </div>
        </div>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "done", label: "Done" },
  { value: "processing", label: "Processing" },
  { value: "error", label: "Error" },
];

export function JobsListPage() {
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = createSignal("");
  const [search, setSearch] = createSignal("");

  const [jobs, { refetch }] = createResource(statusFilter, (status) =>
    listJobs({ pageSize: 100, status: status || undefined }),
  );

  const filtered = () => {
    const q = search().toLowerCase();
    return (jobs()?.items ?? []).filter(
      (j) => !q || j.title.toLowerCase().includes(q),
    );
  };

  // Delete confirm state
  const [pendingDeleteId, setPendingDeleteId] = createSignal<string | null>(null);
  const [isDeleting, setIsDeleting] = createSignal(false);
  const [deleteError, setDeleteError] = createSignal<string | null>(null);

  function requestDelete(id: string, e: MouseEvent): void {
    e.stopPropagation();
    setDeleteError(null);
    setPendingDeleteId(id);
  }

  async function confirmDelete(): Promise<void> {
    const id = pendingDeleteId();
    if (!id) return;
    setIsDeleting(true);
    try {
      await deleteJob(id);
      setPendingDeleteId(null);
      refetch();
    } catch (err) {
      setPendingDeleteId(null);
      setDeleteError(err instanceof Error ? err.message : "Failed to delete job");
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <div class="min-h-screen px-6 py-8">
      {/* Header */}
      <div class="mb-6 flex items-center gap-3">
        <div class="rounded-xl bg-white p-2 shadow-sm ring-1 ring-slate-200">
          <Image class="h-5 w-5 text-violet-600" />
        </div>
        <h1 class="text-xl font-semibold text-slate-800">Jobs</h1>
      </div>

      {/* Filters */}
      <div class="mb-6 flex flex-wrap gap-3">
        <input
          type="search"
          placeholder="Search jobs…"
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
          class="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-400"
        />
        <select
          value={statusFilter()}
          onChange={(e) => setStatusFilter(e.currentTarget.value)}
          class="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-violet-400"
        >
          {STATUS_OPTIONS.map((o) => (
            <option value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {/* Delete error */}
      <Show when={deleteError()}>
        {(msg) => (
          <div role="alert" class="mb-4 flex items-center gap-2 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600 ring-1 ring-red-200">
            <span class="flex-1">{msg()}</span>
            <button
              onClick={() => setDeleteError(null)}
              class="shrink-0 rounded p-0.5 hover:bg-red-100"
              aria-label="Dismiss error"
            >
              ✕
            </button>
          </div>
        )}
      </Show>

      {/* States */}
      <Show when={jobs.loading}>
        <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {Array.from({ length: 10 }).map(() => (
            <div class="aspect-3/4 animate-pulse rounded-2xl bg-slate-200" />
          ))}
        </div>
      </Show>

      <Show when={jobs.error}>
        <div class="rounded-2xl bg-red-50 p-6 text-sm text-red-600 ring-1 ring-red-200">
          Failed to load jobs: {String(jobs.error)}
        </div>
      </Show>

      <Show when={!jobs.loading && !jobs.error}>
        <Show
          when={filtered().length > 0}
          fallback={
            <div class="flex flex-col items-center gap-3 py-24 text-slate-400">
              <Image class="h-10 w-10 opacity-40" />
              <p class="text-sm">No jobs yet.</p>
              <p class="max-w-xs text-center text-xs text-slate-400">
                Upload pages via the extension or API to see translation jobs here.
              </p>
            </div>
          }
        >
          <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            <For each={filtered()}>
              {(job) => (
                <JobCard
                  job={job}
                  onClick={() => navigate(`/jobs/${job.id}`)}
                  onDelete={(e) => requestDelete(job.id, e)}
                />
              )}
            </For>
          </div>
        </Show>
      </Show>

      {/* Delete confirm dialog */}
      <ConfirmDialog
        open={pendingDeleteId() !== null}
        title="Delete job"
        message="This will permanently delete the job, its images, and all bubble data. This cannot be undone."
        confirmLabel="Delete"
        loading={isDeleting()}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDeleteId(null)}
      />
    </div>
  );
}
