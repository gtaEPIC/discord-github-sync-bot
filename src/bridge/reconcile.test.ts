import { describe, expect, it } from "vitest";
import {
  CloseTag,
  ManagedTag,
  StatusTag,
  MetadataInput,
  managedTags,
  planMetadata,
  stripTitle,
  threadName,
} from "./reconcile";

const managed: ManagedTag[] = [
  { id: "t-bug", name: "Bug", label: "bug" },
  { id: "t-crash", name: "Crash", label: "crash" },
  { id: "t-ui", name: "UI", label: "ui" },
];
function plan(overrides: Partial<MetadataInput> = {}) {
  return planMetadata({
    number: 7,
    github: { title: "Train stuck", labels: ["bug"] },
    discord: { name: "#7 Train stuck", tags: ["t-bug"] },
    managed,
    snap: { title: "Train stuck", labels: ["bug"] },
    discordWrites: true,
    ...overrides,
  });
}
const quiet = {
  github: { addLabels: [], removeLabels: [] },
  discord: { addTags: [], removeTags: [] },
};

describe("titles", () => {
  it("does nothing when both sides match the snapshot", () => {
    expect(plan()).toMatchObject({ title: "Train stuck", ...quiet });
    expect(plan().github.title).toBeUndefined();
    expect(plan().discord.name).toBeUndefined();
  });
  it("renames the thread when only GitHub changed", () => {
    const result = plan({
      github: { title: "Train stuck at depot", labels: ["bug"] },
    });
    expect(result.discord.name).toBe("#7 Train stuck at depot");
    expect(result.github.title).toBeUndefined();
  });
  it("retitles the issue when only Discord changed, keeping the prefix on Discord", () => {
    const result = plan({
      discord: { name: "#7 Doors broken", tags: ["t-bug"] },
    });
    expect(result.github.title).toBe("Doors broken");
    expect(result.discord.name).toBeUndefined();
  });
  it("restores a removed #N prefix without touching GitHub, and the restore is then quiet", () => {
    const result = plan({ discord: { name: "Train stuck", tags: ["t-bug"] } });
    expect(result.github.title).toBeUndefined();
    expect(result.discord.name).toBe("#7 Train stuck");
    // The bot's own rename comes back as a thread update: nothing more to do.
    expect(
      plan({ discord: { name: result.discord.name!, tags: ["t-bug"] } }).discord
        .name,
    ).toBeUndefined();
  });
  it("sends a new title written without the prefix and adds the prefix back", () => {
    const result = plan({ discord: { name: "Doors broken", tags: ["t-bug"] } });
    expect(result.github.title).toBe("Doors broken");
    expect(result.discord.name).toBe("#7 Doors broken");
  });
  it("lets GitHub win when both changed", () => {
    const result = plan({
      github: { title: "GitHub title", labels: ["bug"] },
      discord: { name: "#7 Discord title", tags: ["t-bug"] },
    });
    expect(result.github.title).toBeUndefined();
    expect(result.discord.name).toBe("#7 GitHub title");
  });
  it("treats a thread name truncated at 100 characters as equal", () => {
    const long = "x".repeat(150);
    const result = plan({
      github: { title: long, labels: ["bug"] },
      discord: { name: threadName(7, long), tags: ["t-bug"] },
      snap: { title: long, labels: ["bug"] },
    });
    expect(threadName(7, long)).toHaveLength(100);
    expect(result.github.title).toBeUndefined();
    expect(result.discord.name).toBeUndefined();
  });
  it("reverts Discord renames in user mode and when there is no snapshot", () => {
    for (const overrides of [{ discordWrites: false }, { snap: undefined }]) {
      const result = plan({
        discord: { name: "#7 Doors broken", tags: ["t-bug"] },
        ...overrides,
      });
      expect(result.github.title).toBeUndefined();
      expect(result.discord.name).toBe("#7 Train stuck");
    }
  });
  it("strips only this issue's own prefix", () => {
    expect(stripTitle(7, "#7 Title")).toBe("Title");
    expect(stripTitle(7, "#12 Title")).toBe("#12 Title");
    expect(stripTitle(7, "#70 Title")).toBe("#70 Title");
  });
});

