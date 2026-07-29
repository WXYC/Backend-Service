/**
 * Cross-repo handoff for jobs/uncovered-release-list (BS#1877, ADR 0013's
 * "uncovered-release list handoff"): commit the rendered
 * `uncovered-releases.jsonl` snapshot to a dedicated branch on the PRIVATE
 * `WXYC/research-data` repo via GitHub's Contents API (single-file PUT — no
 * tree/blob/ref dance needed for one file), where `research-data`'s `search`
 * crawl mode (RD#16) reads it. This is the ADR's chosen mechanism — "a
 * committed file, refreshed by a scheduled job" — explicitly NOT a live read
 * endpoint on Backend-Service and NOT direct DB access from research-data;
 * see ADR 0013's handoff section for why both were rejected.
 *
 * Ops one-time setup (NOT done by this code, and not done by this job's
 * first run): create the `SNAPSHOT_BRANCH` branch in `WXYC/research-data`
 * (from `main`) and open ONE PR from that branch to `main`. Every subsequent
 * commit this module makes to that branch auto-updates the already-open
 * PR — GitHub's PR view always reflects the branch's current HEAD, no
 * separate "update the PR" API call is needed or made here. This keeps the
 * module's surface to exactly one GitHub call shape (GET the current file's
 * sha, PUT the new content), the same Contents-API idiom
 * `jobs/album-critic-reviews-etl/fetch.ts` already uses one direction over
 * (it GETs a release asset; this PUTs a file).
 *
 * Requires `RESEARCH_DATA_WRITE_TOKEN` — a fine-grained PAT scoped to
 * `WXYC/research-data` with `Contents: Read and write`. Deliberately a
 * SEPARATE credential from `RESEARCH_DATA_TOKEN` (album-critic-reviews-etl's
 * read-only manifest-fetch token): that token's whole point, stated in its
 * own README, is read-only; minting this job a distinct write-scoped token
 * keeps that invariant legible rather than quietly upgrading a read-only
 * credential's effective scope.
 *
 * Gated behind `PUBLISH=true` (`resolvePublishEnabled`) as well as the
 * token's presence — an operator must opt in explicitly, not just possess a
 * token. **As of this job's initial ship, nothing in this codebase's CI or
 * dev environment holds a real write-scoped token, and `PUBLISH` defaults
 * off** — so in production, until an operator provisions the token and sets
 * `PUBLISH=true`, this function returns `{ attempted: false, committed:
 * false }` every run. The local file write (`writer.ts`) still happens
 * every run regardless — an operator can grab `uncovered-releases.jsonl`
 * from the container and hand it to research-data manually in the interim.
 * This is real, DI-tested Contents-API code (see publish.test.ts), not a
 * placeholder that logs success without doing anything — it has simply
 * never made a live call against `WXYC/research-data`, honestly reflected by
 * `attempted: false` rather than a faked `committed: true`.
 */

const RESEARCH_DATA_OWNER = 'WXYC';
const RESEARCH_DATA_REPO = 'research-data';
const SNAPSHOT_BRANCH = 'uncovered-releases-snapshot';
const SNAPSHOT_PATH_IN_REPO = 'uncovered-releases.jsonl';
const USER_AGENT = 'wxyc-uncovered-release-list';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export const resolvePublishEnabled = (raw: string | undefined = process.env.PUBLISH): boolean => {
  if (raw === undefined) return false;
  const lowered = raw.toLowerCase();
  return lowered === 'true' || lowered === '1';
};

export const resolveResearchDataWriteToken = (
  raw: string | undefined = process.env.RESEARCH_DATA_WRITE_TOKEN
): string | null => (raw && raw.trim().length > 0 ? raw : null);

export interface PublishOutcome {
  /** A real GitHub call was attempted (token present AND PUBLISH=true). */
  attempted: boolean;
  /** The Contents API PUT succeeded. */
  committed: boolean;
  /** The new commit's sha, when committed. */
  commitSha?: string;
  /** Why `attempted`/`committed` is false — always present when either is. */
  reason?: string;
}

export interface PublishOptions {
  token: string | null;
  publishEnabled: boolean;
  fetchFn?: FetchFn;
}

interface GithubContentsGetResponse {
  sha: string;
}

interface GithubContentsPutResponse {
  commit?: { sha?: string };
}

/**
 * Commit `content` (the exact string `writeSnapshotFile` also wrote to
 * disk) to `SNAPSHOT_BRANCH` on `WXYC/research-data`. Looks up the branch's
 * current file sha first (required by the Contents API for an in-place
 * update; omitted for that branch's first-ever commit, a 404 on the GET).
 * Any non-404 GET failure, or a non-2xx PUT, throws — orchestrate.ts
 * isolates that the same way it isolates every other per-run failure mode
 * (counted, logged, does not abort the run: the local file write already
 * succeeded and is this run's durable artifact regardless).
 */
export const publishSnapshot = async (content: string, opts: PublishOptions): Promise<PublishOutcome> => {
  const fetchFn = opts.fetchFn ?? fetch;

  if (!opts.publishEnabled) {
    return {
      attempted: false,
      committed: false,
      reason: 'PUBLISH is not enabled (set PUBLISH=true to push to research-data)',
    };
  }
  if (!opts.token) {
    return { attempted: false, committed: false, reason: 'RESEARCH_DATA_WRITE_TOKEN is not set' };
  }

  const headers = {
    Authorization: `Bearer ${opts.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': USER_AGENT,
  };
  const contentsUrl = `https://api.github.com/repos/${RESEARCH_DATA_OWNER}/${RESEARCH_DATA_REPO}/contents/${SNAPSHOT_PATH_IN_REPO}`;

  const existingResp = await fetchFn(`${contentsUrl}?ref=${SNAPSHOT_BRANCH}`, { headers });
  let sha: string | undefined;
  if (existingResp.status === 200) {
    const body = (await existingResp.json()) as GithubContentsGetResponse;
    sha = body.sha;
  } else if (existingResp.status !== 404) {
    throw new Error(`GitHub contents GET failed: ${existingResp.status} ${existingResp.statusText}`);
  }
  // A 404 here means either the branch or the file doesn't exist yet on it —
  // both are the same "no sha to carry" case for the PUT below; distinguishing
  // them isn't actionable (the PUT's own failure mode, if the branch itself
  // is missing, is the real signal an operator needs, surfaced by the throw
  // on a non-ok PUT response).

  const putResp = await fetchFn(contentsUrl, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `chore: refresh uncovered-releases snapshot (${new Date().toISOString().slice(0, 10)})`,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch: SNAPSHOT_BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!putResp.ok) {
    throw new Error(`GitHub contents PUT failed: ${putResp.status} ${putResp.statusText}`);
  }
  const putBody = (await putResp.json()) as GithubContentsPutResponse;

  return { attempted: true, committed: true, commitSha: putBody.commit?.sha };
};
