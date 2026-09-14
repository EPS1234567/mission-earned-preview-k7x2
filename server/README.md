# Mission Earned — volunteer portal service

The backend for volunteer intake: it receives applications from the public
form, gives staff a place to review them, and gives each applicant a private
page where they and staff can message each other and exchange documents.

This is **Mission Earned's own service**. It shares no infrastructure,
account, database or credentials with any other organisation.

## What it does

| Surface | Path | Who | Auth |
|---|---|---|---|
| Application intake | `POST /api/v1/applications` | the public form on the marketing site | none, cookieless |
| Staff review portal | `/staff/` | Mission Earned staff | email + password (+ TOTP for admins) |
| Candidate portal | `/p/` | one applicant, their case only | emailed single-use link |

Both authenticated surfaces are served by this service on **one origin**, so
session cookies are first-party. The public marketing site can stay wherever
it is; it posts here cross-origin without credentials.

## The parts that matter

**Documents move both ways.** An applicant attaches a résumé with the form and
can upload anything staff ask for (DD-214, certifications). Staff can send
documents out (onboarding packet, agreements). Every file is encrypted at rest
with its own key, and is only ever handed back through an authorising endpoint
as `application/octet-stream; attachment` — uploaded bytes can never render as
active content in a staff browser.

**Signatures.** Staff send a form; the applicant reads it and types their name
to sign. That works with a keyboard, a screen reader and no JavaScript.

**The candidate portal needs no JavaScript.** It is server-rendered HTML with
real form posts, because the people using it are veterans on old phones,
library machines and screen readers.

**What "secure messaging" honestly means here.** Messages are protected in
transit (HTTPS) and at rest (Postgres on a private network). They are **not**
end-to-end encrypted: Mission Earned staff can read them, which is the point.
Email notifications deliberately carry no message content — only the fact that
something is waiting, and a link. The portal says this to applicants in plain
language on every page. Do not describe it as end-to-end encrypted anywhere.

## Standing it up on Railway

You need a Railway account for Mission Earned. Do not reuse another
organisation's. Steps only the owner can do are marked **(owner)**.

1. **(owner)** Create a Railway account with a missionearned.org email and its
   own payment method. Create an empty project, e.g. `mission-earned`.

2. **Add Postgres.** In the project: *New → Database → Postgres*. Leave Public
   Access off so it is reachable only on the private network.

3. **Add this service.** *New → GitHub Repo*, pick this repository, and set the
   service **Root Directory** to `server`. Railway sees the `Dockerfile` and
   builds with it — no build command to configure.

4. **Set the variables.** Copy `.env.example`. For `DATABASE_URL` use the
   reference `${{Postgres.DATABASE_URL}}` so it resolves to the private
   hostname. Generate each 32-byte secret with:

   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

   Mark `FILE_MASTER_KEY`, `MAGICLINK_PEPPER`, `CSRF_HMAC_KEY`, `SMTP_PASS` and
   the S3 keys as **sealed**.

   > **Back up `FILE_MASTER_KEY` somewhere outside Railway before launch.**
   > A sealed variable cannot be read back. Lose it and every stored document
   > — every DD-214, every signed agreement — is permanently unreadable.

5. **Choose where documents live.**
   - *Simplest:* attach a Railway **Volume** mounted at `/data/blobs` and leave
     `STORAGE_DRIVER=local`. Note two things: a volume pins the service to one
     replica and makes every redeploy take the service down briefly, and the
     mount is root-owned, so run `chown -R node:node /data/blobs` once from the
     Railway shell or the container cannot write to it.
   - *Better as you grow:* any S3-compatible bucket. Set `STORAGE_DRIVER=s3`
     and the `S3_*` variables, and run `npm install @aws-sdk/client-s3` (it is
     loaded only when selected, so a volume deployment never ships it).

6. **Run the migrations.** Set the service's **Pre-deploy Command** to
   `npm run migrate`. It runs before the new version goes live; if it fails the
   deploy stops and the old version keeps serving.

7. **Add the domain.** *Settings → Networking → Custom Domain*, e.g.
   `app.missionearned.org`, and add the CNAME Railway gives you. Set
   `APP_ORIGIN` to exactly that URL.

8. **Set up email.** Any SMTP provider. **(owner)** Add SPF, DKIM and DMARC
   records for the sending domain — without them, magic links land in spam and
   applicants cannot get into their own case.

9. **Create the first staff account.** From the Railway shell:

   ```
   STAFF_PASSWORD='a long passphrase' npm run createstaff -- \
     --email you@missionearned.org --name "Your Name" --role admin
   ```

   Sign in at `/staff/`. An admin account must enrol an authenticator app on
   first sign-in.

10. **Point the form at it.** In the marketing site, set `apiBase` in
    `assets/js/config.js` to the service URL, and add that origin to
    `FORM_ORIGINS` here.

11. **Health check.** Set the service's healthcheck path to `/healthz`.

### Rough cost

Hobby plan, low volume: **$5–12/month** all in. Set a usage alert rather than a
hard limit — a hard limit takes the service offline, and this service is the
only way a veteran can apply.

## Running it locally

```
createdb mission_earned
cp .env.example .env        # fill in DATABASE_URL and the three secrets
npm install
npm run migrate
STAFF_PASSWORD='a long passphrase' npm run createstaff -- \
  --email you@example.com --name "You" --role admin
npm start
```

Then open http://localhost:3000/staff/.

Tests: `npm test` (unit). The end-to-end suites need a running server and a
database.

## Things to know before you trust it

These are real limits, not hypotheticals. Read them.

- **No virus scanning.** Uploads are validated by their actual bytes against a
  short allowlist (PDF, DOCX, JPEG, PNG, TIFF, HEIC), macro-bearing DOCX is
  rejected, and nothing is ever served as active content. There is no malware
  scanner: ClamAV needs roughly 1.2 GB of RAM, which is a real monthly cost for
  a nonprofit. `documents.scan_status` exists so one can be added later without
  a migration. Staff should still treat an attachment as they would any email
  attachment.

- **Deleting a document is not instant everywhere.** Shredding destroys the
  file's key, which makes the stored bytes unreadable immediately. Database
  backups taken before the shred still contain that key until they age out, so
  "deleted" becomes true for real once the last backup predating it expires.
  Decide your backup retention and say that number out loud.

- **The audit log is append-only by convention, not by permission.** The
  service connects as the database owner, which is what Railway's Postgres
  gives you. Making it tamper-proof means running migrations as a separate
  role from the app. Worth doing; not done here.

- **A candidate's email account is the boundary.** Access to a case is by
  emailed single-use link. If an applicant's email is compromised, so is their
  case. This is a deliberate trade: volunteers apply once, and a password
  account would mean a reused password plus a reset flow that comes back to
  email anyway. Staff can change the delivery address, which immediately
  revokes every outstanding link and session for that case.

- **No SSN is collected, anywhere.** The form has no field for one and the API
  rejects anything that looks like one in free text. A DD-214 often shows an
  SSN, which is why the upload page asks applicants to black it out and send
  Member Copy 4.
