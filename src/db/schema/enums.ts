// enum は本体と同じ数値をそのまま使う。廃止した値は欠番にしてある
export const RATINGS = { general: 0, nsfw: 1, r18: 2, rejected: 3 } as const;
export const CONTENT_STATUSES = { normal: 0, locked: 1, deleted: 2 } as const;
export const VISIBILITIES = { opened: 0, limited: 1, closed: 2 } as const;
export const CHAT_STATUSES = { normal: 0, archived: 2, deleted: 3 } as const;
export const REPLY_STYLES = { balanced: 0, dialogue: 1, narration: 2 } as const;
export const MESSAGE_ROLES = { user: 0, assistant: 1, system: 2 } as const;
export const MESSAGE_STATUSES = {
  normal: 0, pending: 1, streaming: 2, replaced: 3,
  hidden: 4, failed: 5, canceled: 6, deleted: 7,
} as const;
export const AI_MODEL_TIERS = { free: 0, premium: 1 } as const;
export const AI_MODEL_ROUTES = { auto: 0, direct: 1, cf_aig: 2, cf_aig_byok: 3 } as const;
export const AI_MODEL_APIS = { chat_completions: 0, responses: 1 } as const;
export const AI_USAGE_PURPOSES = { chat: 0, summary: 1, title: 2, moderation: 3 } as const;
