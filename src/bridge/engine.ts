import { WriteBlocked } from "./authorship";
import { Store } from "./database";
import {
  chunks,
  hash,
  issueMarker,
  issueSummary,
  messageMarker,
  missing,
  sourceBody,
  timelineBody,
} from "./content";
import { Issue, Link, Message, Platforms, Task } from "./types";
import { MetadataInput, githubStatusTag, planMetadata } from "./reconcile";
import { ProjectItem } from "./projects";

export interface EngineOptions {
  /** Bridge mode: Discord title and tag changes are written to GitHub. Otherwise GitHub wins. */
  discordWrites?: boolean;
  /** Show references (commits, issues, pull requests) in threads; off when absent. */
  timeline?: { maxAgeDaysClosed: number };
}

/** One instance and one consumer per database. All remote mutations pass through this engine. */
export class Engine {
  constructor(
    readonly store: Store,
    readonly api: Platforms,
    readonly backfill: boolean,
    readonly options: EngineOptions = {},
  ) {}

  async run(task: Task): Promise<void> {
    switch (task.type) {
      case "scan":
        return this.scan();
      case "project":
        return this.project();
      case "github":
        return this.github(task.issue);
      case "discord":
        return this.discord(task.thread);
      case "state": {
        const link = this.store.link(task.issue);
        if (!link || link.disabled) return;
        const key = `state:${task.issue}`;
        try {
          if (task.actor)
            await this.api.state(task.issue, task.state, task.actor);
          else await this.api.state(task.issue, task.state);
          this.settleState(task.issue);
          return this.github(task.issue);
        } catch (error) {
          // A refused command is kept and retried by every scan; a failed job would be lost.
          if (await this.hold(error, key, undefined, link.thread)) {
            this.store.setMeta(`held:${key}`, JSON.stringify(task));
            return;
          }
          throw error;
        }
      }
      case "unlink": {
        this.store.clearBlocked(task.thread);
        const link = this.store.thread(task.thread);
        if (link) this.store.saveLink({ ...link, disabled: true });
      }
    }
  }

  async scan() {
    const started = this.store.meta("started")!;
    // Capture the start of the scan and overlap cursors so updates during pagination are replayed.
    const checkpoint = new Date(Date.now() - 60_000).toISOString();
    // Backfill reads every issue once, even when it was switched on after earlier scans.
    const full = this.backfill && !this.store.meta("backfilled");
    const since = full
      ? undefined
      : (this.store.meta("githubScan") ??
        (this.backfill ? undefined : started));
    // Retry held /issue close|reopen commands; the meta key dedupes them across scans.
    for (const [key, task] of this.store.metaEntries("held:state:"))
      this.store.enqueue(JSON.parse(task) as Task, key);
    const issues = await this.api.issues(since);
    for (const issue of issues) {
      if (
        this.store.link(issue.number) ||
        (issue.state === "open" &&
          (this.backfill || issue.createdAt >= started))
      ) {
        this.store.enqueue({ type: "github", issue: issue.number });
      }
    }
    for (const post of await this.api.posts()) {
      if (
        this.store.thread(post.id) ||
        post.createdAt >= started ||
        (this.backfill && !post.archived)
      ) {
        this.store.enqueue({ type: "discord", thread: post.id });
      }
    }
    // Fetch every linked issue as well: comments, edits, removals, and state converge after outages.
    for (const link of this.store.links())
      if (!link.disabled) {
        this.store.enqueue({ type: "github", issue: link.issue });
        this.store.enqueue({ type: "discord", thread: link.thread });
      }
    this.store.setMeta("githubScan", checkpoint);
    if (full) this.store.setMeta("backfilled", checkpoint);
    this.store.prune();
  }

  /**
   * What a backfill would import, without writing anything: open issues without a post and
   * active (unarchived) human posts without an issue, both from before the mapping started.
   */
  async backfillPreview() {
    const started = this.store.meta("started")!;
    const [issues, posts] = await Promise.all([
      this.api.issues(),
      this.api.posts(),
    ]);
    return {
      issues: issues
        .filter(
          (i) =>
            i.state === "open" &&
            i.createdAt < started &&
            !this.store.link(i.number),
        )
        .map((i) => ({ number: i.number, title: i.title, url: i.url })),
      posts: posts
        .filter(
          (p) =>
            !p.archived &&
            !p.starter.bot &&
            p.createdAt < started &&
            !this.store.thread(p.id),
        )
        .map((p) => ({ id: p.id, title: p.title, url: p.starter.url })),
    };
  }

