CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `config_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_path` text NOT NULL,
	`file_path` text NOT NULL,
	`content` text NOT NULL,
	`content_hash` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `config_snapshots_file_idx` ON `config_snapshots` (`project_path`,`file_path`,`created_at`);--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`root` text NOT NULL,
	`overlays` text DEFAULT '[]' NOT NULL,
	`access` text DEFAULT '[]' NOT NULL,
	`model` text,
	`effort` text,
	`permission_mode` text,
	`agent` text,
	`mcp` text DEFAULT '[]' NOT NULL,
	`opening_prompt` text,
	`pinned_order` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profiles_name_unique` ON `profiles` (`name`);--> statement-breakpoint
CREATE TABLE `projects` (
	`path` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`harness_path` text,
	`has_claude_dir` integer DEFAULT false NOT NULL,
	`inventory` text NOT NULL,
	`git` text,
	`last_seen_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `projects_harness_idx` ON `projects` (`harness_path`);