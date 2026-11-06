CREATE TABLE `agent_inbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`parent_session_id` integer NOT NULL,
	`parent_conversation_id` text,
	`child_session_id` integer,
	`child_name` text NOT NULL,
	`event` text NOT NULL,
	`state` text,
	`detail` text,
	`exit_code` integer,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`seen_at` text
);
--> statement-breakpoint
CREATE INDEX `agent_inbox_parent_idx` ON `agent_inbox` (`parent_session_id`,`seen_at`);--> statement-breakpoint
CREATE INDEX `agent_inbox_conversation_idx` ON `agent_inbox` (`parent_conversation_id`,`seen_at`);