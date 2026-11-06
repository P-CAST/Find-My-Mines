# Find My Mines presentation

A 19-slide, 16:9 Marp deck using the built-in **Gaia** theme. Allow roughly
10–12 minutes for the presentation, plus the live demonstration.

- Edit `find-my-mines.md`; HTML comments contain presenter notes and source references.
- Open `find-my-mines.html` in a browser to present (including presenter view).
- Use `find-my-mines.pdf` for sharing or offline projection.

The deck is based on the supplied assignment PDF
(`FindMyMines-1525379-17884898817103.pdf`, pages 1–3), the repository README,
and the implementation files cited in its notes. It distinguishes implemented
features from planned live checks. It explicitly identifies the HTTP/SSE versus
socket-programming requirement and notes that production addresses are embedded
at build time. Grading acceptance is not assumed.

## Regenerate exports

Run from the repository root. The pinned CLI runs through pnpm's temporary tool
cache; no application dependency or lockfile change is needed. PDF export requires
a supported browser such as Chrome.

```sh
pnpm dlx @marp-team/marp-cli@4.2.3 slides/find-my-mines.md -o slides/find-my-mines.html
pnpm dlx @marp-team/marp-cli@4.2.3 slides/find-my-mines.md --pdf -o slides/find-my-mines.pdf
```

## Validation

On 2026-11-03, `pnpm check` passed: lint had zero errors and two existing
anonymous-default-export warnings in `postcss.config.js` and `prettier.config.js`;
type checking passed; 90 tests passed and four opt-in database tests were skipped.
The exported PDF was rendered for visual layout review.

Live integration, database, two-computer, and real AI-provider checks were not run
for this documentation task. No development server was started or restarted.
The private operator environment file was not read or copied into the deck.

For the demonstration, prepare two browser identities, two accounts for saved
history, a separate administrator session, configured AI access, and available
bot quota. Use the existing deployment instructions in the project README.
