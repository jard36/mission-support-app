# Mission Support Management System & PowerPoint Generator

Usa ka moderno ug sayon gamiton nga CRUD Web Application para sa pagdumala sa Mission Support sa mga Pastor ug Missionary, nga adunay automatic PowerPoint (.pptx) presentation generator.

## Mga Feature:
1. **Kompleto nga Reference Data**: Naka-load daan ang tanang 14 ka quarters (2022 Q4 hangtod 2026 Q3) gikan sa orihinal nga 396-slide PowerPoint file.
2. **Full CRUD**:
   - **Create**: Pagdugang og bag-ong Pastor/Missionary o paghimo og bag-ong Quarter.
   - **Read**: Live search, filter by Year & Quarter, statistics ug support completion percentage.
   - **Update**: 1-click monthly status toggling (check/uncheck), bulk updates, ug edit details.
   - **Hide / Restore**: Pastor records are never permanently deleted; excluded pastors remain in the database and can be restored from Hidden Pastors.
3. **Downloadable PowerPoint (.pptx)**:
   - I-click lang ang " Download PPT\ aron makakuha og bag-ong .pptx file nga gi-format tag-3 ka pastor matag slide aron dako ug klaro para sa church projector!
4. **Live Projector Mode**:
 - Pwede i-preview o i-presentar ang mga slides diretso sa browser gamit ang \Present Slides\ button.
5. **Purple Theme UI**:
 - Nindot ug elegante nga purple color palette (#2D1B4E, #4C1D95, #7C3AED).

## Development with Next.js

- Install dependencies with `npm install`.
- Start the development server with `npm run dev`, or double-click `start_app.bat`.
- Open [http://localhost:3000](http://localhost:3000).
- Create a production build with `npm run build`, then start it with `npm start`.

The existing interface is served through the Next.js App Router. The original Express API routes, authentication, database layer, PowerPoint exports, and reminder behavior remain in place behind the Next.js API route handler.

## Project structure

- `app/` contains the Next.js App Router page, root layout, and API route adapter.
- `public/` contains the existing styles, images, and browser application script.
- `server.js` keeps the existing Express API and business logic.
- `db.js` keeps the local JSON and Neon database implementation.

## Latest updates

- Dynamic A/B/C/D/E support totals: each letter is one support slot per month. For example, A+B across three months is 6/6; A+B+C is 9/9; A+B+C+D is 12/12; A+B+C+D+E is 15/15.
- New Local / Foreign / Unassigned pastor classification and filters. The selected type is also applied to PPT exports and presentations.
- Mission Report Builder: select multiple quarters, choose pastor type and status, view the selected report in the browser, or download one combined PPTX.
- Incomplete-only reporting filters completed pastors from older/completed quarters. The latest/current quarter is always shown in full so the report can show both complete and incomplete pastors.
- The All year filter is functional and displays every available quarter; the same selection can be presented or downloaded.
- Pastor Include/Exclude: excluded pastors remain in the database and are omitted from active lists, reports, and PowerPoint exports. Hidden Pastors can be restored anytime.
- Reminders & Notifications: Admin/Staff can send monthly or quarterly reminders through Resend Email and IPROG SMS, with recipient selection, editable templates, duplicate-send tracking, and scheduled reminder checks.
- Export Backup (.json) and Reset to Original PPT Data are Admin-only.
- Supporter account password and confirmation fields include show/hide eye controls.
- Last updated changes only after actual mission-support record changes; login, viewing, and refreshes do not change it.

## Login / Authentication

The app now requires an authenticated session before mission-support data can be accessed.

### Initial Admin Account

- Username: `jarred`
- Password: the initial password provided by the project owner
- Role: Admin

The password is **not stored in plaintext**. On first authentication/session check, the default admin account is created with a salted `scrypt` password hash inside the database. Sessions are stored server-side in the same Neon JSONB state and use an HttpOnly cookie.

This release intentionally does **not** add public signup, Staff accounts, or Supporter accounts yet. Those can be added after the permission/assignment workflow is finalized.

### Important security behavior

- Mission-support API endpoints require an authenticated session.
- Reset-to-original-data requires Admin role.
- Admin passwords cannot be viewed in plaintext.
- Sessions expire after 7 days.
