import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WriteBlocked } from "./authorship";
import { Engine, EngineOptions } from "./engine";
import { Store } from "./database";
import { chunks, issueMarker, issueSummary, messageMarker } from "./content";
import {
  Comment,
  Issue,
  IssueChange,
  Message,
  MetaChange,
  Platforms,
  Post,
  ThreadMeta,
} from "./types";
import { CloseTag, ManagedTag } from "./reconcile";

class Fake implements Platforms {
  gh: Issue[] = [];
  dc: Post[] = [];
  commentsByIssue = new Map<number, Comment[]>();
  messagesByThread = new Map<string, Message[]>();
  seq = 1000;
  state = vi.fn(async (number: number, state: "open" | "closed") => {
    this.gh.find((i) => i.number === number)!.state = state;
  });
  issues = vi.fn(async (_since?: string) => structuredClone(this.gh));
  getIssue = vi.fn(async (number: number) => {
    const issue = this.gh.find((i) => i.number === number);
    if (!issue) throw Object.assign(new Error("Not found"), { status: 404 });
    return structuredClone(issue);
  });
  createIssue = vi.fn(async (post: Post, marker: string) =>
    this.addIssue({ body: `${post.starter.body}\n${marker}`, own: true }),
  );
  editIssue = vi.fn(async (number: number, body: string) => {
    this.gh.find((i) => i.number === number)!.body = body;
  });
  comments = vi.fn(async (number: number) =>
    structuredClone(this.commentsByIssue.get(number) ?? []),
  );
  createComment = vi.fn(async (number: number, body: string) => {
    const id = String(++this.seq);
    const comments = this.commentsByIssue.get(number) ?? [];
    comments.push({
      id,
      body,
      own: true,
      author: "bridge",
      url: `https://github.com/o/r/issues/${number}#issuecomment-${id}`,
    });
    this.commentsByIssue.set(number, comments);
    return id;
  });
  editComment = vi.fn(async (id: string, body: string) => {
    const comment = [...this.commentsByIssue.values()]
      .flat()
      .find((c) => c.id === id);
    if (!comment) throw Object.assign(new Error("Not found"), { status: 404 });
    comment.body = body;
  });
  posts = vi.fn(async () => structuredClone(this.dc));
  getPost = vi.fn(async (thread: string) => {
    const post = this.dc.find((p) => p.id === thread);
    if (!post) throw Object.assign(new Error("Not found"), { status: 404 });
    return structuredClone(post);
  });
  createPost = vi.fn(async (issue: Issue) => {
    const post = this.addPost({
      bot: true,
      own: true,
      body: chunks(issueSummary(issue), issue.url)[0],
    });
    const name = `#${issue.number} ${issue.title}`.slice(0, 100);
    post.title = name;
    this.meta.get(post.id)!.name = name;
    this.meta.get(post.id)!.tags = this.managed
      .filter((m) => issue.labels.includes(m.label))
      .map((m) => m.id);
    return structuredClone(post);
  });
  managed: ManagedTag[] = [];
  meta = new Map<string, ThreadMeta>();
  managedTags = vi.fn(async () => structuredClone(this.managed));
  close: CloseTag[] = [];
  closeTags = vi.fn(async () => structuredClone(this.close));
  threadMeta = vi.fn(async (thread: string) => {
    const meta = this.meta.get(thread);
    if (!meta) throw Object.assign(new Error("Not found"), { status: 404 });
    return structuredClone(meta);
  });
  applyMeta = vi.fn(async (thread: string, change: MetaChange) => {
    const meta = this.meta.get(thread)!;
    if (change.name !== undefined) meta.name = change.name;
    if (change.locked !== undefined) meta.locked = change.locked;
    meta.tags = meta.tags.filter((t) => !change.removeTags?.includes(t));
    const overflow: string[] = [];
    for (const tag of change.addTags ?? [])
      if (meta.tags.length < 5) meta.tags.push(tag);
      else overflow.push(tag);
    return { overflow, renameDeferred: false };
  });
  applyArchive = vi.fn(
    async (thread: string, closed: boolean, reopened: boolean) => {
      const meta = this.meta.get(thread)!;
      if (closed) meta.archived = true;
      else if (reopened) meta.archived = false;
    },
  );
  updateIssue = vi.fn(async (number: number, change: IssueChange) => {
    const issue = this.gh.find((i) => i.number === number)!;
    if (change.title !== undefined) issue.title = change.title;
    if (change.state) {
      issue.state = change.state;
      issue.stateReason =
        change.state === "closed" ? change.reason : "reopened";
    }
    issue.labels = [
      ...issue.labels.filter((l) => !change.removeLabels?.includes(l)),
      ...(change.addLabels ?? []),
    ];
  });
  messages = vi.fn(async (thread: string) =>
    structuredClone(this.messagesByThread.get(thread) ?? []),
  );
  send = vi.fn(
    async (thread: string, body: string, _nonce: string) =>
      this.addMessage(thread, body, true).id,
  );
  edit = vi.fn(async (thread: string, id: string, body: string) => {
    const message = this.messagesByThread.get(thread)?.find((m) => m.id === id);
    if (!message) throw Object.assign(new Error("Not found"), { status: 404 });
    message.body = body;
  });
  addIssue(overrides: Partial<Issue> = {}) {
    const number = ++this.seq;
    const issue: Issue = {
      number,
      title: "Bug",
      body: "Details",
      url: `https://github.com/o/r/issues/${number}`,
      author: "alice",
      state: "open",
      labels: [],
      locked: false,
      createdAt: new Date().toISOString(),
      ...overrides,
    };
    this.gh.push(issue);
    return issue;
  }
  addPost(overrides: Partial<Message> = {}) {
    const id = String(++this.seq);
    const starter: Message = {
      id,
      thread: id,
      body: "Report",
      author: "bob",
      url: `https://discord.com/channels/1/${id}/${id}`,
      bot: false,
      ...overrides,
    };
    const post: Post = {
      id,
      title: "Report",
      starter,
      tags: [],
      createdAt: new Date().toISOString(),
    };
    this.dc.push(post);
    this.messagesByThread.set(id, [starter]);
    this.meta.set(id, {
      name: post.title,
      tags: [],
      archived: false,
      locked: false,
    });
    return post;
  }
  addMessage(thread: string, body: string, bot = false) {
    const id = String(++this.seq);
    const message: Message = {
      id,
      thread,
      body,
      author: bot ? "bridge" : "bob",
      bot,
      own: bot,
      url: `https://discord.com/channels/1/${thread}/${id}`,
    };
    this.messagesByThread.get(thread)!.push(message);
    return message;
  }
  addComment(number: number, body: string) {
    const id = String(++this.seq);
    const comment: Comment = {
      id,
      body,
      author: "alice",
      own: false,
      url: `https://github.com/o/r/issues/${number}#issuecomment-${id}`,
    };
    const comments = this.commentsByIssue.get(number) ?? [];
    comments.push(comment);
    this.commentsByIssue.set(number, comments);
    return comment;
  }
}

