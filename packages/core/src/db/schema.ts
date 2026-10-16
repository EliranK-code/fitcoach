import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

// Every tenant-owned table carries coach_id. Columns ending in `_enc` hold AES-256-GCM ciphertext
// produced with the owning coach's data key (see crypto.ts); they are never readable without it.

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const coaches = pgTable("coaches", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  /** active | suspended. A suspended coach can't log in and the bot doesn't answer their clients. */
  status: text("status").notNull().default("active"),
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  /** Coach-level settings: calorie floors, consent text version, timezone. */
  settings: jsonb("settings").$type<CoachSettings>().notNull().default({}),
  /** The coach's data-encryption key, wrapped by the master key. Deleting it crypto-shreds the coach's data. */
  wrappedDek: text("wrapped_dek").notNull(),
  knowledgeVersion: integer("knowledge_version").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export interface CoachSettings {
  /** Coaches may raise the calorie floors, never lower them below the platform minimum. */
  calorieFloorFemale?: number;
  calorieFloorMale?: number;
  timezone?: string;
  /** The coach's own consent notice; unset = the platform default. */
  consentText?: string;
  /** Recorded with every consent, so it's clear which wording a client agreed to. */
  consentVersion?: string;
  reminders?: ReminderSettings;
}

export const REMINDER_KINDS = ["weigh_in", "workout", "checkin"] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];
/** Everything a reminder message can be about: the client-scheduled kinds plus the automatic inactivity check-in. */
export type ReminderMessageKind = ReminderKind | "inactivity";

export interface ReminderSettings {
  /** No reminders between these local times ("HH:MM"). Default 21:30–08:00. */
  quietStart?: string;
  quietEnd?: string;
  /** Skip Friday afternoon to Saturday night. Default true. */
  skipShabbat?: boolean;
  /** Send a check-in after this many days without a message from the client; 0 = off. Default 4. */
  inactivityDays?: number;
  /** Free-form texts used inside the 24-hour window; {name} is replaced with the client's first name. */
  texts?: Partial<Record<ReminderMessageKind, string>>;
  /** Approved WhatsApp templates used outside the window ({{1}} = first name). Without one, that reminder is skipped. */
  templates?: Partial<Record<ReminderMessageKind, { name: string; language: string }>>;
}

export const coachKnowledge = pgTable(
  "coach_knowledge",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    coachId: uuid("coach_id").notNull().references(() => coaches.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    /** Structured coach.yaml content (validated by knowledge/schema.ts). */
    data: jsonb("data").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("coach_knowledge_coach_version").on(t.coachId, t.version)],
);

export const knowledgeDocuments = pgTable(
  "knowledge_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    coachId: uuid("coach_id").notNull().references(() => coaches.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    extractedText: text("extracted_text").notNull(),
    tokenEstimate: integer("token_estimate").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("knowledge_documents_coach").on(t.coachId)],
);

export const EMBEDDING_DIMENSIONS = 1536;

export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    coachId: uuid("coach_id").notNull().references(() => coaches.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    createdAt: createdAt(),
  },
  (t) => [
    index("knowledge_chunks_coach").on(t.coachId),
    index("knowledge_chunks_embedding").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

export const whatsappAccounts = pgTable(
  "whatsapp_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    coachId: uuid("coach_id").notNull().references(() => coaches.id, { onDelete: "cascade" }),
    phoneNumberId: text("phone_number_id").notNull().unique(),
    wabaId: text("waba_id"),
    displayPhone: text("display_phone"),
    /** managed = number lives under the platform's Meta account; embedded = coach connected their own via Embedded Signup. */
    mode: text("mode").notNull().default("managed"),
    accessTokenEnc: text("access_token_enc"),
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
  },
  (t) => [index("whatsapp_accounts_coach").on(t.coachId)],
);

export const clients = pgTable(
  "clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    coachId: uuid("coach_id").notNull().references(() => coaches.id, { onDelete: "cascade" }),
    /** HMAC of the normalized phone number, for lookup without storing it in the clear. */
    phoneHash: text("phone_hash").notNull(),
    phoneEnc: text("phone_enc").notNull(),
    channel: text("channel").notNull().default("whatsapp"),
    isTest: boolean("is_test").notNull().default(false),
    consentStatus: text("consent_status").notNull().default("pending"),
    consentAt: timestamp("consent_at", { withTimezone: true }),
    consentVersion: text("consent_version"),
    botPaused: boolean("bot_paused").notNull().default(false),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    flags: jsonb("flags").$type<ClientFlags>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("clients_coach_phone").on(t.coachId, t.phoneHash),
    index("clients_coach").on(t.coachId),
  ],
);

