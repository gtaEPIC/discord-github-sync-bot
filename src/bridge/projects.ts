import { WriteBlocked } from "./authorship";

/**
 * Minimal Projects v2 client for one user-owned project and one repository. User-level
 * projects have no webhook and no GitHub App access, so this uses a classic PAT (the
 * "Projects token") and polls. Only Projects calls ever see that token.
 */
export interface ProjectsOptions {
  token: () => string | undefined;
  owner: string;
  number: number;
  field: string;
  repo: { owner: string; repo: string };
  /** Status for open issues that are not on the board yet; absent = never add. */
  defaultOption?: string;
  /** How long a full read of the board stays valid, in milliseconds. */
  ttl: number;
  fetch?: typeof fetch;
}

export interface ProjectItem {
  id: string;
  status: string | null;
}

interface Project {
  id: string;
  field: string;
  options: { id: string; name: string }[];
}

/** A Projects request that will not work until someone fixes access or configuration. */
const refused = (message: string) =>
  new WriteBlocked(undefined, "permission", message);

export class ProjectsClient {
  private project?: Project;
  private items?: { map: Map<number, ProjectItem>; at: number };
  constructor(readonly options: ProjectsOptions) {}

  private async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const token = this.options.token();
    if (!token)
      throw refused(
        "Projects status sync needs a Projects token (Admin -> Connections).",
      );
    const response = await (this.options.fetch ?? fetch)(
      "https://api.github.com/graphql",
      {
        method: "POST",
        headers: {
          authorization: `bearer ${token}`,
          "content-type": "application/json",
          "user-agent": "ry-issue-bridge",
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const body = (await response.json().catch(() => ({}))) as {
      data?: T;
      errors?: { type?: string; message: string }[];
      message?: string;
    };
    const limited =
      response.headers.get("retry-after") ||
      response.headers.get("x-ratelimit-remaining") === "0" ||
      body.errors?.some((e) => e.type === "RATE_LIMITED");
    if (limited || response.status >= 500)
      // Transient: let the queue back off and retry.
      throw Object.assign(
        new Error(`GitHub Projects API unavailable (HTTP ${response.status})`),
        {
          status: response.status,
          response: { headers: Object.fromEntries(response.headers) },
        },
      );
    if (response.status === 401)
      throw refused("The Projects token was rejected. Save a new one.");
    if (!response.ok || body.errors?.length || !body.data)
      throw refused(
        `GitHub Projects request failed: ${body.errors?.map((e) => e.message).join("; ") ?? body.message ?? `HTTP ${response.status}`}`,
      );
    return body.data;
  }

  private async resolve(force = false): Promise<Project> {
    if (this.project && !force) return this.project;
    const data = await this.graphql<{
      user: {
        projectV2: {
          id: string;
          field: {
            id: string;
            options: { id: string; name: string }[];
          } | null;
        } | null;
      } | null;
    }>(
      `query($owner: String!, $number: Int!, $field: String!) {
        user(login: $owner) { projectV2(number: $number) { id
          field(name: $field) { ... on ProjectV2SingleSelectField { id options { id name } } } } } }`,
      {
        owner: this.options.owner,
        number: this.options.number,
        field: this.options.field,
      },
    );
    const project = data.user?.projectV2;
    if (!project)
      throw refused(
        `Project ${this.options.owner}#${this.options.number} was not found or the Projects token cannot see it.`,
      );
    if (!project.field?.id)
      throw refused(
        `The project has no single-select field named "${this.options.field}".`,
      );
    this.project = {
      id: project.id,
      field: project.field.id,
      options: project.field.options,
    };
    return this.project;
  }

  private matches(repository: string | undefined) {
    const { owner, repo } = this.options.repo;
    return repository?.toLowerCase() === `${owner}/${repo}`.toLowerCase();
  }

  /** Read every item on the board (items order only by position, so this is a full scan). */
  async scan(): Promise<Map<number, ProjectItem>> {
    const project = await this.resolve();
    const map = new Map<number, ProjectItem>();
    let cursor: string | null = null;
    do {
      const data: {
        node: {
          items: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: {
              id: string;
              content: {
                number?: number;
                repository?: { nameWithOwner: string };
              } | null;
              fieldValueByName: { name?: string } | null;
            }[];
          };
        } | null;
      } = await this.graphql(
        `query($id: ID!, $field: String!, $cursor: String) { node(id: $id) { ... on ProjectV2 {
          items(first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { id
              content { ... on Issue { number repository { nameWithOwner } } }
              fieldValueByName(name: $field) { ... on ProjectV2ItemFieldSingleSelectValue { name } } } } } } }`,
        { id: project.id, field: this.options.field, cursor },
      );
      if (!data.node) {
        this.project = undefined;
        throw refused("The project disappeared; it will be looked up again.");
      }
      for (const item of data.node.items.nodes)
        if (
          item.content?.number !== undefined &&
          this.matches(item.content.repository?.nameWithOwner)
        )
          map.set(item.content.number, {
            id: item.id,
            status: item.fieldValueByName?.name ?? null,
          });
      cursor = data.node.items.pageInfo.hasNextPage
        ? data.node.items.pageInfo.endCursor
        : null;
    } while (cursor);
    this.items = { map, at: Date.now() };
    return map;
  }

  /** The whole board, from the last scan while it is younger than the TTL. Do not mutate. */
  async board(): Promise<ReadonlyMap<number, ProjectItem>> {
    if (!this.items || Date.now() - this.items.at > this.options.ttl)
      return this.scan();
    return this.items.map;
  }

  /** One issue's item. Cached from the last scan unless `fresh`; null when it is not on the board. */
  async item(number: number, fresh = false): Promise<ProjectItem | null> {
    if (!fresh) return (await this.board()).get(number) ?? null;
    const { item } = await this.issue(number);
    return item;
  }

  private async issue(number: number) {
    const project = await this.resolve();
    const { owner, repo } = this.options.repo;
    const data = await this.graphql<{
      repository: {
        issue: {
          id: string;
          projectItems: {
            nodes: {
              id: string;
              project: { id: string };
              fieldValueByName: { name?: string } | null;
            }[];
          };
        } | null;
      } | null;
    }>(
      `query($owner: String!, $repo: String!, $number: Int!, $field: String!) {
        repository(owner: $owner, name: $repo) { issue(number: $number) { id
          projectItems(first: 50) { nodes { id project { id }
            fieldValueByName(name: $field) { ... on ProjectV2ItemFieldSingleSelectValue { name } } } } } } }`,
      { owner, repo, number, field: this.options.field },
    );
    const issue = data.repository?.issue;
    if (!issue)
      throw refused(
        `The Projects token cannot read issue #${number}. A private repository needs the token's repo scope.`,
      );
    const node = issue.projectItems.nodes.find(
      (n) => n.project.id === project.id,
    );
    const item = node
      ? { id: node.id, status: node.fieldValueByName?.name ?? null }
      : null;
    this.remember(number, item);
    return { id: issue.id, item };
  }

  /** The Status field's option names, for the settings editor. */
  async optionNames() {
    return (await this.resolve()).options.map((o) => o.name);
  }

  /**
   * An issue's Status moves on any board, keyed by event id (the REST timeline has no
   * details), and the token's own login: moves made with it came from the bridge.
   */
  async statusChanges(number: number) {
    const { owner, repo } = this.options.repo;
    type Move = {
      id?: string;
      previousStatus?: string | null;
      status?: string | null;
      project?: { title?: string } | null;
    };
    const data = await this.graphql<{
      viewer: { login: string };
      repository: {
        issue: { timelineItems: { nodes: (Move | null)[] } } | null;
      } | null;
    }>(
      `query($owner: String!, $repo: String!, $number: Int!) { viewer { login }
        repository(owner: $owner, name: $repo) { issue(number: $number) {
          timelineItems(last: 100, itemTypes: [PROJECT_V2_ITEM_STATUS_CHANGED_EVENT]) { nodes {
            ... on ProjectV2ItemStatusChangedEvent { id previousStatus status project { title } } } } } } }`,
      { owner, repo, number },
    );
    const changes = new Map<
      string,
      { from: string | null; to: string | null; project?: string }
    >();
    for (const node of data.repository?.issue?.timelineItems.nodes ?? [])
      if (node?.id)
        changes.set(node.id, {
          from: node.previousStatus || null,
          to: node.status || null,
          project: node.project?.title,
        });
    return { login: data.viewer.login, changes };
  }

  private remember(number: number, item: ProjectItem | null) {
    if (!this.items) return;
    if (item) this.items.map.set(number, item);
    else this.items.map.delete(number);
  }

  private async option(name: string) {
    const find = (p: Project) =>
      p.options.find((o) => o.name.toLowerCase() === name.toLowerCase());
    const found = find(await this.resolve()) ?? find(await this.resolve(true));
    if (!found)
      throw refused(
        `The project's "${this.options.field}" field has no option named "${name}".`,
      );
    return found;
  }

  /**
   * Set (or with null, clear) an issue's Status, adding the issue to the board first when
   * needed. Adding is idempotent on GitHub's side.
   */
  async setStatus(number: number, status: string | null) {
    const project = await this.resolve();
    const option = status === null ? undefined : await this.option(status);
    const current = await this.issue(number);
    let item = current.item;
    if (!item) {
      if (!option) return;
      const added = await this.graphql<{
        addProjectV2ItemById: { item: { id: string } };
      }>(
        `mutation($project: ID!, $content: ID!) {
          addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } } }`,
        { project: project.id, content: current.id },
      );
      item = { id: added.addProjectV2ItemById.item.id, status: null };
    }
    if (option)
      await this.graphql(
        `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
          updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field,
            value: { singleSelectOptionId: $option } }) { projectV2Item { id } } }`,
        {
          project: project.id,
          item: item.id,
          field: project.field,
          option: option.id,
        },
      );
    else if (item.status !== null)
      await this.graphql(
        `mutation($project: ID!, $item: ID!, $field: ID!) {
          clearProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field }) {
            projectV2Item { id } } }`,
        { project: project.id, item: item.id, field: project.field },
      );
    this.remember(number, { id: item.id, status: option?.name ?? null });
  }
}
