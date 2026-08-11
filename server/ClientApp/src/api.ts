import type {
  Chapter,
  PageTranslationJob,
  PaginatedResult,
  TranslationBubble,
  Volume,
} from "./types";

// ---------------------------------------------------------------------------
// Key-case conversion
// ---------------------------------------------------------------------------

/** Convert snake_case string to camelCase. */
function toCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Convert camelCase string to snake_case. */
function toSnake(s: string): string {
  return s.replace(/([A-Z])/g, (c) => `_${c.toLowerCase()}`);
}

/** Recursively convert all object keys from snake_case to camelCase. */
function camelizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(camelizeKeys);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[toCamel(k)] = camelizeKeys(v);
    }
    return out;
  }
  return value;
}

/** Recursively convert all object keys from camelCase to snake_case (for request bodies). */
function snakelizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(snakelizeKeys);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[toSnake(k)] = snakelizeKeys(v);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Core fetch helper
// ---------------------------------------------------------------------------

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`API ${res.status}: ${text}`);
  }
  if (res.status === 204) {
    return undefined as unknown as T;
  }
  const json: unknown = await res.json();
  return camelizeKeys(json) as T;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export interface ListJobsParams {
  page?: number;
  pageSize?: number;
  status?: string;
  chapterId?: number;
}

export function listJobs(params: ListJobsParams = {}): Promise<PaginatedResult<PageTranslationJob>> {
  const qs = new URLSearchParams();
  if (params.page !== undefined) qs.set("page", String(params.page));
  if (params.pageSize !== undefined) qs.set("page_size", String(params.pageSize));
  if (params.status) qs.set("status", params.status);
  if (params.chapterId !== undefined) qs.set("chapter_id", String(params.chapterId));
  const query = qs.toString();
  return apiFetch<PaginatedResult<PageTranslationJob>>(
    `/api/portal/jobs${query ? `?${query}` : ""}`,
  );
}

export function getJob(id: string): Promise<PageTranslationJob> {
  return apiFetch<PageTranslationJob>(`/api/portal/jobs/${id}`);
}

export function deleteJob(id: string): Promise<void> {
  return apiFetch<void>(`/api/portal/jobs/${id}`, { method: "DELETE" });
}

export interface UpdateJobBody {
  title?: string;
  chapterId?: number | null;
  pageOrder?: number;
}

export function updateJob(id: string, body: UpdateJobBody): Promise<PageTranslationJob> {
  return apiFetch<PageTranslationJob>(`/api/portal/jobs/${id}`, {
    method: "PUT",
    body: JSON.stringify(snakelizeKeys(body)),
  });
}

// ---------------------------------------------------------------------------
// Bubbles
// ---------------------------------------------------------------------------

export function getJobBubbles(id: string): Promise<TranslationBubble[]> {
  return apiFetch<TranslationBubble[]>(`/api/portal/jobs/${id}/bubbles`);
}

export interface AddBubbleBody {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function addBubble(id: string, body: AddBubbleBody): Promise<TranslationBubble> {
  return apiFetch<TranslationBubble>(`/api/portal/jobs/${id}/bubbles`, {
    method: "POST",
    body: JSON.stringify(snakelizeKeys(body)),
  });
}

export type UpdateBubbleBody = Partial<{
  sourceText: string;
  translatedText: string;
  bubbleX: number;
  bubbleY: number;
  bubbleW: number;
  bubbleH: number;
  isExcluded: boolean;
  fontFamily: string;
  fontSizeOverride: number;
  fontColor: string;
  strokeColor: string;
  strokeWidth: number;
  rotation: number;
  textAlign: "left" | "center" | "right";
}>;

export function updateBubble(
  jobId: string,
  bubbleIndex: number,
  body: UpdateBubbleBody,
): Promise<TranslationBubble> {
  return apiFetch<TranslationBubble>(
    `/api/portal/jobs/${jobId}/bubbles/${bubbleIndex}`,
    { method: "PUT", body: JSON.stringify(snakelizeKeys(body)) },
  );
}

export function deleteBubble(jobId: string, bubbleIndex: number): Promise<void> {
  return apiFetch<void>(`/api/portal/jobs/${jobId}/bubbles/${bubbleIndex}`, {
    method: "DELETE",
  });
}

// ---------------------------------------------------------------------------
// Job actions
// ---------------------------------------------------------------------------

export function redetectJob(id: string): Promise<void> {
  return apiFetch<void>(`/api/portal/jobs/${id}/redetect`, { method: "POST" });
}

export function retranslateJob(id: string): Promise<void> {
  return apiFetch<void>(`/api/portal/jobs/${id}/retranslate`, { method: "POST" });
}

export function reocrJob(id: string): Promise<void> {
  return apiFetch<void>(`/api/portal/jobs/${id}/reocr`, { method: "POST" });
}

export function translateJob(id: string): Promise<void> {
  return apiFetch<void>(`/api/portal/jobs/${id}/translate`, { method: "POST" });
}

export function inpaintJob(id: string): Promise<void> {
  return apiFetch<void>(`/api/portal/jobs/${id}/inpaint`, { method: "POST" });
}

export function rerenderJob(id: string, padding = 0): Promise<void> {
  return apiFetch<void>(`/api/portal/jobs/${id}/rerender`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ padding }),
  });
}

