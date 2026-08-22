import Elysia, { t } from "elysia";
import { VolumeStore } from "@/stores/volume-store";
import { JobStore } from "@/stores/job-store";
import { VolumeSchema, ChapterSchema, JobSchema } from "@/lib/schemas";

const VolumeBody = t.Object({
  title: t.String(),
  cover_path: t.Optional(t.Nullable(t.String())),
});

const ChapterBody = t.Object({
  volume_id: t.Optional(t.Nullable(t.Number())),
  title: t.String(),
  sort_order: t.Optional(t.Number()),
  pages_dir: t.String(),
});

export const portalLibrary = new Elysia()
  // ── Volumes ────────────────────────────────────────────────────────────────

  .get("/volumes", async () => VolumeStore.list(), {
    response: t.Array(VolumeSchema),
  })

  .post(
    "/volumes",
    async ({ body }) => VolumeStore.insert({ title: body.title, coverPath: body.cover_path }),
    { body: VolumeBody, response: VolumeSchema },
  )

  .put(
    "/volumes/:id",
    async ({ params, body, status: error }) => {
      const updated = await VolumeStore.update(parseInt(params.id, 10), {
        title: body.title,
        coverPath: body.cover_path,
      });
      if (!updated) return error(404, { error: "not found" });
      return updated;
    },
    { body: VolumeBody },
  )

  .delete(
    "/volumes/:id",
    async ({ params, status: error }) => {
      const vol = await VolumeStore.findById(parseInt(params.id, 10));
      if (!vol) return error(404, { error: "not found" });
      await VolumeStore.delete(parseInt(params.id, 10));
      return { deleted: params.id };
    },
  )

  // ── Chapters ───────────────────────────────────────────────────────────────

  .get(
    "/chapters",
    async ({ query }) => {
      if (query.volume_id) {
        return VolumeStore.listChapters(parseInt(query.volume_id, 10));
      }
      const { db } = await import("@/db/index");
      const { chapters } = await import("@/db/schema");
      return db.select().from(chapters);
    },
    {
      query: t.Object({ volume_id: t.Optional(t.String()), standalone: t.Optional(t.String()) }),
      response: t.Array(ChapterSchema),
    },
  )

  .post(
    "/chapters",
    async ({ body }) =>
      VolumeStore.insertChapter({
        title: body.title,
        pagesDir: body.pages_dir,
        sortOrder: body.sort_order ?? 0,
        volumeId: body.volume_id ?? null,
      }),
    { body: ChapterBody, response: ChapterSchema },
  )

  .put(
    "/chapters/:id",
    async ({ params, body, status: error }) => {
      const updated = await VolumeStore.updateChapter(parseInt(params.id, 10), {
        title: body.title,
        pagesDir: body.pages_dir,
        sortOrder: body.sort_order,
        volumeId: body.volume_id,
      });
      if (!updated) return error(404, { error: "not found" });
      return updated;
    },
    { body: ChapterBody },
  )

  .delete(
    "/chapters/:id",
    async ({ params, status: error }) => {
      const ch = await VolumeStore.findChapterById(parseInt(params.id, 10));
      if (!ch) return error(404, { error: "not found" });
      await VolumeStore.deleteChapter(parseInt(params.id, 10));
      return { deleted: params.id };
    },
  )

  // GET /api/portal/chapters/:id/jobs
  .get(
    "/chapters/:id/jobs",
    async ({ params, status: error }) => {
      const ch = await VolumeStore.findChapterById(parseInt(params.id, 10));
      if (!ch) return error(404, { error: "not found" });
      return JobStore.list(500);
    },
  )

  // PUT /api/portal/chapters/:id/jobs/reorder
  .put(
    "/chapters/:id/jobs/reorder",
    async ({ body }) => ({ reordered: body.length }),
    {
      body: t.Array(t.String()),
      response: t.Object({ reordered: t.Integer() }),
    },
  );
