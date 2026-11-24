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
 */

/** Discord allows at most five applied tags per forum post. */
export const MAX_TAGS = 5;

/** A forum tag that mirrors a repository label. */
export interface ManagedTag {
  id: string;
  name: string;
  label: string;
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
}

export interface MetadataInput {
  number: number;
  github: { title: string; labels: string[] };
  /** Thread name and applied tag ids. */
  discord: { name: string; tags: string[] };
  managed: ManagedTag[];
  snap?: Snapshot;
  /** False in user mode: Discord-side changes are reverted instead of sent to GitHub. */
  discordWrites: boolean;
}

export interface MetadataPlan {
  title: string;
  labels: string[];
  overflow: string[];
  github: { title?: string; addLabels: string[]; removeLabels: string[] };
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
  const { number, github, discord, managed, snap, discordWrites } = input;

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

  // Discord tags: unmanaged tags pass through and existing tags are never dropped for space.
  const applied = discord.tags.filter((t) => byTag.has(t));
  const removeTags = applied.filter((t) => !labels.includes(byTag.get(t)!));
  const kept = applied.filter((t) => !removeTags.includes(t));
  const unmanaged = discord.tags.length - applied.length;
  let free = Math.max(0, MAX_TAGS - unmanaged - kept.length);
  const addTags: string[] = [];
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
    github: {
      title: title !== github.title ? title : undefined,
      addLabels: labels.filter((l) => !g.includes(l)),
      removeLabels: g.filter((l) => !labels.includes(l)),
    },
    discord: {
      name: discord.name !== name ? name : undefined,
      addTags,
      removeTags,
    },
  };
}