const stores: Store[] = [];
const dirs: string[] = [];
function setup(options: EngineOptions = {}) {
  const store = new Store(":memory:", "test");
  stores.push(store);
  const api = new Fake();
  return { store, api, engine: new Engine(store, api, false, options) };
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("durable bridge", () => {
  it("holds an unlinked comment without blocking others, then sends it once after linking", async () => {
    const { engine, api, store } = setup();
    const issue = api.addIssue();
    await engine.github(issue.number);
    const thread = store.link(issue.number)!.thread;
    const held = api.addMessage(thread, "held");
    const allowed = api.addMessage(thread, "allowed");
    const create = api.createComment.getMockImplementation()!;
    let linked = false;
    api.createComment.mockImplementation(async (number, body) => {
      if (body.includes(messageMarker(held.id)) && !linked)
        throw new WriteBlocked("123", "link", "link required");
      return create(number, body);
    });
    await engine.discord(thread);
    expect(store.health().blocked).toBe(1);
    expect(store.mirror(`discord:${held.id}`)).toBeUndefined();
    expect(store.mirror(`discord:${allowed.id}`)).toBeDefined();
    linked = true;
    await engine.discord(thread);
    await engine.discord(thread);
    expect(store.health().blocked).toBe(0);
    expect(
      (api.commentsByIssue.get(issue.number) ?? []).filter((c) =>
        c.body.includes(messageMarker(held.id)),
      ),
    ).toHaveLength(1);
  });
  it("clears held changes for source messages deleted before authorization", async () => {
    const { engine, api, store } = setup();
    const issue = api.addIssue();
    await engine.github(issue.number);
    const thread = store.link(issue.number)!.thread;
    const message = api.addMessage(thread, "delete me");
    api.createComment.mockRejectedValue(
      new WriteBlocked("123", "link", "link required"),
    );
    await engine.discord(thread);
    expect(store.health().blocked).toBe(1);
    api.messagesByThread.set(
      thread,
      api.messagesByThread.get(thread)!.filter((m) => m.id !== message.id),
    );
    await engine.discord(thread);
    expect(store.health().blocked).toBe(0);
  });
  it("passes the Discord actor to state writes and preserves blocked commands for retry", async () => {
    const { engine, api, store } = setup();
    const issue = api.addIssue();
    await engine.github(issue.number);
    api.state.mockRejectedValueOnce(
      new WriteBlocked("123", "link", "link required"),
    );
    const task = {
      type: "state" as const,
      issue: issue.number,
      state: "closed" as const,
      actor: "123",
    };
    // Held, not failed: a failed job would be dropped after its retries.
    await engine.run(task);
    expect(api.state).toHaveBeenCalledWith(issue.number, "closed", "123");
    expect(store.health()).toMatchObject({ blocked: 1, failed: 0 });
    // Every scan retries it once (deduplicated) until it goes through.
    const drain = () => {
      const tasks = [];
      for (let job; (job = store.next()); store.complete(job.id))
        tasks.push(job.task);
      return tasks;
    };
    drain();
    await engine.scan();
    await engine.scan();
    expect(drain().filter((t) => t.type === "state")).toEqual([task]);
    await engine.run(task);
    expect(api.gh[0].state).toBe("closed");
    expect(store.health().blocked).toBe(0);
    await engine.scan();
    expect(drain().filter((t) => t.type === "state")).toEqual([]);
  });
  it("recovers signed user-authored relays without duplicating or echoing them", async () => {
    const { engine, api, store } = setup();
    const post = api.addPost();
    const writer = { kind: "user" as const, discordId: "123", githubId: "456" };
    const issue = api.addIssue({
      own: false,
      relay: { kind: "thread", sourceId: post.id, writer },
    });
    const comment = api.addComment(issue.number, "user authored");
    comment.relay = { kind: "message", sourceId: "789", writer };
    await engine.github(issue.number);
    expect(store.link(issue.number)).toMatchObject({
      thread: post.id,
      origin: "discord",
      writer,
    });
    expect(store.mirror(`github:${comment.id}`)).toBeUndefined();
    expect(api.createPost).not.toHaveBeenCalled();
  });
  it("loops bridge-written posts, replies, edits and deletions without echoes when only the relay identifies them", async () => {
    const { engine, api, store } = setup();
    const bridge = (discordId: string) => ({
      kind: "bridge" as const,
      discordId,
      githubId: "999",
    });
    // Production shape: GitHub content is never `own`; only the verified relay marks it as ours.
    api.createIssue.mockImplementation(async (post: Post, marker: string) => {
      const issue = api.addIssue({
        title: post.title,
        body: `${post.starter.body}\n${marker}`,
        own: false,
        author: "app[bot]",
        relay: { kind: "thread", sourceId: post.id, writer: bridge("123") },
      });
      return { ...structuredClone(issue), writer: bridge("123") };
    });
    api.createComment.mockImplementation(
      async (number: number, body: string, source?: Message) => {
        const comment = api.addComment(number, body);
        comment.own = false;
        comment.relay = {
          kind: "message",
          sourceId: source!.id,
          writer: bridge("123"),
        };
        return { id: comment.id, writer: bridge("123") } as never;
      },
    );
    const post = api.addPost({ authorId: "123" });
    await engine.discord(post.id);
    const link = store.thread(post.id)!;
    expect(link).toMatchObject({ origin: "discord", writer: bridge("123") });
    const reply = api.addMessage(post.id, "a reply");
    await engine.discord(post.id);
    await engine.github(link.issue);
    await engine.discord(post.id);
    await engine.github(link.issue);
    expect(api.createIssue).toHaveBeenCalledTimes(1);
    expect(api.createPost).not.toHaveBeenCalled();
    expect(api.createComment).toHaveBeenCalledTimes(1);
    // Nothing GitHub-side was mirrored back into the thread as a new message.
    expect(
      store.mirrors(link.issue).filter((m) => m.key.startsWith("github:")),
    ).toEqual([]);
    // Edits and deletions reuse the pinned bridge writer.
    reply.body = "edited reply";
    await engine.discord(post.id);
    const mirror = store.mirror(`discord:${reply.id}`)!;
    expect(api.editComment).toHaveBeenLastCalledWith(
      mirror.ids[0],
      expect.stringContaining("edited reply"),
      bridge("123"),
      expect.objectContaining({ id: reply.id }),
    );
    api.messagesByThread.set(
      post.id,
      api.messagesByThread.get(post.id)!.filter((m) => m.id !== reply.id),
    );
    await engine.discord(post.id);
    expect(api.editComment).toHaveBeenLastCalledWith(
      mirror.ids[0],
      expect.stringContaining("deleted on Discord"),
      bridge("123"),
    );
    expect(api.createComment).toHaveBeenCalledTimes(1);
  });
  it("repairs a deleted mirror even when the source content hash has not changed", async () => {
    const { engine, api, store } = setup();
    const issue = api.addIssue();
    const comment = api.addComment(issue.number, "Keep this reply");
    await engine.github(issue.number);
    const link = store.link(issue.number)!;
    const mirror = store.mirror(`github:${comment.id}`)!;
    const deleted = mirror.ids[0];
    api.messagesByThread.set(
      link.thread,
      api.messagesByThread.get(link.thread)!.filter((m) => m.id !== deleted),
    );
    await engine.github(issue.number);
    const replacement = store.mirror(mirror.key)!;
    expect(replacement.ids[0]).not.toBe(deleted);
    expect(
      api.messagesByThread
        .get(link.thread)!
        .find((m) => m.id === replacement.ids[0])!.body,
    ).toContain("Keep this reply");
  });
  it("turns deleted GitHub source comments into notices without removing the thread", async () => {
    const { engine, api, store } = setup();
    const issue = api.addIssue();
    const comment = api.addComment(issue.number, "Delete me");
    await engine.github(issue.number);
    api.commentsByIssue.set(issue.number, []);
    await engine.github(issue.number);
    const link = store.link(issue.number)!;
    const mirror = store.mirror(`github:${comment.id}`)!;
    expect(
      api.messagesByThread
        .get(link.thread)!
        .find((m) => m.id === mirror.ids[0])!.body,
    ).toContain("deleted on GitHub");
    expect(link.disabled).not.toBe(true);
  });
  it("retries permission failures without disabling mappings", async () => {
    const { engine, api, store } = setup();
    const issue = api.addIssue();
    await engine.github(issue.number);
    api.applyMeta.mockRejectedValueOnce(
      Object.assign(new Error("Missing permissions"), { status: 403 }),
    );
    await expect(engine.github(issue.number)).rejects.toThrow(
      "Missing permissions",
    );
    expect(store.link(issue.number)!.disabled).not.toBe(true);
    await engine.github(issue.number);
  });

  it("creates from either side, mirrors replies, and ignores its own echoes", async () => {
    const { engine, api, store } = setup();
    const issue = api.addIssue();
    await engine.github(issue.number);
    const link = store.link(issue.number)!;
    const reply = api.addMessage(link.thread, "A Discord reply");
    await engine.discord(link.thread);
    expect(api.createIssue).not.toHaveBeenCalled();
    expect(api.createComment).toHaveBeenCalledOnce();
    const ghReply = api.addComment(
      issue.number,
      "A GitHub reply with https://discord.com/channels/1/2/3",
    );
    await engine.github(issue.number);
    await engine.github(issue.number);
    await engine.discord(link.thread);
    expect(api.createComment).toHaveBeenCalledOnce();
    expect(store.mirror(`discord:${reply.id}`)).toBeDefined();
    expect(store.mirror(`github:${ghReply.id}`)?.ids).toHaveLength(1);
    expect(api.createPost).toHaveBeenCalledOnce();

    const post = api.addPost();
    await engine.discord(post.id);
    await engine.discord(post.id);
    expect(api.createIssue).toHaveBeenCalledOnce();
    expect(store.thread(post.id)?.origin).toBe("discord");
  });

  it("recovers a successful issue creation whose response was lost", async () => {
    const { engine, api, store } = setup();
    const post = api.addPost();
    api.createIssue.mockImplementationOnce(async (p, marker) => {
      api.addIssue({ body: `${p.starter.body}\n${marker}`, own: true });
      throw new Error("Connection lost after write");
    });
    await expect(engine.discord(post.id)).rejects.toThrow("Connection lost");
    await engine.discord(post.id);
    expect(api.createIssue).toHaveBeenCalledOnce();
    expect(store.thread(post.id)).toBeDefined();
  });

  it("recovers a successful forum creation whose response was lost", async () => {
    const { engine, api, store } = setup();
    const issue = api.addIssue();
    api.createPost.mockImplementationOnce(async (i) => {
      api.addPost({
        bot: true,
        own: true,
        body: chunks(issueSummary(i), i.url)[0],
      });
      throw new Error("Lost response");
    });
    await expect(engine.github(issue.number)).rejects.toThrow("Lost response");
    await engine.github(issue.number);
    expect(api.createPost).toHaveBeenCalledOnce();
    expect(store.link(issue.number)).toBeDefined();
  });

  it("recovers interrupted comment sends after the nonce window", async () => {
    const { engine, api, store } = setup();
    const issue = api.addIssue();
    await engine.github(issue.number);
    const link = store.link(issue.number)!;
    const dc = api.addMessage(link.thread, "hello");
    api.createComment.mockImplementationOnce(async (number, body) => {
      api.addComment(number, body).own = true;
      throw new Error("Lost response");
    });
    await expect(engine.discord(link.thread)).rejects.toThrow();
    await engine.discord(link.thread);
    expect(api.createComment).toHaveBeenCalledOnce();
    expect(store.mirror(`discord:${dc.id}`)).toBeDefined();
    const gh = api.addComment(issue.number, "hi back");
    api.send.mockImplementationOnce(async (thread, body) => {
      api.addMessage(thread, body, true);
      throw new Error("Lost response");
    });
    await expect(engine.github(issue.number)).rejects.toThrow();
    await engine.github(issue.number);
    expect(api.send).toHaveBeenCalledOnce();
    expect(store.mirror(`github:${gh.id}`)).toBeDefined();
  });

  it("retains GitHub-origin mappings across database close/reopen and propagates edits", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sync-"));
    dirs.push(directory);
    const file = join(directory, "sync.sqlite");
    let store = new Store(file, "test");
    const api = new Fake();
    const issue = api.addIssue();
    let engine = new Engine(store, api, false);
    await engine.github(issue.number);
    const comment = api.addComment(issue.number, "before");
    await engine.github(issue.number);
    const ids = store.mirror(`github:${comment.id}`)!.ids;
    store.close();
    store = new Store(file, "test");
    stores.push(store);
    engine = new Engine(store, api, false);
    comment.body = "after";
    await engine.github(issue.number);
    expect(api.createPost).toHaveBeenCalledOnce();
    expect(store.mirror(`github:${comment.id}`)!.ids).toEqual(ids);
    expect(
      api.messagesByThread
        .get(store.link(issue.number)!.thread)!
        .find((m) => m.id === ids[0])!.body,
    ).toContain("after");
  });

  it("propagates Discord edits and replaces deleted source messages with tombstones", async () => {
    const { engine, api, store } = setup();
    const post = api.addPost();
    await engine.discord(post.id);
    const reply = api.addMessage(post.id, "before");
    await engine.discord(post.id);
    reply.body = "after";
    await engine.discord(post.id);
    const mirror = store.mirror(`discord:${reply.id}`)!;
    expect(
      api.commentsByIssue
        .get(mirror.issue)!
        .find((c) => c.id === mirror.ids[0])!.body,
    ).toContain("after");
    api.messagesByThread.set(post.id, [post.starter]);
    await engine.discord(post.id);
    expect(api.commentsByIssue.get(mirror.issue)![0].body).toContain(
      "deleted on Discord",
    );
  });

  it("splits long comments, preserves every part, and updates them in place", async () => {
    const { engine, api, store } = setup();
    const issue = api.addIssue();
    const comment = api.addComment(issue.number, "😀".repeat(3000));
    await engine.github(issue.number);
    const mirror = store.mirror(`github:${comment.id}`)!;
    expect(mirror.ids.length).toBeGreaterThan(3);
    const messages = api.messagesByThread.get(
      store.link(issue.number)!.thread,
    )!;
    for (const id of mirror.ids)
      expect(
        messages.find((m) => m.id === id)!.body.length,
      ).toBeLessThanOrEqual(2000);
    comment.body = "short";
    await engine.github(issue.number);
    expect(store.mirror(mirror.key)!.ids).toEqual(mirror.ids);
    expect(messages.find((m) => m.id === mirror.ids[1])!.body).toContain(
      "shortened",
    );
  });

  it("ignores foreign markers and never treats a pasted source URL as a bridge echo", async () => {
    const { engine, api, store } = setup();
    const post = api.addPost();
    api.addIssue({ body: issueMarker(post.id), own: false });
    await engine.discord(post.id);
    expect(api.createIssue).toHaveBeenCalledOnce();
    const issue = store.thread(post.id)!.issue;
    const comment = api.addComment(
      issue,
      `${messageMarker("555")} https://discord.com/channels/1/2/3`,
    );
    await engine.github(issue);
    expect(store.mirror(`github:${comment.id}`)).toBeDefined();
  });

  it("does not delete issues when threads disappear and does not recreate disabled mappings", async () => {
    const { engine, api, store } = setup();
    const issue = api.addIssue();
    await engine.github(issue.number);
    const link = store.link(issue.number)!;
    await engine.run({ type: "unlink", thread: link.thread });
    await engine.github(issue.number);
    await engine.discord(link.thread);
    expect(api.gh).toHaveLength(1);
    expect(api.createPost).toHaveBeenCalledOnce();
    expect(api.state).not.toHaveBeenCalled();
  });

  it("only explicit commands change GitHub state", async () => {
    const { engine, api, store } = setup();
    const issue = api.addIssue();
    await engine.github(issue.number);
    await engine.discord(store.link(issue.number)!.thread);
    expect(api.state).not.toHaveBeenCalled();
    await engine.run({ type: "state", issue: issue.number, state: "closed" });
    expect(api.state).toHaveBeenCalledWith(issue.number, "closed");
  });

  it("reconciles missed events without importing old issues by default", async () => {
    const { engine, api, store } = setup();
    store.setMeta("started", "2026-01-01T00:00:00.000Z");
    const old = api.addIssue({ createdAt: "2025-01-01T00:00:00.000Z" });
    const recent = api.addIssue({ createdAt: "2026-01-02T00:00:00.000Z" });
    const closed = api.addIssue({ state: "closed" });
    await engine.scan();
    const tasks = [];
    for (;;) {
      const job = store.next();
      if (!job) break;
      tasks.push(job.task);
      store.complete(job.id);
    }
    expect(tasks).toContainEqual({ type: "github", issue: recent.number });
    expect(tasks).not.toContainEqual({ type: "github", issue: old.number });
    expect(tasks).not.toContainEqual({ type: "github", issue: closed.number });
  });
});

