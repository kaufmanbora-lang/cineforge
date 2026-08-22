# Quality assurance

Validated on 22 August 2026 with Node.js 24 and pnpm 11.

## Automated checks

- `pnpm typecheck` — passed.
- `pnpm lint` — passed.
- `pnpm test` — 6 files, 13 critical-domain tests passed.
- `pnpm build` — production Next.js build passed.
- Secret scan — no Google or OpenAI API key is present in tracked source files.
- Server-side OpenAI connection test — passed with `gpt-5.6-sol`; the key value was never logged or persisted.

The test suite covers checkpoints and resume, idempotent jobs, content-addressed caching, provider failure classification, continuity context, Project Memory isolation, and minimal-region non-destructive edits.

## Visual fidelity ledger

The production pages were compared with the approved concept images in the same visual review pass.

| Area | Result | Notes |
| --- | --- | --- |
| Structure | 9/10 | Studio keeps the three-pane editor, large preview, inspector, and six-track timeline; Screenwriter keeps the 62/38 workspace split. |
| Hierarchy | 9/10 | Film brief, preview, production state, chat, and project memory remain clearly separated at editor-level density. |
| Spacing | 9/10 | Compact controls and restrained panel gaps match the approved professional editing-tool direction. |
| Typography | 9/10 | Inter plus DM Mono preserves the editorial/technical hierarchy. |
| Colour and imagery | 10/10 | Near-black surfaces, amber actions, teal state accents, and bespoke cinematic frames match the concepts. |

Production desktop screenshots: `docs/qa/studio-production-final.png` and `docs/qa/screenwriter-production-final.png`. A 390 × 844 responsive capture is available at `docs/qa/studio-mobile.png`.

## External integration boundary

No paid Google video render was started during QA. A newly rotated Google API key must be added through **Settings → API** before performing the provider acceptance test. OpenAI and Google secrets remain server-only.
