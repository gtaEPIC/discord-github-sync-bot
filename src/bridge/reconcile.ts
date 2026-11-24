/**
 * Pure three-way reconcile of issue metadata (title, managed labels) between GitHub and a
 * Discord forum thread. No I/O: the engine reads both sides fresh, calls `planMetadata`,
 * writes the result and stores the returned snapshot. Because both sides are read at run
 * time, the order of queued tasks cannot lose an update.
 *
 * Per field, with g = GitHub, d = Discord, s = last agreed snapshot:
 * - g == s and d == s: nothing to do.
 * - only GitHub changed: write Discord.
 * - only Discord changed: write GitHub (only when Discord may write, i.e. bridge mode).
 * - both changed: GitHub wins.
 * A missing snapshot means GitHub wins once (upstream behaviour).
 *
 * Open/closed is one more field, compared in close-tag space: GitHub's state and reason map
 * to a close tag (or none), so a fallback tag never rewrites GitHub's `state_reason`.
 *
 * Projects Status is compared in status-tag space the same way. Status tags show only while
 * the issue is open; while it is closed, status changes are ignored on both sides (the close
 * tag stands in for "Done"). Slots go to the close tag, then the status tag, then labels.
 */
import type { CloseReason } from "./config";

/** Discord allows at most five applied tags per forum post. */
export const MAX_TAGS = 5;

/** A forum tag that mirrors a repository label. */
export interface ManagedTag {
  id: string;
  name: string;
  label: string;
}

/** A forum tag that closes the issue with a reason. */
export interface CloseTag {
  id: string;
  name: string;
  reason: CloseReason;
}

/** A forum tag that stands for a Projects Status option. */
export interface StatusTag {
  id: string;
  name: string;
  option: string;
}

/** Last state both sides agreed on, stored on the link. */
export interface Snapshot {
  /** Agreed GitHub title. Absent when a deferred rename has not been confirmed yet. */
  title?: string;
  /** Agreed managed labels (GitHub names). */
  labels: string[];
  /** Agreed labels that could not be shown on Discord because the post had no free tag slot. */
  overflow?: string[];
  /** GitHub state at the last reconcile, to tell a reopen from an inactivity archive. */
  state?: "open" | "closed";
  /**
   * Agreed close tag id, or null when open. Absent when close tags are not configured or the
   * link predates them: then GitHub wins once.
   */
  closed?: string | null;
  /** The agreed close tag could not be shown (no free tag slot); its absence is not a reopen. */
  closedHidden?: boolean;
  /** Agreed status tag id, or null. Absent when Status sync is off or has not run yet. */
  status?: string | null;
  /** The agreed status tag could not be shown (no free tag slot). */
  statusHidden?: boolean;
}

export interface MetadataInput {
  number: number;
  github: {
    title: string;
    labels: string[];
    state?: "open" | "closed";
    reason?: string | null;
    /** Projects Status option name, null when unset or off the board, undefined when unknown. */
    status?: string | null;
  };
  /** Thread name and applied tag ids. */
  discord: { name: string; tags: string[] };
  managed: ManagedTag[];
  closeTags?: CloseTag[];
  statusTags?: StatusTag[];
  snap?: Snapshot;
  /** False in user mode: Discord-side changes are reverted instead of sent to GitHub. */
  discordWrites: boolean;
}

export interface MetadataPlan {
  title: string;
  labels: string[];
  overflow: string[];
  /** Agreed close tag id, null when open, undefined when close tags are not in use. */
  closed?: string | null;
  closedHidden?: boolean;
  /** Agreed status tag id or null; undefined when Status sync did not run. */
  status?: string | null;
  statusHidden?: boolean;
  github: {
    title?: string;
    addLabels: string[];
    removeLabels: string[];
    state?: "open" | "closed";
    reason?: CloseReason;
    /** Set the Projects Status to this option (null clears it). */
    project?: { status: string | null };
  };
  discord: { name?: string; addTags: string[]; removeTags: string[] };
}

export const threadName = (number: number, title: string) =>
  `#${number} ${title}`.slice(0, 100);

/** Remove only this issue's own `#N ` prefix; other leading text is part of the title. */
export function stripTitle(number: number, name: string) {
  const prefix = `#${number} `;
  return (name.startsWith(prefix) ? name.slice(prefix.length) : name).trim();
}

/**
 * Pair forum tags with existing repository labels: an explicit `tag name -> label name`
 * entry first, otherwise a case-insensitive name match. Tags without a label are unmanaged
 * and never touched; a label is paired with at most one tag.
 */
