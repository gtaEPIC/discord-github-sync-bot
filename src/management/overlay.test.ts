import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ManagementStore, Mapping } from "./store";
import { createManagementServer, Control } from "./server";
import {
  OverlaySource,
  buildBoard,
  currentMilestone,
  rotateOverlayKey,
  taskState,
} from "./overlay";
import type { Milestone, MilestoneIssue } from "../bridge/types";

const stores: { store: ManagementStore; directory: string }[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) {
    s.store.close();
    rmSync(s.directory, { recursive: true, force: true });
  }
});

const milestone = (
  number: number,
  title: string,
  dueOn: string | null,
  state: "open" | "closed" = "open",
): Milestone => ({
  number,
  title,
  dueOn,
  state,
  url: `https://github.com/org/one/milestone/${number}`,
});
const issue = (
  number: number,
  state: "open" | "closed" = "open",
  extra: Partial<MilestoneIssue> = {},
): MilestoneIssue => ({
  number,
  title: `Issue ${number}`,
  url: `https://github.com/org/one/issues/${number}`,
  state,
  stateReason: state === "closed" ? "completed" : null,
  labels: [],
  assignees: [],
  closedAt: null,
  ...extra,
});
const mapping = (id: string, repo: string, enabled = true): Mapping => ({
  id,
  owner: "org",
  repo,
  channel: `1234${id.length}${id.charCodeAt(id.length - 1)}`,
  backfill: false,
  enabled,
  roles: [],
});

function fakeSource(
  /** Issue number and Status, in board order (top first). */
  board: [number, string | null][] | undefined | Error = [],
): OverlaySource & { calls: () => number } {
  const milestoneIssues = vi.fn(async (n: number) =>
    n === 2
      ? [
          issue(1, "closed", { closedAt: "2026-11-01T00:00:00Z" }),
          issue(2),
          issue(3),
          issue(4, "closed", {
            stateReason: "not_planned",
            closedAt: "2026-11-20T00:00:00Z",
          }),
          issue(5),
        ]
      : [],
  );
  return {
    milestones: async () => [
      milestone(1, "Backlog", null),
      milestone(2, "v1.2 Signals", "2026-12-01T00:00:00Z"),
      milestone(3, "v1.3", "2027-02-01T00:00:00Z"),
      milestone(4, "v1.1", "2026-10-01T00:00:00Z", "closed"),
    ],
    milestoneIssues,
    projectBoard: async () => {
      if (board instanceof Error) throw board;
      if (!board) return undefined;
      return new Map(
        board.map(([n, status], position) => [
          n,
          { id: `item-${n}`, status, position },
        ]),
      );
    },
    calls: () => milestoneIssues.mock.calls.length,
  };
}

function setup(source?: OverlaySource) {
  const directory = mkdtempSync(path.join(tmpdir(), "overlay-"));
  const store = new ManagementStore(directory);
  stores.push({ store, directory });
  const control: Control = {
    status: () => ({
      discord: { configured: false, connected: false },
      mappings: [],
    }),
    channels: vi.fn(async () => []),
    reload: vi.fn(async () => {}),
    worker: vi.fn(() =>
      source ? ({ api: source } as ReturnType<Control["worker"]>) : undefined,
    ),
    userGuilds: vi.fn(async () => []),
    userChannels: vi.fn(async () => []),
    authorizeForum: vi.fn(),
    resumeHeld: vi.fn(),
  };
  const app = createManagementServer(
    store,
    control,
    { bootstrap: false, publicUrl: "https://gitissues.example.com" },
    { validateDiscord: vi.fn(async () => "Bot") },
  );
  const get = (query = "", key?: string) => {
    const r = request(app)
      .get(`/overlay/milestone${query}`)
      .set("Host", "gitissues.example.com");
    return key ? r.set("Authorization", `Bearer ${key}`) : r;
  };
  return { store, app, get };
}

