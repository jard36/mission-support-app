# Deploy Mission Support Tracker (Next.js) to Vercel + Neon

The Next.js App Router serves the existing interface and static assets. Its catch-all API route forwards `/api/*` requests to the existing Express app in `server.js`, preserving the current authentication, database, reports, PowerPoint exports, and notification routes.

The JSON database remains the local fallback and seed data for a new Neon database.

## Deploy

1. Push this project to GitHub.
2. In Vercel, create or update the project from that repository. Set **Framework Preset** to **Next.js** and keep the default build and output settings.
3. Add the Neon integration/storage and connect it to this project.
4. Ensure `DATABASE_URL` is available in the Vercel environment.
5. Deploy.
6. Visit `/api/health` on the deployed URL. It should report `ok: true`, `database: "neon-postgres"`, and 14 quarters when the included seed data is used.

The daily Vercel Cron schedule for `/api/notifications/cron` remains configured in `vercel.json` (00:00 UTC / 08:00 Philippines time).

## Local development

Run `npm install`, then `npm run dev`, and open [http://localhost:3000](http://localhost:3000). Without `DATABASE_URL`, the app uses `data/mission_support_db.json`.

For a production-style local run, use `npm run build` followed by `npm start`.

## Environment variables

Do not commit these values to GitHub. Set them in Vercel Project Settings → Environment Variables, or use a local `.env` file (which is ignored by Git).

- `DATABASE_URL` — Neon Postgres connection string.
- `RESEND_API_KEY` — Resend API key.
- `RESEND_FROM_EMAIL` — verified sender address.
- `IPROG_SMS_API_TOKEN` — IPROG SMS API token.
- `CRON_SECRET` — secret used to protect the scheduled reminder endpoint.

The reminder settings determine whether a monthly or quarterly reminder is due on the daily cron check.