export interface ClientFlags {
  minor?: boolean;
  eatingDisorderRisk?: boolean;
  /** When the consent notice was sent; a "yes" only counts as consent after the client has seen it. */
  consentPromptedAt?: string;
  /** The client asked not to receive any proactive messages. */
  remindersOptOut?: boolean;
  /** Last automatic inactivity check-in, so one quiet stretch gets one nudge. */
  lastCheckinAt?: string;
  /** When this client got the "service unavailable" notice, so one suspension gets one notice. */
  suspensionNoticeAt?: string;
  /** Set when the client asked to delete their data and we are waiting for confirmation. */
  pendingDeletionAt?: string;
}

export const clientProfiles = pgTable("client_profiles", {
  clientId: uuid("client_id")
    .primaryKey()
    .references(() => clients.id, { onDelete: "cascade" }),
  coachId: uuid("coach_id").notNull().references(() => coaches.id, { onDelete: "cascade" }),
  dataEnc: text("data_enc").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Long-term memory: the rolling summary carried from one conversation epoch to the next. */
export const clientMemory = pgTable("client_memory", {
  clientId: uuid("client_id")
    .primaryKey()
    .references(() => clients.id, { onDelete: "cascade" }),
  coachId: uuid("coach_id").notNull().references(() => coaches.id, { onDelete: "cascade" }),
  summaryEnc: text("summary_enc").notNull(),
  recentEnc: text("recent_enc"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One epoch = one stretch of conversation with a frozen system prompt and an append-only message list.
 * Claude's thinking blocks are bound to the exact prefix that produced them, so nothing inside an epoch
 * is ever edited; when the epoch grows too long it is summarized and a fresh one starts.
 */
export const conversationEpochs = pgTable(
  "conversation_epochs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    coachId: uuid("coach_id").notNull().references(() => coaches.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    status: text("status").notNull().default("active"),
    systemEnc: text("system_enc").notNull(),
    knowledgeVersion: integer("knowledge_version").notNull(),
    /** Fingerprint of the platform rules and tool definitions the epoch was frozen with. */
    platformHash: text("platform_hash").notNull().default(""),
    lastContextTokens: integer("last_context_tokens").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closeReason: text("close_reason"),
  },
  (t) => [
    uniqueIndex("conversation_epochs_client_seq").on(t.clientId, t.seq),
    index("conversation_epochs_coach").on(t.coachId),
  ],
);

export const llmMessages = pgTable(
  "llm_messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    coachId: uuid("coach_id").notNull().references(() => coaches.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    epochId: uuid("epoch_id")
      .notNull()
      .references(() => conversationEpochs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    role: text("role").notNull(),
    contentEnc: text("content_enc").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("llm_messages_epoch_seq").on(t.epochId, t.seq)],
);

/** The human-readable conversation as the client and coach see it (WhatsApp, CLI, playground). */
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    coachId: uuid("coach_id").notNull().references(() => coaches.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    direction: text("direction").notNull(),
    sender: text("sender").notNull(),
    kind: text("kind").notNull().default("text"),
    bodyEnc: text("body_enc"),
    externalId: text("external_id").unique(),
    /** Delivery status from WhatsApp for outbound messages: sent, delivered, read, failed. */
    status: text("status"),
    /**
     * false for messages the bot's model hasn't seen: the coach's own messages and client messages that
     * arrived while the bot was paused. They are handed to the model as a record on its next turn.
     */
    botSeen: boolean("bot_seen").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("chat_messages_client").on(t.clientId, t.createdAt)],
);

/**
 * Raw inbound WhatsApp messages, stored by the webhook before it answers Meta. The external id makes
 * redelivered webhooks a no-op. Bodies are cleared once processed; chat_messages keeps the readable log.
 */
export const inboundMessages = pgTable(
  "inbound_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    coachId: uuid("coach_id").notNull().references(() => coaches.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    phoneNumberId: text("phone_number_id").notNull(),
    externalId: text("external_id").notNull().unique(),
    kind: text("kind").notNull(),
    bodyEnc: text("body_enc"),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: createdAt(),
  },
  (t) => [index("inbound_messages_client_status").on(t.clientId, t.status, t.sentAt)],
);

/**
 * One row per client with unprocessed inbound messages. The webhook pushes run_at forward on every new
 * message (debounce), and the worker claims rows with FOR UPDATE SKIP LOCKED, so each client's messages
 * are handled one turn at a time, in order. Works the same on PGlite and on Supabase.
 */
export const turnJobs = pgTable(
  "turn_jobs",
  {
    clientId: uuid("client_id")
      .primaryKey()
      .references(() => clients.id, { onDelete: "cascade" }),
    coachId: uuid("coach_id").notNull().references(() => coaches.id, { onDelete: "cascade" }),
    phoneNumberId: text("phone_number_id").notNull(),
    runAt: timestamp("run_at", { withTimezone: true }).notNull(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: createdAt(),
  },
  (t) => [index("turn_jobs_run_at").on(t.runAt)],
);

export const weightLogs = pgTable(
  "weight_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    coachId: uuid("coach_id").notNull().references(() => coaches.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    weightKg: doublePrecision("weight_kg").notNull(),
    measuredOn: text("measured_on").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("weight_logs_client").on(t.clientId, t.measuredOn)],
);

export const mealLogs = pgTable(
  "meal_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    coachId: uuid("coach_id").notNull().references(() => coaches.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    eatenOn: text("eaten_on").notNull(),
    mealType: text("meal_type").notNull(),
    descriptionEnc: text("description_enc").notNull(),
    estCalories: integer("est_calories"),
    estProteinG: integer("est_protein_g"),
    createdAt: createdAt(),
  },
  (t) => [index("meal_logs_client").on(t.clientId, t.eatenOn)],
);

export interface LoggedExercise {
  name: string;
  sets: number;
  reps: number;
  weightKg: number;
}

export const workoutLogs = pgTable(
  "workout_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    coachId: uuid("coach_id").notNull().references(() => coaches.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    performedOn: text("performed_on").notNull(),
    title: text("title").notNull(),
    durationMin: integer("duration_min"),
    exercises: jsonb("exercises").$type<LoggedExercise[]>().notNull().default([]),
    notesEnc: text("notes_enc"),
    createdAt: createdAt(),
  },
  (t) => [index("workout_logs_client").on(t.clientId, t.performedOn)],
);

