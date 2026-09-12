import { createHmac,timingSafeEqual,randomBytes,createCipheriv,createDecipheriv } from 'node:crypto';
import { hash } from './core.mjs';

export function equal(a,b) {const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));return x.length===y.length&&timingSafeEqual(x,y);}
export function verifySlack(raw,headers,secret,now=Date.now()) {
  const ts=headers['x-slack-request-timestamp'];
  if(!secret||!/^\d+$/.test(ts||'')||Math.abs(now/1000-Number(ts))>300) return false;
  return equal(`v0=${createHmac('sha256',secret).update(`v0:${ts}:${raw}`).digest('hex')}`,headers['x-slack-signature']);
}
const list=s=>(s||'').split(',').map(x=>x.trim()).filter(Boolean);
export function slackMessage(p,env,store) {
  if(p.team_id!==env.SLACK_TEAM_ID) return null;
  const e=p.event||{}; if(e.type!=='message'||!list(env.SLACK_CHANNEL_IDS).includes(e.channel)||e.bot_id) return null;
  const msg=e.subtype==='message_changed'?e.message:e;
  if(e.subtype==='message_deleted') {
    const old=store.message('live',hash(['slack',p.team_id,`${e.channel}:${e.deleted_ts}`]));
    return old?{...old,text:'',deleted:true}:null;
  }
  if(e.subtype&&!['message_changed','thread_broadcast'].includes(e.subtype)) return null;
  if(!msg?.ts||!msg.text||msg.bot_id||!Number.isFinite(Number(msg.ts))) return null;
  return {source:'slack',account:p.team_id,conversation:`${e.channel}:${msg.thread_ts||msg.ts}`,messageId:`${e.channel}:${msg.ts}`,sender:msg.user||'unknown',text:msg.text,sentAt:new Date(Number(msg.ts)*1000).toISOString(),sourceUrl:`https://app.slack.com/client/${p.team_id}/${e.channel}/thread/${e.channel}-${msg.thread_ts||msg.ts}`};
}
export function telegramMessage(update,env,store) {
  const m=update.edited_message||update.message;
  if(!m?.text||m.from?.is_bot||!['group','supergroup'].includes(m.chat?.type)||!list(env.TELEGRAM_CHAT_IDS).includes(String(m.chat.id))||m.text.startsWith('/')) return null;
  const account=String(m.chat.id);
  const parent=m.reply_to_message?store.message('live',hash(['telegram',account,String(m.reply_to_message.message_id)])):null;
  return {source:'telegram',account,conversation:parent?.conversation||`${account}:${m.message_thread_id||m.reply_to_message?.message_id||m.message_id}`,messageId:String(m.message_id),sender:m.from?.username||m.from?.first_name||'unknown',text:m.text,sentAt:new Date(m.date*1000).toISOString(),sourceUrl:m.chat.username?`https://t.me/${m.chat.username}/${m.message_id}`:null};
}
export async function requestJson(fetcher,url,options={}) {
  const res=await fetcher(url,{...options,signal:AbortSignal.timeout(15000)});
  if(!res.ok) {const e=new Error(`Provider HTTP ${res.status}`);e.status=res.status;throw e;}
  return res.json();
}
export async function sendTelegram(env,text,fetcher=fetch) {
  try {
    const res=await fetcher(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,{method:'POST',signal:AbortSignal.timeout(10000),headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:env.TELEGRAM_ALERT_CHAT_ID,text:text.slice(0,3800),link_preview_options:{is_disabled:true}})});
    const result=await res.json();
    if(res.ok&&result.ok&&Number.isInteger(result.result?.message_id)) return {state:'provider_accepted',providerMessageId:String(result.result.message_id),detail:'Telegram accepted the message; this is not a read receipt.'};
    return {state:'failed',detail:`Telegram rejected delivery (HTTP ${res.status}).`};
  } catch {return {state:'unknown',detail:'No delivery confirmation. Not retried automatically to avoid duplicate alerts.'};}
}
export function encrypt(text,keyHex) {
  if(!/^[a-f0-9]{64}$/i.test(keyHex||'')) throw new Error('TOKEN_ENCRYPTION_KEY must contain 64 hex characters');
  const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',Buffer.from(keyHex,'hex'),iv);
  const data=Buffer.concat([c.update(text,'utf8'),c.final()]);
  return Buffer.concat([iv,c.getAuthTag(),data]).toString('base64');
}
export function decrypt(ciphertext,keyHex) {
  const data=Buffer.from(ciphertext,'base64');
  const c=createDecipheriv('aes-256-gcm',Buffer.from(keyHex,'hex'),data.subarray(0,12));c.setAuthTag(data.subarray(12,28));
  return Buffer.concat([c.update(data.subarray(28)),c.final()]).toString('utf8');
}
export const GMAIL_SCOPE='https://www.googleapis.com/auth/gmail.readonly';
export function gmailReady(env) {return !!(env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET&&/^[a-f0-9]{64}$/i.test(env.TOKEN_ENCRYPTION_KEY||'')&&env.GMAIL_LABEL_ID);}
export function oauthStart(store,env,session) {
  if(!gmailReady(env)) throw new Error('Gmail client, label or encryption key not configured');
  const state=randomBytes(32).toString('hex'),verifier=randomBytes(32).toString('base64url');
  store.set(`oauth:${state}`,{session,verifier,expires:Date.now()+600000});
  const p=new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,redirect_uri:`${env.APP_ORIGIN}/oauth/gmail/callback`,response_type:'code',scope:GMAIL_SCOPE,access_type:'offline',prompt:'consent',state,code_challenge:Buffer.from(hash(verifier),'hex').toString('base64url'),code_challenge_method:'S256'});
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}
export async function oauthFinish(store,env,session,url,fetcher=fetch) {
  const state=url.searchParams.get('state'),code=url.searchParams.get('code');
  const saved=store.get(`oauth:${state}`);
  if(!saved||saved.session!==session||saved.expires<Date.now()||!code) throw new Error('Invalid, expired or unbound OAuth state');
  store.remove(`oauth:${state}`);
  const body=new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,redirect_uri:`${env.APP_ORIGIN}/oauth/gmail/callback`,code,code_verifier:saved.verifier,grant_type:'authorization_code'});
  const token=await requestJson(fetcher,'https://oauth2.googleapis.com/token',{method:'POST',body});
  if(!token.refresh_token||!token.access_token) throw new Error('Google did not return an offline refresh token');
  if(token.scope&&!token.scope.split(' ').includes(GMAIL_SCOPE)) throw new Error('Read-only Gmail consent was not granted');
  const profile=await requestJson(fetcher,'https://gmail.googleapis.com/gmail/v1/users/me/profile',{headers:{authorization:`Bearer ${token.access_token}`}});
  store.set('gmail.auth',{email:profile.emailAddress,refresh:encrypt(token.refresh_token,env.TOKEN_ENCRYPTION_KEY)});
  store.remove('gmail.cursor');store.set('source:gmail',{status:'authorized',lastSync:null,error:null});
}
function plainText(node) {
  if(node.mimeType==='text/plain'&&node.body?.data) return Buffer.from(node.body.data,'base64url').toString('utf8');
  for(const p of node.parts||[]) {const text=plainText(p);if(text) return text;}
  return '';
}
const header=(m,k)=>(m.payload?.headers||[]).find(h=>h.name.toLowerCase()===k.toLowerCase())?.value||'';
export async function pollGmail(store,env,fetcher=fetch) {
  const connection=store.get('gmail.auth');if(!gmailReady(env)||!connection) return;
  const token=await requestJson(fetcher,'https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,grant_type:'refresh_token',refresh_token:decrypt(connection.refresh,env.TOKEN_ENCRYPTION_KEY)})});
  if(!token.access_token) throw new Error('Google refresh failed');
  const api=path=>requestJson(fetcher,`https://gmail.googleapis.com/gmail/v1/users/me${path}`,{headers:{authorization:`Bearer ${token.access_token}`}});
  let cursor=store.get('gmail.cursor'),backfill=!cursor,ids=new Set(),nextCursor=cursor;
  if(cursor) {
    try {
      let page='',pages=0;
      do {
        const data=await api(`/history?${new URLSearchParams({startHistoryId:cursor,labelId:env.GMAIL_LABEL_ID,maxResults:'100',...(page?{pageToken:page}:{})})}`);
        for(const h of data.history||[]) for(const group of ['messagesAdded','messagesDeleted','labelsAdded','labelsRemoved']) for(const entry of h[group]||[]) ids.add(entry.message.id);
        nextCursor=data.historyId||nextCursor;page=data.nextPageToken||'';
        if(++pages>=20&&page) throw new Error('History backlog exceeds MVP batch limit; narrow the watched label');
      } while(page);
    } catch(e) {if(e.status!==404) throw e;backfill=true;}
  }
  if(backfill) {
    // Capture cursor BEFORE bounded initial import: newer mail remains in subsequent history.
    nextCursor=(await api('/profile')).historyId;
    const recent=await api(`/messages?${new URLSearchParams({labelIds:env.GMAIL_LABEL_ID,maxResults:'25'})}`);
    ids=new Set((recent.messages||[]).map(m=>m.id));
  }
  const seenThreads=new Set();
  for(const id of ids) {
    let m;
    try {m=await api(`/messages/${encodeURIComponent(id)}?format=full`);} catch(e) {
      if(e.status!==404) throw e;
      const old=store.message('live',hash(['gmail',connection.email,id]));if(old) store.ingest('live',[{...old,text:'',deleted:true}]);continue;
    }
    if(!(m.labelIds||[]).includes(env.GMAIL_LABEL_ID)) {
      const old=store.message('live',hash(['gmail',connection.email,id]));if(old) store.ingest('live',[{...old,text:'',deleted:true}]);continue;
    }
    if(seenThreads.has(m.threadId)) continue;seenThreads.add(m.threadId);
    const thread=await api(`/threads/${encodeURIComponent(m.threadId)}?format=full`);
    const messages=(thread.messages||[]).filter(x=>(x.labelIds||[]).includes(env.GMAIL_LABEL_ID)).slice(-30);
    for(const msg of messages) {
      const text=plainText(msg.payload||{})||msg.snippet||'';
      store.ingest('live',[{source:'gmail',account:connection.email,conversation:msg.threadId,messageId:msg.id,sender:header(msg,'From'),text:`${header(msg,'Subject')}\n${text}`.slice(0,8000),sentAt:new Date(Number(msg.internalDate)).toISOString(),sourceUrl:`https://mail.google.com/mail/u/?authuser=${encodeURIComponent(connection.email)}#all/${msg.threadId}`,backfill:backfill||!ids.has(msg.id)}]);
    }
  }
  // Commit cursor only after all pages and message writes succeeded; retries deduplicate.
  store.set('gmail.cursor',nextCursor);
  store.set('source:gmail',{status:'connected',lastSync:new Date().toISOString(),error:null,initialImportLimit:25});
}
