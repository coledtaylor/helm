ALTER TABLE `sessions` ADD `child_class` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `child_worktree` integer DEFAULT false NOT NULL;