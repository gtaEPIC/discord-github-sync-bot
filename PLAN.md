# PLAN: Ry Issue Bridge (Discord Forum <-> GitHub Issues/Projects)

Drafted 2026-11-23 from a research chat plus a read-only audit of upstream `snick-m/discord-github-sync-bot` at `3ba06f9` (2026-11-04).

**Status (2026-11-23, second session):** the whole upstream source has been read, the VERIFY items checked (§8), and the open questions answered (§7). The finalized design is in §10. The baseline (install, tests, Docker build) runs in Phase 0.

Claims marked **VERIFY** come from general knowledge, not from a source read during this work. Check them against GitHub/Discord docs before relying on them.

**Decided with Jasmine (2026-11-23):** build on the fork; Docker-compatible, deployed on server2; everything lives under her personal GitHub account (no organization); the GitHub Project does not exist yet and has to be created (Phase 4 step 0).

## 1. Goal

Jasmine's feature list for the Ry-Transit bug-report forum:

1. Synced threads <-> issues
2. Synced titles
3. Synced messages, including edits
4. Synced tags <-> labels. A `Fixed` tag on Discord means closed on GitHub.
5. Synced status: GitHub Projects Status (In Progress, Backlog, ...) <-> a Discord tag. A closed issue closes the thread.
6. Mentions and commits show up in the Discord thread.

Constraint: Docker-compatible, runs on server2 (see CLAUDE.md).

## 2. Why fork instead of adopting a tool (research, 2026-11-23)

No existing tool covers the whole list. Nothing found documents GitHub Projects v2 status sync, Discord-side title sync, or commits/mentions shown in the thread.

| Tool | Useful for | Gap |
|---|---|---|
| snick-m/discord-github-sync-bot (MIT, self-hosted) | Two-way replies with edits, deletes, GitHub title/labels/state to thread, Docker, recovery scans, durable queue | Discord title/tag changes never reach GitHub; close only via slash command; no Projects; per-author GitHub linking required |
| Tosd0/GitHub-Issues-Discord-Threads-Bot | Closed-state tags (completed / not planned / duplicate) close and reopen the issue; tag groups | GitHub comments not synced to Discord; Discord comments only via manual command; no auto issue creation from GitHub |
| cryptiklemur/discord-github-bridge | Posts, comments, tags<->labels, close/lock/reopen both ways | Title sync, edits, Projects not documented; 1 star; no license stated |
| DiscoHub, Threadline (hosted bots) | Comments, open/close, label mapping | Hosted only (no self-host option found); no edits/Projects/commits documented |
| Bentlybro/Git-Discord-Bot | GitHub to Discord mirror with edits/deletes | Discord to GitHub is slash commands only; v4 source not public |
| D3vl0per/issue-bot | Advertises syncing threads with issues and "kanban Projects" | Page could not be read (rate limit). Unverified, probably classic Projects. Worth a manual look. |
| Zapier/Make/n8n | One-way triggers (new forum post -> issue, new forum message -> comment) | No edit sync, no tag sync |
| kylemcd/linear-discord-sync | Pattern reference: mod-only status tags that follow the tracker's status | Linear, not GitHub |

Why snick-m as the base: it is the only one with the hard parts already done (durable queue, per-mapping SQLite, marker-based echo prevention, recovery scans, edits and deletes, chunking, GitHub App auth, Docker + CI smoke test). Risks: young (about 54 commits, 0 stars), single maintainer, and a heavy management layer (dashboard, OAuth, account linking) that a single-operator setup does not strictly need.

## 3. Upstream audit vs the feature list

| # | Feature | Upstream today (verified in source) | Work needed |
|---|---|---|---|
| 1 | Threads <-> issues | GitHub issue -> forum post (`createPost`); human forum post -> issue (`createIssue`). PRs excluded. | None. Optional: command to link an existing thread to an existing issue (Jasmine already has both). |
| 2 | Titles | GitHub -> Discord works: `updatePost` renames the thread to `#N Title`. Discord -> GitHub only at creation. No `ThreadUpdate` listener in `runtime.ts`. | Listen for thread updates; strip the `#N ` prefix; push title to GitHub (D3). |
| 3 | Messages + edits | Works both ways, including edits and deletion notices (`engine.discord`, `engine.github`, `render`). Discord starter edit -> issue body only when `link.origin === "discord"`. | None functionally. Blocker is who may write: every Discord author must link GitHub (`WriteBlocked`). Fix with bridge write mode (D2). |
| 4 | Tags <-> labels, Fixed = closed | GitHub labels -> Discord tags works (names must match, max 5). Discord tags -> labels only at issue creation, and only labels that already exist. Close/reopen only via `/issue close\|reopen` (needs link + Manage Threads or manager role). | Ongoing tag diff sync; close tags (D5); reason mapping. |
| 5 | Status | Closed issue -> thread archived, reopened -> unarchived: works (`updatePost`). No Projects support. Webhook server accepts only `issues` and `issue_comment` events (`src/management/server.ts`, around L323). | Projects v2 Status <-> status tags (Phase 4). |
| 6 | Mentions/commits | None. No timeline reads. | Timeline polling and rendering (Phase 5). |

