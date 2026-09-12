import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Store,hash,classify,mayNotify,demoMessages,normalize } from './core.mjs';
import { equal,verifySlack,slackMessage,telegramMessage,sendTelegram,gmailReady,oauthStart,oauthFinish,pollGmail,requestJson } from './connectors.mjs';

export function createApp({env=process.env,dbPath,fetcher=fetch,timers=true}={}) {
  const cfg={HOST:'127.0.0.1',PORT:'3100',...env};
  cfg.APP_ORIGIN=(cfg.APP_ORIGIN||`http://127.0.0.1:${cfg.PORT}`).replace(/\/$/,'');
  const origin=new URL(cfg.APP_ORIGIN);
  const hasPassword=typeof cfg.APP_PASSWORD==='string'&&cfg.APP_PASSWORD.length>=16;
  const hasProvider=!!(cfg.SLACK_SIGNING_SECRET||cfg.TELEGRAM_BOT_TOKEN||cfg.GOOGLE_CLIENT_SECRET||cfg.OPENROUTER_API_KEY);
  if((!['127.0.0.1','localhost','::1'].includes(cfg.HOST)||hasProvider)&&!hasPassword) throw new Error('Set APP_PASSWORD to at least 16 characters before network binding or connecting providers.');
  if(cfg.APP_PASSWORD&&!hasPassword) throw new Error('APP_PASSWORD must have at least 16 characters');
  if(origin.protocol!=='https:'&&!['127.0.0.1','localhost','[::1]'].includes(origin.hostname)) throw new Error('Public APP_ORIGIN must use HTTPS');
  const store=new Store(dbPath||cfg.DATABASE_PATH||'data/threadradar.sqlite');
  let busy=false,pollBusy=false,heartbeat=null,stopped=false,lastPoll=0;
  const loginAttempts=new Map();
  const sessionId=req=>String(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('tr_session='))?.slice(11)||'';
  function authenticated(req) {
    if(!hasPassword) return true;
    const token=sessionId(req);if(!token) return false;
    const s=store.get(`session:${hash(token)}`);
    return !!(s&&s.expires>Date.now()&&s.version===hash(cfg.APP_PASSWORD));
  }
  const privateChatFingerprint=()=>hash([cfg.TELEGRAM_BOT_TOKEN,cfg.TELEGRAM_ALERT_CHAT_ID]);
  function sources() {
    return ['slack','telegram','gmail'].map(source=>{
      const ready=source==='slack'?!!(cfg.SLACK_SIGNING_SECRET&&cfg.SLACK_TEAM_ID&&cfg.SLACK_CHANNEL_IDS):source==='telegram'?!!(cfg.TELEGRAM_BOT_TOKEN&&cfg.TELEGRAM_WEBHOOK_SECRET&&cfg.TELEGRAM_CHAT_IDS):gmailReady(cfg);
      const observed=store.get(`source:${source}`,{});
      return {source,configured:ready,status:ready?(observed.status||'awaiting_connection'):'not_configured',lastSync:observed.lastSync||null,error:observed.error||null};
    });
  }
  async function analyze(j) {
    const messages=store.messages(j.space,j.id);
    if(!messages.length) {store.finish(j);return;}
    const settings=store.settings(j.space);
    let r,error=false;
    if(messages.every(m=>m.deleted)) r={classification:'FYI',relevant:false,policyMatch:false,unresolved:false,title:'Source removed',summary:'The source messages were deleted or removed from the watched label.',whyRelevant:'Retained as an audit item; no action requested.',actionRequired:null,dueAt:null,whyCritical:null,evidenceIds:[],analyzer:'Source state'};
    else try {r=await classify(messages,settings,cfg,fetcher,j.space);} catch {
      error=true;r={classification:'REVIEW',relevant:true,policyMatch:false,unresolved:true,title:'This conversation needs review',summary:'AI analysis unavailable. The source was preserved, not filtered as noise.',whyRelevant:'Model configuration or provider request needs attention.',actionRequired:'Review the source conversation.',dueAt:null,whyCritical:null,evidenceIds:messages.filter(m=>!m.deleted).slice(-1).map(m=>m.id),analyzer:'Analysis error'};
    }
    // Never publish or alert stale analysis if a resolution/edit arrived during the model request.
    const current=store.db.prepare('SELECT generation FROM jobs WHERE space=? AND id=?').get(j.space,j.id);
    if(!current||current.generation!==j.generation) {store.db.prepare('UPDATE jobs SET lease=0 WHERE space=? AND id=?').run(j.space,j.id);return;}
    const signature=hash([r.classification,r.dueAt,r.unresolved,r.actionRequired]);
    const old=store.item(j.space,j.id);
    const item={...r,id:j.id,signature,status:old?.signature===signature?old.status:'open',sources:[...new Set(messages.map(m=>m.source))],conversation:messages[0].conversation,updatedAt:new Date().toISOString(),sourceUrl:messages.findLast(m=>!m.deleted&&m.sourceUrl)?.sourceUrl||null};
    store.saveItem(j.space,item);
    const freshSettings=store.settings(j.space);
    const recent=messages.some(m=>!m.deleted&&!m.backfill&&Date.now()-Date.parse(m.receivedAt)<15*60000&&Date.now()-Date.parse(m.sentAt)<24*3600000);
    const receiptId=hash([j.id,signature]);
    const receipts=store.notifications(j.space);
    const previous=receipts.find(n=>n.id===receiptId);
    const cooldown=receipts.some(n=>n.itemId===j.id&&['pending','provider_accepted','unknown'].includes(n.state)&&Date.now()-Date.parse(n.at)<30*60000);
    if(r.classification==='CRITICAL'&&freshSettings.criticalChecks&&!freshSettings.paused&&item.status==='open'&&!previous) {
      const notification={id:receiptId,itemId:j.id,title:item.title,at:new Date().toISOString(),state:j.space==='demo'?'simulated':'in_app',detail:j.space==='demo'?'Sample notification only; nothing sent outside this app.':'Shown in the private attention feed.'};
      const canSend=j.space==='live'&&recent&&!cooldown&&cfg.ALLOW_LIVE_SEND==='true'&&mayNotify(r,freshSettings)&&/^[1-9]\d*$/.test(cfg.TELEGRAM_ALERT_CHAT_ID||'')&&store.get('telegram.verified')===privateChatFingerprint();
      store.notification(j.space,receiptId,{...notification,...(canSend?{state:'pending'}:{})});
      if(canSend) {
        const delivery=await sendTelegram(cfg,`ThreadRadar: needs your attention\n\n${r.title}\n${r.summary}\n\nWhy now: ${r.whyCritical}\nOpen: ${cfg.APP_ORIGIN}`,fetcher);
        store.notification(j.space,receiptId,{...notification,...delivery});
      }
    }
    store.set(`analysis:${j.space}`,new Date().toISOString());
    error?store.fail(j):store.finish(j);
  }
  async function tick() {
    if(busy||stopped) return;busy=true;
    try {
      const now=Date.now();
      for(const space of ['demo','live']) {
        const s=store.settings(space);if(s.paused||!s.reviewMinutes) continue;
        const next=store.get(`review:${space}`);
        if(next===null) store.set(`review:${space}`,now+s.reviewMinutes*60000);
        else if(next<=now) {store.queueAll(space,now);store.set(`review:${space}`,now+s.reviewMinutes*60000);}
      }
      for(let n=0;n<5;n++) {const j=store.claim();if(!j) break;await analyze(j);}
      heartbeat=new Date().toISOString();store.set('worker.heartbeat',heartbeat);
    } finally {busy=false;}
  }
  async function gmailTick(force=false) {
    if(pollBusy||stopped||store.settings('live').paused||!gmailReady(cfg)||!store.get('gmail.auth')) return;
    const s=store.settings('live');const every=s.criticalChecks?60000:s.reviewMinutes?Math.max(60000,s.reviewMinutes*60000):Infinity;
    if(!force&&Date.now()-lastPoll<every) return;
    pollBusy=true;lastPoll=Date.now();
    try {await pollGmail(store,cfg,fetcher);} catch {store.set('source:gmail',{status:'error',lastSync:store.get('source:gmail',{}).lastSync||null,error:'Gmail sync failed. Check consent, label ID and server credentials.'});lastPoll=Date.now()+240000;} finally {pollBusy=false;}
  }
  function json(res,status,data) {res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));}
  async function body(req) {
    let size=0,chunks=[];
    for await(const chunk of req) {size+=chunk.length;if(size>128*1024) {const e=new Error('Request too large');e.status=413;throw e;}chunks.push(chunk);}
    return Buffer.concat(chunks).toString('utf8');
  }
  function safeMutation(req) {
    const reqOrigin=req.headers.origin;
    return req.headers['x-threadradar']==='1'&&(!reqOrigin||reqOrigin===cfg.APP_ORIGIN)&&String(req.headers['content-type']||'').startsWith('application/json');
  }
  const server=createServer(async(req,res)=>{
    res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','no-referrer');res.setHeader('x-frame-options','DENY');
    res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url=new URL(req.url,cfg.APP_ORIGIN),path=url.pathname;
      if(path==='/health'&&req.method==='GET') return json(res,200,{ok:true,workerRunning:timers&&!stopped,lastHeartbeat:heartbeat});
      if(path==='/webhooks/slack'&&req.method==='POST') {
        const raw=await body(req);if(!verifySlack(raw,req.headers,cfg.SLACK_SIGNING_SECRET)) return json(res,401,{error:'Invalid Slack signature'});
        const p=JSON.parse(raw);if(p.type==='url_verification') return json(res,200,{challenge:p.challenge});
        if(typeof p.event_id!=='string') return json(res,400,{error:'Missing event ID'});
        const m=slackMessage(p,cfg,store);
        if(m) {store.ingest('live',[m],{delivery:`slack:${p.event_id}`});store.set('source:slack',{status:'connected',lastSync:new Date().toISOString()});}
        return json(res,200,{ok:true});
      }
      if(path==='/webhooks/telegram'&&req.method==='POST') {
        if(!cfg.TELEGRAM_WEBHOOK_SECRET||!equal(cfg.TELEGRAM_WEBHOOK_SECRET,req.headers['x-telegram-bot-api-secret-token'])) return json(res,401,{error:'Invalid webhook secret'});
        const p=JSON.parse(await body(req));if(!Number.isInteger(p.update_id)) return json(res,400,{error:'Invalid update ID'});
        const msg=p.message;
        if(msg?.chat?.type==='private'&&String(msg.chat.id)===cfg.TELEGRAM_ALERT_CHAT_ID&&msg.from?.id===msg.chat.id&&!msg.from?.is_bot&&/^\/start(?:\s|$)/.test(msg.text||'')) store.set('telegram.verified',privateChatFingerprint());
        const m=telegramMessage(p,cfg,store);
        if(m) {store.ingest('live',[m],{delivery:`telegram:${p.update_id}`});store.set('source:telegram',{status:'connected',lastSync:new Date().toISOString()});}
        return json(res,200,{ok:true});
      }
      if(path==='/api/session'&&req.method==='GET') return json(res,200,{authenticated:authenticated(req),passwordRequired:hasPassword,liveAvailable:hasPassword});
      if(path==='/api/login'&&req.method==='POST') {
        if(!safeMutation(req)) return json(res,403,{error:'Invalid request origin or content type'});
        const ip=req.socket.remoteAddress||'local',now=Date.now();
        for(const [k,v] of loginAttempts) if(v.until<now) loginAttempts.delete(k);
        const limit=loginAttempts.get(ip)||{count:0,until:now+60000};
        if(limit.count>=5||loginAttempts.size>10000) return json(res,429,{error:'Too many attempts. Try again in a minute.'});
        limit.count++;loginAttempts.set(ip,limit);
        const input=JSON.parse(await body(req));
        if(hasPassword&&!equal(hash(input.password||''),hash(cfg.APP_PASSWORD))) return json(res,401,{error:'Incorrect password'});
        const token=randomBytes(32).toString('hex');store.set(`session:${hash(token)}`,{expires:now+8*3600000,version:hash(cfg.APP_PASSWORD||'local')});
        res.setHeader('set-cookie',`tr_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${origin.protocol==='https:'?'; Secure':''}`);
        return json(res,200,{ok:true});
      }
      if(path.startsWith('/api/')||path.startsWith('/oauth/')) {
        if(!authenticated(req)) return json(res,401,{error:'Sign in required'});
        if(req.method!=='GET'&&!safeMutation(req)) return json(res,403,{error:'Invalid request origin or content type'});
        const space=url.searchParams.get('space')||'demo';if(!['demo','live'].includes(space)) return json(res,400,{error:'Invalid mode'});
        if((space==='live'||path.startsWith('/oauth/'))&&!hasPassword) return json(res,403,{error:'Set a strong APP_PASSWORD before using live accounts'});
        if(path==='/oauth/gmail/callback'&&req.method==='GET') {
          try {await oauthFinish(store,cfg,hash(sessionId(req)),url,fetcher);res.writeHead(303,{location:'/?gmail=connected'});return res.end();} catch {return json(res,400,{error:'Gmail authorization failed or expired. Return to Sources and retry.'});}
        }
        if(path==='/api/state'&&req.method==='GET') {
          const messages=store.messages(space),items=store.items(space),jobs=store.db.prepare('SELECT COUNT(*) AS count FROM jobs WHERE space=?').get(space).count;
          return json(res,200,{space,settings:store.settings(space),messages,items,notifications:store.notifications(space).slice(0,50),sources:sources(),worker:{running:timers&&!stopped,heartbeat,busy,queued:jobs},lastAnalysis:store.get(`analysis:${space}`),nextReview:store.get(`review:${space}`),aiConfigured:!!(cfg.OPENROUTER_API_KEY&&cfg.OPENROUTER_MODEL),alertDestinationVerified:store.get('telegram.verified')===privateChatFingerprint(),liveSendAllowed:cfg.ALLOW_LIVE_SEND==='true'});
        }
        if(path==='/api/settings'&&req.method==='POST') return json(res,200,store.saveSettings(space,JSON.parse(await body(req))));
        if(path==='/api/run'&&req.method==='POST') {store.queueAll(space);if(space==='live') gmailTick(true).catch(()=>{});return json(res,202,{queued:true});}
        if(path==='/api/demo/load'&&req.method==='POST') {store.clearDemo();store.ingest('demo',demoMessages(),{force:true});return json(res,202,{loaded:12});}
        if(path==='/api/demo/message'&&req.method==='POST') {
          const m=JSON.parse(await body(req));m.account='synthetic';m.messageId=randomBytes(8).toString('hex');m.sentAt=new Date().toISOString();m.sender=m.sender||'Dana';m.conversation=m.conversation||'launch';
          if(m.text==='__critical__') m.text=`Anthony, the client launch is blocked again. Please approve immediately. Deadline: ${new Date(Date.now()+10*60000).toISOString()}`;
          if(m.text==='__resolved__') m.text='Client launch resolved. No action needed.';
          store.ingest('demo',[m]);return json(res,202,{queued:true});
        }
        if(path==='/api/item'&&req.method==='POST') {const b=JSON.parse(await body(req)),item=store.item(space,b.id);if(!item||!['open','done','dismissed'].includes(b.status)) return json(res,400,{error:'Invalid item or status'});store.saveItem(space,{...item,status:b.status});return json(res,200,{ok:true});}
        if(path==='/api/gmail/connect'&&req.method==='POST') {
          if(!hasPassword) return json(res,403,{error:'Secure login required'});
          return json(res,200,{url:oauthStart(store,cfg,hash(sessionId(req)))});
        }
        if(path==='/api/telegram/register'&&req.method==='POST') {
          if(!hasPassword||!cfg.TELEGRAM_BOT_TOKEN||!cfg.TELEGRAM_WEBHOOK_SECRET||origin.protocol!=='https:') return json(res,400,{error:'Configure bot token, secret and HTTPS origin first'});
          const data=await requestJson(fetcher,`https://api.telegram.org/bot${cfg.TELEGRAM_BOT_TOKEN}/setWebhook`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:`${cfg.APP_ORIGIN}/webhooks/telegram`,secret_token:cfg.TELEGRAM_WEBHOOK_SECRET,allowed_updates:['message','edited_message']})});
          return json(res,200,{registered:data.ok===true});
        }
        if(path==='/api/logout'&&req.method==='POST') {store.remove(`session:${hash(sessionId(req))}`);res.setHeader('set-cookie','tr_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');return json(res,200,{ok:true});}
        return json(res,404,{error:'Unknown API route'});
      }
      const assets={'/':['public/index.html','text/html'],'/app':['public/index.html','text/html'],'/app.js':['public/app.js','text/javascript'],'/style.css':['public/style.css','text/css']};
      if(req.method==='GET'&&assets[path]) {const [file,type]=assets[path];const data=await readFile(new URL(file,import.meta.url));res.writeHead(200,{'content-type':`${type}; charset=utf-8`,'cache-control':'no-store'});return res.end(data);}
      return json(res,404,{error:'Not found'});
    } catch(e) {return json(res,e.status||400,{error:e.status===413?'Payload too large':'Request failed. Check input and server configuration.'});}
  });
  server.requestTimeout=20000;server.headersTimeout=10000;
  const intervals=timers?[setInterval(()=>tick().catch(()=>{heartbeat=null;}),1000),setInterval(()=>gmailTick().catch(()=>{}),1000)]:[];
  return {server,store,tick,gmailTick,config:cfg,async close(){stopped=true;intervals.forEach(clearInterval);while(busy||pollBusy) await new Promise(r=>setTimeout(r,10));await new Promise(r=>server.listening?server.close(r):r());store.close();}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const app=createApp();app.server.listen(Number(app.config.PORT),app.config.HOST,()=>console.log(`ThreadRadar listening on ${app.config.HOST}:${app.config.PORT}. Demo data is synthetic; live connectors require configuration.`));
  for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>app.close().then(()=>process.exit(0)));
}
