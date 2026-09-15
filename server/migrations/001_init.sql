-- Mission Earned volunteer intake, review, messaging and document exchange.
--
-- Design notes that matter later:
--  * Every field the portal filters, searches, sorts or exports on is a real
--    column. Everything else rides in extra_answers, and raw_submission keeps
--    an immutable copy of exactly what was posted.
--  * No SSN and no date of birth is collected anywhere, by design. A DD-214
--    carries an SSN, which is why documents are encrypted at rest and can be
--    shredded without touching the verification decision they supported.
--  * Secrets are never stored in the clear: session and magic-link tokens are
--    kept as digests, document keys as wrapped DEKs.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- staff ----

CREATE TYPE staff_role AS ENUM ('reviewer', 'admin');

CREATE TABLE staff (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text        NOT NULL,
  name           text        NOT NULL,
  role           staff_role  NOT NULL DEFAULT 'reviewer',
  password_hash  text        NOT NULL,
  totp_secret    text,
  totp_confirmed boolean     NOT NULL DEFAULT false,
  is_active      boolean     NOT NULL DEFAULT true,
  failed_logins  integer     NOT NULL DEFAULT 0,
  locked_until   timestamptz,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX staff_email_key ON staff (lower(email));

-- Staff browser sessions. Only the digest of the token is stored, so a
-- database dump yields no usable session.
CREATE TABLE staff_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id      uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  token_sha256  bytea NOT NULL UNIQUE,
  totp_verified boolean NOT NULL DEFAULT false,
  ip            inet,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);
CREATE INDEX staff_sessions_staff_idx ON staff_sessions (staff_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------- applications ----

CREATE TYPE application_status AS ENUM (
  'received', 'in_review', 'interview_scheduled', 'interviewed',
  'onboarding', 'active', 'on_hold', 'withdrawn', 'declined'
);

CREATE TABLE applications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference           text NOT NULL UNIQUE,

  -- contact
  title               text,
  first_name          text NOT NULL,
  last_name           text NOT NULL,
  email               text NOT NULL,
  phone               text NOT NULL,
  address             text,
  city                text,
  state               text,
  zip                 text,
  contact_method      text,

  -- background
  military_connection text,
  branch              text,
  occupation          text,
  education           text,

  -- interests and availability (multi-select)
  interests           text[] NOT NULL DEFAULT '{}',
  interests_other     text,
  availability        text[] NOT NULL DEFAULT '{}',
  volunteer_setting   text,
  willing_to_travel   text,
  start_date          date,

  -- experience
  has_experience      text,
  experience_detail   text,
  speaks_languages    text,
  languages_detail    text,

  -- about
  motivation          text,
  anything_else       text,

  -- agreements, recorded individually because they are legal attestations
  agree_age           boolean NOT NULL DEFAULT false,
  agree_review        boolean NOT NULL DEFAULT false,
  agree_screening     boolean NOT NULL DEFAULT false,
  agree_assignment    boolean NOT NULL DEFAULT false,
  agree_accurate      boolean NOT NULL DEFAULT false,

  -- signature as submitted (PNG data URL from the signature pad)
  signature_name      text,
  signature_date      date,
  signature_png       text,

  -- anything the form grows later, plus an immutable copy of the post
  extra_answers       jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_submission      jsonb NOT NULL,

  -- review state
  status              application_status NOT NULL DEFAULT 'received',
  assigned_staff_id   uuid REFERENCES staff(id) ON DELETE SET NULL,
  decided_at          timestamptz,
  decided_by          uuid REFERENCES staff(id) ON DELETE SET NULL,
  decision_reason     text,

  submitted_ip        inet,
  received_at         timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  purge_after         timestamptz
);

CREATE INDEX applications_received_idx ON applications (received_at DESC, id DESC);
CREATE INDEX applications_status_idx   ON applications (status, received_at DESC);
CREATE INDEX applications_assigned_idx ON applications (assigned_staff_id) WHERE assigned_staff_id IS NOT NULL;
CREATE INDEX applications_email_idx    ON applications (lower(email));
CREATE INDEX applications_interests_idx ON applications USING gin (interests);

-- Free-text search across the fields staff actually search by.
ALTER TABLE applications ADD COLUMN search_text text
  GENERATED ALWAYS AS (
    coalesce(first_name,'') || ' ' || coalesce(last_name,'') || ' ' ||
    coalesce(email,'')      || ' ' || coalesce(phone,'')     || ' ' ||
    coalesce(city,'')       || ' ' || coalesce(state,'')     || ' ' ||
    coalesce(occupation,'') || ' ' || coalesce(military_connection,'')
  ) STORED;
CREATE INDEX applications_search_idx ON applications
  USING gin (to_tsvector('simple', search_text));