describe("labels and tags", () => {
  it("adds a tag when only GitHub added the label, and removes it when only GitHub removed it", () => {
    expect(
      plan({ github: { title: "Train stuck", labels: ["bug", "crash"] } })
        .discord,
    ).toMatchObject({
      addTags: ["t-crash"],
      removeTags: [],
    });
    expect(
      plan({ github: { title: "Train stuck", labels: [] } }).discord,
    ).toMatchObject({
      addTags: [],
      removeTags: ["t-bug"],
    });
  });
  it("adds or removes the label when only Discord changed the tag", () => {
    expect(
      plan({ discord: { name: "#7 Train stuck", tags: ["t-bug", "t-ui"] } })
        .github,
    ).toMatchObject({
      addLabels: ["ui"],
      removeLabels: [],
    });
    expect(
      plan({ discord: { name: "#7 Train stuck", tags: [] } }).github,
    ).toMatchObject({
      addLabels: [],
      removeLabels: ["bug"],
    });
  });
  it("lets GitHub win per label when both sides changed it", () => {
    const result = plan({
      github: { title: "Train stuck", labels: [] },
      discord: { name: "#7 Train stuck", tags: ["t-bug", "t-ui"] },
    });
    // bug: removed on GitHub only -> removed. ui: added on Discord only -> added.
    expect(result.labels).toEqual(["ui"]);
    expect(result.github).toMatchObject({
      addLabels: ["ui"],
      removeLabels: [],
    });
    expect(result.discord).toMatchObject({
      addTags: [],
      removeTags: ["t-bug"],
    });
  });
  it("never touches unmanaged tags or labels", () => {
    const result = plan({
      github: { title: "Train stuck", labels: ["bug", "priority: high"] },
      discord: { name: "#7 Train stuck", tags: ["t-bug", "t-fixed"] },
    });
    expect(result).toMatchObject(quiet);
  });
  it("keeps labels that do not fit in five tags as overflow instead of reading them as removed", () => {
    const tags = ["u1", "u2", "u3", "u4", "t-bug"];
    const first = plan({
      github: { title: "Train stuck", labels: ["bug", "crash"] },
      discord: { name: "#7 Train stuck", tags },
    });
    expect(first.discord.addTags).toEqual([]);
    expect(first.overflow).toEqual(["crash"]);
    expect(first.labels).toEqual(["bug", "crash"]);
    const second = plan({
      github: { title: "Train stuck", labels: ["bug", "crash"] },
      discord: { name: "#7 Train stuck", tags },
      snap: {
        title: "Train stuck",
        labels: first.labels,
        overflow: first.overflow,
      },
    });
    expect(second.github.removeLabels).toEqual([]);
    expect(second.overflow).toEqual(["crash"]);
    // A slot frees up: the overflow label is shown.
    const third = plan({
      github: { title: "Train stuck", labels: ["bug", "crash"] },
      discord: { name: "#7 Train stuck", tags: ["u1", "t-bug"] },
      snap: {
        title: "Train stuck",
        labels: second.labels,
        overflow: second.overflow,
      },
    });
    expect(third.discord.addTags).toEqual(["t-crash"]);
    expect(third.overflow).toEqual([]);
  });
  it("reverts Discord tag edits in user mode and lets GitHub win without a snapshot", () => {
    for (const overrides of [{ discordWrites: false }, { snap: undefined }]) {
      const result = plan({
        discord: { name: "#7 Train stuck", tags: ["t-ui"] },
        ...overrides,
      });
      expect(result.github).toMatchObject({ addLabels: [], removeLabels: [] });
      expect(result.discord).toMatchObject({
        addTags: ["t-bug"],
        removeTags: ["t-ui"],
      });
    }
  });
});

