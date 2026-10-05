# Living Hope Quality Refactor

**Status:** Approved for staged implementation
**Date:** 2026-10-04

## Goal

Improve the maintainability, reuse, loading behavior, accessibility, and visual consistency of the Living Hope Mission Support Tracker while preserving the workflows and data the church already relies on.

## Current architecture

- Next.js App Router serves the application shell and static assets.
- `app/page.js` reads the existing `public/index.html` body and loads the browser application script.
- `app/api/[[...path]]/route.js` adapts Next.js requests to the existing Express application.
- `server.js` contains authentication, pastor and quarter operations, notifications, reporting, and PowerPoint generation.
- `public/js/app.js` contains the browser state, network calls, event wiring, and views in one script.
- `public/css/style.css` contains the dark-purple and light themes and all responsive/component styling.
- `db.js` provides the local JSON and Neon persistence adapters.

## Non-negotiable behavior

- Keep the Next.js App Router and Express API adapter. Do not replace the application with a new React UI or migrate the APIs.
- Preserve all existing URLs, request/response formats, roles, sign-in/session behavior, database fields, and quarter/supporter records.
- Preserve tracker workflows: multi-supporter slots, hidden pastors, pastor types, independent quarter checkmarks, reminders, audit history, mission reports, offline PPTX downloads, and presentations.
- Preserve the current purple theme and existing light theme, church identity, labels, and main navigation.
- Do not change, seed, migrate, or stage `data/mission_support_db.json` as part of this refactor.
- Do not add runtime dependencies.

## Proposed design

### 1. Keep the runtime boundaries stable

Retain `server.js` as the stable Express application entry imported by the Next.js API adapter. Move cohesive domain behavior into small server modules with explicit dependencies, starting with authentication, support-record/quarter operations, notifications, and report/PPTX construction. Keep route paths and authorization at their current boundary. Shared database and identity helpers should have one canonical implementation rather than copies.

Retain the existing static page and browser-rendered product. Organize browser code by responsibility: application startup and state, API access, shared DOM/formatting helpers, and feature modules for authentication, tracker, users/assignments, reports/presentation, and notifications. Keep a small compatibility bridge for existing inline actions until each action is moved to delegated listeners, so the first pass does not break dynamic UI controls.

### 2. Make shared UI work consistent

Use small reusable helpers for API errors/loading, escaping, focus-safe modal setup, status rendering, and repeated UI patterns. Preserve the existing selectors and functionality while reducing duplicated ad hoc strings and global side effects. Replace the global `window.fetch` override with an explicit API/request helper used by application calls; keep credentials and current server error messages intact.

### 3. Polish the incumbent UI, not its visual identity

Keep the current colors and interaction model. Consolidate theme tokens and repeated component rules where this improves consistency. Address verified issues in keyboard focus, accessible labels/states, touch target size, reduced-motion behavior, small-screen overflow, light-theme contrast, and feedback for loading/errors. Avoid adding new product features or decorative animations.

### 4. Optimize only measured or clear bottlenecks

Review roster search, repeated full-list rendering, all-quarter loading, and request handling. Apply low-risk improvements such as debounced search, avoiding duplicate in-flight requests, and rendering only when displayed data changes where the code supports them. Keep filtering, status counts, order, and report output byte-for-byte equivalent in meaning. Do not add caching that could show stale support records.

### 5. Update project guidance

Align the README and deployment notes with the current Mission Report and PPTX flows and the resulting source structure. Keep environment variable names and deployment steps unchanged.

## Scope boundaries

- No Next.js migration, Express replacement, database schema change, or business-rule change.
- No changes to stored church data or automatic account/slot reassignment.
- No third-party component framework, state library, or styling dependency.
- Improvements should be delivered in small coherent slices so the existing system remains reviewable and deployable after each slice.

## Acceptance criteria

1. Existing endpoints and client request/response contracts remain unchanged.
2. Login, roles, quarter selection, pastor editing, support toggles/bulk save, hide/restore, supporter assignments, reports, reminders, audit history, presentation, and PPTX download remain available and retain their existing semantics.
3. Server and browser responsibilities are separated into named, reusable modules with stable entrypoints; the Next.js adapter continues importing the same Express app export.
4. The purple and light themes remain recognizable and usable. Verified accessibility and responsive defects in touched surfaces are corrected without redesigning the product.
5. Search and list interactions avoid unnecessary work without delaying or changing user-visible results.
6. The production build succeeds; server/client syntax checks succeed; a final file-by-file review confirms the local database and unrelated user changes are excluded.

## Verification approach

- Inspect each refactor diff against the original implementation and preserve existing endpoint contracts.
- Run `node --check` on server/browser JavaScript and `npm run build` after the refactor.
- Do not modify or stage the working database, untracked project instruction files, or other unrelated changes.
- No new test suite is included in this pass; any existing tests discovered during planning will be reported before changing or running them.
