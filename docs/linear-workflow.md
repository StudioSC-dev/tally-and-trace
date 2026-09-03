# Linear Workflow

How we use Linear for project management across all StudioSC projects. This file is
identical in every repo — project-specific details (project link, labels) live in each
repo's `CLAUDE.md`.

---

## Session protocol

1. **After every session**, update `HANDOVER.md` (append at the top of the log) AND
   update the Linear project — move tickets, add comments, note what was verified and
   what was not.
2. **After every planning session**, create Linear tickets for each atomic step BEFORE
   executing any code. One ticket per PR; dependencies linked. The backlog is the plan
   of record — design docs are reference, Linear is where progress lives.
3. **Use issue templates.** Don't free-form descriptions — see [Issue templates](#issue-templates).
4. **Create an Epic ticket for each major initiative.** An Epic is a non-work ticket
   with checklists referencing the child tickets. Label it `Epic` only — never attach
   `Trailhead - <project>` labels, so Trailhead does not pick it up as real work. The
   Epic is the umbrella that shows which tickets belong to which group.
5. **On push to a feature/fix branch**, reconcile the changes against the ticket's
   acceptance criteria. Check each criterion, note what passes and what doesn't, and
   update the ticket accordingly.
6. **After all acceptance criteria are checked**, push to the branch assigned by Linear
   and create a PR following our template.
7. **Check the checkboxes on Linear** as each criterion is validated. Once all boxes are
   checked and the PR passes CI/CD with no errors, move the ticket to **Ready for QA**.
8. **Do not append** `🤖 Generated with Claude Code` to PR descriptions, commit
   messages, or any shipped text. All work is Seth's.

---

## Definition of done

- **Ticket level:** QA Verified — all acceptance criteria confirmed after testing, not
  just after implementation.
- **Task / checklist item level:** the individual item matches its acceptance criterion
  after testing. A checkbox is checked when the criterion is met in a running system,
  not when the code is written.

---

## Issue templates

The team has templates configured in Linear. **Always use the matching template** when
creating tickets — via the UI or the API (replicate the template's `descriptionData`
structure in the `issueCreate` mutation's `descriptionData` field, ProseMirror JSON).

| Template | Use for | Label applied |
|---|---|---|
| **Feature Request** | New features or enhancements | `Feature` |
| **Bug Report** | Bugs and regressions | `Bug` |
| **Task** | Chores, refactors, non-feature work | `Chore` |
| **QA Session** | Manual testing sessions | `QA Session` |
| **QA Finding** | Issues found during QA | `Bug` + `QA Finding` |

---

## Epics

For large features that span multiple tickets, create an **epic ticket** — an umbrella
issue with a checklist of atomic sub-tasks.

- **Label the epic `Epic` only.** No `Trailhead - <project>` or other project-scoped
  labels — this prevents Trailhead from picking it up as automated work.
- **Child tickets get the normal labels** (`Trailhead - <project>`, type labels, domain
  labels) so Trailhead can pick them up.
- **Description format:** a checklist of the atomic steps, each linking to (or later
  replaced by) a child ticket.
- **Project:** still assign it to the relevant project so it appears in the project view.

---

## Linear details

- **Team:** StudioSC (`STU`)
- **API key location:** `/srv/Personal/trailhead/secrets/personal.env` (`LINEAR_API_KEY`,
  `LINEAR_TEAM_ID`)
- **States:** `Backlog` → `Todo` → `In Progress` → `Ready for QA` → `Done`
