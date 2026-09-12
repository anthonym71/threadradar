/**
 * Telegram connector (Bot API).
 *  - Intake: the bot must be a member of each watched group (TELEGRAM_CHAT_IDS) with
 *    privacy mode disabled in @BotFather so it can read all group messages.
 *    Polling mode (default) uses getUpdates and needs no public URL.
 *    Webhook mode (TELEGRAM_WEBHOOK_SECRET + HTTPS APP_ORIGIN) uses POST /webhooks/telegram.
 *  - Private alerts: the owner sends /start to the bot from their own account; the private
 *    chat id must equal TELEGRAM_ALERT_CHAT_ID. Only then can alerts be sent.
 */
import { hash, list, requestJson } from '../util.mjs';

const api = env => `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
export const alertChatFingerprint = env => hash([env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_ALERT_CHAT_ID]);
export const telegramIntakeReady = env => !!(env.TELEGRAM_BOT_TOKEN && list(env.TELEGRAM_CHAT_IDS).length);
export const telegramAlertsReady = env => !!(env.TELEGRAM_BOT_TOKEN && /^[1-9]\d*$/.test(env.TELEGRAM_ALERT_CHAT_ID || ''));
export const telegramWebhookMode = env => env.TELEGRAM_MODE === 'webhook';

/** Normalise one update into a raw message (or null). */
export function telegramMessage(update, env, store) {
  const m = update.edited_message || update.message;
  if (!m?.text || m.from?.is_bot || !['group', 'supergroup'].includes(m.chat?.type)) return null;
  if (!list(env.TELEGRAM_CHAT_IDS).includes(String(m.chat.id)) || m.text.startsWith('/')) return null;
  const account = String(m.chat.id);
  const parent = m.reply_to_message ? store.message('live', hash(['telegram', account, String(m.reply_to_message.message_id)])) : null;
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

/**
 * Handle one update from either the webhook or the poller.
 * Records alert-chat verification when the owner sends /start in the private chat.
 */
export function handleTelegramUpdate(update, env, store, { delivery = true, now = Date.now() } = {}) {
  const msg = update.message;
  let verified = false;
  if (msg?.chat?.type === 'private' && String(msg.chat.id) === String(env.TELEGRAM_ALERT_CHAT_ID) && msg.from?.id === msg.chat.id && !msg.from?.is_bot && /^\/start(?:\s|$)/.test(msg.text || '')) {
    store.set('telegram.verified', alertChatFingerprint(env));
    store.set('telegram.verifiedAt', new Date(now).toISOString());
    verified = true;
  }
  const raw = telegramMessage(update, env, store);
  let ingested = 0;
  if (raw) ingested = store.ingest('live', [raw], { delivery: delivery ? `telegram:${update.update_id}` : null, now });
  return { ingested, verified, raw };
}

/** Long-poll-free getUpdates pass. Returns number of ingested messages. */
export async function pollTelegram(store, env, fetcher = fetch, now = Date.now()) {
  if (!env.TELEGRAM_BOT_TOKEN || telegramWebhookMode(env)) return 0;
  const offset = store.get('telegram.offset', 0);
  const data = await requestJson(fetcher, `${api(env)}/getUpdates?${new URLSearchParams({ offset: String(offset), timeout: '0', limit: '100', allowed_updates: JSON.stringify(['message', 'edited_message']) })}`);
  if (!data.ok) throw new Error(data.description || 'Telegram getUpdates failed');
  let ingested = 0, last = offset;
  for (const update of data.result || []) {
    ingested += handleTelegramUpdate(update, env, store, { now }).ingested;
    last = update.update_id + 1;
  }
  if (last !== offset) store.set('telegram.offset', last);
  store.set('source:telegram', { status: 'connected', mode: 'polling', lastSync: new Date(now).toISOString(), error: null });
  return ingested;
}

export async function registerTelegramWebhook(env, fetcher = fetch) {
  const data = await requestJson(fetcher, `${api(env)}/setWebhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: `${env.APP_ORIGIN}/webhooks/telegram`, secret_token: env.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ['message', 'edited_message'] }) });
  return data.ok === true;
}

/**
 * Send a private alert. Never reports success without a provider message id.
 * States: provider_accepted | failed | unknown (no confirmation, not retried).
 */
export async function sendTelegram(env, text, fetcher = fetch) {
  try {
    const res = await fetcher(`${api(env)}/sendMessage`, { method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: env.TELEGRAM_ALERT_CHAT_ID, text: text.slice(0, 3800), link_preview_options: { is_disabled: true } }) });
    const result = await res.json().catch(() => ({}));
    if (res.ok && result.ok && Number.isInteger(result.result?.message_id)) {
      return { state: 'provider_accepted', providerMessageId: String(result.result.message_id), detail: 'Telegram accepted the message. This is delivery to Telegram, not a read receipt.' };
    }
    return { state: 'failed', detail: `Telegram rejected delivery (HTTP ${res.status}${result.description ? ': ' + result.description : ''}).` };
  } catch {
    return { state: 'unknown', detail: 'No delivery confirmation received. Not retried automatically to avoid duplicate alerts.' };
  }
}