  async github(number: number) {
    let link = this.store.link(number);
    if (link?.disabled) return;
    let issue: Issue;
    try {
      issue = await this.api.getIssue(number);
    } catch (error) {
      if (missing(error)) {
        if (link) this.store.saveLink({ ...link, disabled: true });
        return;
      }
      throw error;
    }
    if (!link) {
      if (issue.state === "closed") return;
      if (!this.backfill && issue.createdAt < this.store.meta("started")!)
        return;
      // Recover a successful Discord→GitHub create whose response/database write was interrupted.
      const sourceId =
        issue.relay?.kind === "thread" ? issue.relay.sourceId : undefined;
      const source = sourceId
        ? ["", sourceId]
        : issue.own && issue.body.match(/<!-- gd-sync:thread:(\d+) -->/);
      if (source) {
        const post = await this.api.getPost(source[1]);
        link = {
          issue: number,
          thread: post.id,
          starter: post.starter.id,
          origin: "discord",
          writer: issue.relay?.writer,
        };
      } else {
        // Recover a successful forum create before retrying it. Include archived threads.
        const existing = (await this.api.posts()).find(
          (p) => p.starter.own && p.starter.body.includes(issue.url),
        );
        const post = existing ?? (await this.api.createPost(issue));
        link = {
          issue: number,
          thread: post.id,
          starter: post.starter.id,
          origin: "github",
        };
      }
      this.store.saveLink(link);
    }
    try {
      const { reopened } = await this.metadata(link, issue);
      const history = await this.api.messages(link.thread);
      // A bot-owned summary works for human-created starters too: never edit another user's message.
      await this.render(
        link,
        "summary",
        issueSummary(issue),
        issue.url,
        issue.number.toString(),
        history,
      );
      const comments = await this.api.comments(number);
      for (const comment of comments) {
        // Identity plus persisted mappings prevent echoes. A pasted Discord URL is not an echo.
        if (
          comment.relay ||
          (comment.own && /<!-- gd-sync:message:\d+ -->/.test(comment.body))
        )
          continue;
        if (
          this.store
            .mirrors(number)
            .some((m) => m.origin === "discord" && m.ids.includes(comment.id))
        )
          continue;
        await this.render(
          link,
          `github:${comment.id}`,
          `**${comment.author}** on GitHub\n\n${comment.body}`,
          comment.url,
          comment.id,
          history,
        );
      }
      await this.timeline(link, issue, history);
      const ids = new Set(comments.map((c) => c.id));
      for (const mirror of this.store.mirrors(number)) {
        if (
          mirror.origin === "github" &&
          mirror.key !== `summary:${number}` &&
          // References are never deleted on GitHub; their mirrors are not comments.
          !mirror.key.startsWith("timeline:") &&
          !ids.has(mirror.source)
        ) {
          await this.render(
            link,
            mirror.key,
            "_(This comment was deleted on GitHub.)_",
            `${issue.url}#issuecomment-${mirror.source}`,
            mirror.source,
            history,
          );
        }
      }
      // Posting a comment can unarchive a closed thread, so apply state last.
      await this.api.applyArchive(
        link.thread,
        issue.state === "closed",
        reopened,
      );
    } catch (error) {
      if (missing(error)) {
        // Only an actually missing thread disables the mapping; missing mirror messages are repaired in render().
        try {
          await this.api.getPost(link.thread);
        } catch (check) {
          if (missing(check)) {
            this.store.saveLink({ ...link, disabled: true });
            return;
          }
        }
      }
      throw error;
    }
  }

  /**
   * Read the Projects board and queue the linked issues whose Status moved. User-owned
   * projects have no webhook, so this poll is how board moves reach Discord. Never fails
   * the job: a failed job would block later polls.
   */
  async project() {
    this.store.setMeta("projectPoll", String(Date.now()));
    let items: Map<number, ProjectItem> | undefined;
    try {
      items = await this.api.projectItems();
    } catch (error) {
      this.projectProblem(error);
      return;
    }
    if (!items) return;
    this.store.deleteMeta("projectError");
    const statusTags = await this.api.statusTags();
    for (const link of this.store.links()) {
      const agreed = link.snap?.status;
      if (link.disabled || agreed === undefined) continue;
      const status = items.get(link.issue)?.status ?? null;
      if (githubStatusTag(status, statusTags, [agreed]) !== agreed)
        this.store.enqueue({ type: "github", issue: link.issue });
    }
  }

