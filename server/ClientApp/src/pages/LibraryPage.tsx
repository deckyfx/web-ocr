import { createResource, createSignal, For, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import {
  BookOpen,
  ChevronRight,
  Edit2,
  FolderOpen,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-solid";
import {
  createChapter,
  createVolume,
  deleteChapter,
  deleteVolume,
  listChapters,
  listVolumes,
  updateChapter,
  updateVolume,
} from "../api";
import type { Chapter, Volume } from "../types";
import { Modal } from "../components/Modal";
import { ConfirmDialog } from "../components/ConfirmDialog";

export function LibraryPage() {
  const navigate = useNavigate();

  const [volumes, { refetch: refetchVolumes }] = createResource(listVolumes);
  const [allChapters, { refetch: refetchChapters }] = createResource(() => listChapters());

  const unassigned = () => (allChapters() ?? []).filter((c) => !c.volumeId);

  // ---------------------------------------------------------------------------
  // Volume modal state
  // ---------------------------------------------------------------------------
  const [volumeModal, setVolumeModal] = createSignal<{
    mode: "create" | "edit";
    vol?: Volume;
  } | null>(null);
  const [volTitle, setVolTitle] = createSignal("");
  const [volSynopsis, setVolSynopsis] = createSignal("");

  function openCreateVolume() {
    setVolTitle("");
    setVolSynopsis("");
    setVolumeModal({ mode: "create" });
  }

  function openEditVolume(vol: Volume) {
    setVolTitle(vol.title);
    setVolSynopsis(vol.synopsis ?? "");
    setVolumeModal({ mode: "edit", vol });
  }

  // ---------------------------------------------------------------------------
  // Chapter modal state
  // ---------------------------------------------------------------------------
  const [chapterModal, setChapterModal] = createSignal<{
    mode: "create" | "edit";
    ch?: Chapter;
  } | null>(null);
  const [chTitle, setChTitle] = createSignal("");
  const [chNumber, setChNumber] = createSignal("");
  const [chVolumeId, setChVolumeId] = createSignal<number | undefined>(undefined);

  function openCreateChapter() {
    setChTitle("");
    setChNumber("");
    setChVolumeId(undefined);
    setChapterModal({ mode: "create" });
  }

  function openEditChapter(ch: Chapter) {
    setChTitle(ch.title);
    setChNumber(ch.chapterNumber);
    setChVolumeId(ch.volumeId);
    setChapterModal({ mode: "edit", ch });
  }

  // ---------------------------------------------------------------------------
  // Delete confirm state
  // ---------------------------------------------------------------------------
  const [deleteVolumeTarget, setDeleteVolumeTarget] = createSignal<Volume | null>(null);
  const [deleteChapterTarget, setDeleteChapterTarget] = createSignal<Chapter | null>(null);

  // ---------------------------------------------------------------------------
  // Saving / error state
  // ---------------------------------------------------------------------------
  const [saving, setSaving] = createSignal(false);
  const [mutationError, setMutationError] = createSignal<string | null>(null);

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  async function saveVolume() {
    setSaving(true);
    setMutationError(null);
    try {
      const m = volumeModal();
      if (!m) return;
      if (m.mode === "create") {
        await createVolume({ title: volTitle(), synopsis: volSynopsis() || undefined });
      } else {
        await updateVolume(m.vol!.id, { title: volTitle(), synopsis: volSynopsis() || undefined });
      }
      setVolumeModal(null);
      refetchVolumes();
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function confirmDeleteVolume() {
    setMutationError(null);
    try {
      const vol = deleteVolumeTarget();
      if (!vol) return;
      await deleteVolume(vol.id);
      setDeleteVolumeTarget(null);
      refetchVolumes();
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : String(err));
      setDeleteVolumeTarget(null);
    }
  }

  async function saveChapter() {
    setSaving(true);
    setMutationError(null);
    try {
      const m = chapterModal();
      if (!m) return;
      if (m.mode === "create") {
        await createChapter({ title: chTitle(), chapterNumber: chNumber(), volumeId: chVolumeId() });
      } else {
        await updateChapter(m.ch!.id, { title: chTitle(), chapterNumber: chNumber(), volumeId: chVolumeId() ?? null });
      }
      setChapterModal(null);
      refetchChapters();
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function confirmDeleteChapter() {
    setMutationError(null);
    try {
      const ch = deleteChapterTarget();
      if (!ch) return;
      await deleteChapter(ch.id);
      setDeleteChapterTarget(null);
      refetchChapters();
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : String(err));
      setDeleteChapterTarget(null);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div class="min-h-screen px-6 py-8">
      {/* Mutation error banner */}
      <Show when={mutationError()}>
        <div class="mb-4 flex items-center justify-between rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-200">
          <span>{mutationError()}</span>
          <button class="ml-4 text-red-400 hover:text-red-600" onClick={() => setMutationError(null)}>✕</button>
        </div>
      </Show>
      {/* Header */}
      <div class="mb-6 flex items-center gap-3">
        <div class="rounded-xl bg-white p-2 shadow-sm ring-1 ring-slate-200">
          <BookOpen class="h-5 w-5 text-violet-600" />
        </div>
        <h1 class="text-xl font-semibold text-slate-800">Library</h1>
        <div class="ml-auto flex gap-2">
          <button
            class="rounded-lg p-1.5 text-slate-400 hover:bg-white hover:text-slate-600 hover:shadow-sm hover:ring-1 hover:ring-slate-200"
            title="Refresh"
            disabled={volumes.loading || allChapters.loading}
            onClick={() => { refetchVolumes(); refetchChapters(); }}
          >
            <RefreshCw class={`h-4 w-4 ${volumes.loading || allChapters.loading ? "animate-spin" : ""}`} />
          </button>
          <button
            class="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700"
            onClick={openCreateVolume}
          >
            <Plus class="h-3.5 w-3.5" /> New Volume
          </button>
          <button
            class="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
            onClick={openCreateChapter}
          >
            <Plus class="h-3.5 w-3.5" /> New Chapter
          </button>
        </div>
      </div>

      {/* Volumes section */}
      <section class="mb-10">
        <h2 class="mb-3 text-sm font-semibold text-slate-600">Volumes</h2>

        <Show when={volumes.loading}>
          <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 4 }).map(() => (
              <div class="h-32 animate-pulse rounded-2xl bg-slate-200" />
            ))}
          </div>
        </Show>

        <Show when={volumes.error}>
          <p class="text-sm text-red-500">Failed to load volumes.</p>
        </Show>

        <Show when={!volumes.loading && !volumes.error}>
          <Show
            when={(volumes() ?? []).length > 0}
            fallback={
              <div class="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-slate-300 py-16 text-slate-400">
                <FolderOpen class="h-8 w-8 opacity-40" />
                <p class="text-sm">No volumes yet.</p>
              </div>
            }
          >
            <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              <For each={volumes()}>
                {(vol) => (
                  <div class="group relative flex flex-col gap-2 rounded-2xl bg-white p-4 text-left shadow-sm ring-1 ring-slate-200 transition hover:shadow-md hover:ring-slate-300">
                    {/* Action buttons (appear on hover) */}
                    <div class="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        class="rounded-lg bg-white p-1.5 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
                        title="Edit volume"
                        onClick={(e) => {
                          e.stopPropagation();
                          openEditVolume(vol);
                        }}
                      >
                        <Edit2 class="h-3.5 w-3.5 text-slate-500" />
                      </button>
                      <button
                        class="rounded-lg bg-white p-1.5 shadow-sm ring-1 ring-slate-200 hover:bg-red-50"
                        title="Delete volume"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteVolumeTarget(vol);
                        }}
                      >
                        <Trash2 class="h-3.5 w-3.5 text-red-400" />
                      </button>
                    </div>

                    {/* Card body — clicking navigates */}
                    <button
                      class="flex flex-col gap-2 text-left"
                      onClick={() => navigate(`/library/${vol.id}`)}
                    >
                      <div class="flex h-12 w-12 items-center justify-center rounded-xl bg-violet-50">
                        <BookOpen class="h-6 w-6 text-violet-500" />
                      </div>
                      <div class="min-w-0 pr-10">
                        <p class="truncate text-sm font-semibold text-slate-800">
                          {vol.title}
                        </p>
                        <p class="text-xs text-slate-500">
                          {vol.chapterCount ?? 0} chapters
                        </p>
                      </div>
                      <ChevronRight class="ml-auto h-4 w-4 shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-slate-500" />
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </section>

      {/* Standalone chapters section */}
      <section>
        <h2 class="mb-3 text-sm font-semibold text-slate-600">
          Standalone Chapters
        </h2>

        <Show when={allChapters.loading}>
          <div class="space-y-2">
            {Array.from({ length: 3 }).map(() => (
              <div class="h-12 animate-pulse rounded-xl bg-slate-200" />
            ))}
          </div>
        </Show>

        <Show when={!allChapters.loading}>
          <Show
            when={unassigned().length > 0}
            fallback={
              <div class="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-slate-300 py-12 text-slate-400">
                <p class="text-sm">No standalone chapters.</p>
              </div>
            }
          >
            <ul class="divide-y divide-slate-100 rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
              <For each={unassigned()}>
                {(ch) => (
                  <li class="group flex items-center">
                    <button
                      class="flex flex-1 items-center gap-4 px-5 py-3.5 text-left transition hover:bg-slate-50"
                      onClick={() => navigate(`/library/chapters/${ch.id}`)}
                    >
                      <span class="w-14 shrink-0 text-right text-xs font-mono text-slate-400">
                        #{ch.chapterNumber}
                      </span>
                      <span class="flex-1 text-sm font-medium text-slate-800">
                        {ch.title}
                      </span>
                      <span class="text-xs text-slate-400">
                        {ch.pageCount ?? 0} pages
                      </span>
                      <ChevronRight class="h-4 w-4 text-slate-300" />
                    </button>
                    {/* Row action buttons */}
                    <div class="flex shrink-0 gap-1 px-3 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        class="rounded-lg p-1.5 hover:bg-slate-100"
                        title="Edit chapter"
                        onClick={() => openEditChapter(ch)}
                      >
                        <Edit2 class="h-3.5 w-3.5 text-slate-500" />
                      </button>
                      <button
                        class="rounded-lg p-1.5 hover:bg-red-50"
                        title="Delete chapter"
                        onClick={() => setDeleteChapterTarget(ch)}
                      >
                        <Trash2 class="h-3.5 w-3.5 text-red-400" />
                      </button>
                    </div>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </section>

      {/* ── Volume modal ── */}
      <Modal
        open={volumeModal() !== null}
        title={volumeModal()?.mode === "create" ? "New Volume" : "Edit Volume"}
        onClose={() => setVolumeModal(null)}
      >
        <div class="flex flex-col gap-4">
          <div>
            <label class="block text-xs font-medium text-slate-600 mb-1">
              Title
            </label>
            <input
              class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
              value={volTitle()}
              onInput={(e) => setVolTitle(e.currentTarget.value)}
              placeholder="Volume title"
            />
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-600 mb-1">
              Synopsis (optional)
            </label>
            <textarea
              class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
              rows={3}
              value={volSynopsis()}
              onInput={(e) => setVolSynopsis(e.currentTarget.value)}
              placeholder="Brief description…"
            />
          </div>
          <div class="flex justify-end gap-2">
            <button
              class="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              onClick={() => setVolumeModal(null)}
            >
              Cancel
            </button>
            <button
              class="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
              disabled={saving() || !volTitle().trim()}
              onClick={saveVolume}
            >
              {saving() ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </Modal>

      {/* ── Chapter modal ── */}
      <Modal
        open={chapterModal() !== null}
        title={chapterModal()?.mode === "create" ? "New Chapter" : "Edit Chapter"}
        onClose={() => setChapterModal(null)}
      >
        <div class="flex flex-col gap-4">
          <div>
            <label class="block text-xs font-medium text-slate-600 mb-1">
              Title
            </label>
            <input
              class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
              value={chTitle()}
              onInput={(e) => setChTitle(e.currentTarget.value)}
              placeholder="Chapter title"
            />
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-600 mb-1">
              Chapter Number
            </label>
            <input
              class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
              value={chNumber()}
              onInput={(e) => setChNumber(e.currentTarget.value)}
              placeholder="e.g. 1 or 1.5"
            />
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-600 mb-1">
              Volume (optional)
            </label>
            <select
              class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
              value={chVolumeId() ?? ""}
              onChange={(e) => {
                const val = e.currentTarget.value;
                setChVolumeId(val ? Number(val) : undefined);
              }}
            >
              <option value="">No volume / Standalone</option>
              <For each={volumes() ?? []}>
                {(v) => <option value={v.id}>{v.title}</option>}
              </For>
            </select>
          </div>
          <div class="flex justify-end gap-2">
            <button
              class="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              onClick={() => setChapterModal(null)}
            >
              Cancel
            </button>
            <button
              class="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
              disabled={saving() || !chTitle().trim() || !chNumber().trim()}
              onClick={saveChapter}
            >
              {saving() ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </Modal>

      {/* ── Delete volume confirm ── */}
      <ConfirmDialog
        open={deleteVolumeTarget() !== null}
        title="Delete Volume"
        message={`Delete "${deleteVolumeTarget()?.title}"? Chapters inside will be ungrouped but not deleted.`}
        onConfirm={confirmDeleteVolume}
        onCancel={() => setDeleteVolumeTarget(null)}
      />

      {/* ── Delete chapter confirm ── */}
      <ConfirmDialog
        open={deleteChapterTarget() !== null}
        title="Delete Chapter"
        message={`Delete "${deleteChapterTarget()?.title}"? This cannot be undone.`}
        onConfirm={confirmDeleteChapter}
        onCancel={() => setDeleteChapterTarget(null)}
      />
    </div>
  );
}
