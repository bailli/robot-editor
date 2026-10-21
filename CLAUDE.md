# Notes for Claude

Read [STATUS.md](STATUS.md) first: project state, conventions, open items and the key
addresses in the exe. Setup and commands are in [README.md](README.md).

- pnpm only; erasable TypeScript; `pnpm check` must pass before committing.
- Commits: no attribution footer, linear history. The subject stays within ~72 characters
  and says what changed; when that is not enough, add a short body (a few lines, wrapped
  at 72) instead of growing the subject. Subject-only is fine when the subject says it all.
- Never push: only the user pushes to the remote (GitHub, `origin`).
- Keep STATUS.md current when something is decoded, added or found to be wrong.
