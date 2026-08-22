PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_chapters` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`volume_id` integer NOT NULL,
	`title` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`pages_dir` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`volume_id`) REFERENCES `volumes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_chapters`("id", "volume_id", "title", "sort_order", "pages_dir", "created_at", "updated_at") SELECT "id", "volume_id", "title", "sort_order", "pages_dir", "created_at", "updated_at" FROM `chapters`;--> statement-breakpoint
DROP TABLE `chapters`;--> statement-breakpoint
ALTER TABLE `__new_chapters` RENAME TO `chapters`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `page_translation_jobs_image_hash_unique` ON `page_translation_jobs` (`image_hash`);