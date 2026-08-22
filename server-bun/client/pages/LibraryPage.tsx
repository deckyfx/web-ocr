import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, BookOpen, Loader2 } from "lucide-react";
import { listVolumes, createVolume, deleteVolume, listChapters, createChapter, deleteChapter } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";

export function LibraryPage() {
  const qc = useQueryClient();
  const [selectedVolId, setSelectedVolId] = useState<number | null>(null);
  const [deleteVolTarget, setDeleteVolTarget] = useState<number | null>(null);
  const [deleteChapterTarget, setDeleteChapterTarget] = useState<number | null>(null);
  const [newVolTitle, setNewVolTitle] = useState("");
  const [newChapterTitle, setNewChapterTitle] = useState("");
  const [newChapterDir, setNewChapterDir] = useState("");

  const volsQ = useQuery({ queryKey: ["volumes"], queryFn: listVolumes });
  const chaptersQ = useQuery({
    queryKey: ["chapters", selectedVolId],
    queryFn: () => listChapters(selectedVolId ?? undefined),
    enabled: selectedVolId !== null,
  });

  const createVolMutation = useMutation({
    mutationFn: () => createVolume({ title: newVolTitle }),
    onSuccess: () => { setNewVolTitle(""); qc.invalidateQueries({ queryKey: ["volumes"] }); },
  });

  const deleteVolMutation = useMutation({
    mutationFn: (id: number) => deleteVolume(id),
    onSuccess: (_, id) => {
      setDeleteVolTarget(null);
      if (selectedVolId === id) setSelectedVolId(null);
      qc.invalidateQueries({ queryKey: ["volumes"] });
      qc.invalidateQueries({ queryKey: ["chapters", id] });
    },
  });

  const createChapterMutation = useMutation({
    mutationFn: () => createChapter({
      volumeId: selectedVolId!,
      title: newChapterTitle,
      pagesDir: newChapterDir,
      sortOrder: 0,
    }),
    onSuccess: () => {
      setNewChapterTitle(""); setNewChapterDir("");
      qc.invalidateQueries({ queryKey: ["chapters", selectedVolId] });
    },
  });

  const deleteChapterMutation = useMutation({
    mutationFn: (id: number) => deleteChapter(id),
    onSuccess: () => { setDeleteChapterTarget(null); qc.invalidateQueries({ queryKey: ["chapters", selectedVolId] }); },
  });

  const vols = volsQ.data ?? [];
  const chapters = chaptersQ.data ?? [];

  return (
    <div className="flex h-full">
      {/* Volumes column */}
      <div className="w-64 shrink-0 border-r border-gray-800 flex flex-col">
        <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
          <h2 className="text-sm font-semibold">Volumes</h2>
        </div>

        <div className="flex-1 overflow-y-auto">
          {volsQ.isLoading && (
            <div className="flex justify-center py-8"><Loader2 size={16} className="animate-spin text-gray-500" /></div>
          )}
          {vols.map((vol) => (
            <div
              key={vol.id}
              role="button"
              tabIndex={0}
              onClick={() => setSelectedVolId(vol.id === selectedVolId ? null : vol.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ")
                  setSelectedVolId(vol.id === selectedVolId ? null : vol.id);
              }}
              className={`w-full flex items-center gap-2 px-3 py-2.5 text-sm text-left border-b border-gray-800/50 transition-colors group cursor-pointer ${
                vol.id === selectedVolId ? "bg-indigo-600/20 text-indigo-300" : "text-gray-300 hover:bg-gray-800"
              }`}
            >
              <BookOpen size={13} className="shrink-0 text-gray-500" />
              <span className="flex-1 truncate">{vol.title}</span>
              <button
                onClick={(e) => { e.stopPropagation(); setDeleteVolTarget(vol.id); }}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") e.stopPropagation(); }}
                className="p-1 opacity-0 group-hover:opacity-100 text-gray-600 hover:text-red-400 transition-opacity"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>

        {/* Add volume */}
        <div className="p-2 border-t border-gray-800 flex gap-1.5">
          <input
            className="flex-1 bg-gray-800 rounded-lg px-2 py-1.5 text-xs text-gray-200 placeholder-gray-600 outline-none focus:ring-1 focus:ring-indigo-500"
            placeholder="New volume…"
            value={newVolTitle}
            onChange={(e) => setNewVolTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && newVolTitle.trim() && createVolMutation.mutate()}
          />
          <button
            onClick={() => newVolTitle.trim() && createVolMutation.mutate()}
            disabled={createVolMutation.isPending || !newVolTitle.trim()}
            className="p-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40"
          >
            <Plus size={13} />
          </button>
        </div>
      </div>

      {/* Chapters column */}
      <div className="flex-1 flex flex-col min-w-0">
        {selectedVolId === null ? (
          <div className="flex items-center justify-center h-full text-gray-600 text-sm">
            Select a volume to view chapters
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
              <h2 className="text-sm font-semibold">
                Chapters — {vols.find((v) => v.id === selectedVolId)?.title}
              </h2>
            </div>

            <div className="flex-1 overflow-y-auto px-3 py-2 flex flex-col gap-1.5">
              {chaptersQ.isLoading && (
                <div className="flex justify-center py-8"><Loader2 size={16} className="animate-spin text-gray-500" /></div>
              )}
              {chapters.map((ch) => (
                <div
                  key={ch.id}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-900 border border-gray-800 text-sm group"
                >
                  <span className="flex-1 text-gray-300">{ch.title}</span>
                  <span className="text-xs text-gray-600 font-mono truncate max-w-[8rem]">{ch.pagesDir}</span>
                  <button
                    onClick={() => setDeleteChapterTarget(ch.id)}
                    className="p-1 opacity-0 group-hover:opacity-100 text-gray-600 hover:text-red-400 transition-opacity"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
              {!chaptersQ.isLoading && chapters.length === 0 && (
                <div className="text-gray-600 text-sm text-center py-8">No chapters yet</div>
              )}
            </div>

            {/* Add chapter */}
            <div className="p-2 border-t border-gray-800 flex gap-1.5">
              <input
                className="flex-1 bg-gray-800 rounded-lg px-2 py-1.5 text-xs text-gray-200 placeholder-gray-600 outline-none focus:ring-1 focus:ring-indigo-500"
                placeholder="Chapter title…"
                value={newChapterTitle}
                onChange={(e) => setNewChapterTitle(e.target.value)}
              />
              <input
                className="w-32 bg-gray-800 rounded-lg px-2 py-1.5 text-xs text-gray-200 placeholder-gray-600 outline-none focus:ring-1 focus:ring-indigo-500"
                placeholder="Pages dir…"
                value={newChapterDir}
                onChange={(e) => setNewChapterDir(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && newChapterTitle.trim() && createChapterMutation.mutate()}
              />
              <button
                onClick={() => newChapterTitle.trim() && createChapterMutation.mutate()}
                disabled={createChapterMutation.isPending || !newChapterTitle.trim()}
                className="p-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40"
              >
                <Plus size={13} />
              </button>
            </div>
          </>
        )}
      </div>

      {deleteVolTarget !== null && (
        <ConfirmDialog
          title="Delete volume?"
          message="All chapters linked to this volume will be permanently removed."
          confirmLabel="Delete"
          danger
          loading={deleteVolMutation.isPending}
          onConfirm={() => deleteVolMutation.mutate(deleteVolTarget)}
          onCancel={() => setDeleteVolTarget(null)}
        />
      )}
      {deleteChapterTarget !== null && (
        <ConfirmDialog
          title="Delete chapter?"
          message="The chapter will be deleted."
          confirmLabel="Delete"
          danger
          loading={deleteChapterMutation.isPending}
          onConfirm={() => deleteChapterMutation.mutate(deleteChapterTarget)}
          onCancel={() => setDeleteChapterTarget(null)}
        />
      )}
    </div>
  );
}
