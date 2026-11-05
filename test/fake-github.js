import assert from 'node:assert/strict';

// A tiny in-memory GitHub that speaks the REST shapes 0rchestrator's client uses.
export class FakeGitHub {
  constructor(repo = 'acme/textkit') {
    this.repo = repo;
    this.issues = [];
    this.comments = [];
    this.labels = new Set();
    this.prFiles = {};
    this.pulls = [];
    this.next = 1;
    this.files = {}; // "ref:path" → text, for the contents API
    this.mergeBases = {}; // "base...head" → sha
    this.fetch = this.fetch.bind(this);
  }

  issue(n) {
    return this.issues.find((i) => i.number === n);
  }

  on(n) {
    return this.comments.filter((c) => c.issue === n);
  }

  async fetch(url, opts = {}) {
    const u = new URL(url);
    const method = opts.method ?? 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    assert.match(opts.headers.Authorization, /^Bearer /);
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    const page = Number(u.searchParams.get('page') ?? 1);
    const pageOf = (arr) => (page === 1 ? arr : []);
    const base = `/repos/${this.repo}`;
    if (!u.pathname.startsWith(base)) return json({ message: 'Not Found' }, 404);
    const p = u.pathname.slice(base.length);
    let m;
    if (method === 'POST' && p === '/labels') {
      if (this.labels.has(body.name)) return json({ message: 'Validation Failed' }, 422);
      this.labels.add(body.name);
      return json(body, 201);
    }
    if (method === 'GET' && p === '/issues') {
      const label = u.searchParams.get('labels');
      return json(pageOf(this.issues.filter((i) => i.labels.some((l) => l.name === label))));
    }
    if (method === 'POST' && p === '/issues') {
      const issue = { number: this.next++, title: body.title, body: body.body, state: 'open', labels: body.labels.map((name) => ({ name })), assignees: [] };
      this.issues.push(issue);
      return json(issue, 201);
    }
    if ((m = p.match(/^\/issues\/(\d+)$/)) && method === 'PATCH') {
      const i = this.issue(Number(m[1]));
      i.state = body.state;
      return json(i);
    }
    if ((m = p.match(/^\/issues\/(\d+)\/comments$/))) {
      if (method === 'POST') {
        const c = { id: 9000 + this.comments.length, issue: Number(m[1]), body: body.body, user: { login: 'github-actions[bot]', type: 'Bot' } };
        this.comments.push(c);
        return json(c, 201);
      }
      return json(pageOf(this.on(Number(m[1]))));
    }
    if ((m = p.match(/^\/issues\/comments\/(\d+)$/)) && method === 'PATCH') {
      const c = this.comments.find((x) => x.id === Number(m[1]));
      c.body = body.body;
      c.edits = (c.edits ?? 0) + 1;
      return json(c);
    }
    if ((m = p.match(/^\/issues\/(\d+)\/assignees$/)) && method === 'POST') {
      this.issue(Number(m[1])).assignees.push(...body.assignees);
      return json({}, 201);
    }
    if ((m = p.match(/^\/pulls\/(\d+)\/files$/))) return json(pageOf((this.prFiles[m[1]] ?? []).map((filename) => ({ filename, status: 'modified' }))));
    if (method === 'GET' && p === '/pulls') return json(pageOf(this.pulls));
    if ((m = p.match(/^\/compare\/(.+)$/)) && method === 'GET') {
      return json({ merge_base_commit: { sha: this.mergeBases[decodeURIComponent(m[1])] ?? 'mergebase' } });
    }
    if ((m = p.match(/^\/contents\/(.+)$/)) && method === 'GET') {
      const file = m[1].split('/').map(decodeURIComponent).join('/');
      const text = this.files[`${u.searchParams.get('ref')}:${file}`];
      if (text === undefined) return json({ message: 'Not Found' }, 404);
      return json({ type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64'), sha: 'x' });
    }
    return json({ message: `fake GitHub has no route for ${method} ${p}` }, 404);
  }
}