describe("managed tag pairing", () => {
  it("pairs explicit mappings first, then case-insensitive names, one tag per label", () => {
    const available = [
      { id: "1", name: "Bug" },
      { id: "2", name: "Feature" },
      { id: "3", name: "Fixed" },
      { id: "4", name: "BUG" },
    ];
    expect(
      managedTags(available, ["bug", "enhancement"], {
        feature: "Enhancement",
      }),
    ).toEqual([
      { id: "1", name: "Bug", label: "bug" },
      { id: "2", name: "Feature", label: "enhancement" },
    ]);
  });
});

describe("close tags", () => {
  const closeTags: CloseTag[] = [
    { id: "c-fixed", name: "Fixed", reason: "completed" },
    { id: "c-wontfix", name: "Won't Fix", reason: "not_planned" },
    { id: "c-dupe", name: "Duplicate", reason: "duplicate" },
  ];
  const open = {
    title: "Train stuck",
    labels: ["bug"],
    state: "open" as const,
  };
  const closedAs = (reason: string | null) => ({
    ...open,
    state: "closed" as const,
    reason,
  });
  const snap = (closed: string | null, extra = {}) => ({
    title: "Train stuck",
    labels: ["bug"],
    closed,
    ...extra,
  });
  const tags = (...extra: string[]) => ({
    name: "#7 Train stuck",
    tags: ["t-bug", ...extra],
  });
  const close = (overrides: Partial<MetadataInput>) =>
    plan({ closeTags, github: open, snap: snap(null), ...overrides });

  it("closes the issue with the tag's reason when a close tag is applied on Discord", () => {
    for (const [tag, reason] of [
      ["c-fixed", "completed"],
      ["c-wontfix", "not_planned"],
      ["c-dupe", "duplicate"],
    ]) {
      const result = close({ discord: tags(tag) });
      expect(result.github).toMatchObject({ state: "closed", reason });
      expect(result.closed).toBe(tag);
      expect(result.discord.removeTags).toEqual([]);
    }
  });
  it("reopens the issue when every close tag is removed", () => {
    const result = close({
      github: closedAs("completed"),
      discord: tags(),
      snap: snap("c-fixed"),
    });
    expect(result.github).toMatchObject({ state: "open" });
    expect(result.closed).toBeNull();
  });
  it("shows GitHub closes and reopens as tags", () => {
    expect(
      close({ github: closedAs("not_planned"), discord: tags() }).discord
        .addTags,
    ).toEqual(["c-wontfix"]);
    const reopened = close({
      github: open,
      discord: tags("c-fixed"),
      snap: snap("c-fixed"),
    });
    expect(reopened.discord.removeTags).toEqual(["c-fixed"]);
    expect(reopened.github.state).toBeUndefined();
  });
  it("falls back to the first close tag for an unmapped reason without rewriting the reason", () => {
    const withoutDupe = closeTags.slice(0, 2);
    const first = close({
      closeTags: withoutDupe,
      github: closedAs("duplicate"),
      discord: tags(),
    });
    expect(first.discord.addTags).toEqual(["c-fixed"]);
    expect(first.github.state).toBeUndefined();
    // Next run: the fallback tag is agreed, so nothing changes on either side.
    const second = close({
      closeTags: withoutDupe,
      github: closedAs("duplicate"),
      discord: tags("c-fixed"),
      snap: snap("c-fixed"),
    });
    expect(second.github).toMatchObject({ addLabels: [], removeLabels: [] });
    expect(second.github.state).toBeUndefined();
    expect(second.discord).toMatchObject({ addTags: [], removeTags: [] });
    // A null reason (closed before reasons existed) falls back the same way.
    expect(
      close({ github: closedAs(null), discord: tags() }).discord.addTags,
    ).toEqual(["c-fixed"]);
  });
  it("switching close tags on Discord changes the reason; the newly added tag replaces the old one", () => {
    const result = close({
      github: closedAs("completed"),
      discord: tags("c-fixed", "c-wontfix"),
      snap: snap("c-fixed"),
    });
    expect(result.github).toMatchObject({
      state: "closed",
      reason: "not_planned",
    });
    expect(result.discord.removeTags).toEqual(["c-fixed"]);
  });
  it("lets GitHub win when both sides changed the state", () => {
    const result = close({
      github: closedAs("not_planned"),
      discord: tags("c-fixed"),
    });
    expect(result.github.state).toBeUndefined();
    expect(result.closed).toBe("c-wontfix");
    expect(result.discord).toMatchObject({
      addTags: ["c-wontfix"],
      removeTags: ["c-fixed"],
    });
  });
  it("reverts close tags in user mode and without a close snapshot", () => {
    for (const overrides of [
      { discordWrites: false },
      { snap: { title: "Train stuck", labels: ["bug"] } },
    ]) {
      const result = close({ discord: tags("c-fixed"), ...overrides });
      expect(result.github.state).toBeUndefined();
      expect(result.discord.removeTags).toEqual(["c-fixed"]);
    }
  });
  it("never treats close tags as labels, even when a label has the same name", () => {
    const result = close({
      managed: [
        ...managed,
        { id: "c-dupe", name: "Duplicate", label: "duplicate" },
      ],
      github: { ...open, labels: ["bug", "duplicate"] },
      discord: tags(),
    });
    expect(result.discord.addTags).toEqual([]);
    expect(result.labels).toEqual(["bug"]);
  });
  it("gives the close tag a slot over label tags, keeping the label as overflow", () => {
    const result = close({
      github: { ...closedAs("completed"), labels: ["bug", "crash", "ui"] },
      discord: {
        name: "#7 Train stuck",
        tags: ["u1", "u2", "t-bug", "t-crash", "t-ui"],
      },
      snap: snap(null, { labels: ["bug", "crash", "ui"] }),
    });
    expect(result.discord.addTags).toEqual(["c-fixed"]);
    expect(result.discord.removeTags).toEqual(["t-ui"]);
    expect(result.overflow).toEqual(["ui"]);
    expect(result.github).toMatchObject({ addLabels: [], removeLabels: [] });
    expect(result.github.state).toBeUndefined();
  });
  it("does not read a close tag that never fit as a reopen", () => {
    const full = {
      name: "#7 Train stuck",
      tags: ["u1", "u2", "u3", "u4", "u5"],
    };
    const first = close({
      github: { ...closedAs("completed"), labels: [] },
      discord: full,
      snap: snap(null, { labels: [] }),
    });
    expect(first.closedHidden).toBe(true);
    const second = close({
      github: { ...closedAs("completed"), labels: [] },
      discord: full,
      snap: snap(first.closed!, { labels: [], closedHidden: true }),
    });
    expect(second.github.state).toBeUndefined();
  });
  it("ignores the close field entirely when no close tags are configured", () => {
    const result = plan({ github: closedAs("completed") });
    expect(result.closed).toBeUndefined();
    expect(result.github.state).toBeUndefined();
  });
});

