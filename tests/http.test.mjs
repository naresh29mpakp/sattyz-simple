import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp,readConfig} from '../server.mjs';
import {openStore} from '../store.mjs';

const password='only-for-isolated-http-tests';
async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'sattyz-http-'));
  const config=readConfig({NODE_ENV:'development',PORT:'0',LOCAL_PASSWORD:password,DATA_DIR:dir});
  const store=await openStore({sqlitePath:join(dir,'test.sqlite')});
  const app=await createApp({store,config});
  const server=http.createServer(app.handler);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  config.origin=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{
    await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
    await app.close();await store.close();await rm(dir,{recursive:true,force:true});
  });
  let cookie='';
  const request=async (path,{method='GET',body,headers={},raw}={})=>fetch(config.origin+path,{
    method,headers:{...(cookie?{cookie}:{}),...(method==='POST'?{origin:config.origin,'content-type':'application/json'}:{}),...headers},
    ...(raw!==undefined?{body:raw}:body!==undefined?{body:JSON.stringify(body)}:{}),redirect:'manual',
  });
  const login=async()=>{
    const response=await request('/api/login',{method:'POST',body:{password}});
    assert.equal(response.status,200);
    const setCookie=response.headers.get('set-cookie');
    assert.match(setCookie,/HttpOnly/);assert.match(setCookie,/SameSite=Lax/);
    cookie=setCookie.split(';')[0];return cookie;
  };
  const post=(path,body)=>request(path,{method:'POST',body:{requestId:randomUUID(),...body}});
  return {request,post,login,config,store};
}

test('HTTP login protects records and logout revokes its persisted session',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/api/state')).status,401);
  const initial=await (await f.request('/api/auth')).json();
  assert.equal(initial.user,null);assert.equal(initial.localLogin,true);assert.equal(initial.googleConfigured,false);
  assert.equal((await f.request('/api/login',{method:'POST',body:{password:'incorrect'}})).status,401);
  await f.login();
  const state=await (await f.request('/api/state')).json();
  assert.equal(state.menu.length,100);assert.equal(state.summary.sales,0);
  const sessionRow=(await f.store.query('SELECT * FROM simple_sessions')).rows[0];
  assert.match(sessionRow.id,/^[a-f0-9]{64}$/);assert.equal(sessionRow.name,'Local preview');
  assert.equal((await f.post('/api/logout',{})).status,200);
  assert.equal((await f.request('/api/state')).status,401);
  assert.equal((await f.store.query('SELECT * FROM simple_sessions')).rows.length,0);
});

test('HTTP boundary rejects foreign origins, media types, malformed JSON and unsupported methods',async t=>{
  const f=await fixture(t);await f.login();
  let result=await f.request('/api/bills/save',{method:'POST',headers:{origin:'https://another.example'},body:{}});
  assert.equal(result.status,403);assert.equal((await result.json()).code,'origin_denied');
  result=await f.request('/api/bills/save',{method:'POST',headers:{'content-type':'text/plain'},raw:'{}'});
  assert.equal(result.status,415);
  result=await f.request('/api/bills/save',{method:'POST',headers:{'content-type':'application/jsonish'},raw:'{}'});
  assert.equal(result.status,415);
  result=await f.request('/api/bills/save',{method:'POST',raw:'{"broken"'});
  assert.equal(result.status,400);
  for(const raw of ['[]','null','42']) assert.equal((await f.request('/api/bills/save',{method:'POST',raw})).status,400);
  assert.equal((await f.request('/api/state',{method:'DELETE'})).status,405);
  assert.equal((await f.request('/api/bills/save',{method:'POST',headers:{origin:''},body:{}})).status,403);
  const state=await (await f.request('/api/state')).json();assert.equal(state.openBills.length,0);
});

