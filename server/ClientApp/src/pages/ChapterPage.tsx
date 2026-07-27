import { createResource, createSignal, For, Show } from "solid-js";
import { useNavigate, useParams } from "@solidjs/router";
import {
  ArrowLeft,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Clock,
  FilePlus,
  Image,
  X,
  XCircle,
} from "lucide-solid";
import {
  getChapterJobs,
  jobOriginalUrl,
  jobResultUrl,
  listChapters,
  listJobs,
  updateJob,
} from "../api";
import type { PageTranslationJob } from "../types";
import { Modal } from "../components/Modal";

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

function StatusDot(props: { status: PageTranslationJob["status"] }) {
  switch (props.status) {
    case "done":
      return <CheckCircle class="h-4 w-4 text-green-500" />;
    case "processing":
      return <Clock class="h-4 w-4 text-yellow-500" />;
    case "error":
      return <XCircle class="h-4 w-4 text-red-500" />;
    default:
      return <Clock class="h-4 w-4 text-slate-400" />;
  }
}

// ---------------------------------------------------------------------------
// Page card
// ---------------------------------------------------------------------------

interface PageCardProps {
  job: PageTranslationJob;
  isFirst: boolean;
  isLast: boolean;
  onMove: (dir: "up" | "down") => void;
  onUnassign: () => void;
  onClick: () => void;
}

