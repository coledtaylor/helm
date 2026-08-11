CREATE TABLE `pr_repos` (
	`path` text PRIMARY KEY NOT NULL,
	`url` text,
	`slug` text,
	`checked_at` text,
	`fetched_at` text,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `pull_requests` (
	`slug` text NOT NULL,
	`number` integer NOT NULL,
	`summary` text NOT NULL,
	`detail` text,
	`fetched_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`detail_fetched_at` text,
	PRIMARY KEY(`slug`, `number`)
);
