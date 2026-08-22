import { createResource, createSignal, For, Show } from "solid-js";
import { BookOpen, FolderPlus, Plus, X } from "lucide-solid";
import {
  createChapter,
  createVolume,
  listChapters,
  listVolumes,
  updateJob,
} from "../api";

interface GroupJobsModalProps {
  open: boolean;
  selectedJobIds: string[];
  onClose: () => void;
  onSuccess: () => void;
}

export function GroupJobsModal(props: GroupJobsModalProps) {
  const [tab, setTab] = createSignal<"new" | "existing">("new");

  // Existing mode form state
  const [selectedChapterId, setSelectedChapterId] = createSignal<number | null>(null);

  // New mode form state
  const [volumeOption, setVolumeOption] = createSignal<"none" | "existing" | "new">("new");
  const [selectedVolumeId, setSelectedVolumeId] = createSignal<number | null>(null);
  const [newVolumeTitle, setNewVolumeTitle] = createSignal("");
  const [chapterTitle, setChapterTitle] = createSignal("");
  const [chapterNumber, setChapterNumber] = createSignal("1");

  // Status state
  const [isSubmitting, setIsSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // Resources
  const [volumes] = createResource(() => props.open || undefined, () => listVolumes());
  const [chapters] = createResource(() => props.open || undefined, () => listChapters());

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    if (props.selectedJobIds.length === 0) return;

    setIsSubmitting(true);
    setError(null);

    try {
      let targetChapterId: number;

      if (tab() === "existing") {
        const chId = selectedChapterId();
        if (!chId) {
          throw new Error("Please select a chapter.");
        }
        targetChapterId = chId;
      } else {
        // Validation for new chapter
        if (!chapterTitle().trim()) {
          throw new Error("Please enter a chapter title.");
        }

        let volId: number | undefined;

        if (volumeOption() === "new") {
          if (!newVolumeTitle().trim()) {
            throw new Error("Please enter a volume title.");
          }
          const createdVol = await createVolume({ title: newVolumeTitle().trim() });
          volId = createdVol.id;
        } else if (volumeOption() === "existing") {
          if (!selectedVolumeId()) {
            throw new Error("Please select an existing volume.");
          }
          volId = selectedVolumeId()!;
        }

        const createdCh = await createChapter({
          title: chapterTitle().trim(),
          chapterNumber: chapterNumber().trim() || "1",
          volumeId: volId,
        });

        targetChapterId = createdCh.id;
      }

      // Assign all selected jobs to the target chapter
      await Promise.all(
        props.selectedJobIds.map((jobId, idx) =>
          updateJob(jobId, { chapterId: targetChapterId, pageOrder: idx + 1 }),
        ),
      );

      // Reset form state
      setNewVolumeTitle("");
      setChapterTitle("");
      setChapterNumber("1");
      setSelectedChapterId(null);
      props.onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to group jobs");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-xs">
        <div
          class="relative w-full max-w-lg overflow-hidden rounded-2xl bg-white p-6 shadow-xl ring-1 ring-slate-900/5"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div class="flex items-center justify-between border-b border-slate-100 pb-4">
            <div class="flex items-center gap-2.5">
              <div class="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-50 text-violet-600">
                <FolderPlus class="h-5 w-5" />
              </div>
              <div>
                <h3 class="font-semibold text-slate-800">
                  Group {props.selectedJobIds.length} Job{props.selectedJobIds.length > 1 ? "s" : ""}
                </h3>
                <p class="text-xs text-slate-500">Create or select a volume/chapter to organize these pages.</p>
              </div>
            </div>
            <button
              onClick={props.onClose}
              class="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            >
              <X class="h-5 w-5" />
            </button>
          </div>

          {/* Error notice */}
          <Show when={error()}>
            {(err) => (
              <div class="mt-4 rounded-xl bg-red-50 p-3 text-xs text-red-600 ring-1 ring-red-200">
                {err()}
              </div>
            )}
          </Show>

          {/* Mode Tabs */}
          <div class="mt-4 flex rounded-xl bg-slate-100 p-1">
            <button
              type="button"
              onClick={() => setTab("new")}
              class={`flex-1 rounded-lg py-1.5 text-xs font-medium transition ${
                tab() === "new" ? "bg-white text-slate-800 shadow-xs" : "text-slate-500 hover:text-slate-700"
              }`}
            >
              Create New Chapter
            </button>
            <button
              type="button"
              onClick={() => setTab("existing")}
              class={`flex-1 rounded-lg py-1.5 text-xs font-medium transition ${
                tab() === "existing" ? "bg-white text-slate-800 shadow-xs" : "text-slate-500 hover:text-slate-700"
              }`}
            >
              Assign to Existing Chapter
            </button>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} class="mt-4 space-y-4">
            <Show when={tab() === "new"}>
              {/* Volume Option */}
              <div>
                <label class="block text-xs font-medium text-slate-700">Volume</label>
                <div class="mt-1 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setVolumeOption("new")}
                    class={`flex-1 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                      volumeOption() === "new"
                        ? "border-violet-500 bg-violet-50 text-violet-700"
                        : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    + New Volume
                  </button>
                  <button
                    type="button"
                    onClick={() => setVolumeOption("existing")}
                    class={`flex-1 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                      volumeOption() === "existing"
                        ? "border-violet-500 bg-violet-50 text-violet-700"
                        : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    Existing Volume
                  </button>
                  <button
                    type="button"
                    onClick={() => setVolumeOption("none")}
                    class={`flex-1 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                      volumeOption() === "none"
                        ? "border-violet-500 bg-violet-50 text-violet-700"
                        : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    No Volume
                  </button>
                </div>
              </div>

              {/* Conditional Volume Fields */}
              <Show when={volumeOption() === "new"}>
                <div>
                  <label class="block text-xs font-medium text-slate-700">New Volume Title</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Volume 1"
                    value={newVolumeTitle()}
                    onInput={(e) => setNewVolumeTitle(e.currentTarget.value)}
                    class="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500"
                  />
                </div>
              </Show>

              <Show when={volumeOption() === "existing"}>
                <div>
                  <label class="block text-xs font-medium text-slate-700">Select Volume</label>
                  <select
                    required
                    value={selectedVolumeId() ?? ""}
                    onChange={(e) => setSelectedVolumeId(Number(e.currentTarget.value) || null)}
                    class="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-violet-500"
                  >
                    <option value="">-- Choose Volume --</option>
                    <For each={volumes() ?? []}>
                      {(v) => <option value={v.id}>{v.title}</option>}
                    </For>
                  </select>
                </div>
              </Show>

              {/* Chapter details */}
              <div class="grid grid-cols-3 gap-3">
                <div class="col-span-1">
                  <label class="block text-xs font-medium text-slate-700">Chapter #</label>
                  <input
                    type="text"
                    required
                    placeholder="1"
                    value={chapterNumber()}
                    onInput={(e) => setChapterNumber(e.currentTarget.value)}
                    class="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-violet-500"
                  />
                </div>
                <div class="col-span-2">
                  <label class="block text-xs font-medium text-slate-700">Chapter Title</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Romance Dawn"
                    value={chapterTitle()}
                    onInput={(e) => setChapterTitle(e.currentTarget.value)}
                    class="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-violet-500"
                  />
                </div>
              </div>
            </Show>

            <Show when={tab() === "existing"}>
              <div>
                <label class="block text-xs font-medium text-slate-700">Select Chapter</label>
                <select
                  required
                  value={selectedChapterId() ?? ""}
                  onChange={(e) => setSelectedChapterId(Number(e.currentTarget.value) || null)}
                  class="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-violet-500"
                >
                  <option value="">-- Choose Chapter --</option>
                  <For each={chapters() ?? []}>
                    {(c) => (
                      <option value={c.id}>
                        Ch. {c.chapterNumber} - {c.title}
                      </option>
                    )}
                  </For>
                </select>
              </div>
            </Show>

            {/* Footer Buttons */}
            <div class="flex items-center justify-end gap-2 pt-4">
              <button
                type="button"
                onClick={props.onClose}
                disabled={isSubmitting()}
                class="rounded-xl px-4 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting()}
                class="inline-flex items-center gap-1.5 rounded-xl bg-violet-600 px-4 py-2 text-xs font-medium text-white shadow-sm hover:bg-violet-700 disabled:opacity-50"
              >
                <Show when={isSubmitting()} fallback={<BookOpen class="h-4 w-4" />}>
                  <div class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                </Show>
                Group & Assign Jobs
              </button>
            </div>
          </form>
        </div>
      </div>
    </Show>
  );
}
