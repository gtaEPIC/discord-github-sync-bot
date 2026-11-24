# CLAUDE.md: Ry Issue Bridge (Discord Forum <-> GitHub Issues/Projects)

Owner: Jasmine (gtaEPIC). Purpose: keep the Ry-Transit bug-report Discord Forum and the GitHub Issues/Projects board in sync, so the forum stops being a bad place to manage work.

**Status (2026-11-23): Phase 0 (bootstrap).** This folder is now a git checkout of the fork (`main`). Read `PLAN.md` first; its §10 holds the finalized design and rules from the code review. It holds the research, the audit of the upstream code, the phased plan, and the open questions. Tick its checkboxes as you finish work.

## Base code

- Hard fork of https://github.com/snick-m/discord-github-sync-bot (MIT). That repo is based on Sillhouette/discord-github-sync-bot, which is based on holmityd/GitHub-Issues-Discord-Threads-Bot.
- Jasmine's fork (`origin`): https://github.com/gtaEPIC/discord-github-sync-bot (public, default branch `main`). `upstream` is snick-m's repo. Because the repo is public, never commit instance-specific IDs, tokens or config.
- Audited at upstream commit `3ba06f9` (2026-11-04). Bootstrap steps are in `PLAN.md` Phase 0.
- Keep `LICENSE` and the upstream credits. Add our copyright line below theirs; never remove theirs.
- Treat `upstream` as a read-only remote for cherry-picks. We will diverge in `engine.ts`, `platforms.ts` and `runtime.ts`, so do not plan on regular merges.

## Decisions so far (2026-11-23)

- Build on the fork above; hard fork; Docker-compatible; runs on server2.
- Everything lives under Jasmine's personal GitHub account (no organization). The GitHub Project does not exist yet.
- Discord users do not need to link GitHub: Discord to GitHub writes use a per-mapping "bridge" mode with the GitHub App's own access (PLAN.md D2). Keep the linked-user mode available.
- So Projects v2 is user-owned: no Projects webhooks, so poll; Projects calls likely need a classic PAT with only the `project` scope (an optional, encrypted setting used only for Projects calls). Run the spike in PLAN.md Phase 4 step 0 before building on this.

## Architecture map (upstream, verified by reading the source)

- `src/index.ts`: entrypoint. Starts the management web server (port 5000) and a loopback-only setup server (5001), then `Runtime`.
- `src/management/*`: admin/user dashboard, Discord OAuth sign-in, GitHub App install discovery, GitHub account linking, encrypted credential store (`management.sqlite` + `master.key`). `runtime.ts` owns the Discord client, event listeners, and one worker per mapping. `server.ts` receives the GitHub webhook at `/github-webhook`.
- `src/bridge/engine.ts`: the sync engine. Tasks: `scan | github | discord | state | unlink`. This is the only place that mutates remote state.
- `src/bridge/platforms.ts`: `LivePlatforms`, the Octokit + discord.js implementation of the `Platforms` interface in `types.ts`. Tests use fakes of that interface.
- `src/bridge/database.ts`: per-mapping SQLite (`routes/<id>.sqlite`). Tables: `links`, `mirrors`, `jobs`, `blocked`, `deliveries`, `meta`. `links.data` is a JSON blob, so adding optional fields to `Link` needs no migration.
- `src/bridge/content.ts`: markers (`<!-- gd-sync:thread:ID -->`, `<!-- gd-sync:message:ID -->`), chunking, issue summary rendering.
- `src/bridge/authorship.ts`: `Writer`/`Relay` types and `WriteBlocked`. Discord to GitHub writes currently require each author to link a GitHub account.
- `src/bridge/commands.ts`: the `/issue status|close|reopen` slash command.

## Invariants (do not break)

1. One Engine and one consumer per per-mapping DB. Event handlers enqueue a `Task`; they never write to Discord or GitHub directly.
2. Echo prevention relies on the markers, the signed relay markers (`authorship.sign/verify`), and the `mirrors` rows. Every new write path needs a loop test.
3. Never edit another user's Discord message. GitHub-originated content lives in bot-owned messages (the summary message plus mirrors).
4. Outbound Discord messages use `allowedMentions: { parse: [] }`. Pings are opt-in only.
5. Archiving is not closing. Inactivity auto-archive must never change GitHub state.
6. Secrets are encrypted at rest, never logged, never returned by the API. Never commit `.env`, `data/`, `master.key`, or `*.sqlite*`.
7. Node >= 24 is required (`node:sqlite` `DatabaseSync`). Package manager is pnpm 8.6.3.
8. Upstream deliberately has no shared-token fallback for Discord to GitHub writes. We are adding an opt-in per-mapping "bridge" write mode (PLAN.md D2). Keep the linked-user mode working.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm typecheck && pnpm test && pnpm build
pnpm smoke                      # scripts/smoke.mjs against the built output
pnpm dev                        # tsx watch
pnpm format                     # prettier (src, README.md)
pnpm queue list                 # inspect the job queue (after build)
docker compose up -d --build    # runs the whole thing; /health on :5000
```

Jasmine's PC has no Node 24 (nvm has 20 and 22 only), so run the pnpm checks inside `node:24-alpine`, copying the tree in rather than building on the bind mount. Docker Desktop must be running:

```sh
MSYS_NO_PATHCONV=1 docker run --rm -v "E:/discord-github-bridge:/src:ro" node:24-alpine sh -c 'set -e; mkdir /w; cd /src; tar --exclude=./node_modules --exclude=./.git -cf - . | tar -xf - -C /w; cd /w; npm i -g pnpm@8.6.3 >/dev/null; pnpm install --frozen-lockfile; pnpm typecheck && pnpm test && pnpm build && pnpm smoke'
docker build -t ry-issue-bridge:ci . && node scripts/smoke.mjs ry-issue-bridge:ci   # host Node 22 is fine for the image smoke
```

Definition of done for any change: typecheck, tests and build pass, `docker build` succeeds, and `node scripts/smoke.mjs <image>` passes. CI (`.github/workflows/ci.yml`) already runs all of this; keep it green.

## Docker requirements (non-negotiable)

- `docker compose up -d --build` must keep working from a clean checkout with an empty `.env`.
- Keep `node:24-alpine`, the non-root user, the `/health` HEALTHCHECK, and the `bot-data` volume at `/app/data`. Run one instance per data directory.
- Config stays in the management UI plus a few env vars. Do not add required env vars. New settings need defaults.
- State must survive `docker compose up -d --build` (image rebuilds). Never ask anyone to run `docker compose down -v`.

## Deployment target

- server2: Alpine Linux, Docker, stacks managed with Komodo. Public routes go through a Cloudflare Tunnel on server2 (routes are added in the Cloudflare dashboard).
- GitHub must reach `POST /github-webhook` unauthenticated (HMAC-signed). Do not put Cloudflare Access or browser challenges on that path. Keep `/admin` and `/dashboard` behind auth, and the setup port (5001) never published.
- `PUBLIC_URL` must be the https origin of the tunnel hostname.

## Doc caveats

`docs/architecture/*.md`, `docs/analysis/*` and `docs/backlog/*` describe an older design (Node 20, JSON comment map, `@octokit/graphql`). Trust the code and `README.md`.

## Working with Jasmine

- Keep messages short. Take open decisions one at a time, each as a short question with a recommended default, instead of presenting a big list.
- Do the safe fix, verify it, then move on to the next thing.
