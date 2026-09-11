# Deploy Mission Support Tracker to Vercel + Neon

This version is prepared for Vercel with Neon Postgres. The existing JSON file remains as the local fallback and as the seed data for a new Neon database.

## What changed

- Local development still works with `data/mission_support_db.json` when `DATABASE_URL` is not set.
- When `DATABASE_URL` is set, the app automatically creates a small Postgres table and imports the current JSON data on first use.
- All existing quarter/pastor/status/audit/PPT endpoints use the same API, so the frontend does not need a rewrite.
- Vercel's current Express support can detect and run this app with zero configuration; no `vercel.json` routing file is needed.

## Deploy

1. Upload/push this project to GitHub. Keep `server.js` and `package.json` at the repository root.
2. In Vercel, create a new project from that GitHub repository. Leave **Framework Preset** as `Other` if Vercel does not auto-label Express; leave Build/Output/Install commands at their defaults.
3. Add the **Neon** integration/storage from the Vercel Marketplace and connect it to this project.
4. Make sure `DATABASE_URL` is available to the project (Vercel/Neon normally provisions this for you).
5. Deploy.
6. Open the deployed URL on your Android phone or iPad.
7. Visit `/api/health` on the deployed URL. It should report:
   - `ok: true`
   - `database: "neon-postgres"`
   - `quarters: 14` on the first deployment with the included seed data.

## Local test with Neon

After connecting Neon, add the database URL to your local environment as `DATABASE_URL`, then run:

```bash
npm install
npm start
```

If `DATABASE_URL` is absent, the app intentionally uses the local JSON database.

## Important

Do not commit a real `DATABASE_URL` or database password to GitHub. Put it in Vercel Environment Variables (and a local `.env` file only if needed). `.env` files are ignored by the project.
