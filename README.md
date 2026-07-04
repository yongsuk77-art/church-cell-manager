# seosanch-cell

Cloudflare Pages app for church cell and pastoral-care management.

This repository stores only application code and Cloudflare binding configuration. Do not commit real member photos, phone numbers, addresses, birth dates, family notes, visit notes, call summaries, spreadsheets, or PDF source files.

## Architecture

- Cloudflare Pages: web app hosting
- Pages Functions: API endpoints
- Cloudflare D1: members, visit notes, audit logs
- Cloudflare R2: member photos
- Cloudflare Access: admin-only login protection

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

For production, enable Cloudflare Access and set secrets for `ADMIN_TOKEN` and `CALL_NOTE_TOKEN` if token-based API writes are used.
