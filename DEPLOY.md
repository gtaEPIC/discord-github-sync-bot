# Deploying Ry Issue Bridge (Docker, Komodo, Cloudflare Tunnel)

A step-by-step runbook for one server running Docker, with stacks managed in Komodo and public traffic through a Cloudflare Tunnel. Replace `issues.example.com` with your own hostname. Keep real IDs, tokens and hostnames out of this repository.

Work through the steps in order: later ones need values from earlier ones. Do everything on a **staging** pair first (a test forum and a throwaway private repository), then repeat steps 11 and 12 for the real forum and repository.

## 1. Publish an image

Push a version tag; `.github/workflows/image-build.yml` runs the tests and pushes `ghcr.io/<owner>/discord-github-sync-bot` tagged `v0.1.0`, `0.1.0` and `latest`.

```sh
git tag v0.1.0 && git push origin v0.1.0
```

The first push creates a GHCR package that is private. Either make it public (GitHub → your profile → **Packages** → the package → **Package settings** → **Change visibility**; the source is public anyway) or add a GHCR registry account with a `read:packages` token in Komodo.

## 2. Choose the hostname

Pick the public hostname, for example `issues.example.com`. `PUBLIC_URL` is its https origin. GitHub must reach `POST /github-webhook` on it without any login or browser challenge.

## 3. Create the Komodo stack

The repository ships `deploy/compose.yaml` for this: it pulls the published image (never builds) and reads its settings from the environment.

In Komodo: **Stacks → New Stack**, name it (for example `ry-issue-bridge`), choose the server, then in its config:

- **Source: Git Repo**. Provider `github.com`, repo `gtaEPIC/discord-github-sync-bot`, branch `main`. The repository is public, so no account is needed.
- **Run Directory**: `deploy`. **File Paths**: `compose.yaml`.
- **Environment**:

  ```
  PUBLIC_URL=https://issues.example.com
  IMAGE_TAG=0.1.0
  ```

  Optional: `BIND_ADDRESS` (default `127.0.0.1`) and `HOST_PORT` (default `5000`).

**Save**, then **Deploy**. Check `curl -f http://127.0.0.1:5000/health` on the server.

