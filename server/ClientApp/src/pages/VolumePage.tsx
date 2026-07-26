import { createResource, createSignal, For, Show } from "solid-js";
import { useNavigate, useParams } from "@solidjs/router";
import {
  ArrowLeft,
  BookOpen,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Edit2,
  FileText,
  Plus,
  Trash2,
} from "lucide-solid";
import {
  createChapter,
  deleteChapter,
  deleteVolume,
  listChapters,
  listVolumes,
  updateChapter,
  updateVolume,
} from "../api";
import type { Chapter } from "../types";
import { Modal } from "../components/Modal";
import { ConfirmDialog } from "../components/ConfirmDialog";

export function VolumePage() {
  const params = useParams<{ volumeId: string }>();
  const navigate = useNavigate();
  const volumeId = () => Number(params.volumeId);

  const [volumes, { refetch: refetchVolumes }] = createResource(listVolumes);
  const volume = () => volumes()?.find((v) => v.id === volumeId());

  const [chapters, { refetch: refetchChapters }] = createResource(volumeId, (id) =>
    listChapters({ volumeId: id }),
  );

  // ---------------------------------------------------------------------------
  // Volume edit modal state
  // ---------------------------------------------------------------------------
  const [editVolumeOpen, setEditVolumeOpen] = createSignal(false);
  const [volTitle, setVolTitle] = createSignal("");
  const [volSynopsis, setVolSynopsis] = createSignal("");
  const [savingVol, setSavingVol] = createSignal(false);
  const [mutationError, setMutationError] = createSignal<string | null>(null);

  function openEditVolume() {
    const v = volume();
    if (!v) return;
    setVolTitle(v.title);
    setVolSynopsis(v.synopsis ?? "");
    setEditVolumeOpen(true);
  }

  async function saveVolume() {
    setSavingVol(true);
    setMutationError(null);
    try {
      await updateVolume(volumeId(), { title: volTitle(), synopsis: volSynopsis() || undefined });
      setEditVolumeOpen(false);
      refetchVolumes();
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingVol(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Volume delete confirm
  // ---------------------------------------------------------------------------
  const [deleteVolumeOpen, setDeleteVolumeOpen] = createSignal(false);

  async function confirmDeleteVolume() {
    setMutationError(null);
    try {
      await deleteVolume(volumeId());
      setDeleteVolumeOpen(false);
      navigate("/library");
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : String(err));
      setDeleteVolumeOpen(false);
    }
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
  const [saving, setSaving] = createSignal(false);

  function openCreateChapter() {
    setChTitle("");
    setChNumber("");
    setChapterModal({ mode: "create" });
  }

  function openEditChapter(ch: Chapter) {
    setChTitle(ch.title);
    setChNumber(ch.chapterNumber);
    setChapterModal({ mode: "edit", ch });
  }

  async function saveChapter() {
    setSaving(true);
    setMutationError(null);
    try {
      const m = chapterModal();
      if (!m) return;
      if (m.mode === "create") {
        await createChapter({ title: chTitle(), chapterNumber: chNumber(), volumeId: volumeId() });
      } else {
        await updateChapter(m.ch!.id, { title: chTitle(), chapterNumber: chNumber() });
      }
      setChapterModal(null);
      refetchChapters();
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Chapter delete confirm
  // ---------------------------------------------------------------------------
  const [deleteTarget, setDeleteTarget] = createSignal<Chapter | null>(null);

  async function confirmDeleteChapter() {
    setMutationError(null);
    try {
      const ch = deleteTarget();
      if (!ch) return;
      await deleteChapter(ch.id);
      setDeleteTarget(null);
      refetchChapters();
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : String(err));
      setDeleteTarget(null);
    }
  }

  // ---------------------------------------------------------------------------
  // Reorder chapters
  // ---------------------------------------------------------------------------
  async function moveChapter(ch: Chapter, dir: "up" | "down") {
    setMutationError(null);
    try {
      const list = chapters() ?? [];
      const idx = list.findIndex((c) => c.id === ch.id);
      const other = dir === "up" ? list[idx - 1] : list[idx + 1];
      if (!other) return;
      await Promise.all([
        updateChapter(ch.id, { sortOrder: other.sortOrder }),
        updateChapter(other.id, { sortOrder: ch.sortOrder }),
      ]);
      refetchChapters();
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : String(err));
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
      {/* Back link */}
      <button
        class="mb-5 flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
        onClick={() => navigate("/library")}
      >
        <ArrowLeft class="h-4 w-4" /> Library
      </button>

      {/* Header */}
      <div class="mb-6 flex items-center gap-3">
        <div class="rounded-xl bg-white p-2 shadow-sm ring-1 ring-slate-200">
          <BookOpen class="h-5 w-5 text-violet-600" />
        </div>
        <div class="flex-1 min-w-0">
          <Show
            when={volume()}
            fallback={
              <div class="h-6 w-48 animate-pulse rounded bg-slate-200" />
            }
          >
            {(v) => (
              <>
                <h1 class="text-xl font-semibold text-slate-800">{v().title}</h1>
                <Show when={v().synopsis}>
                  <p class="text-sm text-slate-500">{v().synopsis}</p>
                </Show>
              </>
            )}
          </Show>
        </div>
        <div class="flex items-center gap-2">
          <button
            class="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            title="Edit volume"
            onClick={openEditVolume}
          >
            <Edit2 class="h-4 w-4" />
          </button>
          <button
            class="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-500"
            title="Delete volume"
            onClick={() => setDeleteVolumeOpen(true)}
          >
            <Trash2 class="h-4 w-4" />
          </button>
          <button
            class="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700"
            onClick={openCreateChapter}
          >
            <Plus class="h-3.5 w-3.5" /> Add Chapter
          </button>
        </div>
      </div>

      {/* Chapter list */}
      <Show when={chapters.loading}>
        <div class="space-y-2">
          {Array.from({ length: 4 }).map(() => (
            <div class="h-14 animate-pulse rounded-xl bg-slate-200" />
          ))}
        </div>
      </Show>

      <Show when={chapters.error}>
        <p class="text-sm text-red-500">Failed to load chapters.</p>
      </Show>

      <Show when={!chapters.loading && !chapters.error}>
        <Show
          when={(chapters() ?? []).length > 0}
          fallback={
            <div class="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-slate-300 py-20 text-slate-400">
              <FileText class="h-8 w-8 opacity-40" />
              <p class="text-sm">No chapters yet. Add the first one.</p>
            </div>
          }
        >
          <ul class="divide-y divide-slate-100 rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
            <For each={chapters()}>
              {(ch, idx) => {
                const list = () => chapters() ?? [];
                const isFirst = () => idx() === 0;
                const isLast = () => idx() === list().length - 1;

                return (
                  <li class="group flex items-center">
                    {/* Reorder buttons */}
                    <div class="flex flex-col items-center px-2">
                      <button
                        class="rounded p-0.5 text-slate-300 hover:bg-slate-100 hover:text-slate-500 disabled:cursor-not-allowed disabled:opacity-30"
                        disabled={isFirst()}
                        onClick={() => moveChapter(ch, "up")}
                      >
                        <ChevronUp class="h-3.5 w-3.5" />
                      </button>
                      <button
                        class="rounded p-0.5 text-slate-300 hover:bg-slate-100 hover:text-slate-500 disabled:cursor-not-allowed disabled:opacity-30"
                        disabled={isLast()}
                        onClick={() => moveChapter(ch, "down")}
                      >
                        <ChevronDown class="h-3.5 w-3.5" />
                      </button>
                    </div>

                    {/* Main row — clicking navigates */}
                    <button
                      class="flex flex-1 items-center gap-4 py-4 pr-4 text-left transition hover:bg-slate-50"
                      onClick={() => navigate(`/library/chapters/${ch.id}`)}
                    >
                      <span class="w-16 shrink-0 rounded-lg bg-slate-100 px-2 py-1 text-center text-xs font-mono text-slate-600">
                        {ch.chapterNumber}
                      </span>
                      <span class="flex-1 text-sm font-medium text-slate-800">
                        {ch.title}
                      </span>
                      <span class="text-xs text-slate-400">
                        {ch.pageCount ?? 0} pages
                      </span>
                      <ChevronRight class="h-4 w-4 text-slate-300" />
                    </button>

                    {/* Action buttons */}
                    <div class="flex shrink-0 gap-1 px-2 opacity-0 transition-opacity group-hover:opacity-100">
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
                        onClick={() => setDeleteTarget(ch)}
                      >
                        <Trash2 class="h-3.5 w-3.5 text-red-400" />
                      </button>
                    </div>
                  </li>
                );
              }}
            </For>
          </ul>
        </Show>
      </Show>

      {/* ── Edit volume modal ── */}
      <Modal
        open={editVolumeOpen()}
        title="Edit Volume"
        onClose={() => setEditVolumeOpen(false)}
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
            />
          </div>
          <div class="flex justify-end gap-2">
            <button
              class="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              onClick={() => setEditVolumeOpen(false)}
            >
              Cancel
            </button>
            <button
              class="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
              disabled={savingVol() || !volTitle().trim()}
              onClick={saveVolume}
            >
              {savingVol() ? "Saving…" : "Save"}
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
        open={deleteVolumeOpen()}
        title="Delete Volume"
        message={`Delete "${volume()?.title}"? This will not delete the chapters — they will just be ungrouped.`}
        onConfirm={confirmDeleteVolume}
        onCancel={() => setDeleteVolumeOpen(false)}
      />

      {/* ── Delete chapter confirm ── */}
      <ConfirmDialog
        open={deleteTarget() !== null}
        title="Delete Chapter"
        message={`Delete "${deleteTarget()?.title}"? This cannot be undone.`}
        onConfirm={confirmDeleteChapter}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