export function managedTags(
  available: { id: string; name: string }[],
  repoLabels: string[],
  explicit: Record<string, string> = {},
): ManagedTag[] {
  const labels = new Map(repoLabels.map((l) => [l.toLowerCase(), l]));
  const wanted = new Map(
    Object.entries(explicit).map(([tag, label]) => [tag.toLowerCase(), label]),
  );
  const used = new Set<string>();
  const result: ManagedTag[] = [];
  for (const tag of available) {
    const label = labels.get(
      (wanted.get(tag.name.toLowerCase()) ?? tag.name).toLowerCase(),
    );
    if (!label || used.has(label)) continue;
    used.add(label);
    result.push({ id: tag.id, name: tag.name, label });
  }
  return result;
}

export function planMetadata(input: MetadataInput): MetadataPlan {
  const { number, github, discord, snap, discordWrites } = input;
  const closeTags = input.closeTags ?? [];
  const statusTags = (input.statusTags ?? []).filter(
    (t) => !closeTags.some((c) => c.id === t.id),
  );
  // A tag is a close tag, a status tag or a label tag, never two of them.
  const managed = input.managed.filter(
    (m) =>
      !closeTags.some((c) => c.id === m.id) &&
      !statusTags.some((c) => c.id === m.id),
  );

  // Title.
  let title = github.title;
  if (discordWrites && snap?.title !== undefined) {
    const githubChanged = github.title !== snap.title;
    const discordChanged = discord.name !== threadName(number, snap.title);
    const stripped = stripTitle(number, discord.name);
    if (!githubChanged && discordChanged && stripped) title = stripped;
  }

  // Managed labels.
  const byTag = new Map(managed.map((m) => [m.id, m.label]));
  const byLabel = new Map(managed.map((m) => [m.label, m.id]));
  const g = github.labels.filter((l) => byLabel.has(l));
  const d = discord.tags.filter((t) => byTag.has(t)).map((t) => byTag.get(t)!);
  const s = snap?.labels.filter((l) => byLabel.has(l)) ?? d;
  const overflow = new Set(snap?.overflow ?? []);
  const labels: string[] = [];
  for (const label of new Set([...g, ...s, ...d])) {
    const inG = g.includes(label),
      inS = s.includes(label);
    // A label that never fit on Discord was not removed there.
    const inD = d.includes(label) || (inS && overflow.has(label));
    const keep = inG !== inS || !discordWrites ? inG : inD !== inS ? inD : inS;
    if (keep) labels.push(label);
  }

  // Open/closed, in close-tag space; then Status, in status-tag space.
  const close = closeField(input, closeTags);
  const closeIds = new Set(closeTags.map((t) => t.id));
  const closedFinal = (close.github.state ?? github.state) === "closed";
  const status = statusField(input, statusTags, closedFinal);
  // While Status is unknown (sync off or unreachable), status tags pass through untouched.
  const statusIds = new Set(status ? statusTags.map((t) => t.id) : []);

  // Discord tags: unmanaged tags pass through and existing tags are never dropped for space,
  // except that the close tag and then the status tag outrank label tags (those labels stay
  // on GitHub as overflow).
  const applied = discord.tags.filter((t) => byTag.has(t));
  const removeTags = applied.filter((t) => !labels.includes(byTag.get(t)!));
  const kept = applied.filter((t) => !removeTags.includes(t));
  const unmanaged = discord.tags.filter(
    (t) => !byTag.has(t) && !closeIds.has(t) && !statusIds.has(t),
  ).length;
  const closeApplied = discord.tags.filter((t) => closeIds.has(t));
  const statusApplied = discord.tags.filter((t) => statusIds.has(t));
  const shownStatus = status?.show ?? null;
  removeTags.push(...closeApplied.filter((t) => t !== close.closed));
  removeTags.push(...statusApplied.filter((t) => t !== shownStatus));
  const addTags: string[] = [];
  let free = Math.max(
    0,
    MAX_TAGS -
      unmanaged -
      kept.length -
      (close.closed && closeApplied.includes(close.closed) ? 1 : 0) -
      (shownStatus && statusApplied.includes(shownStatus) ? 1 : 0),
  );
  /** Give `tag` a slot, displacing a label tag if needed. False when it cannot be shown. */
  const claim = (tag: string) => {
    if (!free && kept.length) {
      removeTags.push(kept.pop()!);
      free++;
    }
    if (!free) return false;
    addTags.push(tag);
    free--;
    return true;
  };
  const closedHidden = Boolean(
    close.closed &&
    !closeApplied.includes(close.closed) &&
    !claim(close.closed),
  );
  // A status tag is hidden while closed, or when it has no slot: either way its absence on
  // Discord is not a removal.
  const statusHidden = Boolean(
    status?.status &&
    (closedFinal ||
      (!statusApplied.includes(shownStatus!) && !claim(shownStatus!))),
  );
  const missed: string[] = [];
  for (const label of labels) {
    const tag = byLabel.get(label)!;
    if (kept.includes(tag)) continue;
    if (free > 0) {
      addTags.push(tag);
      free--;
    } else missed.push(label);
  }

  const name = threadName(number, title);
  return {
    title,
    labels,
    overflow: missed,
    closed: closeTags.length ? close.closed : undefined,
    closedHidden: closedHidden || undefined,
    status: status?.status,
    statusHidden: statusHidden || undefined,
    github: {
      title: title !== github.title ? title : undefined,
      addLabels: labels.filter((l) => !g.includes(l)),
      removeLabels: g.filter((l) => !labels.includes(l)),
      ...close.github,
      ...(status?.write && { project: status.write }),
    },
    discord: {
      name: discord.name !== name ? name : undefined,
      addTags,
      removeTags,
    },
  };
}

