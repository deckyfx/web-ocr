import Elysia, { t } from "elysia";
import { rm } from "fs/promises";
import { JobStore } from "@/stores/job-store";
import { JobSchema } from "@/lib/schemas";
import { join } from "path";

const DATA_DIR = "./data/jobs";

export const portalJobs = new Elysia()
  // GET /api/portal/jobs  — no error path: response schema safe here
  .get("/jobs", async () => JobStore.list(), { response: t.Array(JobSchema) })

  // GET /api/portal/jobs/:id
  .get("/jobs/:id", async ({ params, status: error }) => {
    const job = await JobStore.findById(params.id);
    if (!job) return error(404, { error: "not found" });
    return job;
  })

  // DELETE /api/portal/jobs/:id
  .delete("/jobs/:id", async ({ params, status: error }) => {
    const job = await JobStore.findById(params.id);
    if (!job) return error(404, { error: "not found" });
    await JobStore.delete(params.id);
    await rm(join(DATA_DIR, params.id), { recursive: true, force: true });
    return { deleted: params.id };
  })

  // PUT /api/portal/jobs/:id — accepts snake_case body, maps to camelCase store keys
  .put(
    "/jobs/:id",
    async ({ params, body, status: error }) => {
      const updated = await JobStore.update(params.id, {
        ...(body.status !== undefined && { status: body.status }),
        ...(body.error_message !== undefined && { errorMessage: body.error_message }),
        ...(body.text_seg_blocks !== undefined && { textSegBlocks: body.text_seg_blocks }),
      });
      if (!updated) return error(404, { error: "not found" });
      return updated;
    },
    {
      body: t.Object({
        status: t.Optional(t.String()),
        error_message: t.Optional(t.Nullable(t.String())),
        text_seg_blocks: t.Optional(t.Nullable(t.String())),
      }),
    },
  )

  // GET /api/portal/jobs/:id/original  (image)
  .get("/jobs/:id/original", async ({ params, status: error, set }) => {
    const job = await JobStore.findById(params.id);
    if (!job) return error(404, { error: "not found" });
    const file = Bun.file(join(DATA_DIR, params.id, "original.png"));
    if (!(await file.exists())) return error(404, { error: "original image not found" });
    set.headers["Cache-Control"] = "private, max-age=86400";
    return file;
  })

  // GET /api/portal/jobs/:id/inpainted  (image)
  .get("/jobs/:id/inpainted", async ({ params, status: error, set }) => {
    const job = await JobStore.findById(params.id);
    if (!job) return error(404, { error: "not found" });
    const file = Bun.file(join(DATA_DIR, params.id, "inpainted.png"));
    if (!(await file.exists())) return error(404, { error: "inpainted image not found" });
    set.headers["Cache-Control"] = "no-cache";
    return file;
  })

  // GET /api/portal/jobs/:id/result  (image)
  .get("/jobs/:id/result", async ({ params, status: error, set }) => {
    const job = await JobStore.findById(params.id);
    if (!job) return error(404, { error: "not found" });
    const file = Bun.file(join(DATA_DIR, params.id, "result.png"));
    if (!(await file.exists())) return error(404, { error: "result image not found" });
    set.headers["Cache-Control"] = "no-cache";
    return file;
  });
