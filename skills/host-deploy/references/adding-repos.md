# Adding New Company Repos

When new repos are added to the system, update the SKILL.md file with a new
section under "## Company Repos" following the same pattern:

1. Add a heading: `### repo-name — /home/trbck/wp/repo-name`
2. Brief description of the project
3. Key directories and files
4. Common operations (build, test, run, deploy)

The repo should be:
- Cloned to `/home/trbck/wp/<repo-name>` on the host
- Automatically available in the container via the `/wp` mount
- Accessible via SSH using the same `hostmachine` config

No SSH or Docker configuration changes are needed — the existing setup
covers any repo under `/home/trbck/wp/`.
