# Athena (YesImBot v4)

## Custom Changes In This v4 Branch

- Merged the latest upstream v4 code while preserving local fixes and feature additions.
- Fixed duplicate bot replies, image visibility issues, and missing visibility of bot self-sent messages.
- Added `execute` and `sticker` related capabilities, plus several runtime bug fixes.
- Added scheduled image-cache cleanup, editable cleanup config, and a manual cleanup command with strict path-safety boundaries.
- Fixed runtime service issues including persona fragment-source collisions, optional `yesimbot.hook` and `yesimbot.session` access warnings, missing `AgentSessionStore` startup registration, and concurrent `skill.catalog` duplicate fragment failures.

Koishi 4.x plugin monorepo for building personality-driven LLM chat agents.

## Documentation Index

- Project working context: `AGENTS.md`
- Architecture overview: `docs/ARCHITECTURE.md`
- Change playbook: `docs/CHANGE_GUIDE.md`
- Config and environment notes: `docs/ENVIRONMENT.md`
- Milestone and roadmap context: `.planning/PROJECT.md`, `.planning/ROADMAP.md`

## Workspace Layout

- `core/`: main runtime plugin and services
- `packages/shared-model/`: shared model/provider types
- `providers/`: model provider integrations
- `plugins/`: optional extensions
- `references/`: previous versions and design references

## Common Commands

```bash
yarn build
yarn typecheck
yarn test
yarn test -p core
yarn lint
```
