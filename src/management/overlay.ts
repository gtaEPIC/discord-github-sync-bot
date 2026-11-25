import express, { Request, Response } from "express";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ManagementStore, Mapping } from "./store";
import type { ProjectItem } from "../bridge/projects";
import type { Milestone, MilestoneIssue } from "../bridge/types";

/**
 * Read-only feed of one milestone's issues and their Projects Status, for a stream overlay
 * (an OBS browser source). It sits outside `/api` because the overlay has no session: it
 * sends a bearer key instead. Only the key's SHA-256 is stored, so the key is shown once.
 */
export const OVERLAY_KEY_HASH = "overlayKeyHash";
export const OVERLAY_KEY_CREATED = "overlayKeyCreated";

export type TaskState = "todo" | "in_progress" | "done";

export interface OverlaySource {
  milestones(): Promise<Milestone[]>;
  milestoneIssues(milestone: number): Promise<MilestoneIssue[]>;
  /** The Projects board, or undefined when the mapping has no Status sync. */
  projectBoard(): Promise<ReadonlyMap<number, ProjectItem> | undefined>;
}

export interface OverlayTask {
  number: number;
  title: string;
  url: string;
  state: TaskState;
  /** The Projects Status option, verbatim; null when the issue is not on the board. */
  status: string | null;
  /** GitHub's close reason, such as "completed" or "not_planned". */
  closedReason: string | null;
  labels: { name: string; color: string }[];
  assignees: string[];
}

export interface OverlayBoard {
  repository: string;
  milestone: Milestone;
  counts: { todo: number; inProgress: number; done: number; total: number };
  tasks: OverlayTask[];
  /** Set when Status could not be read; open issues then all count as to-do. */
  warning?: string;
  updatedAt: string;
}

const CACHE_MS = 30_000;
const CACHE_LIMIT = 50;
const normal = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const IN_PROGRESS = new Set([
  "inprogress",
  "doing",
  "started",
  "inreview",
  "review",
]);
const ORDER: Record<TaskState, number> = { in_progress: 0, todo: 1, done: 2 };

/** Closed issues are done. Open ones follow their Status: an "In Progress"-like option, or Done. */
export function taskState(
  issue: Pick<MilestoneIssue, "state">,
  status: string | null,
): TaskState {
  if (issue.state === "closed") return "done";
  const name = status ? normal(status) : "";
  if (name === "done") return "done";
  if (IN_PROGRESS.has(name)) return "in_progress";
  return "todo";
}

/** The open milestone due soonest (undated ones last), else none. */
export function currentMilestone(milestones: Milestone[]) {
  return milestones
    .filter((m) => m.state === "open")
    .sort(
      (a, b) =>
        (a.dueOn ? Date.parse(a.dueOn) : Infinity) -
          (b.dueOn ? Date.parse(b.dueOn) : Infinity) || a.number - b.number,
    )[0];
}

export async function buildBoard(
  repository: string,
  source: OverlaySource,
  selector: string | undefined,
): Promise<OverlayBoard> {
  const milestones = await source.milestones();
  const milestone = !selector
    ? currentMilestone(milestones)
    : /^\d+$/.test(selector)
      ? milestones.find((m) => m.number === Number(selector))
      : milestones.find((m) => normal(m.title) === normal(selector));
  if (!milestone)
    throw new OverlayError(
      selector
        ? `No milestone matches "${selector}".`
        : "There is no open milestone.",
      404,
    );
  const issues = await source.milestoneIssues(milestone.number);
  let board: ReadonlyMap<number, ProjectItem> | undefined;
  let warning: string | undefined;
  try {
    board = await source.projectBoard();
  } catch {
    warning =
      "Project Status is unavailable; open issues are shown as to-do. Check the Projects token.";
  }
  const tasks = issues
    .map((issue): OverlayTask & { closedAt: string | null } => {
      const status = board?.get(issue.number)?.status ?? null;
      return {
        number: issue.number,
        title: issue.title,
        url: issue.url,
        state: taskState(issue, status),
        status,
        closedReason: issue.state === "closed" ? issue.stateReason : null,
        labels: issue.labels,
        assignees: issue.assignees,
        closedAt: issue.closedAt,
      };
    })
    .sort(
      (a, b) =>
        ORDER[a.state] - ORDER[b.state] ||
        (a.state === "done"
          ? (b.closedAt ?? "").localeCompare(a.closedAt ?? "")
          : a.number - b.number),
    )
    .map(({ closedAt: _closedAt, ...task }) => task);
  const count = (state: TaskState) =>
    tasks.filter((t) => t.state === state).length;
  return {
    repository,
    milestone,
    counts: {
      todo: count("todo"),
      inProgress: count("in_progress"),
      done: count("done"),
      total: tasks.length,
    },
    tasks,
    ...(warning ? { warning } : {}),
    updatedAt: new Date().toISOString(),
  };
}

