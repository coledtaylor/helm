CREATE TABLE `usage_index` (
	`file` text PRIMARY KEY NOT NULL,
	`bytes` integer NOT NULL,
	`rows` integer DEFAULT 0 NOT NULL,
	`indexed_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `usage_messages` (
	`uuid` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_5m_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_1h_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `usage_messages_at_idx` ON `usage_messages` (`at`,`model`);