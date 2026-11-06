ALTER TABLE `profiles` ADD `session_agents` integer;--> statement-breakpoint
ALTER TABLE `sessions` ADD `parent_session_id` integer REFERENCES sessions(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `sessions` ADD `parent_conversation_id` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `child_name` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `role` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `outlive` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `can_start` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `sessions_parent_idx` ON `sessions` (`parent_session_id`);