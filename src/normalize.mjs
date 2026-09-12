import { hash } from './util.mjs';

export const SOURCES = ['slack', 'telegram', 'gmail'];
const SAFE_URL = /^https:\/\/(?:[a-z0-9-]+\.slack\.com|app\.slack\.com|mail\.google\.com|t\.me)\//i;

/**
 * Normalise a raw connector message into the canonical stored shape.
 * id/topicId are content-addressed so repeated imports are idempotent.
 */
export function normalize(m) {
  if (!m || typeof m !== 'object') throw new Error('Invalid source message');
  for (const field of ['source', 'account', 'conversation', 'messageId', 'sender', 'text', 'sentAt']) {
    if (typeof m[field] !== 'string' || m[field].length > 12000) throw new Error(`Invalid message ${field}`);
  }
  if (!SOURCES.includes(m.source) || !m.account || !m.messageId || !m.conversation || !Number.isFinite(Date.parse(m.sentAt))) {
    throw new Error('Invalid source message');
  }
  return {
    id: hash([m.source, m.account, m.messageId]),
    topicId: hash([m.source, m.account, m.conversation]),
    source: m.source,
    account: m.account,
    conversation: m.conversation,
    conversationName: typeof m.conversationName === 'string' ? m.conversationName.slice(0, 200) : m.conversation.slice(0, 200),
    messageId: m.messageId,
    sender: m.sender.slice(0, 200),
    text: m.text.slice(0, 8000),
    sentAt: new Date(m.sentAt).toISOString(),
    receivedAt: m.receivedAt || new Date().toISOString(),
    sourceUrl: typeof m.sourceUrl === 'string' && SAFE_URL.test(m.sourceUrl) ? m.sourceUrl : null,
    synthetic: m.synthetic === true,
    deleted: m.deleted === true,
    backfill: m.backfill === true
  };
}
