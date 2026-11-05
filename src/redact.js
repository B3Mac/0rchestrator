import { OrchError } from './errors.js';

// Swap private words (client names, codenames, keys) for neutral placeholders
// before a task packet leaves the owner's machine, and swap them back when the
// work returns. The mapping never leaves the owner's side.

export const PLACEHOLDER = /REDACTED_(\d+)/g;

function toRegex(rule) {
  if (rule instanceof RegExp) return new RegExp(rule.source, rule.flags.includes('g') ? rule.flags : rule.flags + 'g');
  const src = typeof rule === 'object' && rule !== null ? rule.pattern : rule;
  if (typeof src !== 'string' || !src) throw new OrchError(`Bad redaction rule: ${JSON.stringify(rule)}`, 'BAD_CONFIG');
  const m = src.match(/^\/(.+)\/([a-z]*)$/s);
  try {
    if (m) return new RegExp(m[1], m[2].includes('g') ? m[2] : m[2] + 'g');
    return new RegExp(src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  } catch (err) {
    throw new OrchError(`Bad redaction pattern ${src}: ${err.message}`, 'BAD_CONFIG');
  }
}

export class Redactor {
  constructor(rules = [], mapping = {}) {
    this.rules = rules.map(toRegex);
    this.byPlaceholder = { ...mapping };
    this.byOriginal = new Map(Object.entries(mapping).map(([ph, orig]) => [orig, ph]));
  }

  get active() {
    return this.rules.length > 0;
  }

  placeholderFor(original) {
    let ph = this.byOriginal.get(original);
    if (!ph) {
      ph = `REDACTED_${this.byOriginal.size + 1}`;
      this.byOriginal.set(original, ph);
      this.byPlaceholder[ph] = original;
    }
    return ph;
  }

  redact(text) {
    let out = String(text);
    for (const re of this.rules) {
      re.lastIndex = 0;
      out = out.replace(re, (match) => (match ? this.placeholderFor(match) : match));
    }
    return out;
  }

  restore(text) {
    return String(text).replace(PLACEHOLDER, (ph) => this.byPlaceholder[ph] ?? ph);
  }

  mapping() {
    return { ...this.byPlaceholder };
  }
}
