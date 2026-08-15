CREATE TABLE `history_names` (
	`session_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`renamed_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `history_prompts` ADD `title_rank` integer;--> statement-breakpoint
ALTER TABLE `history_sessions` ADD `title_prompt` text;