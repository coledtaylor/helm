CREATE TABLE `transcript_index` (
	`file` text PRIMARY KEY NOT NULL,
	`bytes` integer NOT NULL,
	`messages` integer DEFAULT 0 NOT NULL,
	`indexed_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `transcript_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`uuid` text NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`at` integer NOT NULL,
	`body` blob NOT NULL,
	`compressed` integer DEFAULT false NOT NULL,
	`raw_bytes` integer DEFAULT 0 NOT NULL,
	`stored_bytes` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transcript_messages_uuid_unique` ON `transcript_messages` (`uuid`);--> statement-breakpoint
CREATE INDEX `transcript_messages_session_idx` ON `transcript_messages` (`session_id`,`at`,`id`);--> statement-breakpoint
CREATE TABLE `transcript_sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`source_file` text NOT NULL,
	`state` text DEFAULT 'archived' NOT NULL,
	`first_at` integer,
	`last_at` integer,
	`message_count` integer DEFAULT 0 NOT NULL,
	`raw_bytes` integer DEFAULT 0 NOT NULL,
	`stored_bytes` integer DEFAULT 0 NOT NULL,
	`captured_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`evicted_at` text
);
--> statement-breakpoint
CREATE INDEX `transcript_sessions_oldest_idx` ON `transcript_sessions` (`state`,`last_at`);--> statement-breakpoint
-- Everything below this line is HAND-WRITTEN and drizzle-kit did not produce it.
-- drizzle-kit does not model virtual tables: it cannot generate an FTS5 table
-- and it cannot see one that already exists, so it will neither recreate nor
-- drop what follows. `pnpm db:generate` re-embeds whatever is in this folder,
-- so this survives regeneration - but a later migration that needs to touch
-- `transcript_fts` has to carry its own hand-written SQL in the same way. The
-- reasoning is in `schema.ts`, under the three tables above.
--
-- `content=''` because the message text is not stored in plain form anywhere:
-- `transcript_messages.body` is a compressed blob, so there is no column for an
-- external-content FTS table to read and no column an INSERT trigger could read
-- either. The index is written in code, beside the row it indexes and inside
-- the same transaction (`store/archive.ts`).
--
-- `contentless_delete=1` is what makes the DELETE below legal - without it
-- SQLite refuses to delete from a contentless FTS5 table, because it does not
-- hold the text it would need to un-index. SQLite 3.43+; better-sqlite3 13
-- bundles 3.53.
--
-- `unicode61 remove_diacritics 2` is the default tokenizer stated rather than
-- assumed, so a future SQLite changing its default cannot silently re-tokenize
-- an index nothing rebuilds.
CREATE VIRTUAL TABLE `transcript_fts` USING fts5(
  text,
  content='',
  contentless_delete=1,
  tokenize="unicode61 remove_diacritics 2"
);--> statement-breakpoint
-- The DELETE is a trigger and the INSERT is not, and the asymmetry is the
-- design. A delete needs only `old.id`, and eviction is the one path that would
-- otherwise leave index entries pointing at messages that no longer exist - a
-- search that returned rowids the message table cannot resolve. Putting it in
-- the schema means it cannot be forgotten by a caller.
CREATE TRIGGER `transcript_fts_delete` AFTER DELETE ON `transcript_messages` BEGIN
  DELETE FROM `transcript_fts` WHERE rowid = old.`id`;
END;