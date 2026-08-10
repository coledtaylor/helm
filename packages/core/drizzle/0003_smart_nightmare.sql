CREATE TABLE `history_index` (
	`file` text PRIMARY KEY NOT NULL,
	`bytes` integer NOT NULL,
	`indexed_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `history_prompts` (
	`seq` integer PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`project` text NOT NULL,
	`at` integer NOT NULL,
	`text` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `history_prompts_session_idx` ON `history_prompts` (`session_id`,`seq`);--> statement-breakpoint
CREATE TABLE `history_sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`project` text NOT NULL,
	`project_key` text NOT NULL,
	`prompt_count` integer NOT NULL,
	`first_at` integer NOT NULL,
	`last_at` integer NOT NULL,
	`first_prompt` text NOT NULL,
	`transcript_file` text,
	`transcript_bytes` integer,
	`project_exists` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `history_sessions_last_idx` ON `history_sessions` (`last_at`);--> statement-breakpoint
CREATE INDEX `history_sessions_project_idx` ON `history_sessions` (`project_key`,`last_at`);