function PageCard(props: PageCardProps) {
  const thumbSrc = () =>
    props.job.resultImagePath
      ? jobResultUrl(props.job.id)
      : jobOriginalUrl(props.job.id);

  return (
    <div class="group relative flex flex-col overflow-hidden rounded-2xl bg-white text-left shadow-sm ring-1 ring-slate-200 transition hover:shadow-md hover:ring-slate-300">
      {/* Thumbnail — clicking navigates to studio; must be a div to avoid nested button HTML */}
      <div
        class="relative aspect-3/4 w-full cursor-pointer overflow-hidden bg-slate-100"
        onClick={props.onClick}
        role="button"
        tabindex={0}
        onKeyDown={(e) => e.key === "Enter" && props.onClick()}
        aria-label={`Open ${props.job.title} in studio`}
      >
        <img
          src={thumbSrc()}
          alt={props.job.title}
          class="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
          loading="lazy"
        />
        <span class="absolute left-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-white/90 shadow">
          <StatusDot status={props.job.status} />
        </span>

        {/* Reorder controls (top-right overlay) */}
        <div class="absolute right-2 top-2 flex flex-col gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            class="flex h-6 w-6 items-center justify-center rounded-full bg-white/90 shadow hover:bg-white disabled:cursor-not-allowed disabled:opacity-30"
            disabled={props.isFirst}
            onClick={(e) => { e.stopPropagation(); props.onMove("up"); }}
            title="Move up"
          >
            <ChevronUp class="h-3.5 w-3.5 text-slate-600" />
          </button>
          <button
            class="flex h-6 w-6 items-center justify-center rounded-full bg-white/90 shadow hover:bg-white disabled:cursor-not-allowed disabled:opacity-30"
            disabled={props.isLast}
            onClick={(e) => { e.stopPropagation(); props.onMove("down"); }}
            title="Move down"
          >
            <ChevronDown class="h-3.5 w-3.5 text-slate-600" />
          </button>
        </div>

        {/* Unassign button (bottom-right overlay) */}
        <button
          class="absolute bottom-2 right-2 flex h-6 w-6 items-center justify-center rounded-full bg-red-500/90 text-white shadow opacity-0 transition-opacity group-hover:opacity-100 hover:bg-red-600"
          onClick={(e) => { e.stopPropagation(); props.onUnassign(); }}
          title="Remove from chapter"
        >
          <X class="h-3.5 w-3.5" />
        </button>
      </div>

      <div class="p-3">
        <p class="truncate text-xs font-medium text-slate-700">
          {props.job.title}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chapter page
// ---------------------------------------------------------------------------

export function ChapterPage() {
  const params = useParams<{ chapterId: string }>();
  const navigate = useNavigate();
  const chapterId = () => Number(params.chapterId);

  const [allChapters] = createResource(() => listChapters());
  const chapter = () => allChapters()?.find((c) => c.id === chapterId());

  const [jobs, { refetch: refetchJobs }] = createResource(chapterId, getChapterJobs);

  // ---------------------------------------------------------------------------
  // Assign modal state
  // ---------------------------------------------------------------------------
  const [assignModal, setAssignModal] = createSignal(false);
  const [unassignedJobs, setUnassignedJobs] = createSignal<PageTranslationJob[]>([]);
  const [selectedJobIds, setSelectedJobIds] = createSignal<Set<string>>(new Set<string>());
  const [loadingUnassigned, setLoadingUnassigned] = createSignal(false);
  const [assigning, setAssigning] = createSignal(false);
  const [actionError, setActionError] = createSignal<string | null>(null);

  async function openAssignModal() {
    setLoadingUnassigned(true);
    setActionError(null);
    setSelectedJobIds(new Set<string>());
    setAssignModal(true);
    try {
      // Paginate to collect all unassigned jobs
      const all: PageTranslationJob[] = [];
      let page = 1;
      while (true) {
        const result = await listJobs({ page, pageSize: 200 });
        all.push(...result.items.filter((j) => !j.chapterId));
        if (result.items.length < 200) break;
        page++;
      }
      setUnassignedJobs(all);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to load jobs");
    } finally {
      setLoadingUnassigned(false);
    }
  }

  function toggleJobSelection(id: string) {
    setSelectedJobIds((prev) => {
      const next = new Set<string>(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function assignJobs() {
    setAssigning(true);
    setActionError(null);
    try {
      const ids = [...selectedJobIds()];
      const baseOrder = (jobs()?.length ?? 0);
      await Promise.all(
        ids.map((id, i) => updateJob(id, { chapterId: chapterId(), pageOrder: baseOrder + i })),
      );
      setAssignModal(false);
      setSelectedJobIds(new Set<string>());
      refetchJobs();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to assign pages");
    } finally {
      setAssigning(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Reorder jobs within chapter
  // ---------------------------------------------------------------------------
  async function moveJob(job: PageTranslationJob, dir: "up" | "down") {
    const list = jobs() ?? [];
    const idx = list.findIndex((j) => j.id === job.id);
    const other = dir === "up" ? list[idx - 1] : list[idx + 1];
    if (!other) return;
    setActionError(null);
    try {
      await Promise.all([
        updateJob(job.id, { pageOrder: other.pageOrder }),
        updateJob(other.id, { pageOrder: job.pageOrder }),
      ]);
      refetchJobs();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to reorder pages");
    }
  }

  // ---------------------------------------------------------------------------
  // Unassign job
  // ---------------------------------------------------------------------------
  async function unassignJob(id: string) {
    setActionError(null);
    try {
      // Server treats chapterId: null as unassign; we send null explicitly
      await updateJob(id, { chapterId: null });
      refetchJobs();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to remove page from chapter");
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div class="min-h-screen px-6 py-8">
      {/* Back link */}
      <button
        class="mb-5 flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
        onClick={() => {
          const ch = chapter();
          if (ch?.volumeId) {
            navigate(`/library/${ch.volumeId}`);
          } else {
            navigate("/library");
          }
        }}
      >
        <ArrowLeft class="h-4 w-4" />
        <Show when={chapter()?.volumeId} fallback="Library">
          Volume
        </Show>
      </button>

      {/* Header */}
      <div class="mb-6 flex items-center gap-3">
        <div class="rounded-xl bg-white p-2 shadow-sm ring-1 ring-slate-200">
          <Image class="h-5 w-5 text-violet-600" />
        </div>
        <div class="flex-1 min-w-0">
          <Show
            when={chapter()}
            fallback={
              <div class="h-6 w-48 animate-pulse rounded bg-slate-200" />
            }
          >
            {(ch) => (
              <h1 class="text-xl font-semibold text-slate-800">
                Ch. {ch().chapterNumber} — {ch().title}
              </h1>
            )}
          </Show>
        </div>
        <button
          class="ml-auto flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700"
          onClick={openAssignModal}
        >
          <FilePlus class="h-3.5 w-3.5" /> Add pages
        </button>
      </div>

      {/* Action error banner */}
      <Show when={actionError()}>
        {(msg) => (
          <div class="mb-4 flex items-center gap-2 rounded-xl bg-red-50 px-4 py-2.5 text-sm text-red-700 ring-1 ring-red-200">
            <span class="flex-1">{msg()}</span>
            <button
              onClick={() => setActionError(null)}
              class="shrink-0 rounded p-0.5 hover:bg-red-100"
              aria-label="Dismiss error"
            >
              ✕
            </button>
          </div>
        )}
      </Show>

      {/* Job grid */}
      <Show when={jobs.loading}>
        <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {Array.from({ length: 8 }).map(() => (
            <div class="aspect-3/4 animate-pulse rounded-2xl bg-slate-200" />
          ))}
        </div>
      </Show>

      <Show when={jobs.error}>
        <p class="text-sm text-red-500">Failed to load pages.</p>
      </Show>

      <Show when={!jobs.loading && !jobs.error}>
        <Show
          when={(jobs() ?? []).length > 0}
          fallback={
            <div class="flex flex-col items-center gap-3 py-24 text-slate-400">
              <Image class="h-10 w-10 opacity-40" />
              <p class="text-sm">No pages in this chapter yet.</p>
            </div>
          }
        >
          <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            <For each={jobs()}>
              {(job, idx) => {
                const list = () => jobs() ?? [];
                return (
                  <PageCard
                    job={job}
                    isFirst={idx() === 0}
                    isLast={idx() === list().length - 1}
                    onMove={(dir) => moveJob(job, dir)}
                    onUnassign={() => unassignJob(job.id)}
                    onClick={() => navigate(`/jobs/${job.id}`)}
                  />
                );
              }}
            </For>
          </div>
        </Show>
      </Show>

      {/* ── Assign jobs modal ── */}
      <Modal
        open={assignModal()}
        title="Add Pages to Chapter"
        onClose={() => setAssignModal(false)}
      >
        <div class="flex flex-col gap-3">
          <p class="text-xs text-slate-500">
            Select unassigned jobs to add to this chapter.
          </p>

          <Show when={loadingUnassigned()}>
            <div class="space-y-2">
              {Array.from({ length: 4 }).map(() => (
                <div class="h-14 animate-pulse rounded-lg bg-slate-200" />
              ))}
            </div>
          </Show>

          <Show when={!loadingUnassigned() && unassignedJobs().length === 0}>
            <p class="py-6 text-center text-sm text-slate-400">
              No unassigned pages found.
            </p>
          </Show>

          <Show when={!loadingUnassigned() && unassignedJobs().length > 0}>
            <ul class="max-h-80 overflow-y-auto divide-y divide-slate-100 rounded-lg border border-slate-200">
              <For each={unassignedJobs()}>
                {(job) => {
                  const selected = () => selectedJobIds().has(job.id);
                  return (
                    <li>
                      <label class="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-slate-50">
                        <input
                          type="checkbox"
                          class="h-4 w-4 accent-violet-600"
                          checked={selected()}
                          onChange={() => toggleJobSelection(job.id)}
                        />
                        <img
                          src={jobOriginalUrl(job.id)}
                          alt={job.title}
                          class="h-10 w-8 rounded object-cover bg-slate-100"
                          loading="lazy"
                        />
                        <div class="min-w-0 flex-1">
                          <p class="truncate text-sm font-medium text-slate-800">
                            {job.title}
                          </p>
                          <p class="text-xs text-slate-400">
                            {new Date(job.createdAt).toLocaleDateString()}
                          </p>
                        </div>
                        <StatusDot status={job.status} />
                      </label>
                    </li>
                  );
                }}
              </For>
            </ul>
          </Show>

          <div class="flex justify-end gap-2 pt-1">
            <button
              class="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              onClick={() => setAssignModal(false)}
            >
              Cancel
            </button>
            <button
              class="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
              disabled={assigning() || selectedJobIds().size === 0}
              onClick={assignJobs}
            >
              {assigning()
                ? "Assigning…"
                : `Assign ${selectedJobIds().size > 0 ? selectedJobIds().size : ""} selected`}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
