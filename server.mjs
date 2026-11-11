import http from 'node:http';
import {readFile,stat,mkdir} from 'node:fs/promises';
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import {openStore} from './store.mjs';
import {createService} from './service.mjs';
import {createGoogleAuth} from './google-auth.mjs';

const root=fileURLToPath(new URL('./',import.meta.url));
const publicRoot=path.join(root,'public');
const digest=value=>createHash('sha256').update(value).digest('hex');
const problem=(status,message,code='invalid_request')=>Object.assign(new Error(message),{status,code});
const temporaryIdentity='temporary-test@localhost';
const temporaryActive=config=>!!config.temporaryPasswordHash&&Date.now()<config.temporaryUntil;

export function readConfig(env=process.env){
  const production=env.NODE_ENV==='production';
  const port=Number(env.PORT||4320);
  if(!Number.isInteger(port)||port<0||port>65535)throw new Error('PORT must be a valid TCP port.');
  const publicUrl=env.PUBLIC_URL||`http://127.0.0.1:${port}`;
  const parsed=new URL(publicUrl);
  if(!['http:','https:'].includes(parsed.protocol)||parsed.pathname!=='/'||parsed.search||parsed.hash||parsed.username||parsed.password)throw new Error('PUBLIC_URL must be an HTTP(S) website origin only.');
  const ownerEmail=(env.OWNER_EMAIL||'').trim().toLowerCase();
  const google={clientId:env.GOOGLE_CLIENT_ID,clientSecret:env.GOOGLE_CLIENT_SECRET,redirectUri:env.GOOGLE_REDIRECT_URI};
  const googleConfigured=!!(ownerEmail&&google.clientId&&google.clientSecret&&google.redirectUri);
  if(googleConfigured&&google.redirectUri!==`${parsed.origin}/api/google/callback`)throw new Error('GOOGLE_REDIRECT_URI must match PUBLIC_URL and end with /api/google/callback.');
  if(production&&(!env.DATABASE_URL||!googleConfigured||parsed.protocol!=='https:'))throw new Error('Production requires DATABASE_URL, HTTPS PUBLIC_URL, OWNER_EMAIL and the three Google OAuth settings.');
  const localPassword=!production&&['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)?env.LOCAL_PASSWORD||'':'';
  if(localPassword&&localPassword.length<12)throw new Error('LOCAL_PASSWORD must have at least 12 characters.');
  return {production,port,host:env.HOST||(production?'0.0.0.0':'127.0.0.1'),origin:parsed.origin,ownerEmail,google,googleConfigured,localPassword,temporaryPasswordHash:'',temporaryUntil:0,databaseUrl:env.DATABASE_URL,sqlitePath:path.resolve(env.DATA_DIR||path.join(root,'data'),'preview.sqlite')};
}

async function readJson(req){
  if(req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json')throw problem(415,'Please send JSON.');
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>65536)throw problem(413,'This request is too large. Please use fewer items.');chunks.push(chunk);}
  let value;
  try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw problem(400,'The request could not be read. Please try again.');}
  if(!value||typeof value!=='object'||Array.isArray(value))throw problem(400,'A JSON object is required.');
  return value;
}

