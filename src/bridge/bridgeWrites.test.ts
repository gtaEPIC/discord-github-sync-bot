import { describe, expect, it, vi } from "vitest";
import { Client } from "discord.js";
const calls = vi.hoisted(
  () => [] as { token: string; method: string; args: any }[],
);
const failures = vi.hoisted(() => ({ next: undefined as unknown }));
vi.mock("@octokit/rest", () => ({
  Octokit: class {
    hook = { wrap: vi.fn() };
    issues: Record<string, (args: unknown) => Promise<unknown>>;
    constructor(options: { auth: string }) {
      this.issues = Object.fromEntries(
        [
          "create",
          "update",
          "createComment",
          "updateComment",
          "listLabelsForRepo",
        ].map((method) => [
          method,
          async (args: unknown) => {
            calls.push({ token: options.auth, method, args });
            if (failures.next) {
              const error = failures.next;
              failures.next = undefined;
              throw error;
            }
            return {
              data:
                method === "createComment"
                  ? { id: 10, user: { id: 999 } }
                  : {
                      number: 1,
                      title: "test",
                      body: "",
                      state: "open",
                      user: { id: 999, login: "app[bot]" },
                      labels: [],
                      html_url: "https://github.com/o/r/issues/1",
                      created_at: new Date().toISOString(),
                    },
            };
          },
        ]),
      );
    }
    async paginate() {
      return [];
    }
  },
}));
import { LivePlatforms } from "./platforms";
import { Authorship, Relay, WriteBlocked } from "./authorship";
import { resolveConfig } from "./config";

const now = new Date().toISOString();
const source = {
  id: "789",
  thread: "789",
  authorId: "123",
  body: "hello",
  author: "alice",
  url: "https://discord.com/message",
  bot: false,
  createdAt: now,
};
const post = {
  id: "789",
  title: "test",
  starter: source,
  tags: [],
  createdAt: now,
};
function setup(
  settings: unknown = { writeMode: "bridge" },
  roles: string[] = [],
) {
  calls.length = 0;
  failures.next = undefined;
  const signed: Relay[] = [];
  const authorship: Authorship = {
    access: vi.fn(async () => ({
      token: "user-token",
      githubId: "456",
      login: "alice",
    })),
    invalidate: vi.fn(),
    sign: (relay) => {
      signed.push(relay);
      return `<!-- signed:${relay.writer.kind}:${relay.writer.githubId} -->`;
    },
    verify: () => undefined,
  };
  const invalidateWriteToken = vi.fn();
  const api = new LivePlatforms(
    {} as Client,
    {
      owner: "o",
      repo: "r",
      forum: "f",
      readToken: async () => "installation-read",
      config: resolveConfig(settings),
      writeToken: async () => "installation-write",
      invalidateWriteToken,
      started: () => new Date(Date.now() - 60_000).toISOString(),
      memberRoles: async () => roles,
    },
    authorship,
  );
  api.botId = "999";
  return { api, authorship, signed, invalidateWriteToken };
}

