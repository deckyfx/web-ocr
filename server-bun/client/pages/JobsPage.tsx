import { useState, useRef } from "react";
import { useNavigate } from "react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Upload, Loader2, Trash2, ExternalLink } from "lucide-react";
import { listJobs, deleteJob, submitTranslatePage } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import type { PageTranslationJob } from "../types";

function StatusBadge({ status }: { status: PageTranslationJob["status"] }) {
  const cls = ({
    done: "bg-emerald-900/60 text-emerald-300",
    error: "bg-red-900/60 text-red-300",
    processing: "bg-yellow-900/60 text-yellow-300",
    pending: "bg-gray-800 text-gray-400",
  } as Record<string, string>)[status] ?? "bg-gray-800 text-gray-400";
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cls}`}>{status}</span>;
}

export function JobsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const jobsQ = useQuery({ queryKey: ["jobs"], queryFn: listJobs, refetchInterval: 3000 });
  const jobs = jobsQ.data ?? [];

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteJob(id),
    onSuccess: () => {
      setDeleteTarget(null);
      qc.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: () => {
      setDeleteTarget(null);
    },
  });

  const handleUpload = async (file: File) => {
    setUploading(true);
    setUploadError(null);
    try {
      const base64 = await fileToBase64(file);
      const { job_id } = await submitTranslatePage(base64);
      qc.invalidateQueries({ queryKey: ["jobs"] });
      navigate(`/studio/${job_id}`);
    } catch (err) {
      setUploadError(String(err));
    } finally {
      setUploading(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleUpload(file);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
        <h1 className="text-base font-semibold">Jobs</h1>
        <button
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium
            bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 transition-colors"
        >
          {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
          Upload image
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) handleUpload(file);
          }}
        />
      </div>

      {/* Drop zone / error */}
      {uploadError && (
        <div className="mx-4 mt-3 px-3 py-2 bg-red-900/40 border border-red-800 rounded-lg text-red-300 text-sm">
          {uploadError}
        </div>
      )}

      {/* Drop zone */}
      <div
        className="mx-4 mt-3 border-2 border-dashed border-gray-700 rounded-xl p-6 text-center
          text-gray-500 text-sm cursor-pointer hover:border-gray-500 hover:text-gray-400 transition-colors"
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
        onClick={() => fileRef.current?.click()}
      >
        {uploading ? (
          <span className="flex items-center justify-center gap-2">
            <Loader2 size={16} className="animate-spin" /> Processing…
          </span>
        ) : (
          "Drop an image here or click to upload"
        )}
      </div>

      {/* Jobs list */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {jobsQ.isLoading && (
          <div className="flex items-center justify-center py-12 text-gray-500">
            <Loader2 size={20} className="animate-spin" />
          </div>
        )}
        {!jobsQ.isLoading && jobs.length === 0 && (
          <div className="text-center text-gray-600 py-12 text-sm">
            No jobs yet. Upload an image to get started.
          </div>
        )}
        <div className="grid gap-2">
          {jobs.map((job) => (
            <div
              key={job.id}
              className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-gray-900 border border-gray-800
                hover:border-gray-700 transition-colors cursor-pointer group"
              onClick={() => navigate(`/studio/${job.id}`)}
            >
              {/* Thumbnail */}
              <div className="w-14 h-10 shrink-0 rounded-lg overflow-hidden bg-gray-800">
                <img
                  src={`/api/portal/jobs/${job.id}/original`}
                  alt=""
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
              </div>

              <div className="flex-1 min-w-0">
                <div className="text-sm font-mono text-gray-300 truncate">{job.id.slice(0, 16)}</div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {job.processedBubbles}/{job.totalBubbles} bubbles
                  {" · "}
                  {new Date(job.createdAt).toLocaleDateString()}
                </div>
              </div>

              <StatusBadge status={job.status} />

              <button
                onClick={(e) => { e.stopPropagation(); navigate(`/studio/${job.id}`); }}
                className="p-1.5 text-gray-600 hover:text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <ExternalLink size={14} />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setDeleteTarget(job.id); }}
                className="p-1.5 text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      </div>

      {deleteTarget && (
        <ConfirmDialog
          title="Delete job?"
          message="All job data will be permanently removed."
          confirmLabel="Delete"
          danger
          loading={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
