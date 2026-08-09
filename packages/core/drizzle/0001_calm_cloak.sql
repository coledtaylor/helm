CREATE TABLE `sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`cwd` text NOT NULL,
	`project_path` text,
	`argv` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`ended_at` text,
	`duration_ms` integer,
	`exit_code` integer
);
--> statement-breakpoint
CREATE INDEX `sessions_started_idx` ON `sessions` (`started_at`);--> statement-breakpoint
CREATE INDEX `sessions_status_idx` ON `sessions` (`status`);