# seosanch-cell

Cloudflare Pages app for church cell and pastoral-care management.

This repository stores only application code and Cloudflare binding configuration. Do not commit real member photos, phone numbers, addresses, birth dates, family notes, visit notes, call summaries, spreadsheets, or PDF source files.

## Architecture

- Cloudflare Pages: web app hosting
- Pages Functions: API endpoints
- Cloudflare D1: members, cells, managed groups, notes/reminders, mobile-device registrations, push delivery state, visit notes, app settings, and audit logs
- Cloudflare R2: member photos
- Pages middleware: password/passkey login, signed secure session cookies, and login throttling
- Scheduled Worker: due-reminder ledger, retry/lease handling, and authenticated relay delivery
- Publisher-operated FCM Relay Worker: tenant isolation, encrypted Firebase targets, quotas, and FCM HTTP v1 delivery

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
- Pages secret: `RELAY_HMAC_SECRET` (unique to this site; issued by the relay operator)
- Pages variables: `SITE_ORIGIN`, `PUSH_TRANSPORT=relay`, `RELAY_BASE_URL`, and `RELAY_KEY_ID`
- Scheduled Worker variables: `PUSH_TRANSPORT=relay`, `RELAY_BASE_URL`, and the same `RELAY_KEY_ID`

The same D1 database is bound to the separate scheduled Worker through `wrangler.notifications.jsonc`. The Worker intentionally has no photo-bucket binding. Its copy of `RELAY_HMAC_SECRET` must match the Pages secret.

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

## Android memo and visitation notifications

The Android app can connect to any approved clone of this site. Every clone keeps its own members, memos, visitation records, device credential, and delivery/ACK ledger in its own D1 database. Migration `0018` creates a stable lowercase UUID `siteId`, which must survive backup and restore. The app binds that ID to the exact canonical HTTPS `siteOrigin` returned by the site.

The publisher-operated relay is the only component that holds `FCM_SERVICE_ACCOUNT_JSON`. Each clone receives a unique relay key and signs every relay request with HMAC-SHA256, a timestamp, and a one-use nonce. The relay stores FID/legacy registration targets encrypted, applies one-active-phone and request-quota rules, and returns only an opaque target handle. Normal reminders contain no raw Firebase target and no church/member content.

Security boundaries:

- `CALL_NOTE_TOKEN` is only for Android-to-web webhook imports. It is never a mobile push or relay credential.
- A six-digit pair code lasts ten minutes, works once, and is rate limited.
- The app receives a 256-bit device credential once. D1 stores only a keyed digest.
- Firebase targets are AES-GCM encrypted in the site D1 for direct-mode rollback and separately encrypted in the central relay D1.
- A monotonic registration version prevents delayed Android work from overwriting a newer FID.
- FCM is data-only and contains exactly seven routing fields: `schemaVersion`, `siteId`, `type`, `notificationId`, `reminderId`, `scheduledAt`, and `route`.
- Names, phone numbers, addresses, memo text, and visitation content never enter the relay or FCM payload.
- One phone is active per site. Same-site re-pairing transfers the target; a target already active for another site is rejected.

Site secrets:

- Pages: `NOTIFICATION_SECRET`, `RELAY_HMAC_SECRET`
- Scheduled Worker: `RELAY_HMAC_SECRET`; retain legacy direct-mode secrets only while rollback is required
- Central Relay Worker: `RELAY_MASTER_SECRET`, `RELAY_ADMIN_TOKEN`, `FCM_SERVICE_ACCOUNT_JSON`

Never commit any of these values. Do not reuse a session secret, webhook token, password, Firebase key, or another site's relay key.

Both kill switches are committed off: the site Worker uses `PUSH_SEND_ENABLED=false`, and the central relay uses `RELAY_SEND_ENABLED=false`. Keep both off until the updated signed Android build is installed and the disabled-mode connection checks pass.

Safe site rollout order:

1. Export a remote D1 backup and record the member/visitation counts.
2. Run all tests and both Worker dry-runs.
3. Apply migration `0018`, fix `notification.siteOrigin` to the production origin, and verify the original counts plus the new site identity/columns.
4. Have the relay operator provision that `siteId` and `siteOrigin`; install the returned `RELAY_KEY_ID` and `RELAY_HMAC_SECRET` in Pages and the scheduled Worker.
5. Deploy Pages and the scheduled Worker with `PUSH_SEND_ENABLED=false`. Apply every pending central `relay-migrations` migration (including `0002` on an existing `0001` database), then deploy/provision the central relay with `RELAY_SEND_ENABLED=false`.
6. Build and install the updated Android app, pair it with the site's URL and six-digit code, and verify that the relay target is active.
7. Enable the central relay first, then the site Worker, and send one connection-test notification.
8. Confirm FCM accepted, Android received/displayed/opened, and ACK state before scheduling real reminders.

Existing reminder rows intentionally receive no push automatically. A push reminder ID is created only for a newly scheduled reminder, a real time change, or an explicit reactivation, preventing old overdue reminders from sounding at once.

Central provisioning, rotation, rollback, and incident procedures are documented in `docs/fcm-relay-runbook.md`.

Useful commands:

```powershell
npm.cmd test
npm.cmd run check
npm.cmd run dry-run:notifications
npm.cmd run dry-run:relay
npm.cmd run dev:notifications
npm.cmd run dev:relay
```
