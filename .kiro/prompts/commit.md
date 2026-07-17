Prepare and create git commit(s) for the current working directory changes. Follow these steps precisely:

1. **Branch check.** Run `git branch --show-current`. If the result is `main` or `master`, STOP and warn the user that they are on the main branch — do not commit. Ask whether they want to create a new branch first, and if they agree, create one with a sensible name based on the changes (e.g. `git checkout -b <type>/<short-description>`) before continuing.

2. **Inspect the working directory.** Run `git status` and `git diff` (and `git diff --staged` if anything is already staged) to see exactly what changed. Read any new/modified files as needed to understand the change, don't just guess from the diff.

3. **Group changes logically.** If the changes span unrelated concerns (e.g. a bug fix plus an unrelated feature, or changes to multiple independent modules), split them into separate commits by logical grouping rather than one giant commit. Use `git add <specific files>` (never `git add .` when splitting) to stage each group individually. If the changes are all one cohesive unit, a single commit is fine.

4. **Write a Conventional Commit message for each group**, following the `<type>(<scope>)?: <description>` format:
   - Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`
   - Use an optional scope in parentheses when it clarifies the area affected (e.g. `feat(auth): ...`)
   - Description is short, imperative, lowercase after the colon (e.g. "add password reset flow", not "Added password reset flow")
   - Add a `!` after the type/scope for breaking changes (e.g. `fix(api)!: ...`) and explain the breaking change in the commit body
   - Use the commit body (a second `-m`) for context the subject line can't capture, if needed

5. **Commit each group** with `git commit -m "<type>(<scope>): <description>"`. A hook validates the message format automatically — if it's rejected, fix the message and retry.

6. **Confirm.** After all commits, run `git log --oneline -n <N>` (where N is the number of commits made) and `git status` to show the user the result. Do not push unless explicitly asked.

If there are no changes in the working directory, tell the user there's nothing to commit and stop.
