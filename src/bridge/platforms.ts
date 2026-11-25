import { Octokit } from "@octokit/rest";
import {
  Client,
  ForumChannel,
  Message as DiscordMessage,
  PermissionFlagsBits,
  ThreadChannel,
} from "discord.js";
import { Authorship, Writer, WriteBlocked } from "./authorship";
import { uploadToR2 } from "../r2";
import {
  chunks,
  embedMarkdown,
  issueSummary,
  missing,
  sourceBody,
} from "./content";
import {
  Comment,
  Issue,
  IssueChange,
  Message,
  MetaChange,
  Platforms,
  Post,
  ThreadMeta,
  TimelineEvent,
} from "./types";
import { BridgeConfig, DEFAULT_CONFIG } from "./config";
import { ProjectsClient } from "./projects";
import {
  CloseTag,
  StatusTag,
  MAX_TAGS,
  ManagedTag,
  managedTags,
  threadName,
} from "./reconcile";

type Options = {
  owner: string;
  repo: string;
  forum: string;
  readToken: () => Promise<string>;
  repositoryId?: number;
  invalidateReadToken?: () => void;
  /** Resolved per-mapping settings; defaults to upstream user mode. */
  config?: BridgeConfig;
  /** Issues-write installation token, used only for bridge-mode writes. */
  writeToken?: () => Promise<string>;
  invalidateWriteToken?: () => void;
  /** The GitHub App's bot login (`slug[bot]`), the author of bridge-mode writes. */
  botLogin?: string;
  /** Mapping start time; older Discord messages are backfill and exempt from the rate limit. */
  started?: () => string | undefined;
  /** Discord role IDs of a guild member (injectable for tests). */
  memberRoles?: (discordId: string) => Promise<string[]>;
  /** Projects v2 client; present when the mapping has Status sync and a Projects token exists. */
  projects?: ProjectsClient;
};
type Rules = { limit?: "issue" | "comment"; roles?: boolean; source?: Message };
/** The fields of a timeline event this bridge reads (the API returns a wide union). */
type RawTimelineEvent = {
  event?: string;
  id?: number;
  node_id?: string;
  created_at?: string;
  actor?: { login?: string; id?: number } | null;
  commit_id?: string | null;
  commit_url?: string | null;
  state_reason?: string | null;
  label?: { name?: string };
  rename?: { from?: string; to?: string };
  assignee?: { login?: string } | null;
  milestone?: { title?: string };
  source?: {
    issue?: {
      id?: number;
      number?: number;
      title?: string;
      html_url?: string;
      pull_request?: unknown;
      repository?: { full_name?: string };
    };
  };
};
type DescribedTarget = {
  number?: number;
  url?: string;
  title?: string;
  repository?: { nameWithOwner?: string };
};
type DescribedNode = {
  id: string;
  duplicateOf?: DescribedTarget | null;
  canonical?: DescribedTarget | null;
  duplicate?: DescribedTarget | null;
};
const TARGET = `... on Issue { number url title repository { nameWithOwner } }
  ... on PullRequest { number url title repository { nameWithOwner } }`;
/** Duplicate targets of close and duplicate events, which the REST timeline leaves out. */
const DESCRIBE_EVENTS = `query($ids: [ID!]!) { nodes(ids: $ids) { id
  ... on ClosedEvent { duplicateOf { ${TARGET} } }
  ... on MarkedAsDuplicateEvent { canonical { ${TARGET} } duplicate { ${TARGET} } } } }`;
const HOUR = 3600_000;

