# Pastor Supporter Slot Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let staff add and disable/re-enable pastor supporter slots while preserving each slot's support history and assignments across quarters, reports, and presentations.

**Architecture:** Store disabled slot labels as optional entry metadata and derive legacy enabled slots from month statuses. The API remains authoritative and synchronizes slot configuration across every quarter for the pastor identity while keeping month checkmarks quarter-specific. The existing plain JavaScript interface edits this configuration in the Pastor modal and filters disabled slots consistently from active assignment, display, metrics, and export paths.

**Tech Stack:** Next.js 16.3.8 app shell, Express API in `server.js`, browser UI in `public/index.html` and `public/js/app.js`, JSON/Neon database adapter.

**Spec:** `docs/superpowers/specs/2026-10-04-pastor-supporter-slots-design.md`

## Global Constraints

- Keep legacy entries without slot metadata fully enabled.
- Keep disabled labels and marks in stored month values; do not erase slot history.
- Preserve independent monthly marks for each quarter.
- Only Admin and Staff manage slots, following the existing pastor-edit authorization.
- Do not automatically reassign supporter accounts when a slot is added.
- Keep project dependencies unchanged.

## Review Focus

- Legacy entries with one or multiple lettered slots and no metadata remain active; retain the existing unlettered single-supporter behavior.
- Adding labels beyond Z produces unique ordered labels (AA, AB, …) without parsing AA as A.
- Disabling a slot hides it from status controls, assignments, metrics, reminders, browser reports, presentations, and PPTX while preserving checkmarks and existing account assignment.
- Re-enabling a slot restores its marks and assignment availability across quarters.
- New quarters inherit enabled/disabled slot configuration but start all month checks unchecked.

## File Map

- `server.js`: slot label parsing/serialization, global slot-configuration synchronization, request validation, new-quarter inheritance, API output, assignment validation, metrics, reminders, browser reports, and PPTX marks.
- `public/index.html`: supporter-slot editor controls inside the existing pastor form.
- `public/js/app.js`: modal editing, multi-character slot parsing, assignment choices, active status display, metrics, report filters, and presentation-facing calculations.
- `public/css/style.css`: responsive slot rows and enabled/disabled presentation in the edit modal.

## Tasks

### Task 1: Server-side slot model and synchronization

**Files:**
- Modify: `server.js`

**Interfaces:**
- Persist `disabledSupportSlots` as a unique array of uppercase labels on each quarter entry.
- Derive `getEntrySupportSlots(entry)` from `m1`/`m2`/`m3`, supporting labels such as `A` and `AA`.
- Derive active slots by excluding `disabledSupportSlots`; absent metadata means every discovered slot is enabled.
- Accept a `supportSlots` array from the existing pastor PUT endpoint, validate unique labels, and synchronize it across matching pastor names in all quarters.

- [x] Add shared label parse/format helpers and ensure multi-letter labels are parsed as complete tokens.
- [x] Synchronize additions, enabled state, and disabled state across all matching entries without changing their individual month marks; append added labels unchecked to all three months.
- [x] Reject malformed, duplicate, excessive, or non-sequential slot definitions with a 400 response.
- [x] Carry slot metadata in quarter GET responses and retain disabled configuration when cloning a quarter; clear all clone month checks.
- [x] Prevent new supporter-account assignments to disabled slots while retaining existing assignment records.
- [x] Update server-side completion/incomplete counts, reminder eligibility, report filters, and PPTX status marks to use enabled slots only.
- [x] Audit slot configuration changes with pastor identity and affected-quarter count.

### Task 2: Pastor modal slot editor

**Files:**
- Modify: `public/index.html`
- Modify: `public/js/app.js`

**Interfaces:**
- Existing pastor PUT payload gains `supportSlots: [{ label: string, enabled: boolean }]`.
- The UI receives available/disabled slots from the selected entry and submits the complete desired configuration.

- [x] Add an existing-pastor-only Supporter Slots section with accessible enable/disable controls and an Add Supporter button.
- [x] Render the next sequential label (A–Z, AA+) when adding a slot and initialize it enabled.
- [x] Populate slot controls from entry metadata; for legacy entries, infer all known slots as enabled.
- [x] Submit configuration with the normal pastor update; refresh quarter state after save so all-quarter changes show immediately.

### Task 3: Active views and multi-slot parsing

**Files:**
- Modify: `public/js/app.js`

**Interfaces:**
- Parse and serialize lettered month values using full labels (`AA.`), and determine active slots from `disabledSupportSlots`.
- Existing unlettered statuses retain current behavior.

- [x] Filter disabled labels out of live check controls and supporter-facing slot highlights without removing them from persisted values.
- [x] Use enabled-slot counts for row status, dashboard totals, incomplete filters, reminders and Mission Report web preview calculations.
- [x] Offer only enabled slots in the supporter assignment modal and keep existing one-supporter-per-slot conflict handling.
- [x] Ensure pending month updates and bulk actions preserve disabled labels and their saved checked state.

### Task 4: Review and verification

**Files:**
- Review: all changed files from Tasks 1–3.

- [x] Trace add/disable/re-enable flows through an existing multi-quarter pastor and a legacy entry with no slot metadata.
- [x] Confirm quarter cloning retains configuration and clears all checkmarks.
- [x] Run `node --check server.js` and `node --check public/js/app.js`.
- [x] Run `npm run build` and resolve any build errors caused by the change.
- [x] Review `git diff` and confirm no database files or unrelated user changes are included.

## Execution Notes

- The current repository is on `main`; a managed worktree was created but the shell sandbox denied access to it, so implementation proceeds in the user-authorized project folder.
- Do not modify or stage the existing local database changes, `AGENTS.md`, or `CLAUDE.md`.
- Automated tests are omitted because the active workspace policy says not to add or run tests unless the user asks for testing. Use syntax checks, build, and focused manual data-flow review instead.
- Verification completed 2026-10-04: both Node syntax checks passed and `npm run build` succeeded. No test suite was run.