export function reocrBubble(jobId: string, bubbleIndex: number): Promise<TranslationBubble> {
  return apiFetch<TranslationBubble>(
    `/api/portal/jobs/${jobId}/bubbles/${bubbleIndex}/reocr`,
    { method: "POST" },
  );
}

export function retranslateBubble(jobId: string, bubbleIndex: number): Promise<TranslationBubble> {
  return apiFetch<TranslationBubble>(
    `/api/portal/jobs/${jobId}/bubbles/${bubbleIndex}/retranslate`,
    { method: "POST" },
  );
}

export function reinpaintBubble(jobId: string, bubbleIndex: number, padding = 0): Promise<void> {
  return apiFetch<void>(`/api/portal/jobs/${jobId}/bubbles/${bubbleIndex}/reinpaint`, {
    method: "POST",
    body: JSON.stringify({ padding }),
  });
}

export function repatchBubble(jobId: string, bubbleIndex: number, padding = 0): Promise<void> {
  return apiFetch<void>(`/api/portal/jobs/${jobId}/bubbles/${bubbleIndex}/repatch`, {
    method: "POST",
    body: JSON.stringify({ padding }),
  });
}

// ---------------------------------------------------------------------------
// Volumes
// ---------------------------------------------------------------------------

export function listVolumes(): Promise<Volume[]> {
  return apiFetch<Volume[]>("/api/portal/volumes");
}

export interface CreateVolumeBody {
  title: string;
  synopsis?: string;
}

export function createVolume(body: CreateVolumeBody): Promise<Volume> {
  return apiFetch<Volume>("/api/portal/volumes", {
    method: "POST",
    body: JSON.stringify(snakelizeKeys(body)),
  });
}

export type UpdateVolumeBody = Partial<{
  title: string;
  synopsis: string;
  sortOrder: number;
}>;

export function updateVolume(id: number, body: UpdateVolumeBody): Promise<Volume> {
  return apiFetch<Volume>(`/api/portal/volumes/${id}`, {
    method: "PUT",
    body: JSON.stringify(snakelizeKeys(body)),
  });
}

export function deleteVolume(id: number): Promise<void> {
  return apiFetch<void>(`/api/portal/volumes/${id}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Chapters
// ---------------------------------------------------------------------------

export interface ListChaptersParams {
  volumeId?: number;
}

export function listChapters(params: ListChaptersParams = {}): Promise<Chapter[]> {
  const qs = new URLSearchParams();
  if (params.volumeId !== undefined) qs.set("volume_id", String(params.volumeId));
  const query = qs.toString();
  return apiFetch<Chapter[]>(`/api/portal/chapters${query ? `?${query}` : ""}`);
}

export interface CreateChapterBody {
  title: string;
  chapterNumber: string;
  volumeId?: number;
}

export function createChapter(body: CreateChapterBody): Promise<Chapter> {
  return apiFetch<Chapter>("/api/portal/chapters", {
    method: "POST",
    body: JSON.stringify(snakelizeKeys(body)),
  });
}

export type UpdateChapterBody = Partial<{
  title: string;
  chapterNumber: string;
  sortOrder: number;
  volumeId: number | null;
}>;

export function updateChapter(id: number, body: UpdateChapterBody): Promise<Chapter> {
  return apiFetch<Chapter>(`/api/portal/chapters/${id}`, {
    method: "PUT",
    body: JSON.stringify(snakelizeKeys(body)),
  });
}

export function deleteChapter(id: number): Promise<void> {
  return apiFetch<void>(`/api/portal/chapters/${id}`, { method: "DELETE" });
}

export function getChapterJobs(chapterId: number): Promise<PageTranslationJob[]> {
  return apiFetch<PageTranslationJob[]>(`/api/portal/chapters/${chapterId}/jobs`);
}

export function reorderChapterJobs(chapterId: number, jobIds: string[]): Promise<void> {
  return apiFetch<void>(`/api/portal/chapters/${chapterId}/jobs/reorder`, {
    method: "POST",
    body: JSON.stringify(jobIds),
  });
}

// ---------------------------------------------------------------------------
// Image URL builders
// ---------------------------------------------------------------------------

export function jobOriginalUrl(id: string): string {
  return `/api/portal/jobs/${id}/original`;
}

export function jobInpaintedUrl(id: string): string {
  return `/api/portal/jobs/${id}/inpainted`;
}

export function jobResultUrl(id: string): string {
  return `/api/portal/jobs/${id}/result`;
}

export type TextSegBox = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  sourceText?: string;
  translatedText?: string;
};

export async function getJobTextSegBlocks(id: string): Promise<TextSegBox[]> {
  const r = await fetch(`/api/portal/jobs/${id}/textseg-blocks`);
  if (!r.ok) throw new Error(await r.text());
  return r.json() as Promise<TextSegBox[]>;
}

export async function deleteTextSegBlock(id: string, index: number): Promise<TextSegBox[]> {
  const r = await fetch(`/api/portal/jobs/${id}/textseg-blocks/${index}`, { method: "DELETE" });
  if (!r.ok) throw new Error(await r.text());
  return r.json() as Promise<TextSegBox[]>;
}

export async function addTextSegBlock(id: string, box: TextSegBox): Promise<TextSegBox[]> {
  const r = await fetch(`/api/portal/jobs/${id}/textseg-blocks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ x: box.x, y: box.y, w: box.w, h: box.h }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json() as Promise<TextSegBox[]>;
}
