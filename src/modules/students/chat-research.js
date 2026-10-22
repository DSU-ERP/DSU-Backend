import { normalizeQuery } from '../research/web-search.js';

// Reuse the topic for conversational retries instead of searching "give ans".
const FOLLOW_UP = /^(?:(?:please\s+)?(?:give\s+(?:me\s+)?(?:the\s+)?(?:ans(?:wer)?|response)|(?:ans(?:wer)?|respond)(?:\s+(?:me|it|this|that))?|(?:search|check|try)\s+again|what\s+about\s+(?:today|now)|and\s+(?:today|now))(?:\s+(?:please|now))?)[.!?\s]*$/i;
export function chatResearchQuery(message, history = []) {
  const query = normalizeQuery(message);
  if (!FOLLOW_UP.test(query)) return query;
  const previous = [...history].reverse().find(item => item.role === 'user' && normalizeQuery(item.content) && !FOLLOW_UP.test(normalizeQuery(item.content)));
  return previous ? normalizeQuery(previous.content) : query;
}