export class LivePlatforms implements Platforms {
  readonly github: Octokit;
  private forum!: ForumChannel;
  private hostedAttachments = new Map<string, string>();
  /** Numeric GitHub id of the App bot user; known after initialize() when botLogin is set. */
  botId?: string;
  private recent = new Map<string, number[]>();
  private roleCache = new Map<string, { roles: string[]; until: number }>();
  constructor(
    readonly client: Client,
    readonly options: Options,
    private authorship?: Authorship,
  ) {
    this.github = new Octokit({
      request: { timeout: 30_000 },
    });
    this.github.hook.wrap("request", async (request, requestOptions) => {
      requestOptions.headers.authorization = `Bearer ${await options.readToken()}`;
      try {
        return await request(requestOptions);
      } catch (error) {
        if ((error as { status?: number }).status !== 401) throw error;
        options.invalidateReadToken?.();
        requestOptions.headers.authorization = `Bearer ${await options.readToken()}`;
        return request(requestOptions);
      }
    });
  }
  async initialize() {
    const channel = await this.client.channels.fetch(this.options.forum);
    if (!(channel instanceof ForumChannel))
      throw new Error("DISCORD_CHANNEL_ID must identify a forum channel.");
    this.forum = channel;
    const permissions = channel.permissionsFor(this.client.user!);
    const required = {
      ViewChannel: PermissionFlagsBits.ViewChannel,
      SendMessages: PermissionFlagsBits.SendMessages,
      SendMessagesInThreads: PermissionFlagsBits.SendMessagesInThreads,
      ReadMessageHistory: PermissionFlagsBits.ReadMessageHistory,
      ManageThreads: PermissionFlagsBits.ManageThreads,
    };
    const absent = Object.entries(required)
      .filter(([, bit]) => !permissions?.has(bit))
      .map(([name]) => name);
    if (absent.length)
      throw new Error(`Missing forum permissions: ${absent.join(", ")}`);
    // Fail before accepting work if repository access is misconfigured.
    const repository = await this.github.repos.get(this.repo);
    if (
      this.options.repositoryId &&
      repository.data.id !== this.options.repositoryId
    )
      throw new Error("Repository identity changed. Re-approve this mapping.");
    // Bridge writes are recognised as our own by their author id, so resolve it before accepting work.
    if (this.options.botLogin) {
      try {
        const { data } = await this.github.users.getByUsername({
          username: this.options.botLogin,
        });
        this.botId = String(data.id);
      } catch (error) {
        if (this.bridgeMode) throw error;
      }
    }
    if (this.bridgeMode && (!this.botId || !this.options.writeToken))
      throw new Error(
        "Bridge write mode needs the GitHub App slug and an installation with Issues: read and write.",
      );
  }
  private get config() {
    return this.options.config ?? DEFAULT_CONFIG;
  }
  private get bridgeMode() {
    return this.config.writeMode === "bridge";
  }
  private ownAuthor(id: number | undefined) {
    return this.botId !== undefined && String(id) === this.botId;
  }
  get guildId() {
    return this.forum.guildId;
  }
  private get repo() {
    return { owner: this.options.owner, repo: this.options.repo };
  }
  private issue(data: {
    number: number;
    title: string;
    body?: string | null;
    html_url: string;
    user: { login: string; id?: number } | null;
    state: string;
    state_reason?: string | null;
    labels: (string | { name?: string })[];
    locked: boolean;
    created_at: string;
    closed_at?: string | null;
  }): Issue {
    return {
      number: data.number,
      title: data.title,
      body: data.body ?? "",
      url: data.html_url,
      author: data.user?.login ?? "unknown",
      authorId: data.user?.id === undefined ? undefined : String(data.user.id),
      relay: this.authorship?.verify(
        data.body ?? "",
        String(data.user?.id ?? ""),
        `${this.options.owner}/${this.options.repo}`,
      ),
      own: this.ownAuthor(data.user?.id),
      state: data.state === "closed" ? "closed" : "open",
      stateReason: data.state_reason ?? null,
      labels: data.labels
        .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
        .filter(Boolean),
      locked: data.locked,
      createdAt: data.created_at,
      closedAt: data.closed_at ?? null,
    };
  }
  async getIssue(number: number) {
    const { data } = await this.github.issues.get({
      ...this.repo,
      issue_number: number,
    });
    if (data.pull_request)
      throw Object.assign(
        new Error("Pull requests are outside this bridge's scope."),
        { status: 404 },
      );
    return this.issue(data);
  }
  async issues(since?: string) {
    const data = await this.github.paginate(this.github.issues.listForRepo, {
      ...this.repo,
      state: "all",
      since,
      per_page: 100,
    });
    return data.filter((i) => !i.pull_request).map((i) => this.issue(i));
  }
  private async userWrite<T>(
    discordId: string | undefined,
    pinned: Writer | undefined,
    operation: (api: Octokit, writer: Writer) => Promise<T>,
  ): Promise<T> {
    if (!discordId || (pinned?.discordId && pinned.discordId !== discordId))
      throw new WriteBlocked(
        discordId,
        "original-author",
        "The original Discord author must link their GitHub account before this change can be sent.",
      );
    const access = await this.authorship?.access(
      discordId,
      pinned?.kind === "user" ? pinned.githubId : undefined,
    );
    if (!access)
      throw new WriteBlocked(
        discordId,
        "link",
        "Link and authorize your GitHub account with /github link, then /github confirm. This change has not been sent to GitHub.",
      );
    const writer: Writer = {
      kind: "user",
      discordId,
      githubId: access.githubId,
      login: access.login,
    };
    const api = new Octokit({
      auth: access.token,
      request: { timeout: 30_000 },
    });
    try {
      if (this.options.repositoryId) {
        const repository = await api.repos.get(this.repo);
        if (repository.data.id !== this.options.repositoryId)
          throw new WriteBlocked(
            discordId,
            "permission",
            "The repository identity changed. This write was not sent.",
          );
      }
      return await operation(api, writer);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 401) {
        this.authorship?.invalidate(discordId, access.githubId);
        throw new WriteBlocked(
          discordId,
          "link",
          "Your GitHub authorization expired or was revoked. Run /github link again; this change has not been sent.",
        );
      }
      if (status === 403 || status === 404)
        throw new WriteBlocked(
          discordId,
          "permission",
          "Your GitHub account or GitHub App is not authorized for this repository/action. Check repository access and the app installation. This change has not been sent.",
        );
      throw error;
    }
  }
  /**
   * Route a Discord-originated write. A pinned writer keeps the identity the content was
   * created with; new content follows the mapping's write mode. User mode is upstream's path.
   */
  private write<T>(
    discordId: string | undefined,
    pinned: Writer | undefined,
    operation: (api: Octokit, writer: Writer) => Promise<T>,
    rules: Rules = {},
  ): Promise<T> {
    const bridge =
      pinned?.kind === "bridge" || (pinned?.kind !== "user" && this.bridgeMode);
    return bridge
      ? this.bridgeWrite(discordId, pinned, operation, rules)
      : this.userWrite(discordId, pinned, operation);
  }
  private async bridgeWrite<T>(
    discordId: string | undefined,
    pinned: Writer | undefined,
    operation: (api: Octokit, writer: Writer) => Promise<T>,
    rules: Rules,
  ): Promise<T> {
    if (
      !discordId ||
      !/^\d+$/.test(discordId) ||
      (pinned?.discordId && pinned.discordId !== discordId)
    )
      throw new WriteBlocked(
        discordId,
        "original-author",
        "Only the original Discord author's changes are sent to GitHub.",
      );
    if (!this.botId || !this.options.writeToken)
      throw new WriteBlocked(
        discordId,
        "permission",
        "Bridge write mode is not ready: the GitHub App bot identity or write access is missing. This change has not been sent.",
      );
    const allow = this.config.allowRoles;
    // Allowed webhooks and bots have no roles, and one webhook carries many reporters.
    const automated = Boolean(rules.source?.automated);
    if (rules.roles && allow.length && !automated) {
      const roles = await this.memberRoles(discordId);
      if (!roles.some((id) => allow.includes(id)))
        throw new WriteBlocked(
          discordId,
          "role",
          "Your Discord roles do not allow posting to GitHub. This change stays in Discord.",
        );
    }
    const max =
      rules.limit === "issue"
        ? this.config.rateLimit.issuesPerHour
        : this.config.rateLimit.commentsPerHour;
    const started = this.options.started?.();
    const backfill = Boolean(
      started && rules.source?.createdAt && rules.source.createdAt < started,
    );
    const key =
      rules.limit && max > 0 && !backfill && !automated
        ? `${rules.limit}:${discordId}`
        : undefined;
    const recent = key
      ? (this.recent.get(key) ?? []).filter((t) => t > Date.now() - HOUR)
      : [];
    if (key) {
      this.recent.set(key, recent);
      if (recent.length >= max)
        throw new WriteBlocked(
          discordId,
          "rate",
          "You are posting faster than the bridge allows. Your message will be sent to GitHub later.",
        );
    }
    const writer: Writer = { kind: "bridge", discordId, githubId: this.botId };
    const api = new Octokit({
      auth: await this.options.writeToken(),
      request: { timeout: 30_000 },
    });
    try {
      const result = await operation(api, writer);
      if (key) recent.push(Date.now());
      return result;
    } catch (error) {
      throw this.writeFailure(error, discordId);
    }
  }
  /** Map an App write failure: rate limits and auth errors go back to the queue; access problems are held. */
  private writeFailure(error: unknown, discordId: string | undefined) {
    if (error instanceof WriteBlocked) return error;
    const failure = error as {
      status?: number;
      response?: { headers?: Record<string, string> };
    };
    const headers = failure.response?.headers;
    // Rate limits are retried by the queue with GitHub's delay; they are not permission problems.
    if (headers?.["retry-after"] || headers?.["x-ratelimit-remaining"] === "0")
      return error;
    if (failure.status === 401) {
      this.options.invalidateWriteToken?.();
      return error;
    }
    if (failure.status === 403 || failure.status === 404)
      return new WriteBlocked(
        discordId,
        "permission",
        "The GitHub App cannot write issues in this repository. Check that it has Issues: read and write and is installed on the repository. This change has not been sent.",
      );
    return error;
  }
  /** Title/label changes made on Discord. Bridge mode only; there is no Discord actor to attribute. */
  async updateIssue(number: number, change: IssueChange) {
    if (!this.bridgeMode || !this.options.writeToken)
      throw new WriteBlocked(
        undefined,
        "permission",
        "Discord title and tag changes reach GitHub only in bridge write mode.",
      );
    const api = new Octokit({
      auth: await this.options.writeToken(),
      request: { timeout: 30_000 },
    });
    try {
      if (change.title !== undefined || change.state)
        await api.issues.update({
          ...this.repo,
          issue_number: number,
          title: change.title,
          state: change.state,
          // GitHub accepts "duplicate"; the bundled Octokit types predate it.
          state_reason: (change.state === "closed"
            ? change.reason
            : change.state === "open"
              ? "reopened"
              : undefined) as "completed" | "not_planned" | "reopened",
        });
      if (change.addLabels?.length)
        await api.issues.addLabels({
          ...this.repo,
          issue_number: number,
          labels: change.addLabels,
        });
      for (const name of change.removeLabels ?? [])
        try {
          await api.issues.removeLabel({
            ...this.repo,
            issue_number: number,
            name,
          });
        } catch (error) {
          // Already removed on GitHub: the goal is met.
          if ((error as { status?: number }).status !== 404) throw error;
        }
    } catch (error) {
      throw this.writeFailure(error, undefined);
    }
  }
  private labelCache?: { names: string[]; until: number };
  private async repoLabels(): Promise<string[]> {
    if (this.labelCache && this.labelCache.until > Date.now())
      return this.labelCache.names;
    const names = (
      await this.github.paginate(this.github.issues.listLabelsForRepo, {
        ...this.repo,
        per_page: 100,
      })
    ).map((label) => label.name);
    this.labelCache = { names, until: Date.now() + 5 * 60_000 };
    return names;
  }
  async managedTags(): Promise<ManagedTag[]> {
    const close = new Set(
      [
        ...this.config.closeTags.map((t) => t.tag),
        ...Object.keys(this.config.status?.tags ?? {}),
      ].map((t) => t.toLowerCase()),
    );
    return managedTags(
      (this.forum?.availableTags ?? [])
        .filter((t) => !close.has(t.name.toLowerCase()))
        .map((t) => ({ id: t.id, name: t.name })),
      await this.repoLabels(),
      this.config.labels,
    );
  }
  async closeTags(): Promise<CloseTag[]> {
    const available = this.forum?.availableTags ?? [];
    const result: CloseTag[] = [];
    for (const { tag, reason } of this.config.closeTags) {
      const found = available.find(
        (t) => t.name.toLowerCase() === tag.toLowerCase(),
      );
      if (found) result.push({ id: found.id, name: found.name, reason });
    }
    return result;
  }
  async statusTags(): Promise<StatusTag[]> {
    const available = this.forum?.availableTags ?? [];
    const result: StatusTag[] = [];
    for (const [tag, option] of Object.entries(
      this.config.status?.tags ?? {},
    )) {
      const found = available.find(
        (t) => t.name.toLowerCase() === tag.toLowerCase(),
      );
      if (found) result.push({ id: found.id, name: found.name, option });
    }
    return result;
  }
  private get projects() {
    return this.config.status ? this.options.projects : undefined;
  }
  async projectStatus(number: number, fresh = false) {
    return this.projects?.item(number, fresh);
  }
  async projectItems() {
    return this.projects?.scan();
  }
  async setProjectStatus(number: number, status: string | null) {
    if (!this.projects)
      throw new WriteBlocked(
        undefined,
        "permission",
        "Projects status sync needs a Projects token (Admin -> Connections).",
      );
    await this.projects.setStatus(number, status);
  }
  defaultStatus() {
    return this.config.status?.defaultOption;
  }
  private async memberRoles(discordId: string): Promise<string[]> {
    const cached = this.roleCache.get(discordId);
    if (cached && cached.until > Date.now()) return cached.roles;
    let roles: string[] = [];
    if (this.options.memberRoles)
      roles = await this.options.memberRoles(discordId);
    else
      try {
        const member = await this.forum.guild.members.fetch({
          user: discordId,
        });
        roles = [...member.roles.cache.keys()];
      } catch (error) {
        // A member who left the server has no roles; other failures are retried.
        if ((error as { code?: number }).code !== 10007) throw error;
      }
    this.roleCache.set(discordId, { roles, until: Date.now() + 10 * 60_000 });
    return roles;
  }
  /** Adopt the actual author id if a bridge create was not authored by the resolved bot id. */
  private adopt(writer: Writer, authorId: number | undefined): Writer {
    if (writer.kind !== "bridge" || authorId === undefined) return writer;
    if (String(authorId) !== writer.githubId) {
      console.error(
        "Bridge write author did not match the resolved GitHub App bot id; using the actual author id.",
      );
      this.botId = String(authorId);
    }
    return { ...writer, githubId: String(authorId) };
  }
  private signed(
    body: string,
    kind: "thread" | "message",
    sourceId: string | undefined,
    writer: Writer | undefined,
  ) {
    if (!sourceId || !writer) return body;
    const marker = this.authorship?.sign(
      { kind, sourceId, writer },
      `${this.options.owner}/${this.options.repo}`,
    );
    return marker ? `${body}\n\n${marker}` : body;
  }
  async createIssue(post: Post, marker: string) {
    return this.write(
      post.starter.authorId,
      undefined,
      async (api, writer) => {
        // Same tag -> label pairing as the ongoing reconcile.
        const managed = post.tags.length ? await this.managedTags() : [];
        const labels = managed
          .filter((m) => post.tags.includes(m.name))
          .map((m) => m.label);
        const { data } = await api.issues.create({
          ...this.repo,
          title: post.title,
          labels,
          body: this.signed(
            `${sourceBody(post.starter)}\n\n${marker}`,
            "thread",
            post.id,
            writer,
          ),
        });
        return {
          ...this.issue(data),
          writer: this.adopt(writer, data.user?.id),
        };
      },
      { limit: "issue", roles: true, source: post.starter },
    );
  }
  async editIssue(
    number: number,
    body: string,
    writer?: Writer,
    source?: Message,
  ) {
    await this.write(
      source?.authorId ?? writer?.discordId,
      writer,
      async (api, actual) => {
        await api.issues.update({
          ...this.repo,
          issue_number: number,
          body: this.signed(
            body,
            "thread",
            body.match(/<!-- gd-sync:thread:(\d+) -->/)?.[1],
            actual.kind === "bridge" ? actual : writer,
          ),
        });
      },
      { roles: true, source },
    );
  }
  async state(number: number, state: "open" | "closed", actor?: string) {
    // /issue close|reopen already checked Manage Threads or a manager role: no allow-list or rate limit.
    await this.write(actor, undefined, async (api) => {
      await api.issues.update({ ...this.repo, issue_number: number, state });
    });
  }
  async timeline(number: number, etag?: string) {
    const request = { ...this.repo, issue_number: number, per_page: 100 };
    let first;
    try {
      first = await this.github.issues.listEventsForTimeline({
        ...request,
        headers: etag ? { "if-none-match": etag } : {},
      });
    } catch (error) {
      // 304: nothing new, and GitHub does not count it against the rate limit.
      if ((error as { status?: number }).status === 304) return undefined;
      throw error;
    }
    // The first page's ETag says nothing about later pages: use it only for one-page timelines.
    const single = !/rel="next"/.test(first.headers.link ?? "");
    const data = single
      ? first.data
      : await this.github.paginate(
          this.github.issues.listEventsForTimeline,
          request,
        );
    const events: TimelineEvent[] = [];
    const issueUrl = `https://github.com/${this.options.owner}/${this.options.repo}/issues/${number}`;
    for (const raw of data as RawTimelineEvent[]) {
      const actor = raw.actor?.login;
      if (raw.event === "cross-referenced") {
        // Kept even when the bridge made it: a Discord reply that mentions #20 shows up in #20.
        const source = raw.source?.issue;
        if (!source?.id || !source.html_url) continue;
        const repo = source.repository?.full_name;
        events.push({
          key: `xref:${source.id}`,
          kind: "crossref",
          actor,
          createdAt: raw.created_at ?? "",
          url: source.html_url,
          label: this.refLabel(repo, source.number),
          title: source.title,
          pullRequest: Boolean(source.pull_request),
        });
        continue;
      }
      if (raw.id === undefined) continue;
      if (
        (raw.event === "referenced" || raw.event === "closed") &&
        raw.commit_id
      ) {
        const repo = raw.commit_url?.match(
          /\/repos\/([^/]+\/[^/]+)\/commits\//,
        )?.[1];
        const sha = raw.commit_id.slice(0, 7);
        const here =
          !repo ||
          repo.toLowerCase() ===
            `${this.options.owner}/${this.options.repo}`.toLowerCase();
        events.push({
          key: String(raw.id),
          kind: raw.event === "closed" ? "closed" : "commit",
          actor,
          createdAt: raw.created_at ?? "",
          url: `https://github.com/${repo ?? `${this.options.owner}/${this.options.repo}`}/commit/${raw.commit_id}`,
          label: here ? sha : `${repo}@${sha}`,
          reason: raw.state_reason ?? undefined,
        });
        continue;
      }
      // Changes the bridge made itself came from Discord, where they already show.
      if (this.ownAuthor(raw.actor?.id)) continue;
      const base = {
        key: String(raw.id),
        actor,
        createdAt: raw.created_at ?? "",
        url: `${issueUrl}#event-${raw.id}`,
      };
      switch (raw.event) {
        case "closed":
          events.push({
            ...base,
            kind: "closed",
            reason: raw.state_reason ?? undefined,
            node: raw.state_reason === "duplicate" ? raw.node_id : undefined,
          });
          break;
        case "reopened":
        case "locked":
        case "unlocked":
          events.push({ ...base, kind: raw.event });
          break;
        case "renamed":
          if (raw.rename)
            events.push({
              ...base,
              kind: "renamed",
              from: raw.rename.from,
              to: raw.rename.to,
            });
          break;
        case "labeled":
        case "unlabeled":
          if (raw.label?.name)
            events.push({ ...base, kind: raw.event, name: raw.label.name });
          break;
        case "assigned":
        case "unassigned":
          if (raw.assignee?.login)
            events.push({ ...base, kind: raw.event, name: raw.assignee.login });
          break;
        case "milestoned":
        case "demilestoned":
          if (raw.milestone?.title)
            events.push({
              ...base,
              kind: raw.event,
              name: raw.milestone.title,
            });
          break;
        case "marked_as_duplicate":
          if (raw.node_id)
            events.push({ ...base, kind: "duplicate", node: raw.node_id });
          break;
        case "project_v2_item_status_changed":
          if (raw.node_id)
            events.push({ ...base, kind: "status", node: raw.node_id });
          break;
      }
    }
    return { events, etag: single ? first.headers.etag : undefined };
  }
  /**
   * Names the settings editor offers as choices. Each part is best effort: one that cannot be
   * read (no Manage Webhooks, no Projects token) is left empty and the editor takes free text.
   */
  async settingsChoices() {
    const guild = this.forum.guild;
    const settle = async <T>(read: () => Promise<T[]> | T[]) => {
      try {
        return await read();
      } catch {
        return [] as T[];
      }
    };
    const [labels, webhooks, statusOptions] = await Promise.all([
      settle(async () =>
        (
          await this.github.paginate(this.github.issues.listLabelsForRepo, {
            ...this.repo,
            per_page: 100,
          })
        ).map((l) => l.name),
      ),
      settle(async () =>
        (await this.forum.fetchWebhooks())
          .filter((w) => w.isIncoming())
          .map((w) => ({ id: w.id, name: w.name })),
      ),
      settle(() => this.options.projects?.optionNames() ?? []),
    ]);
    return {
      tags: this.forum.availableTags.map((t) => ({
        name: t.name,
        moderated: t.moderated,
      })),
      roles: [...guild.roles.cache.values()]
        .filter((r) => r.id !== guild.id && !r.managed)
        .sort((a, b) => b.position - a.position)
        .map((r) => ({ id: r.id, name: r.name })),
      labels,
      webhooks,
      // Bots seen by this process; others can still be added by ID.
      bots: [...guild.members.cache.values()]
        .filter((m) => m.user.bot && m.id !== this.client.user?.id)
        .map((m) => ({ id: m.id, name: m.user.username })),
      statusOptions,
    };
  }
  /** `#12` in this repository, `owner/repo#12` elsewhere. */
  private refLabel(repo: string | undefined, number: number | undefined) {
    const here =
      !repo ||
      repo.toLowerCase() ===
        `${this.options.owner}/${this.options.repo}`.toLowerCase();
    return `${here ? "" : repo}#${number}`;
  }
  async describeEvents(number: number, events: TimelineEvent[]) {
    let pending = false;
    const details = new Map<string, DescribedNode>();
    const ids = events
      .filter((e) => e.node && e.kind !== "status")
      .map((e) => e.node!);
    if (ids.length) {
      let nodes: (DescribedNode | null)[] | undefined;
      try {
        nodes = (
          await this.github.graphql<{ nodes: (DescribedNode | null)[] }>(
            DESCRIBE_EVENTS,
            { ids },
          )
        ).nodes;
      } catch (error) {
        // A partial answer (one node hidden) still carries the rest.
        const failure = error as {
          status?: number;
          data?: { nodes?: (DescribedNode | null)[] };
        };
        nodes = failure.data?.nodes;
        const status = failure.status;
        if (
          !nodes &&
          (!status || status >= 500 || status === 403 || status === 429)
        )
          pending = true;
      }
      for (const node of nodes ?? []) if (node?.id) details.set(node.id, node);
    }
    // Status moves need the Projects token (user-owned boards are invisible to the App).
    let moves: Awaited<ReturnType<ProjectsClient["statusChanges"]>> | undefined;
    const projects = this.options.projects;
    if (projects && events.some((e) => e.kind === "status")) {
      try {
        moves = await projects.statusChanges(number);
      } catch (error) {
        // Access or configuration problems are reported by the Status sync; only retry outages.
        if (!(error instanceof WriteBlocked)) pending = true;
      }
    }
    const ref = (target?: DescribedTarget | null) =>
      target?.number && target.url
        ? {
            label: this.refLabel(
              target.repository?.nameWithOwner,
              target.number,
            ),
            url: target.url,
            title: target.title,
          }
        : undefined;
    const shown: TimelineEvent[] = [];
    for (const event of events) {
      if (!event.node) {
        shown.push(event);
        continue;
      }
      if (event.kind === "status") {
        const move = moves?.changes.get(event.node);
        // Moves made with the Projects token came from Discord, and a first placement on the
        // board is not news.
        if (!move?.from || event.actor === moves!.login) continue;
        shown.push({ ...event, node: undefined, ...move });
        continue;
      }
      const node = details.get(event.node);
      if (!node && pending) continue;
      if (event.kind === "closed")
        shown.push({
          ...event,
          node: undefined,
          duplicateOf: ref(node?.duplicateOf),
        });
      else {
        const canonical = ref(node?.canonical);
        shown.push({
          ...event,
          node: undefined,
          ...(canonical?.label === `#${number}`
            ? { duplicate: ref(node?.duplicate) }
            : { duplicateOf: canonical }),
        });
      }
    }
    return { events: shown, pending };
  }
  async comments(number: number): Promise<Comment[]> {
    const data = await this.github.paginate(this.github.issues.listComments, {
      ...this.repo,
      issue_number: number,
      per_page: 100,
    });
    return data.map((c) => ({
      id: String(c.id),
      body: c.body ?? "",
      author: c.user?.login ?? "unknown",
      url: c.html_url,
      own: this.ownAuthor(c.user?.id),
      authorId: c.user?.id === undefined ? undefined : String(c.user.id),
      relay: this.authorship?.verify(
        c.body ?? "",
        String(c.user?.id ?? ""),
        `${this.options.owner}/${this.options.repo}`,
      ),
    }));
  }
  async createComment(number: number, body: string, source?: Message) {
    return this.write(
      source?.authorId,
      undefined,
      async (api, writer) => {
        const response = await api.issues.createComment({
          ...this.repo,
          issue_number: number,
          body: this.signed(body, "message", source?.id, writer),
        });
        return {
          id: String(response.data.id),
          writer: this.adopt(writer, response.data.user?.id),
        };
      },
      { limit: "comment", roles: true, source },
    );
  }
  async editComment(
    id: string,
    body: string,
    writer?: Writer,
    source?: Message,
  ) {
    await this.write(
      source?.authorId ?? writer?.discordId,
      writer,
      async (api, actual) => {
        await api.issues.updateComment({
          ...this.repo,
          comment_id: Number(id),
          body: this.signed(
            body,
            "message",
            body.match(/<!-- gd-sync:message:(\d+) -->/)?.[1],
            actual.kind === "bridge" ? actual : writer,
          ),
        });
      },
      // Deletion tombstones have no source message and are always allowed.
      { roles: Boolean(source), source },
    );
  }
  async notifyBlocked(source: Message, message: string) {
    if (!source.authorId || !/^\d+$/.test(source.authorId)) return;
    const channel = await this.channel(source.thread);
    if (channel.archived) return;
    await channel.send({
      content: `<@${source.authorId}> ${message}`,
      allowedMentions: { parse: [], users: [source.authorId] },
    });
  }
  private async channel(id: string, force = false): Promise<ThreadChannel> {
    const channel = await this.client.channels.fetch(
      id,
      force ? { force: true } : undefined,
    );
    if (!channel?.isThread() || channel.parentId !== this.options.forum) {
      throw Object.assign(
        new Error("Thread is missing or outside the configured forum."),
        { status: 404 },
      );
    }
    return channel;
  }
  private async message(message: DiscordMessage): Promise<Message> {
    // Webhook and bot reports often carry most of their text in embeds.
    let body = [message.content, embedMarkdown(message.embeds ?? [])]
      .filter(Boolean)
      .join("\n\n");
    for (const file of message.attachments.values()) {
      let url = file.url;
      if (process.env.R2_BUCKET && this.hostedAttachments.has(file.id)) {
        url = this.hostedAttachments.get(file.id)!;
      } else if (process.env.R2_BUCKET) {
        // Only fetch attachment URLs furnished by Discord, with a bounded size and timeout.
        if (file.size > 20 * 1024 * 1024)
          throw new Error(
            `Attachment ${file.id} exceeds the 20 MiB rehosting limit.`,
          );
        const hostname = new URL(file.url).hostname;
        if (
          hostname !== "cdn.discordapp.com" &&
          hostname !== "media.discordapp.net"
        )
          throw new Error("Unexpected attachment host");
        const response = await fetch(file.url, {
          signal: AbortSignal.timeout(30_000),
          redirect: "error",
        });
        if (!response.ok)
          throw new Error(`Attachment download failed: ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > 20 * 1024 * 1024)
          throw new Error("Attachment exceeds download limit");
        url =
          (await uploadToR2(
            `discord/${message.id}/${file.id}/${file.name}`,
            buffer,
            file.contentType ?? "application/octet-stream",
          )) ?? url;
        this.hostedAttachments.set(file.id, url);
        if (this.hostedAttachments.size > 10_000)
          this.hostedAttachments.delete(
            this.hostedAttachments.keys().next().value!,
          );
      }
      const name = file.name.replace(/[\[\]\r\n]/g, "_");
      body += `\n${file.contentType?.startsWith("image/") ? "!" : ""}[${name}](${url})`;
    }
    return {
      id: message.id,
      thread: message.channelId,
      body,
      url: message.url,
      author: message.author.globalName ?? message.author.username,
      authorId: message.author.id,
      createdAt: message.createdAt?.toISOString(),
      ...this.classify(message.author, message.webhookId),
    };
  }
  /**
   * Whether a message is synced. Members always are; bots and webhooks only when the mapping
   * allows them; the bridge's own messages never are (that is the echo guard).
   */
  classify(
    author: { id: string; bot?: boolean },
    webhookId?: string | null,
  ): { bot: boolean; own: boolean; automated?: true } {
    const own = author.id === this.client.user?.id;
    // An incoming webhook posts as itself; an interaction reply has the bot as author.
    const webhook = Boolean(webhookId) && author.id === webhookId;
    if (!own && !author.bot && !webhookId) return { bot: false, own };
    const { allowWebhooks, allowBots } = this.config;
    const allowed =
      !own &&
      this.bridgeMode &&
      (webhook
        ? allowWebhooks === true ||
          (Array.isArray(allowWebhooks) && allowWebhooks.includes(author.id))
        : allowBots.includes(author.id));
    return allowed ? { bot: false, own, automated: true } : { bot: true, own };
  }
  private async post(channel: ThreadChannel): Promise<Post> {
    const starter = await channel.fetchStarterMessage({ force: true });
    if (!starter)
      throw Object.assign(
        new Error(`Missing starter message in ${channel.id}`),
        { status: 404 },
      );
    return {
      id: channel.id,
      title: channel.name,
      starter: await this.message(starter),
      tags: channel.appliedTags
        .map(
          (id) =>
            this.forum.availableTags.find((tag) => tag.id === id)?.name ?? "",
        )
        .filter(Boolean),
      createdAt: channel.createdAt!.toISOString(),
      archived: channel.archived ?? false,
    };
  }
  async getPost(thread: string) {
    return this.post(await this.channel(thread));
  }
  async posts() {
    // Enumerate archived pages too; an idle thread is still an active GitHub issue.
    const channels = new Map((await this.forum.threads.fetchActive()).threads);
    let before: Date | undefined;
    for (;;) {
      const page = await this.forum.threads.fetchArchived({
        type: "public",
        limit: 100,
        before,
      });
      for (const [id, channel] of page.threads) channels.set(id, channel);
      if (!page.hasMore || !page.threads.size) break;
      before = page.threads.last()!.archiveTimestamp
        ? new Date(page.threads.last()!.archiveTimestamp!)
        : undefined;
      if (!before) break;
    }
    const posts: Post[] = [];
    for (const channel of channels.values()) {
      try {
        posts.push(await this.post(channel));
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    return posts;
  }
  async createPost(issue: Issue) {
    const tags = (await this.managedTags())
      .filter((m) => issue.labels.includes(m.label))
      .slice(0, MAX_TAGS)
      .map((m) => m.id);
    const post = await this.forum.threads.create({
      name: threadName(issue.number, issue.title),
      appliedTags: tags,
      message: {
        content: chunks(issueSummary(issue), issue.url)[0],
        allowedMentions: { parse: [] },
      },
    });
    return this.post(post);
  }
  async threadMeta(thread: string): Promise<ThreadMeta> {
    const channel = await this.channel(thread);
    return {
      name: channel.name,
      tags: [...channel.appliedTags],
      archived: channel.archived ?? false,
      locked: channel.locked ?? false,
    };
  }
  /** Discord allows two thread renames per ten minutes; a third would stall the whole queue. */
  private renames = new Map<string, number[]>();
  async applyMeta(thread: string, change: MetaChange) {
    // Re-read right before writing and apply a delta, so a concurrent Discord edit survives.
    const channel = await this.channel(thread, true);
    const edit: { name?: string; appliedTags?: string[]; locked?: boolean } =
      {};
    let renameDeferred = false;
    if (change.name !== undefined && change.name !== channel.name) {
      const recent = (this.renames.get(thread) ?? []).filter(
        (t) => t > Date.now() - 10 * 60_000,
      );
      this.renames.set(thread, recent);
      if (recent.length < 2) edit.name = change.name;
      else renameDeferred = true;
    }
    const current = [...channel.appliedTags];
    const next = current.filter((t) => !change.removeTags?.includes(t));
    const overflow: string[] = [];
    for (const tag of change.addTags ?? []) {
      if (next.includes(tag)) continue;
      if (next.length < MAX_TAGS) next.push(tag);
      else overflow.push(tag);
    }
    if (
      next.length !== current.length ||
      next.some((t) => !current.includes(t))
    )
      edit.appliedTags = next;
    if (change.locked !== undefined && change.locked !== channel.locked)
      edit.locked = change.locked;
    if (Object.keys(edit).length) {
      // Archived threads must be reopened to edit; restore the archive afterwards.
      const archived = channel.archived;
      if (archived) await channel.setArchived(false);
      await channel.edit(edit);
      if (edit.name) this.renames.get(thread)!.push(Date.now());
      if (archived) await channel.setArchived(true);
    }
    return { overflow, renameDeferred };
  }
  async applyArchive(thread: string, closed: boolean, reopened: boolean) {
    const channel = await this.channel(thread);
    if (closed && !channel.archived) await channel.setArchived(true);
    // Open issues may be archived from inactivity; only an actual reopen unarchives.
    if (!closed && reopened && channel.archived)
      await channel.setArchived(false);
  }
  async messages(thread: string): Promise<Message[]> {
    const channel = await this.channel(thread);
    const result: Message[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await channel.messages.fetch({
        limit: 100,
        before,
        cache: false,
      });
      for (const message of page.values()) {
        if (message.type === 0 || message.type === 19)
          result.push(await this.message(message));
      }
      if (page.size < 100) break;
      before = page.last()!.id;
    }
    return result.reverse();
  }
  async send(thread: string, body: string, nonce: string) {
    const channel = await this.channel(thread);
    if (channel.archived) await channel.setArchived(false);
    return (
      await channel.send({
        content: body,
        allowedMentions: { parse: [] },
        nonce,
        enforceNonce: true,
      })
    ).id;
  }
  async edit(thread: string, id: string, body: string) {
    const channel = await this.channel(thread);
    if (channel.archived) await channel.setArchived(false);
    await channel.messages.edit(id, {
      content: body,
      allowedMentions: { parse: [] },
    });
  }
}
