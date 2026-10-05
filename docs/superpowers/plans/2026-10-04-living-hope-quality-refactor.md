# Living Hope Quality Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing Mission Support Tracker easier to maintain, clearer to use, and safer to evolve while preserving its current architecture, workflows, and stored records.

**Architecture:** Keep the Next.js App Router page and catch-all API adapter, with the existing Express application as the API/business-logic boundary. Retain the static HTML and browser-rendered interface; introduce small CommonJS server modules and classic-script browser modules with explicit shared interfaces and a compatibility facade for existing dynamic actions.

**Tech Stack:** Node.js, Next.js App Router, Express, plain browser JavaScript, CSS, JSON/Neon persistence, and the existing PPTX generator. Add no runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-04-living-hope-quality-refactor-design.md`

## Global Constraints

- Keep the Next.js App Router and Express API adapter; do not replace the application with a React UI or migrate the APIs.
- Preserve all existing URLs, request/response formats, roles, sign-in/session behavior, database fields, and quarter/supporter records.
- Preserve multi-supporter slots, disabled-slot saved marks, hidden pastors, pastor types, quarter checkmarks, reminders, audit history, mission reports, PPTX exports, and presentations.
- Preserve the purple and light themes, church identity, labels, and main navigation.
- Do not change, seed, migrate, stage, or overwrite `data/mission_support_db.json`.
- Do not edit or stage the user-provided `AGENTS.md` or `CLAUDE.md` files.
- Do not add runtime dependencies, a component framework, or a state library.
- Keep changes in small stages; keep each public interface and route contract stable.
- Do not add or run test suites in this pass; use syntax and production-build checks as specified below.

## Review Focus

- Session expiry and same-origin request handling must continue to return staff users to login without redirecting auth endpoints.
- Supporter A/B/C/… assignments, including disabled slots and retained checkmarks, must keep their current semantics.
- Incomplete reports across multiple quarters must retain partial month marks and include every pastor required by the existing latest-quarter rule.
- Dynamic list/modal actions must remain operable after script extraction, including checkboxes and supporter assignments.
- Light-mode text, focus indicators, small-screen layouts, and reduced-motion preferences must remain readable and usable.

---

### Task 1: Review the existing security and behavior boundaries

**Files:**
- Inspect: `server.js`, `db.js`, `app/api/[[...path]]/route.js`, `public/js/app.js`, `public/index.html`, `package.json`, `package-lock.json`
- Do not inspect or send: `data/mission_support_db.json`

**Interfaces:**
- Consumes: the current code and route behavior.
- Produces: a short list of confirmed defects and security findings, with affected files and the smallest safe remediation for each.

- [ ] Review authentication, role checks, same-origin protection, session cookies, export routes, user-controlled HTML, and dependency advisories.
- [ ] Use the repository security scanner only against a clean source-only copy that excludes `.env*`, `data/`, `node_modules/`, and `.git/`; if the scanner is unavailable, document that limitation and complete the manual source review.
- [ ] Fix only confirmed issues within this refactor’s boundaries; preserve endpoint and business-rule behavior.
- [ ] Verify changed JavaScript with `node --check` and review `git status --short` to confirm user data and instruction files remain untouched.

### Task 2: Replace the global fetch override with a shared API client

**Files:**
- Create: `public/js/core/api.js`
- Modify: `app/page.js`, `public/js/app.js`

**Interfaces:**
- Produces: `window.MissionSupportApi.request(input, init = {}) -> Promise<Response>`.
- The helper defaults credentials to `same-origin`; it dispatches one session-expired event for non-auth `401` responses and preserves the original `Response` for existing callers.
- `public/js/app.js` remains the browser application entrypoint and keeps the existing feature actions available through its compatibility facade.

- [ ] Load the shared API client before `app.js` using the installed Next.js Script conventions documented in `node_modules/next/dist/docs/`.
- [ ] Replace application-owned `fetch(...)` calls with `MissionSupportApi.request(...)` without changing paths, methods, payloads, or response parsing.
- [ ] Remove the assignment to `window.fetch`; connect the session-expired event to the existing login-screen behavior.
- [ ] Run `node --check public/js/app.js` and inspect every changed call site for unchanged request options.

### Task 3: Extract PowerPoint generation and report exports

**Files:**
- Create: `server/reports/pptx.js`
- Create: `server/routes/reports.js`
- Modify: `server.js`

**Interfaces:**
- `server/reports/pptx.js` exports `buildPptx(quarterList, filters)` and `sendPptxDownload(res, pptx, filename)`.
- `server/routes/reports.js` exports `createReportRouter(dependencies)` and registers the existing PPTX report/export endpoints with the same paths and authorization requirements.
- `server.js` keeps and exports the same Express `app` instance consumed by the Next.js adapter.

- [ ] Move PPTX formatting and filtering helpers as a behavior-preserving extraction; pass database and access-filter functions as explicit dependencies.
- [ ] Move the existing report/export route handlers to the report router and mount it at the existing API boundary.
- [ ] Preserve logo embedding, incomplete-only behavior, latest-quarter behavior, filenames, MIME types, and binary response handling.
- [ ] Run `node --check` separately for `server.js`, `server/reports/pptx.js`, and `server/routes/reports.js`; inspect route paths and middleware order.

### Task 4: Separate notification operations from the Express entrypoint

**Files:**
- Create: `server/notifications/service.js`
- Create: `server/routes/notifications.js`
- Modify: `server.js`

**Interfaces:**
- `server/notifications/service.js` exports the existing notification scheduling, recipient, and send operations through `createNotificationService(dependencies)`.
- `server/routes/notifications.js` exports `createNotificationRouter(dependencies)`; server-only credentials remain read from the same environment variables.

- [ ] Extract notification formatting, recipient resolution, schedule checks, and provider calls without changing templates, due dates, or duplicate-send behavior.
- [ ] Move the corresponding endpoints and cron handler while preserving their existing role checks and `CRON_SECRET` behavior; keep the cron route before the global `/api` auth middleware, with its secret check intact.
- [ ] Keep delivery providers optional exactly as they are today; do not send real email or SMS during this refactor.
- [ ] Run `node --check` on changed notification/server files and compare the registered route list before and after.

### Task 5: Split browser features behind explicit shared state and UI helpers

**Files:**
- Create: `public/js/core/state.js`
- Create: `public/js/core/dom.js`
- Create: `public/js/features/auth.js`
- Create: `public/js/features/tracker.js`
- Create: `public/js/features/users.js`
- Create: `public/js/features/reports.js`
- Create: `public/js/features/notifications.js`
- Create: `public/js/features/presentation.js`
- Modify: `app/page.js`, `public/js/app.js`

**Interfaces:**
- Shared state is exposed through one `window.MissionSupportState` object rather than duplicate module-local copies.
- Shared DOM utilities expose escaping, toast/status rendering, and modal focus setup through `window.MissionSupportDom`.
- Each feature module exposes an `initialize()` function; `app.js` initializes them once after authentication and preserves existing `window.*` actions needed by inline/dynamic controls.

- [ ] Move one cohesive feature at a time, retaining existing selectors, labels, request contracts, and handler semantics.
- [ ] Keep all external inline actions in a small compatibility facade until the matching feature uses delegated listeners.
- [ ] Guard initialization so logging in again does not duplicate event listeners or polling loops.
- [ ] Load feature scripts in dependency order through Next.js Script conventions; keep `app.js` as the single startup entrypoint.
- [ ] Run `node --check` on each new browser file and verify every former `window.*` action still has a facade binding.

### Task 6: Consolidate UI tokens and repair verified usability issues

**Files:**
- Modify: `public/css/style.css`, `public/index.html`

**Interfaces:**
- Keep current theme names and `data-theme` behavior.
- Keep existing IDs, classes used by JavaScript, and user-facing text unless a verified accessibility defect requires an accessible name or state attribute.

- [ ] Consolidate duplicated theme/component values into the existing CSS custom properties without changing the purple theme identity.
- [ ] Correct verified light-mode contrast and focus visibility; add accessible state labels to interactive controls that lack them.
- [ ] Keep supporter-slot marks distinct in both themes; preserve keyboard operation and touch target sizes.
- [ ] Add reduced-motion handling and resolve only verified small-screen overflow in the touched controls.
- [ ] Inspect the affected source rules and run the production build after the style/markup changes.

### Task 7: Reduce avoidable list work and update project guidance

**Files:**
- Modify: `public/js/app.js` or the extracted tracker module, `README.md`, `DEPLOY-VERCEL.md`

**Interfaces:**
- Search remains local and produces the same case-insensitive matching and ordering.
- Data is not cached across quarter changes or saved-record updates.

- [ ] Coalesce rapid search renders and precompute normalized search text only for the displayed roster; retain immediate, current results and existing filters.
- [ ] Avoid duplicate concurrent quarter-detail requests only where the current loading flow can prove the quarter data is unchanged.
- [ ] Update project structure and current Mission Report/PPTX documentation; keep environment names and deployment steps unchanged.
- [ ] Run `node --check server.js db.js public/js/app.js` and `npm run build`; record any pre-existing build/environment blocker without altering user data.

### Task 8: Final contract and working-tree review

**Files:**
- Review: all files changed in Tasks 1–7.
- Confirm excluded: `data/mission_support_db.json`, `AGENTS.md`, `CLAUDE.md`, and unrelated user changes.

- [ ] Compare the route map, response formats, auth middleware placement, and static app entrypoint against the original architecture.
- [ ] Inspect every changed file for accidental secrets, generated artifacts, obsolete duplicate code, and unrelated formatting churn.
- [ ] Confirm `git status --short` contains only intended source/docs changes plus the pre-existing user changes.
- [ ] Report the security review’s coverage and any unverified live-environment risks; do not claim a clean security bill from source review alone.