describe("title and tag reconcile", () => {
  const managed: ManagedTag[] = [
    { id: "t-bug", name: "Bug", label: "bug" },
    { id: "t-ui", name: "UI", label: "ui" },
  ];
  async function linked(options: EngineOptions) {
    const ctx = setup(options);
    ctx.api.managed = managed;
    const issue = ctx.api.addIssue({ title: "Train stuck", labels: ["bug"] });
    await ctx.engine.github(issue.number);
    const thread = ctx.store.link(issue.number)!.thread;
    return { ...ctx, issue, thread, meta: ctx.api.meta.get(thread)! };
  }
  it("sends Discord renames and tag edits to GitHub in bridge mode, even from a stale queued GitHub task", async () => {
    const { engine, api, issue, meta, store } = await linked({
      discordWrites: true,
    });
    expect(meta).toMatchObject({
      name: `#${issue.number} Train stuck`,
      tags: ["t-bug"],
    });
    // The thread is edited on Discord; a GitHub task queued earlier runs first.
    meta.name = `#${issue.number} Doors broken`;
    meta.tags = ["t-bug", "t-ui", "unmanaged"];
    await engine.github(issue.number);
    expect(api.updateIssue).toHaveBeenCalledWith(issue.number, {
      title: "Doors broken",
      addLabels: ["ui"],
      removeLabels: [],
    });
    expect(api.gh[0]).toMatchObject({
      title: "Doors broken",
      labels: ["bug", "ui"],
    });
    expect(meta.tags).toEqual(["t-bug", "t-ui", "unmanaged"]);
    expect(store.link(issue.number)!.snap).toMatchObject({
      title: "Doors broken",
      labels: ["bug", "ui"],
    });
    // Our own writes come back as events: nothing further changes.
    api.updateIssue.mockClear();
    api.applyMeta.mockClear();
    await engine.github(issue.number);
    expect(api.updateIssue).not.toHaveBeenCalled();
    expect(api.applyMeta).toHaveBeenCalledWith(expect.any(String), {
      name: undefined,
      addTags: [],
      removeTags: [],
      locked: undefined,
    });
    // The summary reflects the reconciled title and labels.
    const summary = store.mirror(`summary:${issue.number}`)!;
    expect(
      api.messagesByThread
        .get(store.link(issue.number)!.thread)!
        .find((m) => m.id === summary.ids[0])!.body,
    ).toContain("Labels: bug, ui");
  });
  it("applies GitHub title and label changes to Discord and lets GitHub win a conflict", async () => {
    const { engine, api, issue, meta } = await linked({ discordWrites: true });
    api.gh[0].title = "From GitHub";
    api.gh[0].labels = ["ui"];
    meta.name = `#${issue.number} From Discord`;
    await engine.github(issue.number);
    expect(api.updateIssue).not.toHaveBeenCalled();
    expect(meta).toMatchObject({
      name: `#${issue.number} From GitHub`,
      tags: ["t-ui"],
    });
  });
  it("reverts Discord edits in user mode without writing GitHub", async () => {
    const { engine, api, issue, meta } = await linked({});
    meta.name = `#${issue.number} Doors broken`;
    meta.tags = ["t-ui", "unmanaged"];
    await engine.github(issue.number);
    expect(api.updateIssue).not.toHaveBeenCalled();
    expect(meta.name).toBe(`#${issue.number} Train stuck`);
    // Managed tags follow GitHub; unmanaged tags are left alone.
    expect(meta.tags.sort()).toEqual(["t-bug", "unmanaged"]);
  });
  it("holds refused GitHub writes without failing the job or reverting Discord, then retries", async () => {
    const { engine, api, issue, meta, store } = await linked({
      discordWrites: true,
    });
    meta.tags = [];
    api.updateIssue.mockRejectedValueOnce(
      new WriteBlocked(undefined, "permission", "no access"),
    );
    await engine.github(issue.number);
    expect(store.health().blocked).toBe(1);
    expect(meta.tags).toEqual([]);
    expect(store.link(issue.number)!.snap!.labels).toEqual(["bug"]);
    await engine.github(issue.number);
    expect(store.health().blocked).toBe(0);
    expect(api.gh[0].labels).toEqual([]);
  });
  it("keeps an inactivity-archived open thread archived and unarchives only on reopen", async () => {
    const { engine, api, issue, meta } = await linked({ discordWrites: true });
    meta.archived = true;
    await engine.github(issue.number);
    expect(meta.archived).toBe(true);
    expect(api.state).not.toHaveBeenCalled();
    api.gh[0].state = "closed";
    await engine.github(issue.number);
    expect(meta.archived).toBe(true);
    api.gh[0].state = "open";
    await engine.github(issue.number);
    expect(meta.archived).toBe(false);
  });
});

