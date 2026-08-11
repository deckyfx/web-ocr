import { createResource, createSignal, For, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import {
  Check,
  CheckCircle,
  CheckSquare,
  Clock,
  FolderPlus,
  Image,
  Layers,
  RefreshCw,
  Square,
  Trash2,
  X,
  XCircle,
} from "lucide-solid";
import { deleteJob, jobOriginalUrl, jobResultUrl, listJobs } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { GroupJobsModal } from "../components/GroupJobsModal";
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
  isSelected: boolean;
  isSelectionMode: boolean;
  onToggleSelect: (e: MouseEvent) => void;
  onClick: () => void;
  onDelete: (e: MouseEvent) => void;
}) {
  const thumbSrc = () =>
    props.job.resultImagePath
      ? jobResultUrl(props.job.id)
      : jobOriginalUrl(props.job.id);

  function handleCardClick(e: MouseEvent) {
    if (props.isSelectionMode) {
      props.onToggleSelect(e);
    } else {
      props.onClick();
    }
  }

  return (
    <div
      class={`group relative flex flex-col overflow-hidden rounded-2xl bg-white shadow-sm ring-1 transition hover:shadow-md ${
        props.isSelected
          ? "ring-2 ring-violet-500 bg-violet-50/20"
          : "ring-slate-200 hover:ring-slate-300"
      }`}
    >
      {/* Selection checkbox toggle (top left) */}
      <button
        class={`absolute left-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-lg shadow-sm transition ${
          props.isSelected
            ? "bg-violet-600 text-white ring-1 ring-violet-600"
            : props.isSelectionMode
              ? "bg-white/90 text-slate-400 ring-1 ring-slate-300 hover:bg-white hover:text-slate-600"
              : "bg-white/80 text-slate-400 opacity-0 ring-1 ring-slate-200 group-hover:opacity-100 hover:bg-white hover:text-slate-600"
        }`}
        title={props.isSelected ? "Deselect job" : "Select job"}
        aria-label="Select job"
        onClick={props.onToggleSelect}
      >
        <Show when={props.isSelected} fallback={<Square class="h-4 w-4" />}>
          <Check class="h-4 w-4 stroke-[3]" />
        </Show>
      </button>

      {/* Delete button (top right, shown when not in selection mode or on hover) */}
      <Show when={!props.isSelectionMode}>
        <button
          class="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-lg bg-white/80 text-slate-500 opacity-0 shadow-sm ring-1 ring-slate-200 transition group-hover:opacity-100 hover:bg-red-50 hover:text-red-600"
          title="Delete job"
          aria-label="Delete job"
          onClick={props.onDelete}
        >
          <Trash2 class="h-3.5 w-3.5" />
        </button>
      </Show>

      {/* Nav button covers thumbnail + info */}
      <button
        class="flex w-full flex-col text-left focus-visible:outline-2 focus-visible:outline-violet-500"
        onClick={handleCardClick}
      >
        {/* Thumbnail */}
        <div class="relative aspect-3/4 w-full overflow-hidden bg-slate-100">
          <img
            src={thumbSrc()}
            alt={props.job.title}
            class="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
            loading="lazy"
          />
          <Show when={!props.isSelectionMode}>
            <div class="absolute right-2 bottom-2">
              <StatusBadge status={props.job.status} />
            </div>
          </Show>
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

  // Selection mode states
  const [isSelectionMode, setIsSelectionMode] = createSignal(false);
  const [selectedIds, setSelectedIds] = createSignal<Set<string>>(new Set());

  // Group modal state
  const [isGroupModalOpen, setIsGroupModalOpen] = createSignal(false);

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
  const [isBatchDelete, setIsBatchDelete] = createSignal(false);
  const [isDeleting, setIsDeleting] = createSignal(false);
  const [deleteError, setDeleteError] = createSignal<string | null>(null);

  // Selection helpers
  function toggleSelectJob(id: string, e: MouseEvent) {
    e.stopPropagation();
    setIsSelectionMode(true);
    const next = new Set(selectedIds());
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelectedIds(next);
  }

  function toggleSelectAll() {
    const all = filtered();
    if (selectedIds().size === all.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(all.map((j) => j.id)));
    }
  }

  function exitSelectionMode() {
    setIsSelectionMode(false);
    setSelectedIds(new Set());
  }

  function requestSingleDelete(id: string, e: MouseEvent): void {
    e.stopPropagation();
    setDeleteError(null);
    setIsBatchDelete(false);
    setPendingDeleteId(id);
  }

  function requestBatchDelete(): void {
    if (selectedIds().size === 0) return;
    setDeleteError(null);
    setIsBatchDelete(true);
    setPendingDeleteId("batch");
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingDeleteId()) return;
    setIsDeleting(true);

    try {
      if (isBatchDelete()) {
        const ids = Array.from(selectedIds());
        await Promise.all(ids.map((id) => deleteJob(id)));
        setSelectedIds(new Set());
        setIsSelectionMode(false);
      } else {
        const id = pendingDeleteId();
        if (id) await deleteJob(id);
      }

      setPendingDeleteId(null);
      refetch();
    } catch (err) {
      setPendingDeleteId(null);
      setDeleteError(err instanceof Error ? err.message : "Failed to delete job(s)");
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <div class="min-h-screen px-6 py-8">
      {/* Header */}
      <div class="mb-6 flex flex-wrap items-center gap-3">
        <div class="rounded-xl bg-white p-2 shadow-sm ring-1 ring-slate-200">
          <Image class="h-5 w-5 text-violet-600" />
        </div>
        <h1 class="text-xl font-semibold text-slate-800">Jobs</h1>

        <div class="ml-auto flex items-center gap-2">
          {/* Select Mode Toggle */}
          <button
            onClick={() => {
              if (isSelectionMode()) {
                exitSelectionMode();
              } else {
                setIsSelectionMode(true);
              }
            }}
            class={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
              isSelectionMode()
                ? "bg-violet-100 text-violet-700 ring-1 ring-violet-300"
                : "bg-white text-slate-600 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
            }`}
          >
            <CheckSquare class="h-4 w-4" />
            {isSelectionMode() ? "Exit Select" : "Select Jobs"}
          </button>

          {/* Refresh */}
          <button
            class="rounded-lg p-1.5 text-slate-400 hover:bg-white hover:text-slate-600 hover:shadow-sm hover:ring-1 hover:ring-slate-200 disabled:opacity-50 disabled:cursor-not-allowed"
            title="Refresh"
            aria-label="Refresh jobs"
            disabled={jobs.loading}
            onClick={() => refetch()}
          >
            <RefreshCw class={`h-4 w-4 ${jobs.loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* Multi-Select Action Bar (Floating Banner) */}
      <Show when={isSelectionMode() || selectedIds().size > 0}>
        <div class="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-slate-900 px-5 py-3.5 text-white shadow-lg">
          <div class="flex items-center gap-3">
            <button
              onClick={toggleSelectAll}
              class="inline-flex items-center gap-1.5 text-xs font-medium text-slate-300 hover:text-white"
            >
              <Show
                when={selectedIds().size > 0 && selectedIds().size === filtered().length}
                fallback={<Square class="h-4 w-4" />}
              >
                <CheckSquare class="h-4 w-4 text-violet-400" />
              </Show>
              {selectedIds().size === filtered().length ? "Deselect All" : "Select All"}
            </button>
            <span class="h-4 w-px bg-slate-700" />
            <span class="rounded-full bg-violet-500/20 px-2.5 py-0.5 text-xs font-semibold text-violet-300 ring-1 ring-violet-500/30">
              {selectedIds().size} selected
            </span>
          </div>

          <div class="flex items-center gap-2">
            {/* Group into Volume / Chapter */}
            <button
              disabled={selectedIds().size === 0}
              onClick={() => setIsGroupModalOpen(true)}
              class="inline-flex items-center gap-1.5 rounded-xl bg-violet-600 px-3.5 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <FolderPlus class="h-4 w-4" />
              Group into Volume/Chapter
            </button>

            {/* Batch Delete */}
            <button
              disabled={selectedIds().size === 0}
              onClick={requestBatchDelete}
              class="inline-flex items-center gap-1.5 rounded-xl bg-red-600/90 px-3.5 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Trash2 class="h-4 w-4" />
              Delete Selected ({selectedIds().size})
            </button>

            {/* Close action bar */}
            <button
              onClick={exitSelectionMode}
              class="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
              title="Close selection"
            >
              <X class="h-4 w-4" />
            </button>
          </div>
        </div>
      </Show>

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
                  isSelected={selectedIds().has(job.id)}
                  isSelectionMode={isSelectionMode()}
                  onToggleSelect={(e) => toggleSelectJob(job.id, e)}
                  onClick={() => navigate(`/jobs/${job.id}`)}
                  onDelete={(e) => requestSingleDelete(job.id, e)}
                />
              )}
            </For>
          </div>
        </Show>
      </Show>

      {/* Group Jobs Modal */}
      <GroupJobsModal
        open={isGroupModalOpen()}
        selectedJobIds={Array.from(selectedIds())}
        onClose={() => setIsGroupModalOpen(false)}
        onSuccess={() => {
          setIsGroupModalOpen(false);
          exitSelectionMode();
          refetch();
        }}
      />

      {/* Delete confirm dialog */}
      <ConfirmDialog
        open={pendingDeleteId() !== null}
        title={isBatchDelete() ? `Delete ${selectedIds().size} jobs` : "Delete job"}
        message={
          isBatchDelete()
            ? `This will permanently delete ${selectedIds().size} selected jobs, their images, and all bubble data. This cannot be undone.`
            : "This will permanently delete the job, its images, and all bubble data. This cannot be undone."
        }
        confirmLabel="Delete"
        loading={isDeleting()}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDeleteId(null)}
      />
    </div>
  );
}