  /** Projects reads are optional: record the problem once and carry on without Status. */
  private projectProblem(error: unknown) {
    const message = (error as Error)?.message ?? String(error);
    if (this.store.meta("projectError") !== message) {
      this.store.setMeta("projectError", message);
      console.error(`Projects status sync: ${message}`);
    }
  }

  /** A state change reached GitHub: an older held command must not undo it later. */
  private settleState(issue: number) {
    this.store.unblock(`state:${issue}`);
    this.store.deleteMeta(`held:state:${issue}`);
  }

  /**
   * Three-way reconcile of title, managed labels and close tags (see reconcile.ts). Both
   * sides are read now, so a stale queued task cannot undo a newer edit. GitHub writes that
   * are refused are held under `meta:N`; they never fail the job (a failed job would block
   * later scans).
   */
  private async metadata(link: Link, issue: Issue) {
    const previous = link.snap;
    const [meta, managed, closeTags, statusTags] = await Promise.all([
      this.api.threadMeta(link.thread),
      this.api.managedTags(),
      this.api.closeTags(),
      this.api.statusTags(),
    ]);
    let project: ProjectItem | null | undefined;
    if (statusTags.length) {
      try {
        project = await this.api.projectStatus(issue.number);
        // Open issues join the board once: with the status tag already on the post (bridge
        // mode), else the default status.
        const tagged = this.options.discordWrites
          ? statusTags.find((t) => meta.tags.includes(t.id))?.option
          : undefined;
        const initial = tagged ?? this.api.defaultStatus();
        if (
          project === null &&
          previous?.status === undefined &&
          issue.state === "open" &&
          initial
        ) {
          await this.api.setProjectStatus(issue.number, initial);
          project = { id: "", status: initial };
        }
      } catch (error) {
        // Without the board, status tags are left as they are this time.
        this.projectProblem(error);
        project = undefined;
      }
    }
    const input = (item: ProjectItem | null | undefined): MetadataInput => ({
      number: issue.number,
      github: {
        title: issue.title,
        labels: issue.labels,
        state: issue.state,
        reason: issue.stateReason,
        status: item === undefined ? undefined : (item?.status ?? null),
      },
      discord: { name: meta.name, tags: meta.tags },
      managed,
      closeTags,
      statusTags,
      snap: previous,
      discordWrites: Boolean(this.options.discordWrites),
    });
    let plan = planMetadata(input(project));
    const key = `meta:${issue.number}`;
    const opened = () => previous?.state === "closed" && issue.state === "open";
    try {
      if (plan.github.project && project !== undefined) {
        // The board was read from a cache: check it before overwriting a move made on GitHub.
        const fresh = await this.api.projectStatus(issue.number, true);
        if ((fresh?.status ?? null) !== (project?.status ?? null))
          plan = planMetadata(input((project = fresh)));
      }
      const { github } = plan;
      if (
        github.title !== undefined ||
        github.addLabels.length ||
        github.removeLabels.length ||
        github.state
      ) {
        await this.api.updateIssue(issue.number, github);
        if (github.state) {
          this.settleState(issue.number);
          issue.state = github.state;
          issue.stateReason =
            github.state === "closed" ? github.reason : "reopened";
        }
      }
      if (github.project)
        await this.api.setProjectStatus(issue.number, github.project.status);
    } catch (error) {
      // Leave Discord and the snapshot as they are, so the change is retried on the next scan.
      if (await this.hold(error, key, undefined, link.thread))
        return { reopened: opened() };
      throw error;
    }
    const { github } = plan;
    const reopened = opened();
    this.store.unblock(key);
    const applied = await this.api.applyMeta(link.thread, {
      name: plan.discord.name,
      addTags: plan.discord.addTags,
      removeTags: plan.discord.removeTags,
      locked: issue.locked !== meta.locked ? issue.locked : undefined,
    });
    issue.title = plan.title;
    issue.labels = [
      ...issue.labels.filter((l) => !github.removeLabels.includes(l)),
      ...github.addLabels,
    ];
    const overflow = new Set(plan.overflow);
    let closedHidden = plan.closedHidden;
    let statusHidden = plan.statusHidden;
    for (const id of applied.overflow) {
      if (id === plan.closed) closedHidden = true;
      if (id === plan.status) statusHidden = true;
      const label = managed.find((m) => m.id === id)?.label;
      if (label) overflow.add(label);
    }
    link.snap = {
      // A rename that had to wait keeps the old title, so the next run retries it.
      title:
        applied.renameDeferred && plan.discord.name !== undefined
          ? previous?.title
          : plan.title,
      labels: plan.labels,
      overflow: [...overflow],
      state: issue.state,
      closed: plan.closed,
      closedHidden,
      // Status unknown this time (board unreachable): keep the last agreed value.
      status: plan.status !== undefined ? plan.status : previous?.status,
      statusHidden:
        plan.status !== undefined ? statusHidden : previous?.statusHidden,
    };
    this.store.saveLink(link);
    return { reopened };
  }

