import fs from 'node:fs';
import { OrchError } from './errors.js';

// Every claim, submission, review and moderation action is one line in
// .0rchestrator/ledger.jsonl. Trust scores are recomputed from that log, so
// anyone can audit how a score was earned or lost.

export const EVENT_TYPES = [
  'claimed', 'released', 'expired', 'submitted', 'failed_submit', 'scope_violation',
  'accepted', 'reopened', 'flagged', 'banned', 'unbanned',
];

export function playerKey(name) {
  return String(name ?? '').trim().toLowerCase();
}

export function readLedger(project) {
  if (!fs.existsSync(project.ledgerPath)) return [];
  return fs
    .readFileSync(project.ledgerPath, 'utf8')
    .split('\n')
    .map((line, i) => {
      if (!line.trim()) return null;
      try {
        return JSON.parse(line);
      } catch {
        throw new OrchError(`Ledger line ${i + 1} is not valid JSON. Someone may have edited it by hand.`, 'BAD_LEDGER');
      }
    })
    .filter(Boolean);
}

export function appendEvent(project, event, now = new Date()) {
  if (!EVENT_TYPES.includes(event.type)) throw new Error(`Unknown ledger event ${event.type}`);
  if (!event.player) throw new Error('Ledger events need a player');
  const row = { at: now.toISOString(), ...event };
  fs.mkdirSync(project.stateDir, { recursive: true });
  fs.appendFileSync(project.ledgerPath, JSON.stringify(row) + '\n');
  return row;
}

export function pointsFor(event, trust) {
  const p = trust.points;
  switch (event.type) {
    case 'accepted':
      return p.accepted?.[event.size] ?? p.accepted?.small ?? 0;
    case 'reopened':
      return event.penalty === false ? 0 : p.reopened ?? 0;
    case 'failed_submit':
      return p.failed_submit ?? 0;
    case 'scope_violation':
      return p.scope_violation ?? 0;
    case 'expired':
      return p.expired ?? 0;
    case 'flagged':
      return p.flagged ?? 0;
    default:
      return 0;
  }
}

function freshStats(name, trust) {
  return {
    name,
    score: trust.starting_score,
    accepted: 0,
    reopened: 0,
    failed_submits: 0,
    scope_violations: 0,
    expired: 0,
    flags: [],
    banned: false,
    ban_reason: null,
    earned: 0,
    first_seen: null,
    last_seen: null,
    history: [],
  };
}

/** Build every player's trust stats from the ledger. Keyed by lower-cased name. */
export function playerStats(project, events = readLedger(project)) {
  const trust = project.config.trust;
  const players = new Map();
  for (const ev of events) {
    const key = playerKey(ev.player);
    if (!key) continue;
    if (!players.has(key)) players.set(key, freshStats(ev.player, trust));
    const s = players.get(key);
    s.first_seen ??= ev.at;
    s.last_seen = ev.at;
    const delta = pointsFor(ev, trust);
    s.score = Math.max(0, Math.min(100, s.score + delta));
    s.history.push({ ...ev, delta, score: s.score });
    switch (ev.type) {
      case 'accepted':
        s.accepted++;
        s.earned += Number(ev.reward) || 0;
        break;
      case 'reopened':
        if (ev.penalty !== false) s.reopened++;
        break;
      case 'failed_submit':
        s.failed_submits++;
        break;
      case 'scope_violation':
        s.scope_violations++;
        break;
      case 'expired':
        s.expired++;
        break;
      case 'flagged':
        s.flags.push({ at: ev.at, reason: ev.reason ?? null, by: ev.by ?? null });
        break;
      case 'banned':
        s.banned = true;
        s.ban_reason = ev.reason ?? null;
        break;
      case 'unbanned':
        s.banned = false;
        s.ban_reason = null;
        break;
      default:
    }
  }
  for (const s of players.values()) {
    const judged = s.accepted + s.reopened + s.failed_submits + s.scope_violations;
    s.reliability = judged ? Math.round((s.accepted / judged) * 100) : null;
    s.tier = tierFor(s, trust);
  }
  return players;
}

export function statsFor(project, name, players = playerStats(project)) {
  return players.get(playerKey(name)) ?? { ...freshStats(name, project.config.trust), reliability: null, tier: 'new' };
}

function meets(stats, fence) {
  return stats.score >= (fence?.min_score ?? 0) && stats.accepted >= (fence?.min_accepted ?? 0);
}

/** banned · fenced · new · member · trusted */
export function tierFor(stats, trust) {
  if (stats.banned) return 'banned';
  if (!meets(stats, trust.fences.small)) return 'fenced';
  if (stats.accepted === 0) return 'new';
  if (meets(stats, trust.fences.sensitive)) return 'trusted';
  return 'member';
}

/** Is a player allowed to take this task? */
export function canClaim(stats, task, trust) {
  if (stats.banned) {
    return { ok: false, reason: `${stats.name} is banned${stats.ban_reason ? ` (${stats.ban_reason})` : ''}.` };
  }
  const checks = [[task.meta.size, trust.fences[task.meta.size]]];
  if (task.meta.sensitive) checks.push(['sensitive', trust.fences.sensitive]);
  for (const [label, fence] of checks) {
    if (!fence) continue;
    if (stats.score < (fence.min_score ?? 0)) {
      return {
        ok: false,
        reason: `${label} tasks need a trust score of ${fence.min_score}+ (${stats.name} has ${stats.score}).`,
      };
    }
    if (stats.accepted < (fence.min_accepted ?? 0)) {
      return {
        ok: false,
        reason: `${label} tasks need ${fence.min_accepted} accepted task(s) first (${stats.name} has ${stats.accepted}).`,
      };
    }
  }
  return { ok: true };
}

/** Players worth a maintainer's attention: banned, fenced, flagged, or caught outside scope. */
export function isFlagged(stats) {
  return stats.banned || stats.tier === 'fenced' || stats.flags.length > 0 || stats.scope_violations > 0;
}
