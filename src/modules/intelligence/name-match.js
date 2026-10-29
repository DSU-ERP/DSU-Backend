// Name match between a student's official name and a platform identity
// (LeetCode username, and the profile name LeetCode shows once synced).
// "verified" means the identity matches or is very similar to the student's
// name. It is a plausibility check, not proof of account ownership: two
// students with the same first name can both match a short username.

const fold = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
export const nameTokens = (s) => fold(s).split(/[^a-z]+/).filter(Boolean);
const letters = (s) => fold(s).replace(/[^a-z]/g, "");

/** Levenshtein distance (small strings only; inputs are capped at 60 letters). */
function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}
export const similarity = (a, b) => (!a || !b ? 0 : 1 - distance(a, b) / Math.max(a.length, b.length));

/** Spellings of the official name: full, reversed, without initials, and word plus initials. */
function variants(tokens) {
  const words = tokens.filter((w) => w.length >= 3);
  const out = new Set([tokens.join(""), [...tokens].reverse().join(""), words.join(""), [...words].reverse().join("")]);
  const initials = tokens.filter((w) => !words.includes(w) || w.length < 3).map((w) => w[0]).join("");
  for (const w of words) {
    const others = tokens.filter((t) => t !== w).map((t) => t[0]).join("");
    out.add(w + others);
    out.add(others + w);
    out.add(w + initials);
  }
  return [...out].filter((v) => v.length >= 3);
}

/** A username like "shreyas2004", "shreyas_kr" or "kshreyas": a full name word (5+ letters) plus at most two initials. */
function usernameMatches(candidate, tokens) {
  const initials = new Set(tokens.map((t) => t[0]));
  for (const word of tokens.filter((w) => w.length >= 5)) {
    const at = candidate.indexOf(word);
    if (at === -1) continue;
    const rest = candidate.slice(0, at) + candidate.slice(at + word.length);
    if (rest.length <= 2 && [...rest].every((c) => initials.has(c))) return true;
    if (tokens.some((t) => t !== word && t.length >= 3 && similarity(rest, t) >= 0.8)) return true;
  }
  return false;
}

/** A username made only of 3+ letter starts of two or more name words, in order ("sidvenkat"). */
function prefixMatches(candidate, tokens, from = 0, used = 0) {
  if (!candidate) return used >= 2;
  for (let i = from; i < tokens.length; i++)
    for (let len = Math.min(tokens[i].length, candidate.length); len >= 3; len--)
      if (candidate.startsWith(tokens[i].slice(0, len)) && prefixMatches(candidate.slice(len), tokens, i + 1, used + 1)) return true;
  return false;
}

/**
 * Returns {status: 'verified'|'unverified', source: 'profile_name'|'username'|null, score}.
 * The LeetCode profile name is checked first (it is the stronger signal), then the username.
 */
export function nameMatch(studentName, { username, realName } = {}) {
  const tokens = nameTokens(studentName).slice(0, 8);
  if (!tokens.length) return { status: "unverified", source: null, score: 0 };
  const forms = variants(tokens);
  const best = (candidate) => Math.max(0, ...forms.map((v) => similarity(candidate, v)));

  const real = letters(realName).slice(0, 60);
  if (real.length >= 4) {
    const score = best(real);
    const realTokens = nameTokens(realName).filter((t) => t.length >= 3);
    const everyWord = realTokens.length > 0 && realTokens.every((t) => tokens.some((w) => w.length >= 3 && similarity(t, w) >= 0.85));
    if (score >= 0.85 || everyWord) return { status: "verified", source: "profile_name", score: Math.round(Math.max(score, everyWord ? 0.9 : 0) * 100) / 100 };
  }
  const user = letters(username).slice(0, 60);
  if (user.length >= 4) {
    const score = best(user);
    if (score >= 0.8 || usernameMatches(user, tokens) || prefixMatches(user, tokens))
      return { status: "verified", source: "username", score: Math.round(Math.max(score, 0.8) * 100) / 100 };
  }
  return { status: "unverified", source: null, score: Math.round(Math.max(real ? best(real) : 0, user ? best(user) : 0) * 100) / 100 };
}
