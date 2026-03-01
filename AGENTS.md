# AGENTS Instructions

## Mandatory End-Of-Development Flow

After every development change in this project, always run the following sequence:

1. Commit changes to Git.
2. Push to remote (`origin`) on the active branch.
3. Refresh Docker deployment with:
   - `docker compose up -d --build --force-recreate`

## Skill Enforcement

Use skill `$dev-finish-git-docker` at the end of each development task to execute the required flow above and report:

- Commit hash and branch
- Push result
- Docker refresh result and `docker compose ps` status
