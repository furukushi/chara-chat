ALTER TABLE `characters` ADD COLUMN `auto_review` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `reviews` ADD COLUMN `review_kind` text DEFAULT 'manual' NOT NULL;
--> statement-breakpoint
ALTER TABLE `reviews` ADD COLUMN `request_id` integer;
--> statement-breakpoint
ALTER TABLE `reviews` ADD COLUMN `batch_text` text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_request_character_unique` ON `reviews` (`request_id`, `character_id`) WHERE `request_id` IS NOT NULL;