test('HTTP bill→manual payment→history keeps saved payment identity and totals',async t=>{
  const f=await fixture(t);await f.login();
  const state=await (await f.request('/api/state')).json(),item=state.menu[0];
  const savedResponse=await f.post('/api/bills/save',{id:null,version:0,tableId:null,lines:[{menuId:item.id,qty:2}]});
  assert.equal(savedResponse.status,200);
  const open=(await savedResponse.json()).bill;
  const paymentBody={requestId:randomUUID(),version:open.version,method:'UPI',device:'HDFC test counter',reference:'HTTP-TEST-UTR'};
  const paidResponse=await f.post(`/api/bills/${open.id}/pay`,paymentBody);
  assert.equal(paidResponse.status,200);
  const paid=(await paidResponse.json()).bill;
  assert.equal(paid.status,'Paid');assert.equal(paid.payment.confirmation,'manual');assert.equal(paid.payment.amount,item.price*2);
  const retry=await (await f.post(`/api/bills/${open.id}/pay`,paymentBody)).json();assert.deepEqual(retry.bill,paid);
  const snapshot=await (await f.request(`/api/bills/${paid.id}`)).json();assert.deepEqual(snapshot,paid);
  const refreshed=await (await f.request('/api/state')).json();
  assert.equal(refreshed.openBills.length,0);assert.equal(refreshed.summary.sales,paid.total);assert.equal(refreshed.summary.upi,paid.total);
  const history=await (await f.request(`/api/bills?date=${refreshed.businessDate}&page=1`)).json();
  assert.equal(history.bills.length,1);assert.equal(history.bills[0].payment.reference,'HTTP-TEST-UTR');assert.equal(history.hasMore,false);
  const edit=await f.post('/api/bills/save',{id:paid.id,version:paid.version,tableId:null,lines:paid.lines});assert.equal(edit.status,409);
  const badPage=await f.request('/api/bills?page=oops');assert.equal(badPage.status,400);
  await f.post('/api/logout',{});
  assert.equal((await f.request(`/api/bills/${paid.id}`)).status,401);
});

test('production configuration requires persistent storage, HTTPS and owner Google sign-in',()=>{
  const production={NODE_ENV:'production',PORT:'4320',PUBLIC_URL:'https://billing.example.invalid',DATABASE_URL:'postgres://not-a-real-server/db',OWNER_EMAIL:'owner@example.invalid',GOOGLE_CLIENT_ID:'test-client',GOOGLE_CLIENT_SECRET:'test-secret',GOOGLE_REDIRECT_URI:'https://billing.example.invalid/api/google/callback',LOCAL_PASSWORD:password};
  const configured=readConfig(production);
  assert.equal(configured.localPassword,'');assert.equal(configured.googleConfigured,true);assert.equal(configured.host,'0.0.0.0');
  for(const field of ['DATABASE_URL','OWNER_EMAIL','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_REDIRECT_URI']) assert.throws(()=>readConfig({...production,[field]:undefined}),/Production requires/);
  assert.throws(()=>readConfig({...production,PUBLIC_URL:'http://billing.example.invalid',GOOGLE_REDIRECT_URI:'http://billing.example.invalid/api/google/callback'}),/Production requires/);
  assert.throws(()=>readConfig({...production,GOOGLE_REDIRECT_URI:'https://elsewhere.example.invalid/api/google/callback'}),/GOOGLE_REDIRECT_URI must match/);
  assert.throws(()=>readConfig({...production,PUBLIC_URL:'https://billing.example.invalid/extra'}),/origin only/);
  assert.equal(readConfig({NODE_ENV:'development',PUBLIC_URL:'http://remote.example.invalid',LOCAL_PASSWORD:password}).localPassword,'');
});

test('temporary login requires its secret and expires both login and issued sessions',async t=>{
  const f=await fixture(t);f.config.localPassword='';
  const expiry=new Date(Date.now()+60000).toISOString();
  await f.store.query('INSERT INTO simple_temp_access(id,password_hash,expires_at) VALUES(?,?,?)',[1,createHash('sha256').update(password).digest('hex'),expiry]);
  await createApp({store:f.store,config:f.config});
  assert.equal((await (await f.request('/api/auth')).json()).temporaryLogin,true);
  assert.equal((await f.post('/api/login',{password:'wrong-password'})).status,401);
  await f.login();
  assert.equal((await f.request('/api/state')).status,200);
  const saved=(await f.store.query('SELECT * FROM simple_sessions')).rows[0];
  assert.ok(Date.parse(saved.expires_at)<=f.config.temporaryUntil);
  f.config.temporaryUntil=Date.now()-1;
  assert.equal((await (await f.request('/api/auth')).json()).temporaryLogin,false);
  assert.equal((await f.request('/api/state')).status,401);
  assert.equal((await f.post('/api/login',{password})).status,403);
});
