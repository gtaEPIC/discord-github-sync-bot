import { describe, expect, it } from "vitest";
import {
  ManagedTag,
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