/**
 * GitHub's state and reason as a close tag: a tag with the same reason (preferring the one
 * already agreed or applied), else the first close tag as a fallback, so an unmapped reason
 * is never read as a reopen or rewritten.
 */
function githubCloseTag(
  state: "open" | "closed" | undefined,
  reason: string | null | undefined,
  closeTags: CloseTag[],
  prefer: (string | null | undefined)[],
): string | null {
  if (state !== "closed" || !closeTags.length) return null;
  const matching = closeTags.filter((t) => t.reason === reason);
  const candidates = matching.length ? matching : closeTags;
  for (const id of prefer)
    if (id && candidates.some((t) => t.id === id)) return id;
  return candidates[0].id;
}

function closeField(input: MetadataInput, closeTags: CloseTag[]) {
  const { github, discord, snap, discordWrites } = input;
  if (!closeTags.length) return { closed: null as string | null, github: {} };
  const s = snap?.closed;
  const applied = discord.tags.filter((t) => closeTags.some((c) => c.id === t));
  // A newly added close tag beats one that was already there.
  let d: string | null = applied.find((t) => t !== s) ?? applied[0] ?? null;
  if (d === null && s && snap?.closedHidden) d = s;
  const g = githubCloseTag(github.state, github.reason, closeTags, [s, d]);
  const closed = discordWrites && s !== undefined && g === s && d !== s ? d : g;
  const change: { state?: "open" | "closed"; reason?: CloseReason } = {};
  if (closed !== g) {
    if (closed === null) change.state = "open";
    else {
      const reason = closeTags.find((t) => t.id === closed)!.reason;
      if (github.state !== "closed" || github.reason !== reason) {
        change.state = "closed";
        change.reason = reason;
      }
    }
  }
  return { closed, github: change };
}

/** A Status option as a status tag (preferring the agreed or applied one); null when unmapped. */
export function githubStatusTag(
  status: string | null | undefined,
  statusTags: StatusTag[],
  prefer: (string | null | undefined)[] = [],
): string | null {
  if (!status) return null;
  const candidates = statusTags.filter(
    (t) => t.option.toLowerCase() === status.toLowerCase(),
  );
  for (const id of prefer)
    if (id && candidates.some((t) => t.id === id)) return id;
  return candidates[0]?.id ?? null;
}

function statusField(
  input: MetadataInput,
  statusTags: StatusTag[],
  closed: boolean,
) {
  const { github, discord, snap, discordWrites } = input;
  if (!statusTags.length || github.status === undefined) return undefined;
  const s = snap?.status;
  const applied = discord.tags.filter((t) =>
    statusTags.some((c) => c.id === t),
  );
  // Status tags are mutually exclusive: a newly added one beats the one already there.
  let d: string | null = applied.find((t) => t !== s) ?? applied[0] ?? null;
  if (d === null && s && snap?.statusHidden) d = s;
  const g = githubStatusTag(github.status, statusTags, [s, d]);
  // While closed, only GitHub's value is tracked; Discord shows no status tag.
  const status =
    !closed && discordWrites && s !== undefined && g === s && d !== s ? d : g;
  let write: { status: string | null } | undefined;
  if (status !== g) {
    const option =
      status === null ? null : statusTags.find((t) => t.id === status)!.option;
    if (option?.toLowerCase() !== github.status?.toLowerCase())
      write = { status: option };
  }
  return { status, show: closed ? null : status, write };
}
