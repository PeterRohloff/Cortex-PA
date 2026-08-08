/* =====================================================================
   Cortex-PA — Azure SQL schema (Phase 1: Teams chats)
   ---------------------------------------------------------------------
   Design references: docs/DESIGN.md §5 (data model), §9 (RBAC),
   §11 (audit log). Evidence integrity uses SQL Ledger tables so any
   after-the-fact tampering is cryptographically detectable.

   Apply with: sqlcmd -G (Entra auth) or via the runbook in
   docs/IMPLEMENTATION.md. Idempotent-ish: guarded with IF NOT EXISTS.
   ===================================================================== */

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

/* ---------- Identities (people resolved from Graph) ---------------- */
IF OBJECT_ID('dbo.Identity', 'U') IS NULL
CREATE TABLE dbo.[Identity] (
    object_id           UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,   -- Entra object id
    display_name        NVARCHAR(256)    NULL,
    upn                 NVARCHAR(256)    NULL,
    mail                NVARCHAR(256)    NULL,
    sam_account_name    NVARCHAR(128)    NULL,
    avatar_blob_ref     NVARCHAR(512)    NULL,
    updated_at          DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX IX_Identity_upn  ON dbo.[Identity](upn);
CREATE INDEX IX_Identity_mail ON dbo.[Identity](mail);
CREATE INDEX IX_Identity_sam  ON dbo.[Identity](sam_account_name);
CREATE INDEX IX_Identity_name ON dbo.[Identity](display_name);
GO

/* ---------- Cases -------------------------------------------------- */
/* Updatable LEDGER: edits allowed (status, description, counters) but
   every change is recorded in the ledger history. case_number and
   project_codename are never updated by the application. */
IF OBJECT_ID('dbo.[Case]', 'U') IS NULL
CREATE TABLE dbo.[Case] (
    case_id             UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    case_number         NVARCHAR(32)     NOT NULL UNIQUE,        -- CTX-YYYY-###### (immutable)
    project_codename    NVARCHAR(64)     NOT NULL UNIQUE,        -- e.g. "SILENT MERIDIAN" (immutable)
    description_html    NVARCHAR(MAX)    NULL,                   -- sanitized rich text
    status              NVARCHAR(16)     NOT NULL DEFAULT 'Active',   -- Active | Archived
    continue_collecting BIT              NOT NULL DEFAULT 0,
    update_count        INT              NOT NULL DEFAULT 0,     -- drives the bell
    created_by_oid      UNIQUEIDENTIFIER NOT NULL,
    created_by_name     NVARCHAR(256)    NULL,
    created_at          DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME()
)
WITH (SYSTEM_VERSIONING = ON, LEDGER = ON);
GO

/* Monotonic, gap-tolerant case number source (never reused). */
IF OBJECT_ID('dbo.CaseSeq', 'U') IS NULL
CREATE TABLE dbo.CaseSeq (id INT IDENTITY(1,1) PRIMARY KEY, ts DATETIME2 DEFAULT SYSUTCDATETIME());
GO

/* ---------- Custodians / non-custodians (free text) --------------- */
IF OBJECT_ID('dbo.Custodian', 'U') IS NULL
CREATE TABLE dbo.Custodian (
    custodian_id        UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    case_id             UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.[Case](case_id),
    name                NVARCHAR(256)    NOT NULL,
    email               NVARCHAR(256)    NULL,
    kind                NVARCHAR(16)     NOT NULL DEFAULT 'Custodian'  -- Custodian | NonCustodian
);
GO
CREATE INDEX IX_Custodian_case ON dbo.Custodian(case_id);
GO

/* ---------- Case membership (per-case RBAC) ----------------------- */
IF OBJECT_ID('dbo.CaseMember', 'U') IS NULL
CREATE TABLE dbo.CaseMember (
    case_id             UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.[Case](case_id),
    member_oid          UNIQUEIDENTIFIER NOT NULL,               -- Entra object id
    member_name         NVARCHAR(256)    NULL,
    role                NVARCHAR(16)     NOT NULL,               -- Owner | Member
    granted_by_oid      UNIQUEIDENTIFIER NOT NULL,
    granted_at          DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_CaseMember PRIMARY KEY (case_id, member_oid)
);
GO
CREATE INDEX IX_CaseMember_member ON dbo.CaseMember(member_oid);
GO

/* ---------- Conversations & messages ------------------------------ */
IF OBJECT_ID('dbo.Conversation', 'U') IS NULL
CREATE TABLE dbo.Conversation (
    conversation_id     NVARCHAR(256)    NOT NULL PRIMARY KEY,   -- Graph chat id or channel id
    source_type         NVARCHAR(16)     NOT NULL,               -- OneOnOne | Group | Meeting | Channel
    team_id             NVARCHAR(256)    NULL,
    team_name           NVARCHAR(512)    NULL,
    channel_id          NVARCHAR(256)    NULL,
    channel_name        NVARCHAR(512)    NULL,
    topic               NVARCHAR(1024)   NULL,
    participants_json   NVARCHAR(MAX)    NULL,                   -- resolved [{oid,name,upn}]
    first_message_at    DATETIME2        NULL,
    last_message_at     DATETIME2        NULL
);
GO
CREATE INDEX IX_Conversation_team    ON dbo.Conversation(team_name);
CREATE INDEX IX_Conversation_channel ON dbo.Conversation(channel_name);
GO

IF OBJECT_ID('dbo.Message', 'U') IS NULL
CREATE TABLE dbo.Message (
    message_id          NVARCHAR(256)    NOT NULL PRIMARY KEY,   -- Graph message id
    conversation_id     NVARCHAR(256)    NOT NULL REFERENCES dbo.Conversation(conversation_id),
    reply_to_id         NVARCHAR(256)    NULL,                   -- threading (channel replies)
    from_oid            UNIQUEIDENTIFIER NULL,
    from_name           NVARCHAR(256)    NULL,
    body_text           NVARCHAR(MAX)    NULL,                   -- plain text for search
    body_blob_ref       NVARCHAR(512)    NULL,                   -- sanitized HTML body in Blob
    message_type        NVARCHAR(32)     NOT NULL DEFAULT 'message',
    created_at          DATETIME2        NULL,
    last_edited_at      DATETIME2        NULL,
    deleted_at          DATETIME2        NULL,
    content_sha256      CHAR(64)         NULL,                   -- chain of custody
    collected_at        DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX IX_Message_conv    ON dbo.Message(conversation_id, created_at);
CREATE INDEX IX_Message_from    ON dbo.Message(from_oid);
CREATE INDEX IX_Message_created ON dbo.Message(created_at);
GO
/* Full-text is optional; MVP uses LIKE on body_text. To enable FTS:
   CREATE FULLTEXT CATALOG cortex_ft AS DEFAULT;
   CREATE FULLTEXT INDEX ON dbo.Message(body_text) KEY INDEX PK__Message... ; */

IF OBJECT_ID('dbo.Reaction', 'U') IS NULL
CREATE TABLE dbo.Reaction (
    reaction_id         BIGINT           NOT NULL IDENTITY PRIMARY KEY,
    message_id          NVARCHAR(256)    NOT NULL REFERENCES dbo.Message(message_id),
    reaction_type       NVARCHAR(64)     NOT NULL,               -- like, heart, laugh, ...
    actor_oid           UNIQUEIDENTIFIER NULL,
    actor_name          NVARCHAR(256)    NULL,
    created_at          DATETIME2        NULL
);
GO
CREATE INDEX IX_Reaction_msg  ON dbo.Reaction(message_id);
CREATE INDEX IX_Reaction_type ON dbo.Reaction(reaction_type);
GO

IF OBJECT_ID('dbo.Attachment', 'U') IS NULL
CREATE TABLE dbo.Attachment (
    attachment_id       BIGINT           NOT NULL IDENTITY PRIMARY KEY,
    message_id          NVARCHAR(256)    NOT NULL REFERENCES dbo.Message(message_id),
    name                NVARCHAR(512)    NULL,
    content_type        NVARCHAR(256)    NULL,
    blob_ref            NVARCHAR(512)    NULL,
    content_sha256      CHAR(64)         NULL
);
GO
CREATE INDEX IX_Attachment_msg ON dbo.Attachment(message_id);
CREATE INDEX IX_Attachment_name ON dbo.Attachment(name);
GO

/* Which cases a message belongs to (many-to-many). */
IF OBJECT_ID('dbo.CaseMessage', 'U') IS NULL
CREATE TABLE dbo.CaseMessage (
    case_id             UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.[Case](case_id),
    message_id          NVARCHAR(256)    NOT NULL REFERENCES dbo.Message(message_id),
    added_by_oid        UNIQUEIDENTIFIER NOT NULL,
    added_at            DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    is_new_since_review BIT              NOT NULL DEFAULT 0,     -- surfaced by the bell
    CONSTRAINT PK_CaseMessage PRIMARY KEY (case_id, message_id)
);
GO
CREATE INDEX IX_CaseMessage_case ON dbo.CaseMessage(case_id);
GO

/* Reviewer tags on evidence within a case. */
IF OBJECT_ID('dbo.Tag', 'U') IS NULL
CREATE TABLE dbo.Tag (
    tag_id              BIGINT           NOT NULL IDENTITY PRIMARY KEY,
    case_id             UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.[Case](case_id),
    message_id          NVARCHAR(256)    NOT NULL REFERENCES dbo.Message(message_id),
    tag_text            NVARCHAR(128)    NOT NULL,
    tagged_by_oid       UNIQUEIDENTIFIER NOT NULL,
    tagged_at           DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX IX_Tag_case ON dbo.Tag(case_id, message_id);
GO

/* Active continuous-collection subscriptions, with the legal attestation
   that authorized them (design §8.3). */
IF OBJECT_ID('dbo.CollectionSubscription', 'U') IS NULL
CREATE TABLE dbo.CollectionSubscription (
    subscription_id     NVARCHAR(128)    NOT NULL PRIMARY KEY,   -- Graph subscription id
    case_id             UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.[Case](case_id),
    resource            NVARCHAR(256)    NOT NULL,               -- /chats/getAllMessages etc.
    client_state        NVARCHAR(128)    NULL,                   -- validates inbound notifications
    expires_at          DATETIME2        NULL,
    authorized_by_oid   UNIQUEIDENTIFIER NOT NULL,               -- who ticked the attestation
    authorized_by_name  NVARCHAR(256)    NULL,
    authorized_at       DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    active              BIT              NOT NULL DEFAULT 1
);
GO

/* Custodian Entra object ids a case actively monitors for continuous
   collection. New messages whose sender matches are auto-added (design §4.2). */
IF OBJECT_ID('dbo.CaseMonitoredUser', 'U') IS NULL
CREATE TABLE dbo.CaseMonitoredUser (
    case_id             UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.[Case](case_id),
    user_oid            UNIQUEIDENTIFIER NOT NULL,
    added_by_oid        UNIQUEIDENTIFIER NOT NULL,
    added_at            DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_CaseMonitoredUser PRIMARY KEY (case_id, user_oid)
);
GO
CREATE INDEX IX_CaseMonitoredUser_user ON dbo.CaseMonitoredUser(user_oid);
GO

/* ---------- Audit log (append-only LEDGER; admin-only) ------------ */
IF OBJECT_ID('dbo.AuditEvent', 'U') IS NULL
CREATE TABLE dbo.AuditEvent (
    audit_id            BIGINT           NOT NULL IDENTITY PRIMARY KEY,
    occurred_at         DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    actor_oid           UNIQUEIDENTIFIER NULL,
    actor_name          NVARCHAR(256)    NULL,
    actor_upn           NVARCHAR(256)    NULL,
    action              NVARCHAR(64)     NOT NULL,               -- LOGIN, SEARCH, VIEW_CONVERSATION, CREATE_CASE, ...
    target_type         NVARCHAR(64)     NULL,                   -- Case, Message, Export, Subscription, ...
    target_id           NVARCHAR(256)    NULL,
    detail_json         NVARCHAR(MAX)    NULL,                   -- e.g. attestation text, filters used
    result              NVARCHAR(16)     NOT NULL DEFAULT 'Success'
)
WITH (LEDGER = ON (APPEND_ONLY = ON));
GO
CREATE INDEX IX_Audit_time  ON dbo.AuditEvent(occurred_at);
CREATE INDEX IX_Audit_actor ON dbo.AuditEvent(actor_oid);
GO

PRINT 'Cortex-PA schema applied.';
GO
