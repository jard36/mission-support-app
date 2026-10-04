# Pastor Supporter Slot Management

**Status:** Approved and implemented
**Date:** 2026-10-04

## Goal

Let Admin and Staff manage the number of supporter slots for an existing pastor from the Edit Pastor dialog. A pastor can gain additional slots without manually editing month values, and a slot can be disabled and later restored without losing its support history.

## Current behavior

- Supporter slots are represented by letter labels such as `A.` and `B.` embedded in each quarter entry's `m1`, `m2`, and `m3` values.
- The assignment editor discovers slots from those month values.
- Completion metrics, the live tracker, reports, presentations, and PPTX generation also interpret those values.
- Pastor name/type/visibility already synchronize between matching quarter entries, while monthly marks remain quarter-specific.

## Proposed behavior

1. The Edit Pastor dialog includes a **Supporter Slots** section for existing entries.
2. It lists each known slot and its enabled/disabled state. **Add Supporter** appends the next label in sequence: A through Z, then AA, AB, and so on.
3. Saving synchronizes a pastor's slot configuration across matching records in every existing quarter, including hidden records. It does not change whether the pastor itself is hidden.
4. Adding a slot adds that label as unchecked in each existing quarter's three month values. Existing labels and checkmarks are preserved.
5. Disabling a slot is reversible: retain its label and checkmarks in stored month values, but omit it from active check controls, supporter assignment choices, visible report/PPT status marks, and completion totals.
6. Re-enabling a slot restores its existing checkmarks and makes it available in those active views again.
7. New quarters copy slot configuration from their source quarter. Their month checks still start unchecked, including disabled slots' retained labels.
8. Legacy entries without explicit slot-state metadata remain fully enabled by default. Existing lettered history is migrated lazily or normalized on edit; no saved month values are discarded.
9. Supporter account assignments to a disabled slot stay stored. The slot cannot be newly assigned while disabled; if re-enabled, the prior assignment and saved marks become effective again.

## Data and API

- Add optional entry metadata for disabled supporter labels, normalized to unique uppercase labels. Absence of this metadata means all labels found in the month values are enabled, preserving backward compatibility.
- Extend the existing pastor update request to accept the desired slot configuration. The API validates labels and limits malformed or duplicate values, applies updates to all entries matching the existing normalized pastor identity, and preserves each quarter's independent month marks.
- The server remains authoritative for slot sequence generation, cross-quarter synchronization, and status normalization. Staff authorization remains the same as the existing pastor edit endpoint.
- Audit slot additions and enable/disable changes with pastor identity and affected quarter count; do not put sensitive or unrelated user data in the audit event.

## UI and calculations

- Render the slot list in the existing edit modal, with clear enabled/disabled state and accessible control labels.
- Assignment UI offers only enabled slots and keeps its current one-supporter-per-slot conflict protection.
- Status parsing must support multi-character labels (for example `AA.`), not just single A–Z labels.
- Live tracker controls and supporter views render only enabled slots. Metrics, incomplete filters, reminders, browser reports, presentations, and PPTX exports calculate from enabled slots only.
- Existing unlettered, single-supporter records keep their present behavior.

## Out of scope

- Permanently deleting a slot or erasing any historical support mark.
- Changing pastor names, ordering rules, pastor types, or support checks across quarters.
- Reassigning supporter accounts automatically when an enabled slot is newly added.

## Acceptance criteria

- Adding a slot from one quarter adds the next letter to every matching existing quarter with unchecked marks, without changing existing marks.
- A disabled slot disappears from active check controls and assignment choices and no longer contributes to completion or incomplete calculations.
- Re-enabling restores the same slot and its prior marks in every matching quarter.
- Adding a quarter inherits the active/disabled slot configuration while starting new quarter checks unchecked.
- Slot A…Z and AA… labels round-trip through editing, status toggles, assignments, reports, and PPTX generation.
- Only Admin/Staff can manage slots; supporter accounts cannot access the edit capability.
- A normal pastor edit with no slot change preserves legacy behavior and all month data.

## Review notes

- User approved the behavior that disabled slots are hidden from active controls and excluded from completion counts while their marks remain saved.
- The draft additionally carries slot state across all existing and future quarters, preserves supporter-account assignments while a slot is disabled, and hides disabled marks in reports. Please review those details before implementation.
