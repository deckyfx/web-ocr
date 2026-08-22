import { sqliteTable, text, integer, real, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ── OCR / Translate logs (mirrors C# OcrLog / TranslateLog) ────────────────

export const ocrLogs = sqliteTable("ocr_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  imageHash: text("image_hash").notNull(),
  sourceText: text("source_text").notNull(),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  modelRepo: text("model_repo").notNull(),
  processingTimeMs: integer("processing_time_ms"),
});

export const translateLogs = sqliteTable("translate_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sourceText: text("source_text").notNull(),
  translatedText: text("translated_text").notNull(),
  sourceLang: text("source_lang").notNull().default("ja"),
  targetLang: text("target_lang").notNull().default("en"),
  engine: text("engine").notNull().default("local"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  processingTimeMs: integer("processing_time_ms"),
});

// ── Manga library ────────────────────────────────────────────────────────────

export const volumes = sqliteTable("volumes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  coverPath: text("cover_path"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const chapters = sqliteTable("chapters", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  volumeId: integer("volume_id").notNull().references(() => volumes.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  pagesDir: text("pages_dir").notNull(),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

// ── Studio page-translation pipeline ────────────────────────────────────────

export const pageTranslationJobs = sqliteTable("page_translation_jobs", {
  id: text("id").primaryKey(),
  imageHash: text("image_hash").notNull().unique(),
  /** Original image path or URL */
  sourcePath: text("source_path").notNull(),
  status: text("status").notNull().default("pending"),
  totalBubbles: integer("total_bubbles").notNull().default(0),
  processedBubbles: integer("processed_bubbles").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  errorMessage: text("error_message"),
  /** Serialised TextSeg blocks (JSON) */
  textSegBlocks: text("text_seg_blocks"),
  inpaintEnabled: integer("inpaint_enabled", { mode: "boolean" }).notNull().default(false),
  bubbleEnabled: integer("bubble_enabled", { mode: "boolean" }).notNull().default(false),
});

export const pageTranslationLogs = sqliteTable("page_translation_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: text("job_id")
    .notNull()
    .references(() => pageTranslationJobs.id, { onDelete: "cascade" }),
  bubbleIndex: integer("bubble_index").notNull(),
  x: real("x").notNull(),
  y: real("y").notNull(),
  width: real("width").notNull(),
  height: real("height").notNull(),
  rotation: real("rotation").notNull().default(0),
  sourceText: text("source_text"),
  translatedText: text("translated_text"),
  ocrLogId: integer("ocr_log_id").references(() => ocrLogs.id),
  translateLogId: integer("translate_log_id").references(() => translateLogs.id),
  inpaintedImagePath: text("inpainted_image_path"),
  patchImagePath: text("patch_image_path"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  /** Serialised style JSON (font size, color, alignment …) */
  styleJson: text("style_json"),
}, (table) => ({
  bubbleJobIdx: uniqueIndex("page_translation_logs_job_bubble_idx").on(table.jobId, table.bubbleIndex),
}));

// ── Type exports ─────────────────────────────────────────────────────────────

export type OcrLog = typeof ocrLogs.$inferSelect;
export type NewOcrLog = typeof ocrLogs.$inferInsert;

export type TranslateLog = typeof translateLogs.$inferSelect;
export type NewTranslateLog = typeof translateLogs.$inferInsert;

export type Volume = typeof volumes.$inferSelect;
export type NewVolume = typeof volumes.$inferInsert;

export type Chapter = typeof chapters.$inferSelect;
export type NewChapter = typeof chapters.$inferInsert;

export type PageTranslationJob = typeof pageTranslationJobs.$inferSelect;
export type NewPageTranslationJob = typeof pageTranslationJobs.$inferInsert;

export type PageTranslationLog = typeof pageTranslationLogs.$inferSelect;
export type NewPageTranslationLog = typeof pageTranslationLogs.$inferInsert;
