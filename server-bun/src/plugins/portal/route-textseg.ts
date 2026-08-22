import Elysia, { t } from "elysia";
import { JobStore } from "@/stores/job-store";
import { catchErrorSync } from "@/lib/error-handler";

interface TextSegBlock {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  source_text: string | null;
  translated_text: string | null;
}

function parseBlocks(raw: string | null): TextSegBlock[] {
  if (!raw) return [];
  const [err, parsed] = catchErrorSync(() => JSON.parse(raw) as TextSegBlock[]);
  return err ? [] : parsed;
}

export const portalTextSeg = new Elysia()
  // GET /api/portal/jobs/:id/textseg-blocks
  .get("/jobs/:id/textseg-blocks", async ({ params, status: error }) => {
    const job = await JobStore.findById(params.id);
    if (!job) return error(404, { error: "not found" });
    return parseBlocks(job.textSegBlocks);
  })

  // POST /api/portal/jobs/:id/textseg-blocks
  .post(
    "/jobs/:id/textseg-blocks",
    async ({ params, body, status: error }) => {
      const job = await JobStore.findById(params.id);
      if (!job) return error(404, { error: "not found" });

      const blocks = parseBlocks(job.textSegBlocks);
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
    },
    {
      body: t.Object({ x: t.Number(), y: t.Number(), w: t.Number(), h: t.Number() }),
    },
  )

  // PUT /api/portal/jobs/:id/textseg-blocks/:blockId
  .put(
    "/jobs/:id/textseg-blocks/:blockId",
    async ({ params, body, status: error }) => {
      const job = await JobStore.findById(params.id);
      if (!job) return error(404, { error: "not found" });

      const blocks = parseBlocks(job.textSegBlocks);
      const idx = blocks.findIndex((b) => b.id === params.blockId);
      if (idx === -1) return error(404, { error: "block not found" });

      blocks[idx] = { ...blocks[idx], ...body };
      await JobStore.update(params.id, { textSegBlocks: JSON.stringify(blocks) });
      return blocks[idx];
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
    const job = await JobStore.findById(params.id);
    if (!job) return error(404, { error: "not found" });

    const blocks = parseBlocks(job.textSegBlocks).filter((b) => b.id !== params.blockId);
    await JobStore.update(params.id, { textSegBlocks: JSON.stringify(blocks) });
    return { deleted: params.blockId };
  });