-- Status changes are a record, not just a column overwrite.
CREATE TABLE application_status_events (
  id             bigserial PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  from_status    application_status,
  to_status      application_status NOT NULL,
  staff_id       uuid REFERENCES staff(id) ON DELETE SET NULL,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX application_status_events_app_idx ON application_status_events (application_id, created_at DESC);

-- Internal reviewer notes. Never visible to the candidate.
CREATE TABLE review_notes (
  id             bigserial PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  staff_id       uuid REFERENCES staff(id) ON DELETE SET NULL,
  body           text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_notes_app_idx ON review_notes (application_id, created_at DESC);

-- ------------------------------------------------------------- messaging ----

CREATE TYPE message_author AS ENUM ('staff', 'candidate');

CREATE TABLE messages (
  id             bigserial PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  author         message_author NOT NULL,
  staff_id       uuid REFERENCES staff(id) ON DELETE SET NULL,
  body           text NOT NULL,
  read_by_staff_at     timestamptz,
  read_by_candidate_at timestamptz,
  notified_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_app_idx ON messages (application_id, created_at);
CREATE INDEX messages_unread_staff_idx ON messages (application_id)
  WHERE author = 'candidate' AND read_by_staff_at IS NULL;

-- ------------------------------------------------------------- documents ----

CREATE TYPE document_direction AS ENUM ('inbound', 'outbound');
CREATE TYPE scan_state AS ENUM ('pending', 'clean', 'infected', 'skipped');

CREATE TABLE documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  direction      document_direction NOT NULL,
  kind           text,
  filename       text NOT NULL,
  mime_type      text NOT NULL,
  size_bytes     bigint NOT NULL CHECK (size_bytes > 0),
  sha256         bytea NOT NULL,
  storage_key    text NOT NULL UNIQUE,
  -- AES-256-GCM envelope: the per-file key, itself encrypted under the master key
  wrapped_dek    bytea NOT NULL,
  dek_iv         bytea NOT NULL,
  dek_tag        bytea NOT NULL,
  file_iv        bytea NOT NULL,
  file_tag       bytea NOT NULL,
  scan_status    scan_state NOT NULL DEFAULT 'pending',
  uploaded_by_staff_id uuid REFERENCES staff(id) ON DELETE SET NULL,
  request_id     bigint,
  created_at     timestamptz NOT NULL DEFAULT now(),
  shredded_at    timestamptz,
  purge_after    timestamptz
);
CREATE INDEX documents_app_idx ON documents (application_id, created_at DESC);

-- Staff asking a candidate for a specific document.
CREATE TABLE document_requests (
  id             bigserial PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  kind           text NOT NULL,
  instructions   text,
  requested_by   uuid REFERENCES staff(id) ON DELETE SET NULL,
  fulfilled_by_document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  fulfilled_at   timestamptz,
  cancelled_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_requests_app_idx ON document_requests (application_id, created_at DESC);

ALTER TABLE documents
  ADD CONSTRAINT documents_request_fk
  FOREIGN KEY (request_id) REFERENCES document_requests(id) ON DELETE SET NULL;

-- --------------------------------------------------- forms for signature ----

CREATE TABLE signature_requests (
  id             bigserial PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  title          text NOT NULL,
  body           text NOT NULL,          -- the text the candidate is agreeing to
  requested_by   uuid REFERENCES staff(id) ON DELETE SET NULL,
  signed_at      timestamptz,
  signed_name    text,
  signature_png  text,
  signed_ip      inet,
  signed_user_agent text,
  cancelled_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX signature_requests_app_idx ON signature_requests (application_id, created_at DESC);

-- -------------------------------------------------- candidate case access ----

-- Emailed magic links. selector is looked up; only the HMAC of the verifier is
-- stored, so the table alone cannot be used to mint a session.
CREATE TABLE case_tokens (
  id             bigserial PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  selector       text NOT NULL UNIQUE,
  verifier_hmac  bytea NOT NULL,
  purpose        text NOT NULL DEFAULT 'case_access',
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX case_tokens_app_idx ON case_tokens (application_id);

CREATE TABLE case_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  token_sha256   bytea NOT NULL UNIQUE,
  ip             inet,
  user_agent     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz
);
CREATE INDEX case_sessions_app_idx ON case_sessions (application_id) WHERE revoked_at IS NULL;

-- ------------------------------------------------------------- plumbing ----

-- A double-click, a retry and a refresh-resubmit must all be one application.
CREATE TABLE idempotency_keys (
  key            text PRIMARY KEY,
  application_id uuid REFERENCES applications(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id             bigserial PRIMARY KEY,
  actor_type     text NOT NULL,            -- 'staff' | 'candidate' | 'system' | 'public'
  actor_id       text,
  action         text NOT NULL,
  application_id uuid,
  detail         jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip             inet,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_app_idx ON audit_log (application_id, created_at DESC);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);

CREATE TABLE rate_limits (
  bucket     text PRIMARY KEY,
  count      integer NOT NULL DEFAULT 0,
  reset_at   timestamptz NOT NULL
);
