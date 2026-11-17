## Database validation

Before a review the app applies the project's migrations to a temporary database when the project has one, and runs the tests against it. When its checks passed there, the migrations apply cleanly: don't apply them again and don't set up a database for it.

What that run can't tell you, in the migrations this task added:

- A model or schema change has its migration. The migration tool's own check shows drift without touching a database (`python manage.py makemigrations --check --dry-run`, `npx prisma validate`, and the like). A changed model without a migration is a critical issue.
- A destructive statement (a dropped table or column, a changed type) has a reason in the spec. Migration tools generate these from drift nobody meant to change.
- Rows that already exist survive: a new column on an existing table has a default or allows null, and a data migration handles the rows already there.

If the app could not run against a database, the migrations are unverified. Apply them to a throwaway database (a container from the project's compose file, never a database that holds data), or say in the report that nobody verified them.
