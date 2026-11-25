import { Relay, Writer } from "./authorship";
import { CloseTag, ManagedTag, Snapshot, StatusTag } from "./reconcile";
import { ProjectItem } from "./projects";
import { CloseReason } from "./config";
export interface Issue {
  number: number;
  title: string;
  body: string;
  url: string;
  author: string;
  state: "open" | "closed";
  /** GitHub `state_reason`: completed, not_planned, duplicate, reopened or null. */
  stateReason?: string | null;
  labels: string[];
  locked: boolean;
  createdAt: string;
  closedAt?: string | null;
  own?: boolean;
  authorId?: string;
  writer?: Writer;
  relay?: Relay;
}
export interface Comment {
  id: string;
  body: string;
  url: string;
  author: string;
  own: boolean;
  authorId?: string;
  relay?: Relay;
}
export interface Post {
  id: string;
  title: string;
  starter: Message;
  tags: string[];
  createdAt: string;
  archived?: boolean;
}
export interface Message {
  id: string;
  thread: string;
  body: string;
  url: string;
  author: string;
  bot: boolean;
  own?: boolean;
  authorId?: string;
  createdAt?: string;
}
export interface Link {
  issue: number;
  thread: string;
  origin: "github" | "discord";
  starter: string;
  disabled?: boolean;
  writer?: Writer;
  /** Last agreed metadata (title, managed labels, state); see reconcile.ts. */
  snap?: Snapshot;
}
/** A forum thread's metadata, read without fetching messages. */
export interface ThreadMeta {
  name: string;
  /** Applied tag ids. */
  tags: string[];
  archived: boolean;
  locked: boolean;
}
export interface MetaChange {
  name?: string;
  addTags?: string[];
  removeTags?: string[];
  locked?: boolean;
}
export interface IssueChange {
  title?: string;
  addLabels?: string[];
  removeLabels?: string[];
  state?: "open" | "closed";
  reason?: CloseReason;
}
/** A reference to an issue from elsewhere on GitHub, shown in its thread. */
export interface TimelineEvent {
  /** Stable per issue: the event id, or `xref:<source issue id>` (cross-references have no id). */
  key: string;
  kind: "commit" | "closed" | "crossref";
  actor?: string;
  createdAt: string;
  url: string;
  /** `abc1234`, `owner/repo@abc1234`, `#12` or `owner/repo#12`. */
  label: string;
  /** Issue or pull request title (cross-references). */
  title?: string;
  pullRequest?: boolean;
}
export interface Mirror {
  key: string;
  issue: number;
  origin: "github" | "discord";
  source: string;
  ids: string[];
  hash: string;
  writer?: Writer;
}
export type Task =
  | { type: "github"; issue: number }
  | { type: "discord"; thread: string }
  | { type: "state"; issue: number; state: "open" | "closed"; actor?: string }
  | { type: "scan" }
  | { type: "project" }
  | { type: "unlink"; thread: string };
export interface Platforms {
  getIssue(number: number): Promise<Issue>;
  issues(since?: string): Promise<Issue[]>;
  createIssue(post: Post, marker: string): Promise<Issue>;
  editIssue(
    number: number,
    body: string,
    writer?: Writer,
    source?: Message,
  ): Promise<void>;
  state(
    number: number,
    state: "open" | "closed",
    actor?: string,
  ): Promise<void>;
  comments(number: number): Promise<Comment[]>;
  createComment(
    number: number,
    body: string,
    source?: Message,
  ): Promise<string | { id: string; writer: Writer }>;
  editComment(
    id: string,
    body: string,
    writer?: Writer,
    source?: Message,
  ): Promise<void>;
  notifyBlocked?(source: Message, message: string): Promise<void>;
  posts(): Promise<Post[]>;
  getPost(thread: string): Promise<Post>;
  createPost(issue: Issue): Promise<Post>;
  /** Forum tags paired with repository labels. */
  managedTags(): Promise<ManagedTag[]>;
  /** Configured close tags that exist in the forum. */
  closeTags(): Promise<CloseTag[]>;
  /** Configured status tags that exist in the forum; empty when Status sync is off. */
  statusTags(): Promise<StatusTag[]>;
  /**
   * The issue's Projects item: cached from the last board read unless `fresh`. Null when the
   * issue is not on the board; undefined when Status sync is off.
   */
  projectStatus(
    number: number,
    fresh?: boolean,
  ): Promise<ProjectItem | null | undefined>;
  /** Read the whole board; undefined when Status sync is off. */
  projectItems(): Promise<Map<number, ProjectItem> | undefined>;
  /** Set or clear an issue's Status, adding it to the board first when needed. */
  setProjectStatus(number: number, status: string | null): Promise<void>;
  /** Status for open issues that are not on the board yet; undefined = do not add them. */
  defaultStatus(): string | undefined;
  /**
   * References to the issue (commits, issues, pull requests). Undefined when unchanged since
   * `etag`; the returned etag is only set when it covers the whole timeline.
   */
  timeline(
    number: number,
    etag?: string,
  ): Promise<{ events: TimelineEvent[]; etag?: string } | undefined>;
  threadMeta(thread: string): Promise<ThreadMeta>;
  /**
   * Apply only the given changes, as a delta against the thread's current tags.
   * Returns tag ids that did not fit and whether a rename had to wait for Discord's rename limit.
   */
  applyMeta(
    thread: string,
    change: MetaChange,
  ): Promise<{ overflow: string[]; renameDeferred: boolean }>;
  /** Archive a closed issue's thread; unarchive only on a reopen. Never changes GitHub. */
  applyArchive(
    thread: string,
    closed: boolean,
    reopened: boolean,
  ): Promise<void>;
  /** Discord-originated title/label/state change, written by the GitHub App (bridge mode only). */
  updateIssue(number: number, change: IssueChange): Promise<void>;
  messages(thread: string): Promise<Message[]>;
  send(thread: string, body: string, nonce: string): Promise<string>;
  edit(thread: string, id: string, body: string): Promise<void>;
}