describe("overlay task states", () => {
  it("maps closed issues to done and open issues by their Status", () => {
    expect(taskState({ state: "closed" }, "In Progress")).toBe("done");
    expect(taskState({ state: "open" }, "In Progress")).toBe("in_progress");
    expect(taskState({ state: "open" }, "in-review")).toBe("in_progress");
    expect(taskState({ state: "open" }, "Done")).toBe("done");
    expect(taskState({ state: "open" }, "Todo")).toBe("todo");
    expect(taskState({ state: "open" }, null)).toBe("todo");
  });

  it("picks the open milestone due soonest, undated ones last", () => {
    expect(
      currentMilestone([
        milestone(1, "Backlog", null),
        milestone(3, "Later", "2027-01-01T00:00:00Z"),
        milestone(2, "Soon", "2026-12-01T00:00:00Z"),
        milestone(4, "Past", "2026-01-01T00:00:00Z", "closed"),
      ])?.number,
    ).toBe(2);
    expect(currentMilestone([milestone(5, "Backlog", null)])?.number).toBe(5);
    expect(currentMilestone([])).toBeUndefined();
  });

  it("groups by state, then follows the board's order", async () => {
    const board = await buildBoard(
      "org/one",
      fakeSource([
        [5, "Todo"],
        [1, "Done"],
        [3, "In Progress"],
        [2, null],
      ]),
      undefined,
    );
    expect(board.milestone.title).toBe("v1.2 Signals");
    // 4 is not on the board (done items are often archived), so it follows the board's.
    expect(board.tasks.map((t) => [t.number, t.state])).toEqual([
      [3, "in_progress"],
      [5, "todo"],
      [2, "todo"],
      [1, "done"],
      [4, "done"],
    ]);
    expect(board.tasks.find((t) => t.number === 4)?.closedReason).toBe(
      "not_planned",
    );
    expect(board.tasks.find((t) => t.number === 2)?.status).toBeNull();
    expect(board.tasks[0]).not.toHaveProperty("position");
    expect(board.counts).toEqual({ todo: 2, inProgress: 1, done: 2, total: 5 });
    expect(board.warning).toBeUndefined();
  });

  it("orders issues off the board by number, and done ones latest closed first", async () => {
    const board = await buildBoard("org/one", fakeSource(undefined), "2");
    expect(board.tasks.map((t) => t.number)).toEqual([2, 3, 5, 4, 1]);
  });

  it("selects a milestone by number or title and refuses unknown ones", async () => {
    const source = fakeSource();
    expect((await buildBoard("org/one", source, "3")).milestone.number).toBe(3);
    expect(
      (await buildBoard("org/one", source, "V1.2 signals")).milestone.number,
    ).toBe(2);
    await expect(buildBoard("org/one", source, "nope")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("still answers when Status cannot be read", async () => {
    const board = await buildBoard(
      "org/one",
      fakeSource(new Error("token rejected")),
      "2",
    );
    expect(board.warning).toMatch(/Projects token/);
    expect(board.counts.inProgress).toBe(0);
    expect(JSON.stringify(board)).not.toMatch(/token rejected/);
  });
});

describe("overlay endpoint", () => {
  it("needs the current key, and a new key replaces the old one", async () => {
    const { store, get } = setup(fakeSource());
    store.saveMapping(mapping("m1", "one"));
    expect((await get()).status).toBe(401);
    expect((await get("", "ovl_guess")).status).toBe(401);
    const first = rotateOverlayKey(store);
    expect((await get("", first)).status).toBe(200);
    const second = rotateOverlayKey(store);
    expect((await get("", first)).status).toBe(401);
    expect((await get("", second)).status).toBe(200);
    expect(store.get("overlayKeyHash")).not.toContain(second);
  });

  it("answers CORS preflights from a local OBS file without a key", async () => {
    const { app } = setup();
    const res = await request(app)
      .options("/overlay/milestone")
      .set("Host", "gitissues.example.com")
      .set("Origin", "null")
      .set("Access-Control-Request-Headers", "authorization");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-headers"]).toMatch(
      /authorization/i,
    );
  });

  it("chooses the repository, and asks for ?repo= when several are mapped", async () => {
    const { store, get } = setup(fakeSource([[2, "In Progress"]]));
    const key = rotateOverlayKey(store);
    store.saveMapping(mapping("m1", "one"));
    store.saveMapping(mapping("m3", "paused", false));
    const one = await get("?milestone=2", key);
    expect(one.status).toBe(200);
    expect(one.headers["access-control-allow-origin"]).toBe("*");
    expect(one.body.repository).toBe("org/one");
    expect(one.body.counts.inProgress).toBe(1);
    store.saveMapping(mapping("m2", "two"));
    expect((await get("", key)).status).toBe(400);
    expect((await get("?repo=ORG/two", key)).body.repository).toBe("org/two");
    expect((await get("?repo=org/paused", key)).status).toBe(404);
  });

  it("caches each milestone for 30 seconds so polling overlays stay cheap", async () => {
    const source = fakeSource();
    const { store, get } = setup(source);
    store.saveMapping(mapping("m1", "one"));
    const key = rotateOverlayKey(store);
    await get("", key);
    await get("", key);
    await get("?milestone=2", key);
    expect(source.calls()).toBe(2);
  });

  it("lets only a signed-in admin generate or revoke the key, shown once", async () => {
    const { store, app, get } = setup(fakeSource());
    store.saveMapping(mapping("m1", "one"));
    const headers = {
      Host: "gitissues.example.com",
      Origin: "https://gitissues.example.com",
    };
    expect(
      (await request(app).post("/api/overlay-key").set(headers).send({}))
        .status,
    ).toBe(401);
    store.createAdmin("a private test admin password");
    const cookie = `bridge_session=${store.session()}`;
    const made = await request(app)
      .post("/api/overlay-key")
      .set(headers)
      .set("Cookie", cookie)
      .send({});
    expect(made.body.key).toMatch(/^ovl_/);
    const state = await request(app)
      .get("/api/state")
      .set(headers)
      .set("Cookie", cookie);
    expect(state.body.overlay.configured).toBe(true);
    expect(state.body.overlay.url).toBe(
      "https://gitissues.example.com/overlay/milestone",
    );
    expect(JSON.stringify(state.body)).not.toContain(made.body.key);
    expect((await get("", made.body.key)).status).toBe(200);
    await request(app)
      .post("/api/overlay-key/revoke")
      .set(headers)
      .set("Cookie", cookie)
      .send({});
    expect((await get("", made.body.key)).status).toBe(401);
  });
});
