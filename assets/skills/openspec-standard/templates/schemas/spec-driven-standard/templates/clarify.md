## Open Questions

<!-- Unknowns surfaced during clarification. One per bullet. Cover: problem & intent,
     scope, related-surface survey, data model, business rules, integration
     boundaries, architecture approaches. Resolve them with the user by
     interviewing in rounds over a decision tree: each round asks every currently
     answerable question (numbered, each with a recommended answer); keep going
     until no doubt is left unresolved and nothing is silently assumed. -->

- <!-- question -->

## User Answers

<!-- The user's responses, captured verbatim or summarized. -->

- <!-- answer -->

## Related-Surface Survey

<!-- 关联场景清点：every consumer of the capability being changed, grounded in
     code evidence (file/class/method): functional entry points (API endpoints,
     import/export entries, scheduled jobs, message consumers, frontend calls),
     shared processing logic reused by multiple entry points, and downstream
     data consumers (readers/writers of the tables, fields, events, or export
     artifacts involved). When shared processing logic changes, every consuming
     entry point must be adapted in the SAME change; splitting into separate
     changes requires an explicit boundary rationale confirmed by the user. -->

- <!-- entry point / shared logic / downstream consumer + code evidence + scoping verdict -->

## Architecture Direction

<!-- The crystallized approach: chosen direction, key decisions, 2-3 alternatives
     considered with tradeoffs, and the plan summary the user explicitly confirmed
     (interview answers alone do not count as confirmation; the summary must be a
     plain message listing the key points — never a question-tool prompt). This is
     the HARD-GATE output — proposal, specs, design, and tasks must stay consistent
     with what is recorded here. -->

## Authoring Tier

<!-- SIMPLE or COMPLEX, with a one-line rationale (criteria in the clarify
     instruction's Phase 2). SIMPLE: orchestrating agent writes proposal →
     specs → design → tasks itself. COMPLEX: one generation subagent writes
     them. Recorded here for auditability before Phase 2 starts. -->

- Tier: <!-- SIMPLE / COMPLEX -->
- Rationale: <!-- one line -->

## Initial Capabilities

<!-- Preliminary guess of which specs will be created or modified (kebab-case names).
     Finalized in proposal.md Capabilities section. -->

- `<name>`: <!-- what this capability covers -->