Other facts that shape the work:
- `Platforms` (in `types.ts`) is the seam. New capabilities go in as new methods, and tests use fakes of it.
- The GitHub adapter hardcodes `own: false` on issues/comments. Echo detection relies on markers, signed relay markers, and `mirrors` rows. Bridge-mode writes (authored by the app) must be recognised the same way.
- Discord applies at most 5 tags per post (upstream comment in `tags()`), so status tags, close tags and type tags share 5 slots. A forum may also cap available tags at 20 (**VERIFY**).
- The `jobs` queue is single-consumer and ordered: a `github` task queued before a `discord` task can overwrite a fresh Discord edit (lost-update race). See D3.

## 4. Design decisions (proposed; confirm the starred ones with Jasmine)

**D1. Hard fork.** Own repo, upstream as read-only remote. Keep MIT credits. Decided 2026-11-23: GitHub fork at https://github.com/gtaEPIC/discord-github-sync-bot (public, since forks of public repos are public; default branch `main`; checked via the GitHub API, not yet diverged from upstream). `origin` is the fork, `upstream` is snick-m, read-only. Because the repo is public, never commit instance-specific IDs, tokens or config.

**D2 (confirmed 2026-11-23). Per-mapping write mode: `user` (upstream behaviour) or `bridge`.** In `bridge` mode, Discord -> GitHub writes use the GitHub App installation token (needs Issues: write on the installation; upstream requests read-only installation tokens, so this widens token scope). Attribution is already in the body (`**Name** on Discord`, from `sourceBody`). The type `Writer.kind` already allows `"bridge"`, and `accounts.ts` already parses it from signed markers. Reason: reporters in a public bug forum will not link GitHub accounts. Safeguards: the forum is a publishing boundary, so add an optional role allow-list and a per-user rate limit, and keep editing limited to content the bridge authored.

**D3. Three-way reconcile for title, labels, state and status.**
- Add an optional snapshot to `Link` (`snap: { title, labels, state, status? }`); no DB migration needed.
- One function `reconcileMetadata(link, issue, post)` is called from both `github()` and `discord()` so neither can clobber the other. Per field, with g = GitHub value, d = Discord value, s = snapshot:
  - g == d: set s = g.
  - only GitHub changed (d == s): write Discord = g.
  - only Discord changed (g == s): write GitHub = d.
  - both changed: GitHub wins; log it.
- Labels are set arithmetic (added/removed vs snapshot per side), restricted to **managed labels** only: names that exist as forum tags in the mapping. Never touch other labels.
- Thread title <-> issue title compares after stripping `^#\d+\s+`.
- Add a `ThreadUpdate` listener in `runtime.ts` (enqueue `{type:"discord"}`); also handle forum tag list changes via the periodic scan.

**D4*. Config model.** A per-mapping JSON "bridge config" (see below), stored with the mapping. Extend the `Mapping` interface (`src/management/store.ts`, currently: id, owner, repo, channel, backfill, enabled, roles, file?, installation?, repositoryId?, guildId?, createdBy?). Check first how mappings are persisted (JSON vs columns). Start with an admin-only JSON textarea in the existing mapping UI instead of building full UI. (`src/admin.ts` is only the interactive admin-password setup/reset CLI, not a config tool.)
```json
{
  "writeMode": "bridge",
  "managedTags": ["Bug", "Crash", "Feature"],
  "closeTags": [
    { "tag": "Fixed",     "reason": "completed"   },
    { "tag": "Won't Fix", "reason": "not_planned" }
  ],
  "status": {
    "project": { "owner": "<your GitHub login>", "number": 1, "ownerType": "user" },
    "field": "Status",
    "map": { "Backlog": "Backlog", "In Progress": "In Progress", "In Review": "In Review", "Done": "Done" }
  },
  "timeline": { "commits": true, "crossReferences": true, "maxAgeDaysClosed": 14 }
}
```