  /**
   * Mirror references to the issue as bot-owned messages, once each. Bounded to open issues
   * and recently closed ones; an ETag makes unchanged timelines free. References made before
   * the mapping started are not posted, so a backfill does not flood old threads.
   */
  private async timeline(link: Link, issue: Issue, history: Message[]) {
    const settings = this.options.timeline;
    if (!settings) return;
    if (
      issue.state === "closed" &&
      issue.closedAt &&
      Date.now() - Date.parse(issue.closedAt) >
        settings.maxAgeDaysClosed * 86400_000
    )
      return;
    const etagKey = `timeline-etag:${issue.number}`;
    const result = await this.api.timeline(
      issue.number,
      this.store.meta(etagKey),
    );
    if (!result) return;
    const started = this.store.meta("started")!;
    for (const event of result.events) {
      const key = `timeline:${issue.number}:${event.key}`;
      if (event.createdAt < started && !this.store.mirror(key)) continue;
      await this.render(
        link,
        key,
        timelineBody(event),
        event.url,
        event.key,
        history,
      );
    }
    if (result.etag) this.store.setMeta(etagKey, result.etag);
    else this.store.deleteMeta(etagKey);
  }

  private async render(
    link: Link,
    key: string,
    body: string,
    url: string,
    source: string,
    history: Message[],
  ) {
    if (key === "summary") key = `summary:${link.issue}`;
    let mirror = this.store.mirror(key);
    const content = chunks(body, url);
    const digest = hash(JSON.stringify(content));
    if (
      mirror?.hash === digest &&
      mirror.ids.every((id) => history.some((m) => m.id === id))
    )
      return;
    if (!mirror) {
      mirror = {
        key,
        issue: link.issue,
        origin: "github",
        source,
        ids: [],
        hash: "",
      };
      // The first summary part is the starter when the bot created the post.
      if (key === `summary:${link.issue}` && link.origin === "github")
        mirror.ids.push(link.starter);
      this.store.saveMirror(mirror);
    }
    for (let i = 0; i < Math.max(content.length, mirror.ids.length); i++) {
      const text =
        content[i] ??
        `_(Content moved or shortened.)_\n\n↪ ${url} · former part ${i + 1}`;
      let id: string | undefined = mirror.ids[i];
      if (id) {
        try {
          await this.api.edit(link.thread, id, text);
        } catch (error) {
          if (!missing(error)) throw error;
          id = undefined;
        }
      }
      if (!id) {
        // Exact bot-authored content recovers writes even after Discord's short nonce window expires.
        const recovered = history.find((m) => m.own && m.body === text);
        id =
          recovered?.id ??
          (await this.api.send(
            link.thread,
            text,
            hash(`${key}:${i}:${text}`).slice(0, 24),
          ));
        mirror.ids[i] = id;
        this.store.saveMirror(mirror);
      }
    }
    mirror.hash = digest;
    this.store.saveMirror(mirror);
  }

  private async hold(
    error: unknown,
    key: string,
    source?: Message,
    thread?: string,
  ) {
    if (!(error instanceof WriteBlocked)) return false;
    this.store.block(
      key,
      error.discordId ?? source?.authorId,
      error.reason,
      source?.thread ?? thread,
    );
    const noticeKey = `link-notice:${source?.thread}:${source?.authorId}`;
    // Role refusals stay quiet: anyone may post in the forum, but only some roles reach GitHub.
    if (
      error.reason !== "role" &&
      !source?.automated &&
      source?.createdAt &&
      Date.now() - Date.parse(source.createdAt) < 10 * 60_000 &&
      Date.now() - Number(this.store.meta(noticeKey) ?? 0) > 10 * 60_000
    ) {
      try {
        await this.api.notifyBlocked?.(source, error.message);
        this.store.setMeta(noticeKey, String(Date.now()));
      } catch {
        /* A missing notification permission must not lose the held change. */
      }
    }
    return true;
  }