describe("close tags", () => {
  const close: CloseTag[] = [
    { id: "c-fixed", name: "Fixed", reason: "completed" },
    { id: "c-wontfix", name: "Won't Fix", reason: "not_planned" },
  ];
  async function linked(options: EngineOptions) {
    const ctx = setup(options);
    ctx.api.close = close;
    const issue = ctx.api.addIssue({ title: "Train stuck" });
    await ctx.engine.github(issue.number);
    const thread = ctx.store.link(issue.number)!.thread;
    return { ...ctx, issue, thread, meta: ctx.api.meta.get(thread)! };
  }
  it("closes on GitHub when a close tag is applied, archives the thread, and stays quiet afterwards", async () => {
    const { engine, api, issue, meta, store } = await linked({
      discordWrites: true,
    });
    meta.tags = ["c-wontfix"];
    await engine.github(issue.number);
    expect(api.updateIssue).toHaveBeenCalledWith(
      issue.number,
      expect.objectContaining({ state: "closed", reason: "not_planned" }),
    );
    expect(api.gh[0]).toMatchObject({
      state: "closed",
      stateReason: "not_planned",
    });
    expect(meta).toMatchObject({ archived: true, tags: ["c-wontfix"] });
    expect(store.link(issue.number)!.snap).toMatchObject({
      state: "closed",
      closed: "c-wontfix",
    });
    // The GitHub "closed" event comes back: nothing more to write.
    api.updateIssue.mockClear();
    await engine.github(issue.number);
    expect(api.updateIssue).not.toHaveBeenCalled();
    expect(api.state).not.toHaveBeenCalled();
  });
  it("reopens on GitHub when the close tag is removed, and unarchives", async () => {
    const { engine, api, issue, meta } = await linked({ discordWrites: true });
    meta.tags = ["c-fixed"];
    await engine.github(issue.number);
    expect(meta.archived).toBe(true);
    meta.tags = [];
    await engine.github(issue.number);
    expect(api.gh[0]).toMatchObject({
      state: "open",
      stateReason: "reopened",
    });
    expect(meta.archived).toBe(false);
  });
  it("mirrors GitHub closes and reopens as tags", async () => {
    const { engine, api, issue, meta } = await linked({ discordWrites: true });
    Object.assign(api.gh[0], { state: "closed", stateReason: "completed" });
    await engine.github(issue.number);
    expect(meta).toMatchObject({ tags: ["c-fixed"], archived: true });
    Object.assign(api.gh[0], { state: "open", stateReason: "reopened" });
    await engine.github(issue.number);
    expect(meta).toMatchObject({ tags: [], archived: false });
    expect(api.updateIssue).not.toHaveBeenCalled();
  });
  it("an inactivity archive never closes the issue", async () => {
    const { engine, api, issue, meta } = await linked({ discordWrites: true });
    meta.archived = true;
    await engine.github(issue.number);
    expect(api.gh[0].state).toBe("open");
    expect(api.updateIssue).not.toHaveBeenCalled();
    expect(meta.archived).toBe(true);
  });
  it("/issue close still works and shows the close tag", async () => {
    const { engine, api, issue, meta } = await linked({ discordWrites: true });
    api.state.mockImplementationOnce(async (number: number) => {
      Object.assign(
        api.gh.find((i) => i.number === number)!,
        {
          state: "closed",
          stateReason: "completed",
        },
      );
    });
    await engine.run({ type: "state", issue: issue.number, state: "closed" });
    expect(meta).toMatchObject({ tags: ["c-fixed"], archived: true });
    expect(api.updateIssue).not.toHaveBeenCalled();
  });
  it("reverts close tags in user mode", async () => {
    const { engine, api, issue, meta } = await linked({});
    meta.tags = ["c-fixed"];
    await engine.github(issue.number);
    expect(api.gh[0].state).toBe("open");
    expect(meta.tags).toEqual([]);
  });
  it("closes a backfilled post that already carries a close tag after creating its issue", async () => {
    const { store, api } = setup();
    const engine = new Engine(store, api, true, { discordWrites: true });
    api.close = close;
    const post = api.addPost();
    api.meta.get(post.id)!.tags = ["c-fixed"];
    await engine.discord(post.id);
    const number = store.thread(post.id)!.issue;
    await engine.github(number);
    expect(api.gh[0]).toMatchObject({
      state: "closed",
      stateReason: "completed",
    });
    expect(api.meta.get(post.id)).toMatchObject({
      tags: ["c-fixed"],
      archived: true,
    });
  });
  it("a refused close is held and leaves the tag in place for the next scan", async () => {
    const { engine, api, issue, meta, store } = await linked({
      discordWrites: true,
    });
    meta.tags = ["c-fixed"];
    api.updateIssue.mockRejectedValueOnce(
      new WriteBlocked(undefined, "permission", "no access"),
    );
    await engine.github(issue.number);
    expect(api.gh[0].state).toBe("open");
    expect(meta).toMatchObject({ tags: ["c-fixed"], archived: false });
    expect(store.health()).toMatchObject({ blocked: 1, failed: 0 });
    await engine.github(issue.number);
    expect(api.gh[0].state).toBe("closed");
    expect(store.health().blocked).toBe(0);
  });
});