describe("bridge write mode", () => {
  it("writes every mutation with the installation write token and never asks for a linked account", async () => {
    const { api, authorship, signed } = setup();
    const issue = await api.createIssue(post, "marker");
    const comment = await api.createComment(1, "body", source);
    await api.editComment(
      "10",
      "body <!-- gd-sync:message:789 -->",
      comment.writer,
      source,
    );
    await api.editIssue(
      1,
      "body <!-- gd-sync:thread:789 -->",
      issue.writer,
      source,
    );
    await api.state(1, "closed", "123");
    expect(calls.map((c) => c.method)).toEqual([
      "create",
      "createComment",
      "updateComment",
      "update",
      "update",
    ]);
    expect(calls.every((c) => c.token === "installation-write")).toBe(true);
    expect(authorship.access).not.toHaveBeenCalled();
    // Every relay is signed as the bridge for the Discord author, with the bot's GitHub id.
    expect(signed).toHaveLength(4);
    for (const relay of signed)
      expect(relay.writer).toEqual({
        kind: "bridge",
        discordId: "123",
        githubId: "999",
      });
    expect(issue.own).toBe(true);
    expect(comment.writer).toEqual({
      kind: "bridge",
      discordId: "123",
      githubId: "999",
    });
  });
  it("closes and reopens with a reason, and keeps close tags out of the label tags", async () => {
    const { api } = setup({
      writeMode: "bridge",
      closeTags: [
        { tag: "fixed", reason: "completed" },
        { tag: "Missing", reason: "duplicate" },
      ],
    });
    Object.assign(api, {
      forum: {
        availableTags: [
          { id: "1", name: "Bug" },
          { id: "2", name: "Fixed" },
        ],
      },
      labelCache: { names: ["bug", "fixed"], until: Infinity },
    });
    expect(await api.closeTags()).toEqual([
      { id: "2", name: "Fixed", reason: "completed" },
    ]);
    expect(await api.managedTags()).toEqual([
      { id: "1", name: "Bug", label: "bug" },
    ]);
    await api.updateIssue(1, { state: "closed", reason: "not_planned" });
    await api.updateIssue(1, { state: "open" });
    expect(calls.map((c) => c.args)).toEqual([
      expect.objectContaining({ state: "closed", state_reason: "not_planned" }),
      expect.objectContaining({ state: "open", state_reason: "reopened" }),
    ]);
    expect(calls.every((c) => c.token === "installation-write")).toBe(true);
  });
  it("leaves user mode on the linked-account path", async () => {
    const { api } = setup({ writeMode: "user" });
    await api.createComment(1, "body", source);
    expect(calls.map((c) => c.token)).toEqual(["user-token"]);
  });
  it("keeps pinned identities: bridge content stays bridge-written after switching back to user mode", async () => {
    const { api, authorship } = setup({ writeMode: "user" });
    const writer = {
      kind: "bridge" as const,
      discordId: "123",
      githubId: "999",
    };
    await api.editComment("10", "body", writer, source);
    expect(calls.map((c) => c.token)).toEqual(["installation-write"]);
    expect(authorship.access).not.toHaveBeenCalled();
    await expect(
      api.editComment("10", "body", writer, { ...source, authorId: "555" }),
    ).rejects.toMatchObject({ reason: "original-author" });
  });
  it("holds writes from members without an allowed role, except tombstones and commands", async () => {
    const { api } = setup({ writeMode: "bridge", allowRoles: ["111111"] }, [
      "222222",
    ]);
    await expect(api.createIssue(post, "marker")).rejects.toMatchObject({
      reason: "role",
    });
    await expect(api.createComment(1, "body", source)).rejects.toMatchObject({
      reason: "role",
    });
    expect(calls).toEqual([]);
    const writer = {
      kind: "bridge" as const,
      discordId: "123",
      githubId: "999",
    };
    await api.editComment("10", "deleted", writer);
    await api.state(1, "closed", "123");
    expect(calls.map((c) => c.method)).toEqual(["updateComment", "update"]);
  });
  it("lets allowed roles write", async () => {
    const { api } = setup({ writeMode: "bridge", allowRoles: ["111111"] }, [
      "111111",
    ]);
    await api.createComment(1, "body", source);
    expect(calls).toHaveLength(1);
  });
  it("rate limits new comments per Discord user and exempts backfilled messages", async () => {
    const { api } = setup({
      writeMode: "bridge",
      rateLimit: { commentsPerHour: 2 },
    });
    await api.createComment(1, "a", source);
    await api.createComment(1, "b", source);
    await expect(api.createComment(1, "c", source)).rejects.toMatchObject({
      reason: "rate",
    });
    // Another user has their own budget.
    await api.createComment(1, "d", { ...source, authorId: "321" });
    // Messages from before the mapping started are backfill.
    await api.createComment(1, "e", {
      ...source,
      createdAt: "2020-01-01T00:00:00.000Z",
    });
    expect(calls).toHaveLength(4);
  });
  it("does not count failed writes against the rate limit", async () => {
    const { api } = setup({
      writeMode: "bridge",
      rateLimit: { commentsPerHour: 1 },
    });
    failures.next = Object.assign(new Error("boom"), { status: 500 });
    await expect(api.createComment(1, "a", source)).rejects.toMatchObject({
      status: 500,
    });
    await api.createComment(1, "a", source);
    expect(calls).toHaveLength(2);
  });
  it("rethrows GitHub rate limits for the queue to back off instead of holding them as permission problems", async () => {
    const { api } = setup();
    const limited = Object.assign(new Error("secondary rate limit"), {
      status: 403,
      response: { headers: { "retry-after": "60" } },
    });
    failures.next = limited;
    await expect(api.createComment(1, "a", source)).rejects.toBe(limited);
    failures.next = Object.assign(new Error("forbidden"), { status: 403 });
    await expect(api.createComment(1, "a", source)).rejects.toBeInstanceOf(
      WriteBlocked,
    );
  });
  it("refreshes the write token after a 401 and lets the queue retry", async () => {
    const { api, invalidateWriteToken } = setup();
    failures.next = Object.assign(new Error("bad credentials"), {
      status: 401,
    });
    await expect(api.createComment(1, "a", source)).rejects.toMatchObject({
      status: 401,
    });
    expect(invalidateWriteToken).toHaveBeenCalled();
  });
  it("holds every write while the bot identity is unknown", async () => {
    const { api } = setup();
    api.botId = undefined;
    await expect(api.createComment(1, "a", source)).rejects.toMatchObject({
      reason: "permission",
    });
    expect(calls).toEqual([]);
  });
});