export const mealPlans = pgTable(
  "meal_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    coachId: uuid("coach_id").notNull().references(() => coaches.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    planEnc: text("plan_enc").notNull(),
    dailyCalories: integer("daily_calories").notNull(),
    proteinG: integer("protein_g"),
    showNumbers: boolean("show_numbers").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("meal_plans_client_version").on(t.clientId, t.version)],
);

export interface PlannedExercise {
  name: string;
  sets: number;
  reps: string;
  targetWeightKg: number;
  notes: string;
}

export interface PlannedDay {
  label: string;
  exercises: PlannedExercise[];
}

export const workoutPlans = pgTable(
  "workout_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    coachId: uuid("coach_id").notNull().references(() => coaches.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    days: jsonb("days").$type<PlannedDay[]>().notNull(),
    progressionRule: text("progression_rule").notNull(),
    planEnc: text("plan_enc").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("workout_plans_client_version").on(t.clientId, t.version)],
);

export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    coachId: uuid("coach_id").notNull().references(() => coaches.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    severity: text("severity").notNull(),
    source: text("source").notNull(),
    summaryEnc: text("summary_enc").notNull(),
    questionEnc: text("question_enc"),
    status: text("status").notNull().default("open"),
    resolutionEnc: text("resolution_enc"),
    createdAt: createdAt(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [index("alerts_coach_status").on(t.coachId, t.status, t.createdAt)],
);

export const usageEvents = pgTable(
  "usage_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    coachId: uuid("coach_id").notNull().references(() => coaches.id, { onDelete: "cascade" }),
    // No FK: usage stays countable for billing after a client is deleted.
    clientId: uuid("client_id"),
    kind: text("kind").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("usage_events_coach").on(t.coachId, t.createdAt)],
);

/**
 * Proactive reminders a client asked for (weigh-in, workout days, weekly check-in). next_run_at is the
 * next allowed occurrence in the coach's time zone, already skipping quiet hours and Shabbat.
 */
export const reminders = pgTable(
  "reminders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    coachId: uuid("coach_id").notNull().references(() => coaches.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    kind: text("kind").$type<ReminderKind>().notNull(),
    /** 0 = Sunday … 6 = Saturday. */
    days: jsonb("days").$type<number[]>().notNull(),
    time: text("time").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("reminders_client_kind").on(t.clientId, t.kind), index("reminders_next_run").on(t.nextRunAt)],
);

/** People who log into a coach's dashboard. Passwords are scrypt hashes; never stored or logged in clear. */
export const coachUsers = pgTable(
  "coach_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    coachId: uuid("coach_id").notNull().references(() => coaches.id, { onDelete: "cascade" }),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").notNull().default("owner"),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("coach_users_coach").on(t.coachId)],
);

/** Dashboard sessions. Only a SHA-256 of the cookie token is stored, so a DB leak doesn't leak sessions. */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => coachUsers.id, { onDelete: "cascade" }),
    coachId: uuid("coach_id").notNull().references(() => coaches.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user").on(t.userId)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    coachId: uuid("coach_id").notNull().references(() => coaches.id, { onDelete: "cascade" }),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    // No FK: audit entries must outlive the client they describe.
    targetId: text("target_id"),
    meta: jsonb("meta").notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index("audit_log_coach").on(t.coachId, t.createdAt)],
);

/**
 * Platform operations on coaches (suspend, resume, delete). No FK to coaches: a deletion record, with the
 * usage summary needed for billing, outlives the coach. Tenants have no access to it (migration 0006).
 */
export const platformAudit = pgTable(
  "platform_audit",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    coachId: uuid("coach_id"),
    coachSlug: text("coach_slug"),
    meta: jsonb("meta").notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index("platform_audit_created").on(t.createdAt)],
);