describe("Projects status", () => {
  const statusTags: StatusTag[] = [
    { id: "s-backlog", name: "Backlog", option: "Backlog" },
    { id: "s-progress", name: "In Progress", option: "In Progress" },
    { id: "s-doing", name: "Doing", option: "In Progress" },
  ];
  const closeTags: CloseTag[] = [
    { id: "c-fixed", name: "Fixed", reason: "completed" },
  ];
  const github = (status: string | null, extra = {}) => ({
    title: "Train stuck",
    labels: ["bug"],
    state: "open" as const,
    status,
    ...extra,
  });
  const snap = (status: string | null, extra = {}) => ({
    title: "Train stuck",
    labels: ["bug"],
    closed: null,
    status,
    ...extra,
  });
  const tags = (...extra: string[]) => ({
    name: "#7 Train stuck",
    tags: ["t-bug", ...extra],
  });
  const run = (overrides: Partial<MetadataInput>) =>
    plan({
      closeTags,
      statusTags,
      github: github("Backlog"),
      discord: tags("s-backlog"),
      snap: snap("s-backlog"),
      ...overrides,
    });

  it("is quiet when the board and the tag agree", () => {
    const result = run({});
    expect(result.status).toBe("s-backlog");
    expect(result.github.project).toBeUndefined();
    expect(result.discord).toMatchObject({ addTags: [], removeTags: [] });
  });
  it("moves the card when the status tag changes on Discord; the new tag replaces the old one", () => {
    const result = run({ discord: tags("s-backlog", "s-progress") });
    expect(result.github.project).toEqual({ status: "In Progress" });
    expect(result.discord.removeTags).toEqual(["s-backlog"]);
    expect(result.status).toBe("s-progress");
  });
  it("swaps the tag when the card moves on GitHub, and GitHub wins a conflict", () => {
    const moved = run({ github: github("In Progress") });
    expect(moved.discord).toMatchObject({
      addTags: ["s-progress"],
      removeTags: ["s-backlog"],
    });
    expect(moved.github.project).toBeUndefined();
    const conflict = run({
      github: github("In Progress"),
      discord: tags(),
    });
    expect(conflict.github.project).toBeUndefined();
    expect(conflict.discord.addTags).toEqual(["s-progress"]);
  });
  it("clears the Status when the tag is removed, and shows no tag for an unmapped option", () => {
    expect(run({ discord: tags() }).github.project).toEqual({ status: null });
    const done = run({ github: github("Done") });
    expect(done.status).toBeNull();
    expect(done.discord.removeTags).toEqual(["s-backlog"]);
    expect(done.github.project).toBeUndefined();
  });
  it("does not move the card between two tags for the same option", () => {
    const result = run({
      github: github("In Progress"),
      discord: tags("s-doing"),
      snap: snap("s-progress"),
    });
    expect(result.github.project).toBeUndefined();
    expect(result.status).toBe("s-doing");
    expect(result.discord).toMatchObject({ addTags: [], removeTags: [] });
  });
  it("hides status tags while closed and ignores Discord status changes then", () => {
    const closed = run({
      github: github("Backlog", { state: "closed", reason: "completed" }),
      discord: tags("c-fixed", "s-progress"),
      snap: snap("s-backlog", { closed: "c-fixed" }),
    });
    expect(closed.github.project).toBeUndefined();
    expect(closed.discord.removeTags).toEqual(["s-progress"]);
    expect(closed.status).toBe("s-backlog");
    // Closing from Discord also drops the status tag without touching the board.
    const closing = run({ discord: tags("s-backlog", "c-fixed") });
    expect(closing.github).toMatchObject({ state: "closed" });
    expect(closing.github.project).toBeUndefined();
    expect(closing.discord.removeTags).toEqual(["s-backlog"]);
    // Reopening shows the board's status again.
    const reopened = run({
      github: github("In Progress"),
      discord: tags(),
      snap: snap("s-backlog", { closed: "c-fixed" }),
    });
    expect(reopened.discord.addTags).toEqual(["s-progress"]);
    expect(reopened.github.project).toBeUndefined();
  });
  it("leaves status tags alone while the board is unknown", () => {
    const result = run({
      github: github(null, { status: undefined }),
      discord: tags("s-progress"),
    });
    expect(result.status).toBeUndefined();
    expect(result.github.project).toBeUndefined();
    expect(result.discord).toMatchObject({ addTags: [], removeTags: [] });
  });
  it("reverts status tags in user mode and lets GitHub win without a status snapshot", () => {
    for (const overrides of [
      { discordWrites: false },
      { snap: { title: "Train stuck", labels: ["bug"] } },
    ]) {
      const result = run({ discord: tags("s-progress"), ...overrides });
      expect(result.github.project).toBeUndefined();
      expect(result.discord).toMatchObject({
        addTags: ["s-backlog"],
        removeTags: ["s-progress"],
      });
    }
  });
  it("ranks the close tag, then the status tag, then labels for the five slots", () => {
    const result = run({
      github: github("Backlog", { labels: ["bug", "crash", "ui"] }),
      discord: {
        name: "#7 Train stuck",
        tags: ["u1", "u2", "t-bug", "t-crash", "t-ui"],
      },
      snap: snap(null, { labels: ["bug", "crash", "ui"] }),
    });
    expect(result.discord.addTags).toEqual(["s-backlog"]);
    expect(result.discord.removeTags).toEqual(["t-ui"]);
    expect(result.overflow).toEqual(["ui"]);
    expect(result.github.project).toBeUndefined();
  });
});
