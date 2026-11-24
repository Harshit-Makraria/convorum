// Secret redaction: runs on the client before a message leaves the machine, and again on the hub as a second line of defense.
// Patterns are deliberately specific (vendor prefixes, key blocks, credential assignments) to avoid mangling normal text.

const RULES = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/g],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g],
  ['slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ['stripe-key', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['convorum-key', /\bcv[kmi]_[A-Za-z0-9_-]{20,}/g],
  ['url-credentials', /(?<=\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]{3,}(?=@)/gi],
  ['credential-assignment', /(?<=\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*["']?)[^\s"'`,;]{6,}/gi],
];

/** @returns {{ text: string, found: string[] }} */
export function redact(text) {
  if (typeof text !== 'string' || !text) return { text, found: [] };
  const found = [];
  let out = text;
  for (const [name, re] of RULES) {
    out = out.replace(re, () => { found.push(name); return `[REDACTED:${name}]`; });
  }
  return { text: out, found };
}

export const REDACTION_RULES = RULES.map(([n]) => n);