- `IMAGE_TAG` pins a version, so an update is a deliberate change and a rollback is the previous tag.
- The data volume is named `ry-issue-bridge-data` regardless of the stack name. Never destroy it or run `docker compose down -v`.
- **cloudflared in a container** (it cannot reach `127.0.0.1` on the host): find its network, for example `docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' <cloudflared-container>`, then set **File Paths** to `compose.yaml, compose.tunnel.yaml` and add `TUNNEL_NETWORK=<that network>` to the environment. The bridge joins that network as `ry-issue-bridge`, and no host port needs to be reachable. If the network is `bridge` (Docker's default, which has no container names), create one (`docker network create tunnel`), connect cloudflared to it, and use that.
- Never publish port 5001 (first-administrator setup). It stays inside the container.

## 4. Add the tunnel route

Cloudflare dashboard → **Zero Trust → Networks → Tunnels** → your tunnel → **Public hostnames → Add**: hostname `issues.example.com`, service type `HTTP`, URL `ry-issue-bridge:5000` when cloudflared shares the network (step 3), or `localhost:5000` when it runs on the host.

- Leave **HTTP Host Header** empty: the bridge only answers requests for the `PUBLIC_URL` hostname, which cloudflared passes through by default.

- Do not put Cloudflare Access or a challenge on `/github-webhook`. If you add Access, scope it to `/admin*` only; the app also has its own login.
- Check `https://issues.example.com/health` from outside.

## 5. Create the administrator

In Komodo, open a terminal on the stack's container (or `docker exec -it <container> sh` on the server) and run:

```sh
node dist/admin.js setup
```

The password input is hidden. Then sign in at `https://issues.example.com/admin`.

## 6. Discord bot

1. https://discord.com/developers/applications → **New Application**.
2. **Bot**: **Reset Token** and copy it; enable **Message Content Intent**.
3. Invite it, replacing `<APPLICATION_ID>` (from **General Information**):
   `https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot+applications.commands&permissions=292057844736`
   That number grants View Channel, Send Messages, Send Messages in Threads, Read Message History and Manage Threads, nothing more.
4. In **/admin → Connections → Your Discord bot**, paste the token, plus a webhook secret of at least 16 random characters (keep it for step 7), and save.

## 7. GitHub App

1. https://github.com/settings/apps/new.
   - Homepage URL: `https://issues.example.com`
   - Callback URL: shown in **/admin → Connections → GitHub App** (`https://issues.example.com/auth/github/callback`)
   - Webhook: active; URL `https://issues.example.com/github-webhook`; secret: the one from step 6.
   - Repository permissions: **Issues: Read and write**, **Metadata: Read-only**. Nothing else.
   - Subscribe to events: **Issues**, **Issue comment**.
   - Where can it be installed: **Only on this account**.
2. After creating it: note the **App ID**, **Client ID** and the slug (the last part of the app's URL); **Generate a new client secret**; **Generate a private key** (downloads a `.pem`).
3. **Install App** → your account → **Only select repositories** → the staging repository (add the real one later).
4. In **/admin → Connections**: save **GitHub App** (client ID, slug, client secret), then **Installation access** (App ID and the contents of the `.pem`). Delete the downloaded `.pem` afterwards.

## 8. Projects token (only for Projects Status sync)

User-owned boards need a classic token with `project` and, for a private repository, `repo`. A `repo` token reaches every repository its account can, so use a dedicated machine account:

1. Sign out (or use a private window) and create a new GitHub account for the bridge, with its own email.
2. From your main account: invite it as a collaborator on the repository (**Settings → Collaborators**, write) and on the Project (**Project → … → Settings → Manage access**, write).
3. As the machine account, accept both invitations, then create a classic token at https://github.com/settings/tokens/new?scopes=project,repo&description=ry-issue-bridge with no expiry or a long one you will rotate.
4. Check it: `PROJECTS_TOKEN=... pnpm projects-check <owner> <project-number> <owner/repo> <issue-number>`.
5. Save it in **/admin → Connections → Projects token**.

## 9. Forum setup

In the forum channel's settings:

- Tags (at most 20): type tags whose names match repository labels (for example Bug, Feature), close tags (for example Fixed, Won't Fix, Duplicate), and status tags (for example Backlog, In Progress, In Review).
- Mark close and status tags **Only moderators can apply** (moderated). Discord does not report who changed a tag, so this is the authorization.
- Do not require tags on new posts.
- Give the bot's role the five permissions from step 6 on the forum.

## 10. Discord sign-in (optional)

Only needed for the member dashboard. Discord application → **OAuth2** → add the redirect `https://issues.example.com/auth/discord/callback`, then save the client ID and OAuth client secret in **/admin → Connections → Discord sign-in**.

## 11. Create the mapping

1. **/admin → Mappings → New mapping**: choose the installation, repository, server and forum. Leave **Import existing** unticked.
2. **Settings** on the new row, for example:

   ```json
   {
     "writeMode": "bridge",
     "closeTags": [
       { "tag": "Fixed", "reason": "completed" },
       { "tag": "Won't Fix", "reason": "not_planned" },
       { "tag": "Duplicate", "reason": "duplicate" }
     ],
     "status": {
       "owner": "<project-owner-login>",
       "number": 1,
       "tags": {
         "Backlog": "Backlog",
         "In Progress": "In Progress",
         "In Review": "In Review"
       },
       "defaultOption": "Backlog"
     },
     "timeline": {}
   }
   ```

3. Check on staging: a new post becomes an issue; replies sync both ways; renaming the thread and changing a type tag change the issue; a close tag closes it and reopening on GitHub removes the tag; moving the card changes the status tag and the reverse; a commit with `#N` shows up once; restarting the stack repeats nothing.

## 12. Import existing posts

On the mapping row, **Import…** shows which active forum posts would get an issue and which open issues would get a post. Nothing is created until you press **Import**. Archived posts and closed issues are never imported. GitHub's content limits slow large imports down; the queue waits as GitHub asks.

## Updates and backups

- **Update:** push a new tag (step 1), change `IMAGE_TAG` in the Komodo stack's environment and redeploy. State lives in `bot-data` and survives. Never run `docker compose down -v` or delete the volume.
- **Back up** the whole volume, including `master.key`, while the stack is stopped (Komodo **Stop**, copy the volume directory, **Start**). The volume directory is shown by `docker volume inspect ry-issue-bridge-data`. `master.key` plus `management.sqlite` can decrypt the saved credentials, so store backups privately.
- **Rotate** tokens by saving new ones in **/admin → Connections**; revoke the old ones on Discord or GitHub.
