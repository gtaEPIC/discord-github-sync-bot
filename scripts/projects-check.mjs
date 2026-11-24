#!/usr/bin/env node
/**
 * Check what a GitHub token can do with a user-owned Projects v2 board, before giving it to
 * the bridge. Reads the token from PROJECTS_TOKEN and never prints it.
 *
 *   PROJECTS_TOKEN=... node scripts/projects-check.mjs <user> <project-number> <owner/repo> <issue-number> [--write]
 *
 * Read checks: token scopes, the project and its Status field, the project's items (counting
 * ones hidden from this token), and the issue. With --write it also adds the issue to the
 * project and sets its Status to the first option (adding is idempotent).
 */
const [user, number, repository, issueNumber] = process.argv.slice(2);
const write = process.argv.includes("--write");
const token = process.env.PROJECTS_TOKEN;
if (!user || !number || !repository?.includes("/") || !issueNumber || !token) {
  console.error(
    "Usage: PROJECTS_TOKEN=... node scripts/projects-check.mjs <user> <project-number> <owner/repo> <issue-number> [--write]",
  );
  process.exit(2);
}
const [owner, repo] = repository.split("/");
let failed = false;
const pass = (step, detail = "") =>
  console.log(`PASS  ${step}${detail ? `: ${detail}` : ""}`);
const fail = (step, detail) => {
  failed = true;
  console.log(`FAIL  ${step}: ${detail}`);
};

async function graphql(query, variables) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "ry-issue-bridge-projects-check",
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json();
  if (!response.ok || body.errors?.length)
    throw new Error(
      body.errors?.map((e) => e.message).join("; ") ??
        `HTTP ${response.status} ${body.message ?? ""}`,
    );
  return body.data;
}

// 1. Who is this token, and which classic scopes does it carry?
const me = await fetch("https://api.github.com/user", {
  headers: {
    authorization: `bearer ${token}`,
    "user-agent": "ry-issue-bridge-projects-check",
  },
});
if (!me.ok) {
  fail("token", `HTTP ${me.status}`);
  process.exit(1);
}
const scopes = me.headers.get("x-oauth-scopes");
pass(
  "token",
  `${(await me.json()).login}; scopes: ${scopes === null ? "(none reported: not a classic PAT)" : scopes || "(none)"}`,
);

// 2. The project and its Status field.
let project;
try {
  const data = await graphql(
    `
      query ($user: String!, $number: Int!) {
        user(login: $user) {
          projectV2(number: $number) {
            id
            title
            field(name: "Status") {
              ... on ProjectV2SingleSelectField {
                id
                options {
                  id
                  name
                }
              }
            }
          }
        }
      }
    `,
    { user, number: Number(number) },
  );
  project = data.user?.projectV2;
  if (!project) throw new Error("not found");
  if (!project.field)
    throw new Error(`"${project.title}" has no single-select Status field`);
  pass(
    "project",
    `"${project.title}", Status options: ${project.field.options.map((o) => o.name).join(", ")}`,
  );
} catch (error) {
  fail("project", error.message);
  process.exit(1);
}

// 3. Items: every page, counting items whose content this token cannot see.
try {
  let cursor = null;
  const counts = { total: 0, redacted: 0, fromRepo: 0 };
  do {
    const data = await graphql(
      `
        query ($id: ID!, $cursor: String) {
          node(id: $id) {
            ... on ProjectV2 {
              items(first: 100, after: $cursor) {
                pageInfo {
                  hasNextPage
                  endCursor
                }
                nodes {
                  type
                  updatedAt
                  content {
                    ... on Issue {
                      number
                      repository {
                        nameWithOwner
                      }
                    }
                  }
                  fieldValueByName(name: "Status") {
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      name
                    }
                  }
                }
              }
            }
          }
        }
      `,
      { id: project.id, cursor },
    );
    const items = data.node.items;
    for (const item of items.nodes) {
      counts.total++;
      if (item.type === "REDACTED") counts.redacted++;
      if (
        item.content?.repository?.nameWithOwner?.toLowerCase() ===
        repository.toLowerCase()
      )
        counts.fromRepo++;
    }
    cursor = items.pageInfo.hasNextPage ? items.pageInfo.endCursor : null;
  } while (cursor);
  (counts.redacted ? fail : pass)(
    "items",
    `${counts.total} items, ${counts.fromRepo} from ${repository}, ${counts.redacted} hidden from this token${counts.redacted ? " (it needs access to their repositories)" : ""}`,
  );
} catch (error) {
  fail("items", error.message);
}

// 4. The issue itself (a private repository needs the repo scope or repository access).
let issueId;
try {
  const data = await graphql(
    `
      query ($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $number) {
            id
            title
          }
        }
      }
    `,
    { owner, repo, number: Number(issueNumber) },
  );
  issueId = data.repository?.issue?.id;
  if (!issueId) throw new Error("not found");
  pass("issue", `#${issueNumber} "${data.repository.issue.title}"`);
} catch (error) {
  fail("issue", `${error.message} (the token cannot read ${repository})`);
}

// 5. Writes: add the issue to the project and set its Status.
if (write && issueId) {
  try {
    const added = await graphql(
      `
        mutation ($project: ID!, $content: ID!) {
          addProjectV2ItemById(
            input: { projectId: $project, contentId: $content }
          ) {
            item {
              id
            }
          }
        }
      `,
      { project: project.id, content: issueId },
    );
    const item = added.addProjectV2ItemById.item.id;
    pass("add item");
    const option = project.field.options[0];
    await graphql(
      `
        mutation ($project: ID!, $item: ID!, $field: ID!, $option: String!) {
          updateProjectV2ItemFieldValue(
            input: {
              projectId: $project
              itemId: $item
              fieldId: $field
              value: { singleSelectOptionId: $option }
            }
          ) {
            projectV2Item {
              id
            }
          }
        }
      `,
      { project: project.id, item, field: project.field.id, option: option.id },
    );
    pass("set Status", option.name);
  } catch (error) {
    fail("write", error.message);
  }
} else if (write) fail("write", "skipped: the issue could not be read");

process.exit(failed ? 1 : 0);
