/**
 * Telegram connector (per user, Bot API). Config: { botToken, chatIds, alertChatId, backfillHours }.
 *  - Intake: the user's bot must be in each watched group with privacy mode disabled
 *    (@BotFather /setprivacy -> Disable). Polling uses getUpdates; Telegram keeps
 *    undelivered updates for 24 hours only, so backfill is capped at that.
 *  - Private alerts: the owner sends /start to their bot from their own account; the
 *    private chat id must equal alertChatId. Only then can alerts be sent.
 */
import { hash, list, requestJson } from '../util.mjs';

const api = token => `https://api.telegram.org/bot${token}`;
export const alertChatFingerprint = config => hash([config.botToken, config.alertChatId]);

export function validateTelegramConfig(input, existing = null) {
  const botToken = typeof input.botToken === 'string' && input.botToken && !/^•+/.test(input.botToken) ? input.botToken.trim() : existing?.botToken;
  if (!botToken || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(botToken)) throw new Error('Telegram bot token looks wrong (expected 123456:ABC...)');
  const chatIds = list(input.chatIds);
  if (chatIds.some(c => !/^-?\d+$/.test(c))) throw new Error('Telegram chat IDs must be numeric (e.g. -1001234567890)');
  const alertChatId = String(input.alertChatId || '').trim();
  if (alertChatId && !/^[1-9]\d*$/.test(alertChatId)) throw new Error('Your private chat id must be a positive number');
  if (!chatIds.length && !alertChatId) throw new Error('Enter at least one group chat id to watch or your private chat id for alerts');
  const backfillHours = Math.min(24, Number(input.backfillHours ?? existing?.backfillHours ?? 24));
  if (!Number.isFinite(backfillHours) || backfillHours < 1) throw new Error('Backfill must be between 1 and 24 hours (Telegram keeps updates for 24 h)');
  return { botToken, chatIds: chatIds.join(','), alertChatId, backfillHours };
}

export function telegramMessage(update, config, store, space) {
  const m = update.edited_message || update.message;
  if (!m?.text || m.from?.is_bot || !['group', 'supergroup'].includes(m.chat?.type)) return null;
  if (!list(config.chatIds).includes(String(m.chat.id)) || m.text.startsWith('/')) return null;
  const account = String(m.chat.id);
  const parent = m.reply_to_message ? store.message(space, hash(['telegram', account, String(m.reply_to_message.message_id)])) : null;
  const threadKey = m.message_thread_id || m.reply_to_message?.message_id || m.message_id;
  return {
    source: 'telegram',
    account,
    conversation: parent?.conversation || `${account}:${threadKey}`,
    conversationName: m.chat.title ? `${m.chat.title} (Telegram)` : `Telegram chat ${account}`,
    messageId: String(m.message_id),
    sender: m.from?.first_name ? `${m.from.first_name}${m.from.last_name ? ' ' + m.from.last_name : ''}` : m.from?.username || 'unknown',
    text: m.text,
    sentAt: new Date(m.date * 1000).toISOString(),
    sourceUrl: m.chat.username ? `https://t.me/${m.chat.username}/${m.message_id}` : null
  };
}

/** Handle one update. Records alert-chat verification when the owner sends /start privately. */
export function handleTelegramUpdate(update, config, store, space, { now = Date.now(), minDate = 0 } = {}) {
  const msg = update.message;
  let verified = false;
  if (msg?.chat?.type === 'private' && config.alertChatId && String(msg.chat.id) === String(config.alertChatId) && msg.from?.id === msg.chat.id && !msg.from?.is_bot && /^\/start(?:\s|$)/.test(msg.text || '')) {
    store.set(`telegram.verified:${space}`, alertChatFingerprint(config));
    store.set(`telegram.verifiedAt:${space}`, new Date(now).toISOString());
    verified = true;
  }
  const raw = telegramMessage(update, config, store, space);
  let ingested = 0;
  if (raw && Date.parse(raw.sentAt) >= minDate) ingested = store.ingest(space, [{ ...raw, backfill: !store.get(`telegram.offset:${space}`) }], { now });
  return { ingested, verified, raw };
}

export async function pollTelegram(store, space, config, fetcher = fetch, now = Date.now()) {
  const offset = store.get(`telegram.offset:${space}`, 0);
  const minDate = offset ? 0 : now - Number(config.backfillHours || 24) * 3600000;
  const data = await requestJson(fetcher, `${api(config.botToken)}/getUpdates?${new URLSearchParams({ offset: String(offset), timeout: '0', limit: '100', allowed_updates: JSON.stringify(['message', 'edited_message']) })}`);
  if (!data.ok) throw new Error(data.description || 'Telegram getUpdates failed');
  let ingested = 0, last = offset, verified = false;
  for (const update of data.result || []) {
    const r = handleTelegramUpdate(update, config, store, space, { now, minDate });
    ingested += r.ingested; verified = verified || r.verified;
    last = update.update_id + 1;
  }
  if (last !== offset || !offset) store.set(`telegram.offset:${space}`, last || 1);
  return { ingested, verified };
}

export async function getBotInfo(config, fetcher = fetch) {
  const data = await requestJson(fetcher, `${api(config.botToken)}/getMe`);
  if (!data.ok) throw new Error(data.description || 'Telegram getMe failed');
  return data.result;
}

/** Send a private alert. Never reports success without a provider message id. */
export async function sendTelegram(config, text, fetcher = fetch) {
  try {
    const res = await fetcher(`${api(config.botToken)}/sendMessage`, { method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: config.alertChatId, text: text.slice(0, 3800), link_preview_options: { is_disabled: true } }) });
    const result = await res.json().catch(() => ({}));
    if (res.ok && result.ok && Number.isInteger(result.result?.message_id)) {
      return { state: 'provider_accepted', providerMessageId: String(result.result.message_id), detail: 'Telegram accepted the message. This is delivery to Telegram, not a read receipt.' };
    }
    return { state: 'failed', detail: `Telegram rejected delivery (HTTP ${res.status}${result.description ? ': ' + result.description : ''}).` };
  } catch {
    return { state: 'unknown', detail: 'No delivery confirmation received. Not retried automatically to avoid duplicate alerts.' };
  }
}
