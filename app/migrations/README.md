# Database migrations

Each file `NNNN_short_name.sql` changes the schema one step. On start-up the app applies every
file whose number is not yet in the `schema_migrations` table, in order, each inside its own
transaction (all of the file or none of it).

Rules:

- Never edit a file that has been released — add a new, higher-numbered file instead.
- No `BEGIN` / `COMMIT` in the files; the runner wraps each one.
- Foreign keys are switched off while migrating (so SQLite table rebuilds work) and
  `PRAGMA foreign_key_check` must pass before a migration commits.
- Check what is applied: `docker compose exec app python -m app.migrate status`