export class OverlayError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const digest = (key: string) =>
  createHash("sha256").update(key, "utf8").digest();

/** Make a new overlay key, replacing any old one. Returns the key; only its hash is kept. */
export function rotateOverlayKey(store: ManagementStore) {
  const key = `ovl_${randomBytes(24).toString("base64url")}`;
  store.set(OVERLAY_KEY_HASH, digest(key).toString("hex"));
  store.set(OVERLAY_KEY_CREATED, new Date().toISOString());
  return key;
}
export function revokeOverlayKey(store: ManagementStore) {
  store.set(OVERLAY_KEY_HASH, "");
  store.set(OVERLAY_KEY_CREATED, "");
}
export function overlayKeyInfo(store: ManagementStore) {
  return store.get(OVERLAY_KEY_HASH)
    ? { createdAt: store.get(OVERLAY_KEY_CREATED) || undefined }
    : undefined;
}
function validKey(store: ManagementStore, req: Request) {
  const stored = store.get(OVERLAY_KEY_HASH);
  const match = /^Bearer\s+(\S+)$/i.exec(req.get("authorization") ?? "");
  if (!stored || !match) return false;
  const expected = Buffer.from(stored, "hex");
  const given = digest(match[1]);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function createOverlayRouter(
  store: ManagementStore,
  source: (mapping: Mapping) => OverlaySource | undefined,
  now = () => Date.now(),
) {
  const router = express.Router();
  const cache = new Map<string, { at: number; board: Promise<OverlayBoard> }>();
  // An overlay is usually a local file in OBS (origin "null"), so allow any origin. The
  // key travels in a header, never a cookie, so this exposes nothing to other sites.
  router.use("/overlay", (req, res, next) => {
    res.set({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Max-Age": "600",
    });
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });
  const fail = (res: Response, status: number, error: string) =>
    res.status(status).json({ error });
  router.get("/overlay/milestone", (req, res) => {
    if (!validKey(store, req))
      return fail(res, 401, "Missing or invalid overlay key.");
    const repo = typeof req.query.repo === "string" ? req.query.repo : "";
    const selector =
      typeof req.query.milestone === "string" && req.query.milestone.trim()
        ? req.query.milestone.trim().slice(0, 200)
        : undefined;
    const enabled = store.mappings().filter((m) => m.enabled);
    const candidates = repo
      ? enabled.filter(
          (m) =>
            `${m.owner}/${m.repo}`.toLowerCase() === repo.trim().toLowerCase(),
        )
      : enabled;
    if (candidates.length !== 1)
      return fail(
        res,
        candidates.length ? 400 : 404,
        candidates.length
          ? "Several repositories are mapped: add ?repo=owner/name."
          : "That repository is not mapped.",
      );
    const mapping = candidates[0];
    const api = source(mapping);
    if (!api) return fail(res, 503, "The mapping is still starting.");
    const key = `${mapping.id}\n${selector ? normal(selector) : ""}`;
    let entry = cache.get(key);
    if (!entry || now() - entry.at > CACHE_MS) {
      if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
      const board = buildBoard(
        `${mapping.owner}/${mapping.repo}`,
        api,
        selector,
      );
      entry = { at: now(), board };
      cache.set(key, entry);
      // A failure is not cached, so the next poll tries again.
      board.catch(() => {
        if (cache.get(key)?.board === board) cache.delete(key);
      });
    }
    entry.board.then(
      (board) => res.json(board),
      (error) =>
        error instanceof OverlayError
          ? fail(res, error.status, error.message)
          : fail(res, 502, "GitHub could not be read. Try again shortly."),
    );
  });
  return router;
}