const cookies=req=>Object.fromEntries((req.headers.cookie||'').split(';').map(part=>part.trim().split(/=(.*)/s).slice(0,2)).filter(pair=>pair.length===2));
export async function createApp({store,config,googleTransport}={}){
  config??=readConfig();
  let ownsStore=false;
  if(!store){
    if(!config.databaseUrl)await mkdir(path.dirname(config.sqlitePath),{recursive:true});
    store=await openStore({databaseUrl:config.databaseUrl,sqlitePath:config.sqlitePath});ownsStore=true;
  }
  for(const sql of [
    'CREATE TABLE IF NOT EXISTS simple_sessions (id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL, expires_at TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS simple_google_flows (id TEXT PRIMARY KEY, data TEXT NOT NULL, expires_at TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS simple_owner (id INTEGER PRIMARY KEY, subject TEXT NOT NULL, email TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS simple_temp_access (id INTEGER PRIMARY KEY, password_hash TEXT NOT NULL, expires_at TEXT NOT NULL)'
  ])await store.query(sql);
  const temporaryRow=(await store.query('SELECT password_hash,expires_at FROM simple_temp_access WHERE id=1')).rows[0];
  if(temporaryRow&&/^[a-f0-9]{64}$/.test(temporaryRow.password_hash)&&Number.isFinite(Date.parse(temporaryRow.expires_at))){
    config.temporaryPasswordHash=temporaryRow.password_hash;config.temporaryUntil=Date.parse(temporaryRow.expires_at);
  }else{config.temporaryPasswordHash='';config.temporaryUntil=0;}
  const service=await createService(store);
  const flowStore={
    reserve:async(id,value)=>store.transaction(async tx=>{
      await tx.query('DELETE FROM simple_google_flows WHERE expires_at <= ?',[new Date().toISOString()]);
      const count=await tx.query('SELECT COUNT(*) AS total FROM simple_google_flows');
      if(Number(count.rows[0].total)>=100)return false;
      await tx.query('INSERT INTO simple_google_flows (id,data,expires_at) VALUES (?,?,?)',[id,JSON.stringify(value),new Date(value.expires).toISOString()]);return true;
    }),
    take:async id=>store.transaction(async tx=>{
      const result=await tx.query('SELECT data FROM simple_google_flows WHERE id=?',[id]);
      await tx.query('DELETE FROM simple_google_flows WHERE id=?',[id]);
      return result.rows[0]?JSON.parse(result.rows[0].data):undefined;
    })
  };
  const google=createGoogleAuth({...config.google,transport:googleTransport,flowStore});
  const secure=config.production||config.origin.startsWith('https:');
  const sessionCookie=secure?'__Host-sattyz':'sattyz_session';
  const flowCookie=secure?'__Host-sattyz-flow':'sattyz_flow';
  const cookie=(name,value,seconds)=>`${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secure?'; Secure':''}`;
  async function session(req){
    const token=cookies(req)[sessionCookie];if(!token||!/^[A-Za-z0-9_-]{43}$/.test(token))return null;
    const result=await store.query('SELECT email,name FROM simple_sessions WHERE id=? AND expires_at>?',[digest(token),new Date().toISOString()]);
    const user=result.rows[0]||null;
    return user?.email===temporaryIdentity&&!temporaryActive(config)?null:user;
  }
  async function issue(user){
    const token=randomBytes(32).toString('base64url');
    const expires=Math.min(Date.now()+12*3600000,user.email===temporaryIdentity?config.temporaryUntil:Infinity);
    await store.transaction(async tx=>{
      await tx.query('DELETE FROM simple_sessions WHERE expires_at<=?',[new Date().toISOString()]);
      await tx.query('INSERT INTO simple_sessions (id,email,name,expires_at) VALUES (?,?,?,?)',[digest(token),user.email,user.name,new Date(expires).toISOString()]);
    });
    return cookie(sessionCookie,token,Math.max(0,Math.floor((expires-Date.now())/1000)));
  }
  const attempts=new Map();
  const handler=async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','same-origin');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'");
    res.setHeader('Cache-Control','no-store');
    if(secure)res.setHeader('Strict-Transport-Security','max-age=31536000');
    const json=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
    try{
      const url=new URL(req.url,config.origin);
      if(url.pathname==='/api/health'&&req.method==='GET'){
        await store.query('SELECT 1');return json(200,{ok:true,storage:config.databaseUrl?'postgres':'local-preview'});
      }
      if(url.pathname==='/api/auth'&&req.method==='GET')return json(200,{user:await session(req),googleConfigured:config.googleConfigured,localLogin:!!config.localPassword,temporaryLogin:temporaryActive(config),temporaryUntil:temporaryActive(config)?new Date(config.temporaryUntil).toISOString():null});
      if(url.pathname==='/api/google/start'&&req.method==='GET'){
        if(!config.googleConfigured)throw problem(503,'Google sign-in is awaiting the owner’s hosting setup.','auth_not_configured');
        const start=await google.start();res.writeHead(302,{Location:start.url,'Set-Cookie':cookie(flowCookie,start.browserToken,300)});return res.end();
      }
      if(url.pathname==='/api/google/callback'&&req.method==='GET'){
        if(!config.googleConfigured)throw problem(503,'Google sign-in is not configured.');
        const user=await google.finish(`${config.origin}${url.pathname}${url.search}`,cookies(req)[flowCookie]);
        if(user.email.toLowerCase()!==config.ownerEmail)throw problem(403,'This Google account is not the configured Sattyz owner.','wrong_owner');
        await store.transaction(async tx=>{
          const result=await tx.query('SELECT subject FROM simple_owner WHERE id=1');
          if(result.rows[0]&&result.rows[0].subject!==user.subject)throw problem(403,'This account does not match the linked owner.','wrong_owner');
          if(!result.rows[0])await tx.query('INSERT INTO simple_owner (id,subject,email) VALUES (1,?,?)',[user.subject,user.email]);
        });
        const issued=await issue(user);res.writeHead(302,{Location:'/', 'Set-Cookie':[issued,cookie(flowCookie,'',0)]});return res.end();
      }
      if(url.pathname.startsWith('/api/')){
        if(!['GET','POST'].includes(req.method))throw problem(405,'This action is not supported.');
        let body;
        if(req.method==='POST'){
          if(req.headers.origin!==config.origin)throw problem(403,'Please use this website to submit changes.','origin_denied');
          body=await readJson(req);
        }
        if(url.pathname==='/api/login'&&req.method==='POST'){
          const temporary=temporaryActive(config);
          if(!config.localPassword&&!temporary)throw problem(403,'Please use Google sign-in. Temporary access is unavailable or expired.');
          const now=Date.now(),key=req.socket.remoteAddress||'local';
          for(const [k,v]of attempts)if(v.until<now)attempts.delete(k);
          const limit=attempts.get(key)||{count:0,until:now+15*60000};
          if(limit.count>=8||(!attempts.has(key)&&attempts.size>=500))throw problem(429,'Too many attempts. Please wait 15 minutes.');
          limit.count++;attempts.set(key,limit);
          const expected=temporary?config.temporaryPasswordHash:digest(config.localPassword);
          if(typeof body.password!=='string'||body.password.length>512||!timingSafeEqual(Buffer.from(digest(body.password)),Buffer.from(expected)))throw problem(401,'That password did not match. Please try again.');
          attempts.delete(key);const user=temporary?{name:'Temporary testing',email:temporaryIdentity}:{name:'Local preview',email:'preview@localhost'};
          res.setHeader('Set-Cookie',await issue(user));return json(200,{user});
        }
        const user=await session(req);if(!user)throw problem(401,'Please sign in to continue.','sign_in_required');
        if(url.pathname==='/api/logout'&&req.method==='POST'){
          const token=cookies(req)[sessionCookie];if(token)await store.query('DELETE FROM simple_sessions WHERE id=?',[digest(token)]);
          res.setHeader('Set-Cookie',cookie(sessionCookie,'',0));return json(200,{ok:true});
        }
        if(req.method==='GET'){
          if(url.pathname==='/api/state')return json(200,await service.state(url.searchParams.get('date')||undefined));
          if(url.pathname==='/api/bills')return json(200,await service.bills({date:url.searchParams.get('date')||undefined,page:Number(url.searchParams.get('page')||1)}));
          const match=url.pathname.match(/^\/api\/bills\/([^/]+)$/);if(match)return json(200,await service.bill(match[1]));
          throw problem(404,'This page was not found.');
        }
        return json(200,await service.mutate(url.pathname,body,user));
      }
      if(req.method!=='GET'&&req.method!=='HEAD')throw problem(405,'This action is not supported.');
      const pathname=decodeURIComponent(url.pathname);
      const file=path.resolve(publicRoot,pathname==='/'?'index.html':'.'+pathname);
      if(!file.startsWith(publicRoot+path.sep))throw problem(404,'File not found.');
      const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.jpg':'image/jpeg','.png':'image/png','.ico':'image/x-icon'};
      const type=types[path.extname(file)];if(!type)throw problem(404,'File not found.');
      const info=await stat(file).catch(()=>null);if(!info?.isFile())throw problem(404,'File not found.');
      res.setHeader('Content-Type',type);
      if(req.method==='HEAD')return res.end();
      res.end(await readFile(file));
    }catch(error){
      if(res.headersSent){res.destroy();return;}
      const status=Number.isInteger(error.status)&&error.status>=400&&error.status<600?error.status:500;
      if(status===500)console.error('Request failed:',error.code||'internal');
      json(status,{error:status===500?'Could not complete this action. Your bill has not been cleared. Please retry.':error.message,code:status===500?'internal':error.code});
    }
  };
  return {handler,service,close:async()=>{if(ownsStore)await store.close();}};
}

export async function start(config=readConfig()){
  const app=await createApp({config});
  const server=http.createServer(app.handler);server.requestTimeout=30000;server.headersTimeout=15000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.host,resolve);});
  console.log(`Sattyz Kitchen: ${config.origin}`);
  const stop=()=>{server.close(async()=>{await app.close();process.exit(0);});server.closeIdleConnections();};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  return {server,app};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  start().catch(error=>{console.error('Sattyz could not start:',error.code?'Check database access and server environment.':error.message);process.exitCode=1;});
}
