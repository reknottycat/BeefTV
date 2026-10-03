# Updating the BeefTV fork

Keep `origin` as the user's fork and `upstream` as the official BeefTV repository.
The adaptation branch starts at
`db82831593544314f454c519e098c19aa6b1d0e9`. LICENSE, NOTICE and upstream
attribution are retained. Do not force push or overwrite a dirty working tree.

1. Inspect `git status --short`; finish or preserve local changes first.
2. Run `git fetch upstream` and `git fetch origin`. Review
   `git log --oneline HEAD..upstream/main` and
   `git diff --stat HEAD...upstream/main`, including API/database/dependency
   changes. Fetching does not update the running application.
3. Create an isolated integration branch from the current tested adaptation:
   `git switch -c integration/upstream-<revision>`.
4. Merge the reviewed upstream revision with `git merge --no-ff <revision>`.
   Resolve only understood conflicts. Use `git merge --abort` when needed;
   preserve user changes and return to the original branch.
5. Run adapter and skill contract tests, then the required frontend/backend
   checks using the exact declared dependency versions. Recheck local UI,
   channel preservation, result import and disabled-generation behavior.
6. Push the integration branch to the user's fork for review. No periodic
   automatic merge, deployment or privilege expansion is configured.
7. Build a separately tagged immutable image only after source checks pass.
   Follow `deploy/spark/` backup, staging and rollback instructions before
   updating the running service. Retain the prior image and SQLite backup.

Rollback source by selecting the previous tested branch/commit; rollback the
deployed program and its matching database snapshot together. Do not reset the
fork's history or copy a live WAL database as a backup.
