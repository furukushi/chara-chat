ALTER TABLE `reviews` ADD COLUMN `prompt_text` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `reviews` ADD COLUMN `response_text` text DEFAULT '' NOT NULL;
