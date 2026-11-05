import { OrchError } from './errors.js';

// A small GitHub REST client: only the calls GitHub mode needs. Uses the
// GITHUB_TOKEN an Actions run provides. `fetchImpl` is swappable for tests.

const PER_PAGE = 100;

export function githubClient({
  token = process.env.GITHUB_TOKEN,
  repo = process.env.GITHUB_REPOSITORY,
  apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com',
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) throw new OrchError('GITHUB_REPOSITORY (owner/name) is not set.', 'NO_REPO');
  if (!token) throw new OrchError('GITHUB_TOKEN is not set. In a workflow, pass it with env: GITHUB_TOKEN: ${{ github.token }}', 'NO_TOKEN');

  async function request(method, path, body) {
    const res = await fetchImpl(`${apiUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': '0rchestrator',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = new Error(`GitHub ${method} ${path} failed (${res.status}): ${data?.message ?? text}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function paginate(path) {
    const out = [];
    const sep = path.includes('?') ? '&' : '?';
    for (let page = 1; page <= 30; page++) {
      const batch = await request('GET', `${path}${sep}per_page=${PER_PAGE}&page=${page}`);
      out.push(...batch);
      if (batch.length < PER_PAGE) break;
    }
    return out;
  }

  const r = `/repos/${repo}`;
  return {
    repo,
    request,
    /** Issues (not PRs) carrying the label, open and closed. */
    async listIssues(label) {
      const all = await paginate(`${r}/issues?state=all&labels=${encodeURIComponent(label)}`);
      return all.filter((i) => !i.pull_request);
    },
    createIssue: (fields) => request('POST', `${r}/issues`, fields),
    setIssueState: (n, state) => request('PATCH', `${r}/issues/${n}`, { state, ...(state === 'closed' ? { state_reason: 'completed' } : {}) }),
    comment: (n, body) => request('POST', `${r}/issues/${n}/comments`, { body }),
    listComments: (n) => paginate(`${r}/issues/${n}/comments`),
    editComment: (id, body) => request('PATCH', `${r}/issues/comments/${id}`, { body }),
    addAssignees: (n, logins) => request('POST', `${r}/issues/${n}/assignees`, { assignees: logins }),
    async ensureLabel(name, color, description) {
      try {
        await request('POST', `${r}/labels`, { name, color, description });
      } catch (err) {
        if (err.status !== 422) throw err; // 422: already exists
      }
    },
    /** Every path a PR touches, including the old name of renamed files. */
    async prFiles(n) {
      const files = await paginate(`${r}/pulls/${n}/files`);
      return [...new Set(files.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean)))];
    },
    listOpenPulls: () => paginate(`${r}/pulls?state=open`),
    /** The commit a PR branched from, so only its own changes are compared. */
    async mergeBase(base, head) {
      const cmp = await request('GET', `${r}/compare/${base}...${head}`);
      return cmp.merge_base_commit.sha;
    },
    /** A file's text at a commit, or null if it doesn't exist there. */
    async fileAt(file, ref) {
      try {
        const meta = await request('GET', `${r}/contents/${file.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`);
        if (Array.isArray(meta) || meta.type !== 'file') return null;
        if (meta.encoding === 'base64' && meta.content) return Buffer.from(meta.content, 'base64').toString('utf8');
        // Files over 1 MB come without content: fetch the blob instead.
        const blob = await request('GET', `${r}/git/blobs/${meta.sha}`);
        return Buffer.from(blob.content, 'base64').toString('utf8');
      } catch (err) {
        if (err.status === 404) return null;
        throw err;
      }
    },
  };
}
