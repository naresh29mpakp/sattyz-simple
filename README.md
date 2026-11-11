# Sattyz Kitchen — simple billing

An independent, smaller online billing app using the supplied Sattyz menu. The old `sattyz-kitchen` app and its data were not changed or imported.

## Everyday use

Sign in, tap food, optionally choose a table, and choose **Take payment**. Check the successful HDFC receipt and tap **Payment received**, then **Print bill**. **Save for later** keeps an unpaid bill under **Open bills**. Bills can gain, change or lose a table while open.

**More** holds Today, Stock, Spending, Your menu, Tables and Settings. Stock purchases record their spending once. Stock is maintained manually; billing does not infer recipes or deduct ingredients. Paid prices, payment details and receipt headers are saved snapshots. Paid bills are available in Today for reprinting. Tax is not configured or inferred from the menu; this version does not calculate GST or claim to issue a GST tax invoice.

## Run on this PC

Use the Node version in `.nvmrc` (24.22.1) and npm 11.16.0. Verification here used the available Node 24.18.0 and npm 11.16.0; the exact pinned Node release was not installed or tested.

```powershell
npm ci
Copy-Item .env.example .env
```

Set a private `LOCAL_PASSWORD` of at least 12 characters in `.env`, then run `npm start`. Open http://127.0.0.1:4320. Local preview uses its own `data/preview.sqlite`; this is a development store, not the cloud restaurant database. Do not commit `.env` or `data/`.

The temporary QA preview used `output/preview-data`, not the default data directory or old app. Its bills are test records. Saved data is online only when deployed with PostgreSQL; unsaved screen edits are in memory, with a warning before leaving. There is no offline queue.

## Free-host deployment

The app is prepared for **Render Free + Neon Free PostgreSQL**. Vercel Hobby is restricted to non-commercial personal use. Render Free sleeps after idle periods, can take about a minute to wake, and does not preserve local files. Its free Postgres expires after 30 days; use Neon rather than storing restaurant data on Render's local filesystem or its expiring database. Free service capacity and uptime are limited; Render recommends against using free instances for production.

References checked 2026-11-11: [Render limits](https://render.com/docs/free), [Vercel use restrictions](https://vercel.com/docs/limits/fair-use-guidelines), [Neon plans](https://neon.com/pricing).

1. Create a **private** GitHub repository with this directory as its root. Include source, lockfile, catalog, public assets, tests, scripts and `render.yaml`. Exclude node_modules, environment files, data, output and planning artifacts. Do not push the parent REA repository or old business databases.
2. The new Neon project is `fragrant-glade-94942574`, named `sattyz-simple`, in Singapore (`aws-ap-southeast-1`), on the connected organization's Free plan. Main branch is `br-winter-rice-ao0oz2db`; database `sattyz`, role `sattyz_owner`. Main was left empty; startup creates additive tables and seeds the actual menu plus eight editable tables. No real sales or inventory counts are seeded.
3. The isolated branch `br-quiet-lake-aoeakew8` (`verification-20261111`) contains QA records from real PostgreSQL verification. **Do not use its connection string for live billing.** Existing source app records have not been migrated.
4. Connect the private repository to Render and use `render.yaml` or a Node web service: plan **Free**, build `npm ci --omit=dev`, start `npm start`, health check `/api/health`. Do not add a paid disk, database or compute plan. No automatic upgrade or keep-awake mechanism is configured.
5. Set `DATABASE_URL` to the main branch's pooled Postgres connection, with TLS certificate verification. Keep the credential in Render's secret environment settings, never GitHub. Startup schema initialization should be tested with a direct connection on an isolated branch before releases; this initial schema was exercised on the isolated cloud branch.
6. Set `PUBLIC_URL` to the exact HTTPS Render URL, `OWNER_EMAIL` to the intended owner's Google email, and configure `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REDIRECT_URI`. Register the exact `https://YOUR-SERVICE.onrender.com/api/google/callback` redirect URI in the owner's Google OAuth project. These credentials were not created or obtained here.
7. Verify owner sign-in, deny another Google account, then test a clearly identified verification bill, reopen/edit/table changes, manual payment, spending and printing before live cutover. Only one application should accept live restaurant writes. Back up and reconcile the old app and resolve any old pending offline orders before retiring it; this app does not automatically migrate those records.

Production refuses to start without a persistent database, HTTPS public origin and complete owner Google configuration. Development-password login is disabled in production. There are no default production credentials.

## Payment and printing boundaries

### Temporary testing access

The owner can authorize an expiring password login while Google setup is pending. The login screen shows its expiry. Only the password hash and deadline are stored in the private authentication table; the password is never committed. Sessions are capped at the deadline and expire after at most twelve hours. Updating the deadline requires the running service to reload its authentication configuration. Google remains available. Test bills are real saved records in the hosted database, not an automatically cleared sandbox.

HDFC confirmation is manual bookkeeping, not a bank integration. The website neither listens to the soundbox nor independently verifies funds, controls a POS terminal or sends it an amount. Verify the exact successful merchant receipt first; optional transaction references are retained. Merely opening payment does not mark a bill paid. Failed/uncertain saves retain the original request identity so checking it does not duplicate the payment.

Settings chooses 58 or 80 mm paper. Use a printer installed on the operating device and select it in the browser's print dialog. Match paper size in the driver, disable browser headers/footers and review the preview. Opening a dialog does not prove physical output. Print failures do not undo a paid bill. No direct cloud-to-LAN, USB/Bluetooth bridge or silent printing is claimed.

## Executed verification

- `npm run check`: passed after the finished frontend/backend were present.
- `npm test`: **14/14 passed**, actual local service and HTTP boundaries, including table assignment/removal, saved prices/header snapshots, retries, immutable paid bills, stock/spending, login/logout, temporary access and session expiry, origin and exact media-type checks. Loopback tests required host access outside the execution sandbox.
- `scripts/verify-postgres.mjs`: passed against the isolated real Neon branch, covering 100 menu items, saved bill identity, manual payment retries, saved receipt retrieval and one linked stock purchase. It was run before the later additive receipt-header snapshot refinement; that refinement is covered by local tests, not a subsequent cloud run.
- Browser: local sign-in; menu addition; no-table bill at ₹110; save; reload; reopen; assign Table 2; save; manual UPI confirmation; Paid status and Print/New bill actions; secondary menu and stock form opening were observed. Inventory browser entry was interrupted before completion. Full responsive, recovery, accessibility and printing browser checks remain incomplete.

No live deployment, real Google OAuth login, HDFC bank connection, physical receipt, production migration or untrained-user usability test was verified. No performance or resource-efficiency claim is made.

Source is published at [naresh29mpakp/sattyz-simple](https://github.com/naresh29mpakp/sattyz-simple). The app is hosted at [Sattyz Billing](https://sattyz-simple.onrender.com/). HTTPS, PostgreSQL health, protected records, temporary sign-in and sign-out were verified. Google sign-in is blocked until the deployed callback is registered in the OAuth client's allowed redirects. Render management calls have intermittently failed; verify the actual website after deployment and configuration changes. The GitHub connector's write request returned an integration-permission error; publishing through this PC's existing authorized Git credentials succeeded.
