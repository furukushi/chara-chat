ALTER TABLE `characters` ADD COLUMN `review_mode` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `groups` ADD COLUMN `review_mode` integer DEFAULT 0 NOT NULL;