**D5. Close tags.** Applying a close tag closes the issue (`state_reason` from the tag's `reason`); removing all close tags reopens it. GitHub-side close applies the matching close tag using `state_reason` (completed -> Fixed, not_planned -> Won't Fix) if none is present. Existing behaviour stays: closed issue archives the thread, reopened issue unarchives it. In Discord, set the close tags and status tags to "only moderators can apply" (same pattern as linear-discord-sync), so tag permission is the authorization. Requires `state_reason` on `Issue` and a `reason` argument on `Platforms.state`. GitHub's own close reasons are limited to completed / not planned (per the Tosd0 README, a secondary source; **VERIFY** in GitHub docs).

**D6. Status and close precedence.** Status tags are mutually exclusive: at most one at a time; if two appear, keep the most recently applied. Closing an issue sets Status to the mapped "Done" option if the project has not already; GitHub's own project workflow can do this too (docs: "when an issue is closed, you can automatically set the status to Done"). Define exactly which wins to avoid ping-pong, and cover it with a test.

**D7. Projects v2 access (decided 2026-11-23: personal account, user-owned Project).**
- A user-owned Project gets no `projects_v2_item` webhook: that event is listed for organizations only and is in public preview (docs.github.com webhook events page). So Projects state is polled.
- Token: GitHub's Projects API page says a classic PAT or an installation token can be used, but it is silent on user-owned projects. Secondary sources agree that fine-grained PATs and GitHub App tokens cannot reach user-owned Projects, so a classic PAT with the `project` scope is needed (see sources: Piton issue 275; agenthook issue 451 found that a GitHub App gives user-owned boards no hook path). Likely, but run the Phase 4 step 0 spike before building on it.
- Upstream deliberately removed PAT support. Add an optional, encrypted "projects token" setting (same write-only secret handling as the other credentials in `ManagementStore`) used ONLY for Projects GraphQL calls. Issues, comments and reads keep using the GitHub App. Create it as a classic PAT with only the `project` scope (not `repo`). It can read and write all of Jasmine's user-level projects.
- Polling shape: one paginated GraphQL query per scan for the whole project's items (issue number, repo, Status option), diffed against the snapshot, instead of one query per issue. Default is every scan interval (300 s); allow a per-mapping override, minimum 60 s.
- Mutations: `updateProjectV2ItemFieldValue` (single-select supported, per GitHub's GraphQL reference) and `addProjectV2ItemById` when the issue is not in the project yet (**VERIFY** exact schema). The bridge adds new issues to the project itself (default Status = Backlog), so it does not depend on GitHub's auto-add workflow.
- If the project ever moves to an organization: `projects_v2_item` webhooks and an App "Projects" permission become possible, and the PAT can go.

**D8. Commits and mentions via the issue timeline.** Poll `GET /repos/{owner}/{repo}/issues/{n}/timeline` (**VERIFY** event types: `referenced` with `commit_id`, `cross-referenced`, `closed` with `commit_id`) for linked issues that are open or closed within `maxAgeDaysClosed`. Render each new event as one compact bot message in the thread, deduplicated by a mirror key `timeline:<event id>`. Pull requests stay out of scope as threads; they appear only as cross-references. The interpretation of "mentions" is an open question (Q4).

## 5. Phases

Each phase ends with typecheck, tests, build, docker build and smoke green, then a commit. Tests extend the fake-`Platforms` style in `engine.test.ts` (read it first).

### Phase 0: Bootstrap and baseline
- [x] In this folder: `git init`; `git remote add origin https://github.com/gtaEPIC/discord-github-sync-bot.git`; `git remote add upstream https://github.com/snick-m/discord-github-sync-bot.git`; `git fetch origin main`; `git checkout -B main origin/main` (untracked CLAUDE.md/PLAN.md are fine). Commit CLAUDE.md and PLAN.md as the first commit. Adjust if git objects.
- [x] Use Node 24+ and pnpm 8.6.3. This PC has only Node 20/22 under nvm, so the checks run in `node:24-alpine` through Docker: copy the tree into the container, `npm i -g pnpm@8.6.3`, then `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test && pnpm build && pnpm smoke`.
- [x] `docker compose up -d --build`; confirm `curl -f http://127.0.0.1:5000/health`; run `node scripts/smoke.mjs <image>`.
- [x] Baseline (2026-11-23, upstream `3ba06f9` in Node 24.22.3 and pnpm 8.6.3): typecheck clean; 17 test files and 117 tests passed; build OK; `pnpm smoke` OK; `docker build` OK; image smoke OK; `docker compose up -d --build` with an empty `.env` returned `/health` `{"status":"ok"}`. No baseline failures.
- [x] Renamed the package to `ry-issue-bridge`; compose image is now `ghcr.io/gtaepic/discord-github-sync-bot:latest` with `pull_policy: missing` (`build:` kept); CI image tag `ry-issue-bridge:ci`. Added the LICENSE line and the README "Fork notes". `.gitignore` now also ignores `master.key` and `*.sqlite*`.
- [x] Added `.github/workflows/pr-build-check.yml` (PRs to `main`: tests, then a Docker build) and `image-build.yml` (`v*` tags: tests, then push to GHCR), via the `ghcr-docker-workflows` skill. actionlint was not run (not installed).

### Phase 1: Bridge write mode (D2)
- [x] `writeMode` in mapping settings (`src/bridge/config.ts`, `Mapping.bridge`, admin `POST /api/mappings/:id/config` and a Settings dialog). `LivePlatforms.write()` routes to `bridgeWrite` (bridge mode or a pinned bridge writer) or upstream `userWrite`.
- [x] Write tokens: `repositoryToken(..., "write")` mints `{issues: "write", metadata: "read"}` pinned to the repository, cached under the same `repo:` prefix. Read tokens unchanged. README documents bridge mode.
- [x] Echo handling: the bot id is resolved in `initialize()` (`users.getByUsername(slug[bot])`) and the mapping fails if it cannot be resolved in bridge mode. Relays are signed `{kind:"bridge", discordId, githubId: botId}`; `own` is set for bot-authored content; a mismatched author id on create is adopted. Loop test in `engine.test.ts` (`own: false`, relay only) covers post, reply, edit and delete.
- [x] Role allow-list (`allowRoles`; role refusals are held without a ping) and per-user rate limit (`rateLimit`, in-memory, backfill exempt, failures not counted). GitHub rate-limit 403s are rethrown for queue backoff; a 401 refreshes the write token. Tests in `bridgeWrites.test.ts`. Live acceptance waits for Phase 6 staging.
- Acceptance: a Discord user with no linked GitHub account can open a post, reply, and edit; issue and comments appear with Discord attribution; no echo loops.

### Phase 2: Titles and tags/labels (D3)
- [x] `Link.snap` (title, managed labels, overflow, state) and pure `planMetadata` in `src/bridge/reconcile.ts`. It runs once, in `engine.github()` (`metadata()`), which every Discord task already ends in; both sides are read at run time. A missing snapshot means GitHub wins once, so links need no seeding (a Discord-origin issue is created with the same tag-to-label pairing, so both sides start equal).
- [x] `ThreadUpdate` listener enqueues the linked issue's `github` task when the name or applied tags change.
- [x] `Platforms.updateIssue` (App write token, bridge mode only; refusals are held under `meta:N` and never fail the job), `threadMeta`, `managedTags`, `applyMeta` (forced re-read, delta, only changed fields, archived state restored), `applyArchive` (archive on close, unarchive only on reopen vs the snapshot). `updatePost` is gone.
- [x] Title: only this issue's `#N ` prefix is stripped; names truncated to 100 compare equal. Managed pairing: explicit `labels` setting, else case-insensitive name; unmanaged tags pass through. Five-tag cap: tags already applied are kept, labels that do not fit are kept as `overflow` and not read as removals. No warning message in the thread (decided against: it would add bot noise on every overflow). Renames: at most two per thread per ten minutes; a deferred rename keeps the old snapshot title so it is retried.
- [x] Tests: `reconcile.test.ts` (all outcomes for title and labels, truncation, prefix restore without ping-pong, overflow, user mode, missing snapshot, pairing), engine tests (stale queued GitHub task loses nothing, own edits are quiet, user mode reverts, held write retried, inactivity archive kept), adapter tests (delta, forced re-read, archive restore, rename deferral).
- Acceptance: rename a thread -> issue title changes; add/remove a managed tag -> label changes; same in reverse; simultaneous edits resolve with GitHub winning.

### Phase 3: Close tags (D5)
- [ ] `state_reason` on `Issue`; `Platforms.state(number, state, actor, reason)`.
- [ ] Config `closeTags`; tag add/remove -> `state` task; GitHub close/reopen -> add/remove the tag.
- [ ] Keep `/issue close|reopen` working.
- [ ] Tests: Fixed -> closed/completed; Won't Fix -> closed/not_planned; reopen removes tags; GitHub-side close applies the right tag.
- Acceptance: Fixed tag closes the issue and archives the thread; reopening on GitHub removes the tag.

### Phase 4: Projects v2 status (D6, D7)
- [ ] Step 0 (prerequisite): create the user-level Project (Status options such as Backlog, In Progress, In Review, Done) plus a throwaway test project. Run a spike proving a classic PAT with only the `project` scope can list items, add an issue, and set Status via GraphQL, and that an installation token cannot. If the spike disagrees with D7, fix D7 first.
- [ ] Optional encrypted "projects token" setting in the management store/UI (write-only), plus mapping config for project owner login and number.
- [ ] 4a read-only: GitHub Status -> Discord status tag via polling (whole-project item query on the scan interval).
- [ ] 4b write: Discord status tag -> project item field update (add the item to the project if missing).
- [ ] 4c (only if the project ever moves to an organization): accept the `projects_v2_item` webhook in `server.ts`, route by project/issue, enqueue a `github` task.
- [ ] Status/close precedence tests; mutual exclusion of status tags.
- Acceptance: moving a card in the project changes the thread's status tag; changing the tag moves the card; closing the issue ends in a consistent state with no ping-pong.

### Phase 5: Commits and mentions (D8)
- [ ] Timeline reader in `LivePlatforms`; render and dedupe by mirror key.
- [ ] Config `timeline`; bound requests (open issues plus recently closed).
- [ ] Optional, off by default: @mention to Discord ping via linked accounts. Upstream disables pings on purpose.
- Acceptance: a commit that references `#N` shows up once in the thread; a cross-reference from another issue shows up once; none repeat after restart.

### Phase 6: Deploy to server2
- [ ] Komodo stack: image from GHCR, `bot-data` volume, `.env` with `PUBLIC_URL`, port bound to loopback or tunnel network only.
- [ ] Cloudflare Tunnel route for the hostname; confirm `/github-webhook` is reachable without Access/challenge; `/admin` stays protected.
- [ ] Create the Discord bot (Message Content Intent; permissions: View Channel, Send Messages, Send Messages in Threads, Read Message History, Manage Threads) and the GitHub App (Issues r/w, Metadata read; webhook events: Issues and Issue comments only, since a user-owned Project has no webhook), plus a classic PAT with only the `project` scope for Projects calls (D7).
- [ ] Map the Ry-Transit repo to the forum. Decide backfill first (Q6).
- [ ] Backup note: stop the service, then copy the whole data volume including `master.key` and any `-wal`/`-shm` files.

## 6. Risks

- Echo loops and duplicate writes when adding bridge mode and metadata sync. Mitigation: loop tests per path, single-consumer queue, markers.
- Lost updates between concurrent `github` and `discord` tasks (D3).
- Tag slot limit (5 applied) squeezes type + status + close tags. Mitigation: keep type tags few, or drop the type tags that are not needed.
- Bridge mode widens the GitHub App's write authority; anyone who can post in the forum can create issues. Mitigation: allow-list, rate limit, private/limited forum audience if needed.
- Projects access needs a classic PAT (`project` scope) because the Project is user-owned; it can read and write all of Jasmine's user-level projects. Mitigation: encrypted at rest, write-only, used only for Projects calls, rotate if leaked (D7).
- API rate limits with timeline polling; mitigation: bound by age and state, use conditional requests where possible.
- Diverging from a young single-maintainer upstream: accepted.

## 7. Open questions for Jasmine (ask one at a time, with a recommended default)

1. ~~Org or personal account?~~ Answered 2026-11-23: everything is under Jasmine's personal account and the Project does not exist yet (D7 resolved: polling plus a classic PAT).
2. ~~Bridge write mode for public reporters?~~ Answered 2026-11-23: yes (D2). Role allow-list and rate limit stay as optional safeguards.
3. Tags: Jasmine already has some forum tags; the full list (type, status, close tags) will be defined later and is not blocking. Tag names live in the per-mapping config (D4), not in code. Mind the 5-per-post cap when defining them. Close and status tags must be "moderated" in Discord (see §10 rule 2).
4. ~~What does "mentions" mean?~~ Answered 2026-11-23: cross-references only (commits, other issues, PRs). No Discord pings; the optional ping item in Phase 5 is dropped.
5. ~~Where does the code live?~~ Answered 2026-11-23: Jasmine forked it herself to gtaEPIC/discord-github-sync-bot (D1).
6. ~~Existing data?~~ Answered 2026-11-23: the target repo is `gtaEPIC/Ry-Transit-Line-2-Dev` (private, 0 issues, default branch `master`, default labels only). Backfill the open (unarchived) forum threads into new issues, after a preview that lists what would be created.
7. ~~PRs as threads?~~ Default 2026-11-23: no, cross-references only.
8. ~~Write mode for linked users?~~ Answered 2026-11-23: in `bridge` mode every Discord to GitHub write goes through the GitHub App bot, linked or not.
9. ~~Projects PAT owner?~~ Answered 2026-11-23: if the spike shows a classic PAT needs `repo` (likely, because the repo is private), use a dedicated machine GitHub account that collaborates only on this repo and the Project.

## 8. Things to verify before relying on them

Checked against official docs on 2026-11-23:
- [x] Close reasons (D5): `state_reason` accepts `completed | not_planned | duplicate | reopened` and is returned on issue objects. `duplicate` is usable. Still to check: that the `issues` webhook payload carries it (inspect one delivery).
- [x] Timeline (D8): `referenced` and `closed` carry `commit_id`/`commit_url`; `mentioned` exists; all have `id` **except `cross-referenced`**, which has only `actor`, `created_at`, `updated_at` and `source` (with `source.issue`; a PR is recognisable because `source.issue.pull_request` exists). Pagination is up to 100 per page. ETag 304 replies with auth do not count against the primary rate limit.
- [x] Discord: 20 available tags per forum, 5 applied per thread, tag names up to 20 characters. `moderated` tags need Manage Threads. `threadUpdate(old, new)` has no actor. The audit log (type 111) has one, but we do not need it.
- [x] Installation tokens can be minted narrowed, for example `permissions: {issues: "write"}`.
- [x] `projects_v2_item` is still org-only (public preview).
- [ ] Projects tokens (D7): a classic PAT needs `read:project` to read and `project` to write. **It probably also needs `repo` to see private-repo items.** Fine-grained PATs cannot reach user-owned projects (documented gap). Apps have only an org Projects permission. Mutations `addProjectV2ItemById` (idempotent) and `updateProjectV2ItemFieldValue` (one field per call) are as written in D7. Items have `updatedAt` but order only by position, so each poll is a full scan. Still run the Phase 4 step 0 spike.

## 9. Sources (research, 2026-11-23)

- https://github.com/snick-m/discord-github-sync-bot
- https://github.com/Tosd0/GitHub-Issues-Discord-Threads-Bot
- https://github.com/cryptiklemur/discord-github-bridge
- https://github.com/klrmngr/gh-issue-sync
- https://github.com/Bentlybro/Git-Discord-Bot
- https://github.com/D3vl0per/issue-bot (not read)
- https://github.com/kylemcd/linear-discord-sync
- https://discohub.osiris-devworks.com/
- https://docs.github.com/en/webhooks/webhook-events-and-payloads (`projects_v2_item`: Organizations, public preview)
- https://github.com/orgs/community/discussions/17405 (Projects v2 webhook feedback)
- https://docs.github.com/en/enterprise-server@3.20/graphql/reference/projects (`updateProjectV2ItemFieldValue`)
- https://docs.github.com/en/enterprise-server@3.20/issues/planning-and-tracking-with-projects/learning-about-projects/best-practices-for-projects (built-in "closed -> Done" workflow)
- https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects (token types; silent on user-owned projects)
- https://github.com/alex35mil/Piton/issues/275 (secondary: user-owned Projects need a classic token)
- https://github.com/Jesuso/agenthook/issues/451 (secondary: a GitHub App gives no hook path for user-owned Projects v2)

## 10. Finalized implementation design (2026-11-23, second session)

This section comes from reading the whole upstream source plus an independent review against the code. Where it disagrees with §4 or §5, it wins.

### 10.1 Code facts the design relies on
- `engine.discord()` always ends with `enqueue({type:"github"})`, so every Discord change eventually runs `engine.github()`.
- `store.enqueue` dedupes on the task's JSON when no key is passed. That dedupe includes failed rows, so a failed job blocks later re-enqueues (see review rule 1). Event handlers in `runtime.ts` pass `randomUUID()` keys.
- `engine.github()` calls `api.updatePost(link, issue)` twice: once before rendering and once at the end for archive state. Together with `createPost` (which also sets the name and tags), these are the GitHub to Discord metadata writes. The reconcile step replaces the first call.
- `engine.github()`'s deletion loop marks every `origin:"github"` mirror whose `source` is not a current comment id as deleted, except the summary. **Timeline mirrors must be excluded from that loop**, or every one of them would be marked deleted.
- Relay signing (`accounts.ts` `sign`/`verify`) already supports `writer.kind:"bridge"`. It needs a numeric `githubId` equal to the comment author's id, so bridge mode needs the App bot user's numeric id (`GET /app` gives the slug, then `GET /users/{slug}[bot]` gives the id).
- Mappings are JSON blobs (`mappings.data`), so `Mapping.bridge?: BridgeConfig` needs no migration. `Link` is a JSON blob too, so adding `snap` and `projectItem` needs none either.
- Admin `POST /api/mappings/:id` only toggles `enabled`. Webhook routing accepts only `issues` and `issue_comment`, which is enough (nothing new is needed there).
- `installations.mint()` hardcodes `{issues:"read", metadata:"read"}`, and the token cache is keyed by repo.
- Local machine: Node 22.16 (the project needs 24), Docker 28 is present, and pnpm's corepack shim fails on drive E:.

### 10.2 Approach

All tag, label, status and close-tag behaviour is one **per-field three-way reconcile** that runs inside `engine.github()`. It reads both sides fresh, so queue order cannot cause lost updates. Discord-side triggers (`ThreadUpdate`) enqueue a `github` task for the linked issue. Projects polling only detects changes and enqueues `github` tasks. One code path, one consumer; invariant 1 holds.

### 10.3 New and changed modules
- `src/bridge/config.ts` (new): the `BridgeConfig` type, `parseBridgeConfig(unknown)` (validation, defaults, a clear error list) and `DEFAULT_CONFIG` (writeMode `user`, so existing behaviour is unchanged). Shape:
  ```ts
  { writeMode: "user"|"bridge",
    allowRoles?: string[], rateLimit?: { issuesPerHour: 5, commentsPerHour: 60 },
    labels?: Record<tag, label>,            // explicit tag->label; else case-insensitive name match
    closeTags?: { tag, reason: "completed"|"not_planned"|"duplicate" }[],
    status?: { owner, number, field: "Status", map: Record<tag, option>, defaultOption?: "Backlog" },
    timeline?: { enabled: true, maxAgeDaysClosed: 14 } }
  ```
- `src/bridge/reconcile.ts` (new): pure functions with no I/O, for the bulk of the unit tests. It covers:
  - `reconcile(g, d, s)` per field (title, labels as sets, closed-state, status). Same values: update the snapshot. Only one side changed: write the other side. Both changed: GitHub wins.
  - `toDiscordTags()`: allocates the 5 slots in priority order: close tag, then status tag (only when open), then labels. Labels that do not fit go into `snap.overflow` and are excluded from the Discord-side diff, so the cap never reads as "Discord removed it".
  - `stripTitle()`: removes `^#\d+\s+` and treats a truncated 100-character thread name as equal to the GitHub title.
- `types.ts`:
  - `Issue.stateReason?`.
  - `Link.snap?: {title, labels, closed: tag|null, status?: string|null, overflow?: string[]}` and `Link.projectItem?`.
  - `Platforms.updateIssue(number, {title?, addLabels?, removeLabels?, state?, reason?}, writer?)`.
  - `Platforms.updatePost(link, desired: {name, tags, locked, closed})`, which replaces the current issue-shaped call.
  - Optional `Platforms.projectStatus?/setProjectStatus?/projectItems?` and `timeline?`.
- `platforms.ts`:
  - A `bridgeWrite()` next to `userWrite()`, selected by `writeMode`. It mints a write token, signs with `{kind:"bridge", discordId, githubId: botId}` and enforces the role allow-list and the rate limit by throwing `WriteBlocked` with new reasons `"role"`/`"rate"`. Held rate-limited writes are retried on the next scan.
  - `updatePost` writes the desired tags by tag id.
  - Label writes go through `addLabels`/`removeLabel`. They never touch labels outside the managed set.
- `installations.ts`:
  - `mint(installation, repos, permissions)`.
  - `repositoryToken(..., access: "read"|"write")` with a separate cache key.
  - `botIdentity()`, cached.
- `engine.ts`:
  - `github()`: replace the first `updatePost` with `metadata(link, issue)`. It fetches the post, maps both sides to fields, reconciles, writes, then saves `link.snap`. A missing snapshot means GitHub wins once (today's behaviour).
  - Keep the final archive-only pass.
  - Exclude `timeline:*` mirrors from the deletion loop.
  - Add `timeline()` rendering after comments.
- `runtime.ts`:
  - A `ThreadUpdate` listener: if the thread is linked and its name or tags changed, enqueue `{type:"github", issue}`.
  - Pass the mapping config to `LivePlatforms`/`Engine`.
  - In bridge mode, `/issue close|reopen` skips the linked-account check (the Manage Threads or manager-role check stays).
- `store.ts`/`server.ts`/admin UI:
  - `Mapping.bridge?`.
  - `POST /api/mappings/:id/config`: admin only, existing CSRF and session handling, validated by `parseBridgeConfig`, audited, then reload.
  - A JSON textarea in the admin mapping card.
  - Write-only `POST /api/projects-token` (vault id `projects-token`, checked with a `viewer{login}` call, never returned or logged).
  - `GET /api/mappings/:id/backfill-preview`: lists the posts that would get issues.
- `src/bridge/projects.ts` (new): a small GraphQL client using `fetch` and the PAT (no new dependency).
  - Resolves the project id, the field id and the option ids, cached and refreshed on error.
  - `items()` runs a paginated full scan and returns `{issueNumber, itemId, status, updatedAt}` for this repo only.
  - Also `addItem(issueNodeId)` and `setStatus(itemId, optionId)`.

### 10.4 Rules from the code review (they override anything above that disagrees)
1. **No `WriteBlocked` may leave `github()`.** A WriteBlocked that escapes `run()` marks the job `failed=1` (`runtime.ts:489`). The JSON-keyed `enqueue` is `INSERT OR IGNORE`, so that failed row then swallows every later scan for that issue.
   - Wrap every write in `metadata()` with `hold()` under the key `meta:<issue>`.
   - On each scan, clear held rows and retry them.
   - Exempt `/issue close|reopen` from the rate limit.
   - Retry held `state` jobs on scan (`resumeHeld` runs only on account linking, which bridge mode never does).
2. **Discord to GitHub metadata writes happen only in `bridge` mode,** with the App write token. `user` mode keeps upstream's "GitHub wins" for title and tags (invariant 8). The allow-list and rate limit cannot apply to tag edits, since `ThreadUpdate` has no actor. So every tag with a GitHub effect beyond a label (close tags, status tags) must be *moderated*. Default: the original poster may retitle their post and change unmoderated type tags.
3. **Seed `link.snap` when the link is created,** in `discord()` from the post and in `github()`/`createPost` from the issue, so the first run never wipes tags. `createIssue` uses the same tag-to-label mapping as reconcile. A backfilled thread that already has a close tag is created, then closed with that tag's reason.
4. **The final pass uses the reconciled state.** Write the reconciled fields back into `issue` before rendering the summary.
   - Split `updatePost` into `applyMeta(delta)` and `applyArchive(closed, reopened)`.
   - Unarchive only on a closed-to-open change against the snapshot, never because metadata changed.
   - Archive state is never a reconcile field (invariant 5).
5. **Bridge echo safety.**
   - Resolve the bot user id in `initialize()` and fail the mapping if it cannot.
   - Check that `data.user.id === botId` on every create.
   - Set `own:true` when the author is the bot, so the marker recovery paths work in production.
   - Edits re-sign with the pinned writer (`mirror.writer`/`link.writer`). A pinned `bridge` writer always uses `bridgeWrite`, even if the mapping switches back to `user` mode.
   - Loop tests use `own:false` with a fake `Authorship`; the current Fake hides this with `own:true`.
6. **A rate-limit 403 is not a permission error.** `bridgeWrite` rethrows when `retry-after` is present or `x-ratelimit-remaining` is `0`, so the queue backs off. It does not hold the change or ping the user (that matters during backfill).
7. **Discord allows 2 thread renames per 10 minutes.**
   - Send only the changed fields to `channel.edit`.
   - If a rename is rate-limited, defer it by holding with a retry time; do not block the global drain loop.
8. **Apply deltas, not replacements.** Re-fetch the channel right before editing and apply only the tag add/remove delta. Keep `randomUUID` keys on `ThreadUpdate` enqueues.
9. **Managed sets.**
   - Unmapped Discord tags pass through untouched.
   - Never `addLabels` an unknown name (GitHub would create the label).
   - `stripTitle` strips only `#${number} `.
   - The closed field is compared in tag space, so a fallback tag never rewrites `state_reason`.
   - The snapshot stores tag *ids*, so renaming a forum tag is safe.
10. **Use a light `threadMeta(thread)`** (name, tag ids, archived, locked) for reconcile instead of `getPost`. `getPost` force-fetches the starter and may re-upload its attachments to R2.
11. **Timeline.**
    - Mirror keys include the target issue: `timeline:<issue>:<id>` or `timeline:<issue>:xref:<source.issue.id>`. `mirrors.key` is global.
    - Request `contents:read` only if the installation has granted it; check through `GET /app/installations/{id}` permissions.
12. **Plumbing.**
    - The `bridge` field already survives every mapping save; they spread the existing object.
    - The write-token cache key stays under the `repo:o/r:` prefix so `invalidate()` clears it.
    - The `Fake` gains `updateIssue`, `threadMeta`, tag ids, archived/locked state and the split post methods.

