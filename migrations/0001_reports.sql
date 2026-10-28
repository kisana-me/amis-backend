CREATE TABLE `reports` (
	`id` integer PRIMARY KEY NOT NULL,
	`aid` text(14) NOT NULL,
	`account_id` integer,
	`target_type` text NOT NULL,
	`target_id` integer NOT NULL,
	`category` integer DEFAULT 0 NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`announcement` text DEFAULT '' NOT NULL,
	`status` integer DEFAULT 0 NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "meta" CHECK(json_valid("meta"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `index_reports_on_aid` ON `reports` (`aid`);--> statement-breakpoint
CREATE INDEX `index_reports_on_target_type_and_target_id` ON `reports` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `index_reports_on_account_id` ON `reports` (`account_id`);