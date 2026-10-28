CREATE TABLE `images` (
	`id` integer PRIMARY KEY NOT NULL,
	`aid` text(14) NOT NULL,
	`account_id` integer,
	`name` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`original_key` text,
	`original_ext` text,
	`variant_type` text,
	`width` integer,
	`height` integer,
	`status` integer DEFAULT 0 NOT NULL,
	`visibility` integer DEFAULT 0 NOT NULL,
	`user_rating` integer DEFAULT 0 NOT NULL,
	`auto_rating` integer,
	`mod_rating` integer,
	`rating` integer GENERATED ALWAYS AS (coalesce(mod_rating, max(user_rating, coalesce(auto_rating, 0)))) VIRTUAL,
	`meta` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "meta" CHECK(json_valid("meta"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `index_images_on_aid` ON `images` (`aid`);--> statement-breakpoint
CREATE INDEX `index_images_on_account_id` ON `images` (`account_id`);--> statement-breakpoint
CREATE INDEX `index_images_on_rating` ON `images` (`rating`);--> statement-breakpoint
CREATE TABLE `ai_models` (
	`id` integer PRIMARY KEY NOT NULL,
	`aid` text(14) NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`provider` text NOT NULL,
	`upstream_model` text NOT NULL,
	`api` integer DEFAULT 0 NOT NULL,
	`route` integer DEFAULT 0 NOT NULL,
	`tier` integer DEFAULT 0 NOT NULL,
	`status` integer DEFAULT 0 NOT NULL,
	`max_rating` integer DEFAULT 2 NOT NULL,
	`context_window` integer DEFAULT 0 NOT NULL,
	`max_output_tokens` integer DEFAULT 0 NOT NULL,
	`input_price_micro` integer DEFAULT 0 NOT NULL,
	`cached_input_price_micro` integer DEFAULT 0 NOT NULL,
	`output_price_micro` integer DEFAULT 0 NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`request_params` text DEFAULT '{}' NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "meta" CHECK(json_valid("meta")),
	CONSTRAINT "request_params" CHECK(json_valid("request_params"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `index_ai_models_on_aid` ON `ai_models` (`aid`);--> statement-breakpoint
CREATE TABLE `ai_usages` (
	`id` integer PRIMARY KEY NOT NULL,
	`account_id` integer,
	`ai_model_id` integer,
	`chat_id` integer,
	`chat_message_id` integer,
	`purpose` integer DEFAULT 0 NOT NULL,
	`prompt_tokens` integer,
	`cached_tokens` integer,
	`completion_tokens` integer,
	`reasoning_tokens` integer,
	`cost_micro` integer,
	`finish_reason` text,
	`ttft_ms` integer,
	`latency_ms` integer,
	`gateway_log_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`ai_model_id`) REFERENCES `ai_models`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`chat_message_id`) REFERENCES `chat_messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `index_ai_usages_on_account_id_and_created_at` ON `ai_usages` (`account_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `index_ai_usages_on_ai_model_id` ON `ai_usages` (`ai_model_id`);--> statement-breakpoint
CREATE INDEX `index_ai_usages_on_chat_id` ON `ai_usages` (`chat_id`);--> statement-breakpoint
CREATE INDEX `index_ai_usages_on_chat_message_id` ON `ai_usages` (`chat_message_id`);--> statement-breakpoint
CREATE INDEX `index_ai_usages_on_created_at` ON `ai_usages` (`created_at`);--> statement-breakpoint
CREATE TABLE `characters` (
	`id` integer PRIMARY KEY NOT NULL,
	`aid` text(14) NOT NULL,
	`author_id` integer,
	`icon_id` integer,
	`name` text NOT NULL,
	`tagline` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`persona` text NOT NULL,
	`persona_public` integer DEFAULT false NOT NULL,
	`allow_casting` integer DEFAULT true NOT NULL,
	`allow_fork` integer DEFAULT false NOT NULL,
	`status` integer DEFAULT 0 NOT NULL,
	`visibility` integer DEFAULT 0 NOT NULL,
	`user_rating` integer DEFAULT 0 NOT NULL,
	`auto_rating` integer,
	`mod_rating` integer,
	`derived_rating` integer,
	`rating` integer GENERATED ALWAYS AS (coalesce(mod_rating, max(user_rating, coalesce(auto_rating, 0), coalesce(derived_rating, 0)))) VIRTUAL,
	`chats_count` integer DEFAULT 0 NOT NULL,
	`leads_count` integer DEFAULT 0 NOT NULL,
	`likes_count` integer DEFAULT 0 NOT NULL,
	`messages_count` integer DEFAULT 0 NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`icon_id`) REFERENCES `images`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "meta" CHECK(json_valid("meta"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `index_characters_on_aid` ON `characters` (`aid`);--> statement-breakpoint
CREATE INDEX `index_characters_on_author_id` ON `characters` (`author_id`);--> statement-breakpoint
CREATE INDEX `index_characters_on_icon_id` ON `characters` (`icon_id`);--> statement-breakpoint
CREATE INDEX `index_characters_on_rating` ON `characters` (`rating`);--> statement-breakpoint
CREATE INDEX `index_characters_on_status_and_visibility_and_chats_count` ON `characters` (`status`,`visibility`,`chats_count`);--> statement-breakpoint
CREATE TABLE `plots` (
	`id` integer PRIMARY KEY NOT NULL,
	`aid` text(14) NOT NULL,
	`author_id` integer,
	`icon_id` integer,
	`forked_from_id` integer,
	`title` text NOT NULL,
	`tagline` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`situation` text DEFAULT '' NOT NULL,
	`situation_public` integer DEFAULT false NOT NULL,
	`chapters` text DEFAULT '[]' NOT NULL,
	`opening_scene` text DEFAULT '[]' NOT NULL,
	`allow_fork` integer DEFAULT false NOT NULL,
	`status` integer DEFAULT 0 NOT NULL,
	`visibility` integer DEFAULT 0 NOT NULL,
	`user_rating` integer DEFAULT 0 NOT NULL,
	`auto_rating` integer,
	`mod_rating` integer,
	`derived_rating` integer,
	`rating` integer GENERATED ALWAYS AS (coalesce(mod_rating, max(user_rating, coalesce(auto_rating, 0), coalesce(derived_rating, 0)))) VIRTUAL,
	`chats_count` integer DEFAULT 0 NOT NULL,
	`clears_count` integer DEFAULT 0 NOT NULL,
	`likes_count` integer DEFAULT 0 NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`icon_id`) REFERENCES `images`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chapters" CHECK(json_valid("chapters")),
	CONSTRAINT "opening_scene" CHECK(json_valid("opening_scene")),
	CONSTRAINT "meta" CHECK(json_valid("meta"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `index_plots_on_aid` ON `plots` (`aid`);--> statement-breakpoint
CREATE INDEX `index_plots_on_author_id` ON `plots` (`author_id`);--> statement-breakpoint
CREATE INDEX `index_plots_on_icon_id` ON `plots` (`icon_id`);--> statement-breakpoint
CREATE INDEX `index_plots_on_forked_from_id` ON `plots` (`forked_from_id`);--> statement-breakpoint
CREATE INDEX `index_plots_on_rating` ON `plots` (`rating`);--> statement-breakpoint
CREATE INDEX `index_plots_on_status_and_visibility_and_clears_count` ON `plots` (`status`,`visibility`,`clears_count`);--> statement-breakpoint
CREATE TABLE `lores` (
	`id` integer PRIMARY KEY NOT NULL,
	`aid` text(14) NOT NULL,
	`author_id` integer,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`allow_attach` integer DEFAULT true NOT NULL,
	`status` integer DEFAULT 0 NOT NULL,
	`visibility` integer DEFAULT 0 NOT NULL,
	`entries_count` integer DEFAULT 0 NOT NULL,
	`plots_count` integer DEFAULT 0 NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "meta" CHECK(json_valid("meta"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `index_lores_on_aid` ON `lores` (`aid`);--> statement-breakpoint
CREATE INDEX `index_lores_on_author_id` ON `lores` (`author_id`);--> statement-breakpoint
CREATE INDEX `index_lores_on_status_and_visibility` ON `lores` (`status`,`visibility`);--> statement-breakpoint
CREATE TABLE `lore_entries` (
	`id` integer PRIMARY KEY NOT NULL,
	`lore_id` integer NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`keywords` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`lore_id`) REFERENCES `lores`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `index_lore_entries_on_lore_id` ON `lore_entries` (`lore_id`);--> statement-breakpoint
CREATE TABLE `personas` (
	`id` integer PRIMARY KEY NOT NULL,
	`aid` text(14) NOT NULL,
	`account_id` integer,
	`plot_id` integer,
	`icon_id` integer,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`status` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`plot_id`) REFERENCES `plots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`icon_id`) REFERENCES `images`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "personas_owner_xor" CHECK((account_id IS NULL) <> (plot_id IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `index_personas_on_aid` ON `personas` (`aid`);--> statement-breakpoint
CREATE INDEX `index_personas_on_account_id` ON `personas` (`account_id`);--> statement-breakpoint
CREATE INDEX `index_personas_on_plot_id` ON `personas` (`plot_id`);--> statement-breakpoint
CREATE INDEX `index_personas_on_icon_id` ON `personas` (`icon_id`);--> statement-breakpoint
CREATE TABLE `chats` (
	`id` integer PRIMARY KEY NOT NULL,
	`aid` text(14) NOT NULL,
	`account_id` integer NOT NULL,
	`plot_id` integer NOT NULL,
	`persona_id` integer,
	`ai_model_id` integer,
	`title` text DEFAULT '' NOT NULL,
	`status` integer DEFAULT 0 NOT NULL,
	`reply_style` integer DEFAULT 0 NOT NULL,
	`choice_mode` integer DEFAULT false NOT NULL,
	`current_chapter_key` text DEFAULT '' NOT NULL,
	`turns_in_chapter` integer DEFAULT 0 NOT NULL,
	`finished_at` integer,
	`summaries` text DEFAULT '[]' NOT NULL,
	`messages_count` integer DEFAULT 0 NOT NULL,
	`last_message_at` integer,
	`meta` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`plot_id`) REFERENCES `plots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ai_model_id`) REFERENCES `ai_models`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "summaries" CHECK(json_valid("summaries")),
	CONSTRAINT "meta" CHECK(json_valid("meta"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `index_chats_on_aid` ON `chats` (`aid`);--> statement-breakpoint
CREATE INDEX `index_chats_on_account_id_and_last_message_at` ON `chats` (`account_id`,`last_message_at`);--> statement-breakpoint
CREATE INDEX `index_chats_on_plot_id` ON `chats` (`plot_id`);--> statement-breakpoint
CREATE INDEX `index_chats_on_persona_id` ON `chats` (`persona_id`);--> statement-breakpoint
CREATE INDEX `index_chats_on_ai_model_id` ON `chats` (`ai_model_id`);--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`id` integer PRIMARY KEY NOT NULL,
	`aid` text(14) NOT NULL,
	`chat_id` integer NOT NULL,
	`role` integer NOT NULL,
	`status` integer DEFAULT 0 NOT NULL,
	`content` text DEFAULT '[]' NOT NULL,
	`chapter_key` text DEFAULT '' NOT NULL,
	`speaker_character_id` integer,
	`replaced_by_id` integer,
	`ai_model_id` integer,
	`user_rating` integer DEFAULT 0 NOT NULL,
	`auto_rating` integer,
	`mod_rating` integer,
	`rating` integer GENERATED ALWAYS AS (coalesce(mod_rating, max(user_rating, coalesce(auto_rating, 0)))) VIRTUAL,
	`streamed_at` integer,
	`meta` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`speaker_character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ai_model_id`) REFERENCES `ai_models`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "content" CHECK(json_valid("content")),
	CONSTRAINT "meta" CHECK(json_valid("meta"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `index_chat_messages_on_aid` ON `chat_messages` (`aid`);--> statement-breakpoint
CREATE INDEX `index_chat_messages_on_chat_id_and_id` ON `chat_messages` (`chat_id`,`id`);--> statement-breakpoint
CREATE INDEX `index_chat_messages_on_status` ON `chat_messages` (`status`);--> statement-breakpoint
CREATE INDEX `index_chat_messages_on_replaced_by_id` ON `chat_messages` (`replaced_by_id`);--> statement-breakpoint
CREATE TABLE `character_images` (
	`id` integer PRIMARY KEY NOT NULL,
	`character_id` integer NOT NULL,
	`image_id` integer NOT NULL,
	`situation` text(50) DEFAULT '' NOT NULL,
	`secret` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`image_id`) REFERENCES `images`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `index_character_images_on_character_id_and_image_id` ON `character_images` (`character_id`,`image_id`);--> statement-breakpoint
CREATE INDEX `index_character_images_on_character_id_and_position` ON `character_images` (`character_id`,`position`);--> statement-breakpoint
CREATE INDEX `index_character_images_on_image_id` ON `character_images` (`image_id`);--> statement-breakpoint
CREATE TABLE `character_likes` (
	`account_id` integer NOT NULL,
	`character_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`account_id`, `character_id`),
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `index_character_likes_on_account_id_and_created_at` ON `character_likes` (`account_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `index_character_likes_on_character_id` ON `character_likes` (`character_id`);--> statement-breakpoint
CREATE TABLE `plot_characters` (
	`id` integer PRIMARY KEY NOT NULL,
	`plot_id` integer NOT NULL,
	`character_id` integer NOT NULL,
	`speaker_key` text(32) NOT NULL,
	`role_name` text DEFAULT '' NOT NULL,
	`role_description` text DEFAULT '' NOT NULL,
	`is_lead` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`plot_id`) REFERENCES `plots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `index_plot_characters_on_plot_id_and_character_id` ON `plot_characters` (`plot_id`,`character_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `index_plot_characters_on_plot_id_and_speaker_key` ON `plot_characters` (`plot_id`,`speaker_key`);--> statement-breakpoint
CREATE INDEX `index_plot_characters_on_character_id_and_is_lead` ON `plot_characters` (`character_id`,`is_lead`);--> statement-breakpoint
CREATE TABLE `plot_images` (
	`id` integer PRIMARY KEY NOT NULL,
	`plot_id` integer NOT NULL,
	`image_id` integer NOT NULL,
	`situation` text(50) DEFAULT '' NOT NULL,
	`secret` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`plot_id`) REFERENCES `plots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`image_id`) REFERENCES `images`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `index_plot_images_on_plot_id_and_image_id` ON `plot_images` (`plot_id`,`image_id`);--> statement-breakpoint
CREATE INDEX `index_plot_images_on_plot_id_and_position` ON `plot_images` (`plot_id`,`position`);--> statement-breakpoint
CREATE INDEX `index_plot_images_on_image_id` ON `plot_images` (`image_id`);--> statement-breakpoint
CREATE TABLE `plot_likes` (
	`account_id` integer NOT NULL,
	`plot_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`account_id`, `plot_id`),
	FOREIGN KEY (`plot_id`) REFERENCES `plots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `index_plot_likes_on_account_id_and_created_at` ON `plot_likes` (`account_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `index_plot_likes_on_plot_id` ON `plot_likes` (`plot_id`);--> statement-breakpoint
CREATE TABLE `plot_lores` (
	`plot_id` integer NOT NULL,
	`lore_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`plot_id`, `lore_id`),
	FOREIGN KEY (`plot_id`) REFERENCES `plots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`lore_id`) REFERENCES `lores`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `index_plot_lores_on_lore_id` ON `plot_lores` (`lore_id`);