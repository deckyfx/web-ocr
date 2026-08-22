import Elysia, { t } from "elysia";
import { JobStore } from "@/stores/job-store";

interface TextSegBlock {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  source_text: string | null;
  translated_text: string | null;
}

// Per-job async mutex: each new waiter chains onto the previous lock promise.
const jobLocks = new Map<string, Promise<void>>();

async function withJobLock<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  const prev = jobLocks.get(jobId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((r) => { release = r; });
  jobLocks.set(jobId, current);
  await prev;
  try {
    return await fn();
  } finally {
    if (jobLocks.get(jobId) === current) jobLocks.delete(jobId);
    release();
  }
}

/** Returns parsed blocks, or `null` when the stored JSON is malformed. */
function parseBlocks(raw: string | null): TextSegBlock[] | null {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed as TextSegBlock[];
  } catch {
    return null;
  }
}

export const portalTextSeg = new Elysia()
  // GET /api/portal/jobs/:id/textseg-blocks
  .get("/jobs/:id/textseg-blocks", async ({ params, status: error }) => {
    const job = await JobStore.findById(params.id);
    if (!job) return error(404, { error: "not found" });
    const blocks = parseBlocks(job.textSegBlocks);
    if (blocks === null) return error(500, { error: "textseg data corrupted" });
    return blocks;
  })

  // POST /api/portal/jobs/:id/textseg-blocks
  .post(
    "/jobs/:id/textseg-blocks",
    async ({ params, body, status: error }) => {
      return withJobLock(params.id, async () => {
        const job = await JobStore.findById(params.id);
        if (!job) return error(404, { error: "not found" });

        const blocks = parseBlocks(job.textSegBlocks);
        if (blocks === null) return error(500, { error: "textseg data corrupted" });

        const newBlock: TextSegBlock = {
          id: crypto.randomUUID(),
          x: body.x,
          y: body.y,
          w: body.w,
          h: body.h,
          source_text: null,
          translated_text: null,
        };
        blocks.push(newBlock);

        await JobStore.update(params.id, { textSegBlocks: JSON.stringify(blocks) });
        return newBlock;
      });
    },
    {
      body: t.Object({ x: t.Number(), y: t.Number(), w: t.Number(), h: t.Number() }),
    },
  )

  // PUT /api/portal/jobs/:id/textseg-blocks/:blockId
  .put(
    "/jobs/:id/textseg-blocks/:blockId",
    async ({ params, body, status: error }) => {
      return withJobLock(params.id, async () => {
        const job = await JobStore.findById(params.id);
        if (!job) return error(404, { error: "not found" });

        const blocks = parseBlocks(job.textSegBlocks);
        if (blocks === null) return error(500, { error: "textseg data corrupted" });

        const idx = blocks.findIndex((b) => b.id === params.blockId);
        if (idx === -1) return error(404, { error: "block not found" });

        blocks[idx] = { ...blocks[idx], ...body };
        await JobStore.update(params.id, { textSegBlocks: JSON.stringify(blocks) });
        return blocks[idx];
      });
    },
    {
      body: t.Object({
        x: t.Optional(t.Number()),
        y: t.Optional(t.Number()),
        w: t.Optional(t.Number()),
        h: t.Optional(t.Number()),
        source_text: t.Optional(t.Nullable(t.String())),
        translated_text: t.Optional(t.Nullable(t.String())),
      }),
    },
  )

  // DELETE /api/portal/jobs/:id/textseg-blocks/:blockId
  .delete("/jobs/:id/textseg-blocks/:blockId", async ({ params, status: error }) => {
    return withJobLock(params.id, async () => {
      const job = await JobStore.findById(params.id);
      if (!job) return error(404, { error: "not found" });

      const blocks = parseBlocks(job.textSegBlocks);
      if (blocks === null) return error(500, { error: "textseg data corrupted" });

      const filtered = blocks.filter((b) => b.id !== params.blockId);
      if (filtered.length === blocks.length) return error(404, { error: "block not found" });
      await JobStore.update(params.id, { textSegBlocks: JSON.stringify(filtered) });
      return { deleted: params.blockId };
    });
  });
