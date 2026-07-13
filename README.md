# seosanch-cell

Cloudflare Pages app for church cell and pastoral-care management.

This repository stores only application code and Cloudflare binding configuration. Do not commit real member photos, phone numbers, addresses, birth dates, family notes, visit notes, call summaries, spreadsheets, or PDF source files.

## Architecture

- Cloudflare Pages: web app hosting
- Pages Functions: API endpoints
- Cloudflare D1: members, cells, managed groups, notes/reminders, mobile-device registrations, push delivery state, visit notes, app settings, and audit logs
- Cloudflare R2: member photos
- Pages middleware: password/passkey login, signed secure session cookies, and login throttling
- Scheduled Worker: due-reminder ledger, retry/lease handling, and FCM HTTP v1 delivery

## Local development

Static UI can be opened from `public/index.html`. For Pages Functions and bindings, use Wrangler.

```powershell
npm run dev
```

## Build settings for Cloudflare Pages

- Framework preset: None
- Build command: `exit 0` or empty
- Build output directory: `public`
- Production branch: `main`

## Pages bindings

D1/R2 bindings are managed through `wrangler.jsonc`, because this Pages project is configured to use Wrangler-managed bindings.

Required production bindings:

- D1 binding: variable name `DB`, database `seosanch-cell-db`
- R2 binding: variable name `PHOTOS`, bucket `seosanch-member-photos`
- Pages secret: `NOTIFICATION_SECRET` (at least 32 random characters)

The same D1 database is bound to the separate Worker through `wrangler.notifications.jsonc`. The Worker intentionally has no photo-bucket binding.

## Cloudflare resources

Create the resources:

```powershell
npx wrangler d1 create seosanch-cell-db
npx wrangler r2 bucket create seosanch-member-photos
```

Apply the schema migrations:

```powershell
npx wrangler d1 migrations apply seosanch-cell-db --remote
```

For production, set a strong `SESSION_SECRET` and configure the administrator password from the app login/settings flow (or use `SITE_PASSWORD` as the initial fallback). Sessions expire one hour after the most recent real user activity. Use `CALL_NOTE_TOKEN` or `CALL_NOTE_WEBHOOK_TOKEN` only for the external Call Note webhook if you manage that token through Cloudflare environment variables.

The administrator can enable or replace a read-only guest password from Settings. Guest passwords are 4–6 characters, simple sequences are rejected, and six mixed characters are recommended. Guest sessions can read only active members' names, roles, photos, phone numbers, and addresses; notes, visitation records, attendance, and all write APIs are denied. Replacing or disabling the guest password invalidates existing guest sessions immediately.

## Android memo notifications

The web-side device API, one-use pairing flow, delivery ledger, administrator UI, and scheduled FCM sender are implemented. The Android implementation brief, checked against the current Kotlin project, is in `ANTIGRAVITY_CALL_NOTE_PROMPT.md`.

Security boundaries:

- `CALL_NOTE_TOKEN` is only for Android-to-web webhook imports. It is never used as a mobile push credential.
- A six-digit pair code lasts ten minutes and can be used once. Failed attempts are throttled.
- The app receives a 256-bit device credential once. D1 stores only a keyed digest.
- FID/legacy registration targets are AES-GCM encrypted in D1.
- A monotonic per-device registration version prevents delayed Android retry work from overwriting a newer FID.
- `FCM_SERVICE_ACCOUNT_JSON` exists only as a Scheduled Worker secret. It is never stored in Pages, D1, Android, or Git.
- FCM data contains IDs and routing fields only—never a member name, phone number, address, memo title/body, or visitation content.
- Only one phone is active. A new phone replaces the old phone only after the new app safely stores its credential and completes registration.

The production Pages project and Scheduled Worker must receive the same independently generated `NOTIFICATION_SECRET`. Do not reuse `SESSION_SECRET`, the webhook token, or a password.

```powershell
# Set the Pages copy before deploying Pages. Do not commit or paste the value into a config file.
npx.cmd wrangler pages secret put NOTIFICATION_SECRET --project-name seosanch-cell

# Run these two commands only after the first Worker deployment with PUSH_SEND_ENABLED=false.
# Enter the same NOTIFICATION_SECRET value used for Pages.
npx.cmd wrangler secret put NOTIFICATION_SECRET --config wrangler.notifications.jsonc

# Pipe the complete Firebase service-account JSON from a protected local file.
Get-Content -Raw C:\secure\firebase-service-account.json |
  npx.cmd wrangler secret put FCM_SERVICE_ACCOUNT_JSON --config wrangler.notifications.jsonc
```

The committed Worker configuration has `PUSH_SEND_ENABLED` set to `false`. Keep that kill switch off for the first deployment.

Safe production order:

1. Before any Pages deployment, run `npx.cmd wrangler d1 migrations apply seosanch-cell-db --remote` and verify every pending migration is applied in order. At the time of this change, production still needs `0012` through `0016`.
2. Set the Pages copy of `NOTIFICATION_SECRET`.
3. Deploy Pages so the device API and settings UI exist.
4. Deploy the Worker once with `PUSH_SEND_ENABLED=false` and wait for at least one scheduled run. It is safe for its secrets to be absent at this point, and no FCM request can be sent.
5. Set the Worker's matching `NOTIFICATION_SECRET` and `FCM_SERVICE_ACCOUNT_JSON`. `wrangler secret put` creates and deploys a Worker version, so do this only after the disabled Worker configuration is active.
6. Install the updated Android app, create a ten-minute code in web Settings, and complete device registration.
7. Wait for a scheduled run and confirm Settings shows `발송 꺼짐`. That state means the scheduler, Worker secret, and FCM configuration are ready while the kill switch remains off.
8. Change `PUSH_SEND_ENABLED` to `true`, run `npm run dry-run:notifications`, and deploy the Worker again.
9. Send a test notification from Settings and confirm the separate FCM accepted/received/displayed/opened states.

Existing reminder rows intentionally receive no push automatically. A push reminder ID is created only for a newly scheduled reminder, a real time change, or an explicit reactivation. This prevents old overdue reminders from sounding all at once after deployment.

Useful commands:

```powershell
npm.cmd test
npm.cmd run check
npm.cmd run dry-run:notifications
npm.cmd run dev:notifications
```