  async discord(thread: string) {
    let link = this.store.thread(thread);
    if (link?.disabled) return;
    let post;
    try {
      post = await this.api.getPost(thread);
    } catch (error) {
      if (missing(error)) {
        this.store.clearBlocked(thread);
        if (link) this.store.saveLink({ ...link, disabled: true });
        return;
      }
      throw error;
    }
    if (!link) {
      if (post.starter.bot) return;
      const marker = issueMarker(thread);
      const existing = (await this.api.issues()).find(
        (i) =>
          (i.relay?.kind === "thread" && i.relay.sourceId === thread) ||
          (i.own && i.body.includes(marker)),
      );
      let issue: Issue;
      try {
        issue = existing ?? (await this.api.createIssue(post, marker));
        this.store.unblock(`issue:${thread}`);
      } catch (error) {
        if (await this.hold(error, `issue:${thread}`, post.starter)) return;
        throw error;
      }
      link = {
        issue: issue.number,
        thread,
        starter: post.starter.id,
        origin: "discord",
        writer: issue.writer ?? issue.relay?.writer,
      };
      // The new issue matches the post: seed the snapshot so tags already on the post
      // (a close tag on a backfilled post, say) count as Discord's side, not as stale.
      if (!existing && issue.state === "open")
        link.snap = {
          title: issue.title,
          labels: issue.labels,
          state: "open",
          closed: (await this.api.closeTags()).length ? null : undefined,
        };
      this.store.saveLink(link);
    }
    if (link.origin === "discord") {
      const body = `${sourceBody(post.starter)}\n\n${issueMarker(thread)}`;
      const key = `body:${thread}`;
      if (this.store.meta(key) !== hash(body)) {
        try {
          await this.api.editIssue(link.issue, body, link.writer, post.starter);
          this.store.setMeta(key, hash(body));
          this.store.unblock(key);
        } catch (error) {
          if (!(await this.hold(error, key, post.starter))) throw error;
        }
      }
    }
    const messages = await this.api.messages(thread);
    let comments: Awaited<ReturnType<Platforms["comments"]>> | undefined;
    const sourceIds = new Set(messages.filter((m) => !m.bot).map((m) => m.id));
    this.store.clearBlocked(thread, sourceIds);
    for (const message of messages) {
      if (message.bot || message.id === link.starter) continue;
      const key = `discord:${message.id}`;
      const body = `${sourceBody(message)}\n\n${messageMarker(message.id)}`;
      let mirror = this.store.mirror(key);
      if (mirror?.hash === hash(body)) continue;
      try {
        if (!mirror) {
          comments ??= await this.api.comments(link.issue);
          const recovered = comments.find(
            (c) =>
              (c.relay?.kind === "message" &&
                c.relay.sourceId === message.id) ||
              (c.own && c.body.includes(messageMarker(message.id))),
          );
          const created = recovered
            ? { id: recovered.id, writer: recovered.relay?.writer }
            : await this.api.createComment(link.issue, body, message);
          mirror = {
            key,
            issue: link.issue,
            origin: "discord",
            source: message.id,
            ids: [typeof created === "string" ? created : created.id],
            hash: "",
            writer: typeof created === "string" ? undefined : created.writer,
          };
          this.store.saveMirror(mirror);
        }
        await this.api.editComment(mirror.ids[0], body, mirror.writer, message);
        mirror.hash = hash(body);
        this.store.saveMirror(mirror);
        this.store.unblock(key);
      } catch (error) {
        if (!(await this.hold(error, key, message))) throw error;
      }
    }
    for (const mirror of this.store.mirrors(link.issue)) {
      if (
        mirror.origin !== "discord" ||
        sourceIds.has(mirror.source) ||
        mirror.hash === "deleted"
      )
        continue;
      try {
        await this.api.editComment(
          mirror.ids[0],
          `_(This message was deleted on Discord.)_\n\n${messageMarker(mirror.source)}`,
          mirror.writer,
        );
      } catch (error) {
        if (
          await this.hold(error, `delete:${mirror.source}`, undefined, thread)
        )
          continue;
        if (!missing(error)) throw error;
      }
      this.store.unblock(`delete:${mirror.source}`);
      mirror.hash = "deleted";
      this.store.saveMirror(mirror);
    }
    this.store.enqueue({ type: "github", issue: link.issue });
  }
}
