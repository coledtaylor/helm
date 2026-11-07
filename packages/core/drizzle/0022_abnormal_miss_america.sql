CREATE TABLE `notices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`parent_session_id` integer NOT NULL,
	`parent_name` text NOT NULL,
	`child_session_id` integer,
	`child_name` text,
	`text` text NOT NULL,
	`limit_kind` text,
	`allow_more` integer,
	`since` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notices_parent_idx` ON `notices` (`parent_session_id`);--> statement-breakpoint
ALTER TABLE `profiles` ADD `remote_control` integer;--> statement-breakpoint
ALTER TABLE `sessions` ADD `remote_control_name` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `extra_starts` integer DEFAULT 0 NOT NULL;