import { Client, Collection } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { LivePlatforms } from "./platforms";

function setup() {
  const client = { user: { id: "bot" }, channels: { fetch: vi.fn() } };
  const api = new LivePlatforms(client as unknown as Client, {
    owner: "owner",
    repo: "repo",
    forum: "forum",
    readToken: async () => "test",
  });
  const forum = {
    availableTags: [],
    threads: { fetchActive: vi.fn(), fetchArchived: vi.fn() },
  };
  Reflect.set(api, "forum", forum);
  return { api, client, forum };
}
function channel(id = "thread") {
  const value = {
    id,
    parentId: "forum",
    isThread: () => true,
    name: "#42 Title",
    locked: false,
    archived: false,
    appliedTags: [] as string[],
    createdAt: new Date("2026-01-01T00:00:00Z"),
    archiveTimestamp: Date.parse("2026-02-01T00:00:00Z"),
    fetchStarterMessage: vi.fn(async () => ({
      id,
      channelId: id,
      content: "starter",
      url: "https://discord.com/starter",
      author: { id: "human", username: "alice", bot: false },
      attachments: new Map(),
    })),
    setArchived: vi.fn(async (state: boolean) => {
      value.archived = state;
    }),
    edit: vi.fn(async (_options: unknown) => {}),
    send: vi.fn(async (_options: unknown) => ({ id: "sent" })),
    messages: { fetch: vi.fn(), edit: vi.fn() },
  };
  return value;
}
describe("Discord adapter", () => {
  it("keeps an inactive open issue archived instead of reopening it every scan", async () => {
    const { api, client } = setup();
    const thread = channel();
    thread.archived = true;
    client.channels.fetch.mockResolvedValue(thread);
    expect(await api.applyMeta(thread.id, {})).toEqual({
      overflow: [],
      renameDeferred: false,
    });
    await api.applyArchive(thread.id, false, false);
    expect(thread.setArchived).not.toHaveBeenCalled();
    expect(thread.edit).not.toHaveBeenCalled();
    await api.applyArchive(thread.id, false, true);
    expect(thread.setArchived.mock.calls).toEqual([[false]]);
  });
  it("edits an archived thread and restores the archive, sending only changed fields", async () => {
    const { api, client } = setup();
    const thread = channel();
    thread.archived = true;
    client.channels.fetch.mockResolvedValue(thread);
    await api.applyMeta(thread.id, { name: "#42 Changed", locked: false });
    expect(thread.setArchived.mock.calls).toEqual([[false], [true]]);
    expect(thread.edit).toHaveBeenCalledWith({ name: "#42 Changed" });
    // Metadata is re-read with force right before writing.
    expect(client.channels.fetch).toHaveBeenCalledWith(thread.id, {
      force: true,
    });
    await api.applyArchive(thread.id, true, false);
    expect(thread.setArchived).toHaveBeenCalledTimes(2);
  });
  it("applies tag changes as a delta, keeps other tags, and reports tags that do not fit", async () => {
    const { api, client } = setup();
    const thread = channel();
    thread.appliedTags = ["a", "b", "c", "d"];
    client.channels.fetch.mockResolvedValue(thread);
    expect(
      await api.applyMeta(thread.id, {
        addTags: ["e", "f"],
        removeTags: ["missing"],
      }),
    ).toEqual({ overflow: ["f"], renameDeferred: false });
    expect(thread.edit).toHaveBeenCalledWith({
      appliedTags: ["a", "b", "c", "d", "e"],
    });
  });
  it("defers a third rename within ten minutes instead of waiting on Discord's rate limit", async () => {
    const { api, client } = setup();
    const thread = channel();
    client.channels.fetch.mockResolvedValue(thread);
    for (const name of ["#42 One", "#42 Two"])
      expect((await api.applyMeta(thread.id, { name })).renameDeferred).toBe(
        false,
      );
    expect(
      (await api.applyMeta(thread.id, { name: "#42 Three", addTags: ["x"] }))
        .renameDeferred,
    ).toBe(true);
    expect(thread.edit).toHaveBeenLastCalledWith({ appliedTags: ["x"] });
  });
  it("disables mentions for both sends and edits and uses Discord nonce deduplication", async () => {
    const { api, client } = setup();
    const thread = channel();
    thread.archived = true;
    client.channels.fetch.mockResolvedValue(thread);
    await api.send(thread.id, "@everyone", "nonce");
    await api.edit(thread.id, "message", "@everyone");
    expect(thread.send).toHaveBeenCalledWith({
      content: "@everyone",
      allowedMentions: { parse: [] },
      nonce: "nonce",
      enforceNonce: true,
    });
    expect(thread.messages.edit).toHaveBeenCalledWith("message", {
      content: "@everyone",
      allowedMentions: { parse: [] },
    });
  });
  it("enumerates multiple archived pages with a correct before cursor", async () => {
    const { api, forum } = setup();
    const first = channel("1");
    const second = channel("2");
    forum.threads.fetchActive.mockResolvedValue({ threads: new Collection() });
    forum.threads.fetchArchived
      .mockResolvedValueOnce({
        threads: new Collection([[first.id, first]]),
        hasMore: true,
      })
      .mockResolvedValueOnce({
        threads: new Collection([[second.id, second]]),
        hasMore: false,
      });
    expect((await api.posts()).map((p) => p.id)).toEqual(["1", "2"]);
    expect(forum.threads.fetchArchived.mock.calls[1][0].before).toEqual(
      new Date(first.archiveTimestamp),
    );
  });
  it("reads all message pages in chronological order", async () => {
    const { api, client } = setup();
    const thread = channel();
    client.channels.fetch.mockResolvedValue(thread);
    const message = (id: number) => ({
      id: String(id),
      channelId: thread.id,
      content: `message ${id}`,
      type: 0,
      url: `https://discord.com/${id}`,
      author: { id: "human", username: "alice", bot: false },
      attachments: new Map(),
    });
    const page = new Collection(
      Array.from({ length: 100 }, (_, i) => [
        String(201 - i),
        message(201 - i),
      ]),
    );
    thread.messages.fetch
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce(new Collection([["101", message(101)]]));
    const messages = await api.messages(thread.id);
    expect(messages).toHaveLength(101);
    expect(messages[0].id).toBe("101");
    expect(messages.at(-1)!.id).toBe("201");
    expect(thread.messages.fetch.mock.calls[1][0].before).toBe("102");
  });
  it("rejects channels outside the configured forum", async () => {
    const { api, client } = setup();
    const thread = channel();
    thread.parentId = "another-forum";
    client.channels.fetch.mockResolvedValue(thread);
    await expect(api.getPost(thread.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe("timeline reader", () => {
  const events = [
    {
      event: "cross-referenced",
      created_at: "2026-11-24T00:00:00Z",
      actor: { login: "dev" },
      source: {
        issue: {
          id: 555,
          number: 12,
          title: "Fix the doors",
          html_url: "https://github.com/owner/repo/pull/12",
          pull_request: {},
          repository: { full_name: "owner/repo" },
        },
      },
    },
    {
      event: "cross-referenced",
      created_at: "2026-11-24T00:00:00Z",
      source: {
        issue: {
          id: 777,
          number: 3,
          title: "Elsewhere",
          html_url: "https://github.com/other/tool/issues/3",
          repository: { full_name: "other/tool" },
        },
      },
    },
    {
      event: "referenced",
      id: 91,
      created_at: "2026-11-24T00:00:00Z",
      actor: { login: "dev" },
      commit_id: "abcdef1234567890",
      commit_url:
        "https://api.github.com/repos/owner/repo/commits/abcdef1234567890",
    },
    {
      event: "closed",
      id: 92,
      created_at: "2026-11-24T00:00:00Z",
      commit_id: "1234567abcdef",
      commit_url:
        "https://api.github.com/repos/fork/repo/commits/1234567abcdef",
    },
    {
      event: "closed",
      id: 93,
      node_id: "CE_93",
      commit_id: null,
      state_reason: "duplicate",
      actor: { login: "maintainer", id: 5 },
    },
    { event: "labeled", id: 94 },
    { event: "labeled", id: 95, label: { name: "bug" }, actor: { id: 999 } },
    { event: "renamed", id: 96, rename: { from: "Old", to: "New" } },
    { event: "project_v2_item_status_changed", id: 97, node_id: "PVTISC_97" },
    { event: "subscribed", id: 98 },
  ];
  it("keeps cross-references and commit references, keyed for deduplication", async () => {
    const { api } = setup();
    // Changes the bridge's own App made (actor 999) came from Discord: not shown.
    Reflect.set(api, "botId", "999");
    const list = vi.fn(async () => ({
      data: events,
      headers: { etag: 'W/"one"' },
    }));
    Reflect.set(api.github.issues, "listEventsForTimeline", list);
    const result = await api.timeline(42);
    expect(result!.etag).toBe('W/"one"');
    expect(result!.events).toEqual([
      expect.objectContaining({
        key: "xref:555",
        kind: "crossref",
        label: "#12",
        pullRequest: true,
        title: "Fix the doors",
      }),
      expect.objectContaining({
        key: "xref:777",
        label: "other/tool#3",
        pullRequest: false,
      }),
      expect.objectContaining({
        key: "91",
        kind: "commit",
        label: "abcdef1",
        url: "https://github.com/owner/repo/commit/abcdef1234567890",
      }),
      expect.objectContaining({
        key: "92",
        kind: "closed",
        label: "fork/repo@1234567",
      }),
      expect.objectContaining({
        key: "93",
        kind: "closed",
        reason: "duplicate",
        node: "CE_93",
        actor: "maintainer",
        url: "https://github.com/owner/repo/issues/42#event-93",
      }),
      expect.objectContaining({
        key: "96",
        kind: "renamed",
        from: "Old",
        to: "New",
      }),
      expect.objectContaining({ key: "97", kind: "status", node: "PVTISC_97" }),
    ]);
  });
  it("reads duplicate targets and Status moves, leaving out moves the bridge made", async () => {
    const { api } = setup();
    const graphql = vi.fn(async () => ({
      nodes: [
        {
          id: "CE_1",
          duplicateOf: {
            number: 20,
            url: "https://github.com/owner/repo/issues/20",
            title: "Floating items",
            repository: { nameWithOwner: "owner/repo" },
          },
        },
        {
          id: "MADE_2",
          canonical: {
            number: 42,
            url: "u42",
            repository: { nameWithOwner: "owner/repo" },
          },
          duplicate: {
            number: 16,
            url: "u16",
            title: "Map",
            repository: { nameWithOwner: "owner/repo" },
          },
        },
      ],
    }));
    Reflect.set(api.github, "graphql", graphql);
    const statusChanges = vi.fn(async () => ({
      login: "machine",
      changes: new Map([
        ["S_1", { from: "Backlog", to: "Done", project: "Board" }],
        ["S_2", { from: null, to: "Backlog" }],
        ["S_3", { from: "Done", to: "Backlog" }],
      ]),
    }));
    Reflect.set(api.options, "projects", { statusChanges });
    const event = (key: string, kind: string, node: string, actor?: string) =>
      ({ key, kind, node, actor, createdAt: "", url: "" }) as never;
    const result = await api.describeEvents(42, [
      event("1", "closed", "CE_1"),
      event("2", "duplicate", "MADE_2"),
      event("3", "status", "S_1", "github-project-automation[bot]"),
      event("4", "status", "S_2"),
      event("5", "status", "S_3", "machine"),
    ]);
    expect(result.pending).toBe(false);
    expect(graphql.mock.calls[0][1]).toEqual({ ids: ["CE_1", "MADE_2"] });
    expect(result.events).toEqual([
      expect.objectContaining({
        key: "1",
        node: undefined,
        duplicateOf: {
          label: "#20",
          url: "https://github.com/owner/repo/issues/20",
          title: "Floating items",
        },
      }),
      expect.objectContaining({
        key: "2",
        duplicate: { label: "#16", url: "u16", title: "Map" },
      }),
      expect.objectContaining({
        key: "3",
        from: "Backlog",
        to: "Done",
        project: "Board",
      }),
    ]);
  });
  it("reports details it could not read as pending", async () => {
    const { api } = setup();
    Reflect.set(
      api.github,
      "graphql",
      vi.fn(async () => {
        throw Object.assign(new Error("Server error"), { status: 502 });
      }),
    );
    const result = await api.describeEvents(42, [
      { key: "1", kind: "closed", node: "CE_1", createdAt: "", url: "" },
      { key: "2", kind: "status", node: "S_1", createdAt: "", url: "" },
      { key: "3", kind: "reopened", createdAt: "", url: "" },
    ]);
    // Without a Projects token, Status moves are not shown; the close is retried later.
    expect(result).toEqual({
      pending: true,
      events: [expect.objectContaining({ key: "3" })],
    });
  });
  it("treats 304 as unchanged and trusts the ETag only for one-page timelines", async () => {
    const { api } = setup();
    const list = vi.fn(async (options: { headers: Record<string, string> }) => {
      if (options.headers["if-none-match"])
        throw Object.assign(new Error("Not modified"), { status: 304 });
      return {
        data: events.slice(0, 1),
        headers: {
          etag: '"page1"',
          link: '<https://api.github.com/x?page=2>; rel="next"',
        },
      };
    });
    const paginate = vi.fn(async () => events);
    Reflect.set(api.github.issues, "listEventsForTimeline", list);
    Reflect.set(api.github, "paginate", paginate);
    expect(await api.timeline(42, '"page1"')).toBeUndefined();
    const result = await api.timeline(42);
    expect(paginate).toHaveBeenCalledOnce();
    expect(result!.etag).toBeUndefined();
    expect(result!.events).toHaveLength(8);
  });
});

describe("message bodies", () => {
  it("adds a webhook's embeds after its text", async () => {
    const { api } = setup();
    const message = await (
      api as unknown as { message(m: unknown): Promise<{ body: string }> }
    ).message({
      id: "1",
      channelId: "thread",
      url: "https://discord.com/m",
      content: "Bug Report from **player1**",
      attachments: new Map(),
      embeds: [
        {
          data: { type: "rich" },
          title: "Station signs",
          description: "Floating signs.",
          fields: [],
        },
      ],
      author: { id: "777777777", username: "Bug Reporter", bot: true },
      webhookId: "777777777",
      createdAt: new Date(),
    });
    expect(message.body).toBe(
      "Bug Report from **player1**\n\n> **Station signs**\n\n> Floating signs.",
    );
  });
});
