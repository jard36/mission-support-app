# Mission Support Management System & PowerPoint Generator

Usa ka moderno ug sayon gamiton nga CRUD Web Application para sa pagdumala sa Mission Support sa mga Pastor ug Missionary, nga adunay automatic PowerPoint (.pptx) presentation generator.

## Mga Feature:
1. **Kompleto nga Reference Data**: Naka-load daan ang historical quarter records ug mahimong dugangan og bag-ong quarter samtang magpadayon ang support tracking.
2. **Full CRUD**:
   - **Create**: Pagdugang og bag-ong Pastor/Missionary o paghimo og bag-ong Quarter.
   - **Read**: Live search, filter by Year & Quarter, statistics ug support completion percentage.
   - **Update**: 1-click monthly status toggling (check/uncheck), bulk updates, ug edit details.
   - **Hide / Restore**: Pastor records are never permanently deleted; excluded pastors remain in the database and can be restored from Hidden Pastors.
3. **Mission Report ug PowerPoint (.pptx)**:
   - Pilia ang mga quarter, pastor type, ug status sa Mission Report Builder aron makita sa web o ma-download isip usa ka offline-ready PowerPoint presentation.
4. **Live Projector Mode**:
 - Pwede i-preview o i-presentar ang mga slides diretso sa browser gamit ang \Present Slides\ button.
5. **Themes**:
 - Pilia ang original purple theme o ang light theme nga mas sayon basahon.

## Development with Next.js

- Install dependencies with `npm install`.
- Start the development server with `npm run dev`, or double-click `start_app.bat`.
- Open [http://localhost:3000](http://localhost:3000).
- Create a production build with `npm run build`, then start it with `npm start`.

The existing interface is served through the Next.js App Router. The original Express API routes, authentication, database layer, PowerPoint exports, and reminder behavior remain in place behind the Next.js API route handler.

## Project structure

- `app/` contains the Next.js App Router page, root layout, and API route adapter.
- `public/` contains the existing page markup, styles, images, and browser scripts.
- `public/js/core/` contains the shared API client, app state, DOM helpers, and short-lived per-account quarter cache.
- `public/js/features/` contains isolated browser feature behavior, including notifications.
- `server.js` remains the Express app entrypoint and stable API boundary.
- `server/routes/` contains the report and notification route groups.
- `server/reports/` and `server/notifications/` contain the corresponding services.
- `db.js` keeps the local JSON and Neon database implementation.

## Latest updates

- Dynamic A/B/C/D/E support totals: each letter is one support slot per month. For example, A+B across three months is 6/6; A+B+C is 9/9; A+B+C+D is 12/12; A+B+C+D+E is 15/15.
- New Local / Foreign / Unassigned pastor classification and filters. The selected type is also applied to PPT exports and presentations.
- Mission Report Builder: select multiple quarters, choose pastor type and status, view the selected report in the browser, or download one combined PPTX.
- Incomplete-only reports retain each quarter’s month marks for incomplete pastors; the latest quarter is included in full, including completed pastors.
- The All year filter is functional and displays every available quarter; the same selection can be presented or downloaded.
- Pastor Include/Exclude: excluded pastors remain in the database and are omitted from active lists, reports, and PowerPoint exports. Hidden Pastors can be restored anytime.
- Reminders & Notifications: Admin/Staff can send monthly or quarterly reminders through Resend Email and IPROG SMS, with recipient selection, editable templates, duplicate-send tracking, and scheduled reminder checks.
- Export Backup (.json) and Reset to Original PPT Data are Admin-only.
- Supporter account password and confirmation fields include show/hide eye controls.
- Last updated changes only after actual mission-support record changes; login, viewing, and refreshes do not change it.
- After authentication, the latest quarter can render from this browser's account-scoped cache for up to 24 hours while fresh records load. Credentials are never cached, and the cached view stays read-only until the server refresh succeeds.

## Login / Authentication

The app now requires an authenticated session before mission-support data can be accessed.

### Initial Admin Account

- Username: `jarred`
- Password: set by the project owner through `INITIAL_ADMIN_PASSWORD` when bootstrapping an empty database
- Role: Admin

The bootstrap password must be at least 12 characters, is read only from the server environment, and is stored only as a salted `scrypt` hash. The password is not hardcoded in the current source. If the database has the original fixed bootstrap hash, setting this variable rotates it on the next authentication check and invalidates existing sessions. Other existing admin passwords are unchanged. Sessions are stored server-side in the same Neon JSONB state and use an HttpOnly, SameSite=Lax cookie.

Public signup creates pending Supporter accounts. Admin and Staff accounts are managed by an Admin.

### Important security behavior

- Mission-support API endpoints require an authenticated session.
- Reset-to-original-data requires Admin role.
- Admin passwords cannot be viewed in plaintext.
- Sessions expire after 7 days.
- Changing a user's password revokes that user's existing sessions.
- Sign-in attempts are temporarily throttled after repeated failures.
- Same-origin checks protect state-changing authenticated requests.
- Production must set `CRON_SECRET` to enable scheduled reminder processing.

## Environment variables

Do not commit these values to GitHub. Set them in Vercel Project Settings → Environment Variables, or use a local `.env` file (which is ignored by Git).

- `INITIAL_ADMIN_PASSWORD` — bootstrap password used when the database has no `jarred` admin account; also rotates the original fixed bootstrap credential if present. Use at least 12 characters and update this secret before the next login when rotating the legacy credential.
- `DATABASE_URL` — Neon Postgres connection string.
- `RESEND_API_KEY` — Resend API key.
- `RESEND_FROM_EMAIL` — verified sender address.
- `IPROG_SMS_API_TOKEN` — IPROG SMS API token.
- `CRON_SECRET` — secret used to protect the scheduled reminder endpoint.
