import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../store.mjs';
import {createService,businessDate} from '../service.mjs';

const owner={name:'Test owner',email:'owner@example.invalid'};
async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'sattyz-simple-'));
  const store=await openStore({sqlitePath:join(dir,'test.sqlite')});
  t.after(async()=>{await store.close();await rm(dir,{recursive:true,force:true});});
  const service=await createService(store);
  const state=await service.state();
  const mutate=(path,body)=>service.mutate(path,{requestId:randomUUID(),...body},owner);
  const save=(fields={})=>mutate('/api/bills/save',{id:null,version:0,tableId:null,lines:[{menuId:state.menu[0].id,qty:1}],...fields});
  return {store,service,state,mutate,save};
}
const rejectsCode=(action,code)=>assert.rejects(action,error=>error.code===code);

test('source catalog and empty financial records seed once',async t=>{
  const f=await fixture(t);
  assert.equal(f.state.menu.length,100);
  assert.equal(f.state.tables.length,8);
  assert.equal(f.state.stock.length,0);
  assert.deepEqual(f.state.summary,{sales:0,upi:0,cash:0,card:0,spending:0,unpaid:0,paidCount:0});
  assert.equal(f.state.menu.find(x=>x.name==='Mirchi Biriyani'&&x.variant==='Standard Serve').price,17000);
  await createService(f.store);
  assert.equal((await f.service.state()).menu.length,100);
});

test('a bill works without a table, then attaches and detaches a table',async t=>{
  const f=await fixture(t);
  const first=(await f.save()).bill;
  assert.equal(first.status,'Open'); assert.equal(first.tableId,null);
  const assigned=(await f.save({id:first.id,version:first.version,tableId:f.state.tables[0].id,lines:first.lines})).bill;
  assert.equal(assigned.tableId,f.state.tables[0].id);
  const detached=(await f.save({id:assigned.id,version:assigned.version,tableId:null,lines:assigned.lines})).bill;
  assert.equal(detached.tableId,null); assert.equal(detached.version,3);
  assert.equal((await f.service.state()).stock.length,0);
  assert.equal((await f.store.query('SELECT COUNT(*) AS n FROM stock_movements')).rows[0].n,0);
});

test('request retries return one result and changed reuse is rejected',async t=>{
  const f=await fixture(t),requestId=randomUUID();
  const body={requestId,id:null,version:0,tableId:null,lines:[{menuId:f.state.menu[0].id,qty:2}]};
  const first=await f.mutate('/api/bills/save',body);
  assert.deepEqual(await f.mutate('/api/bills/save',body),first);
  await rejectsCode(f.mutate('/api/bills/save',{...body,lines:[{menuId:f.state.menu[0].id,qty:3}]}),'REQUEST_REUSED');
  assert.equal((await f.service.state()).openBills.length,1);
  const changed=(await f.save({id:first.bill.id,version:first.bill.version,lines:first.bill.lines})).bill;
  assert.equal(changed.version,2);
  await rejectsCode(f.save({id:first.bill.id,version:first.bill.version,lines:first.bill.lines}),'STALE_BILL');
});

test('saved line snapshots survive menu changes and new lines use current prices',async t=>{
  const f=await fixture(t),item=f.state.menu[0],old=(await f.save()).bill;
  await f.mutate('/api/menu/save',{...item,name:'Changed display name',price:item.price+1500});
  const edited=(await f.save({id:old.id,version:old.version,lines:[{...old.lines[0],qty:2},{menuId:item.id,qty:1}]})).bill;
  assert.equal(edited.lines[0].name,item.name);
  assert.equal(edited.lines[0].price,item.price);
  assert.equal(edited.lines[0].total,item.price*2);
  assert.equal(edited.lines[1].price,item.price+1500);
  assert.equal(edited.total,item.price*3+1500);
  await rejectsCode(f.save({id:edited.id,version:edited.version,lines:[{...edited.lines[0],lineId:'foreign-line'}]}),'INVALID_LINE');
});

test('table occupancy, manual full payment and reprints have one saved owner',async t=>{
  const f=await fixture(t),tableId=f.state.tables[0].id,open=(await f.save({tableId})).bill;
  await f.mutate('/api/settings',{...f.state.settings,name:'Original test kitchen',address:'Old test road',phone:'555-0100'});
  await rejectsCode(f.save({tableId}),'TABLE_BUSY');
  const requestId=randomUUID(),payment={requestId,version:open.version,method:'UPI',device:'HDFC counter',reference:'UTR-ONE'};
  const paid=(await f.mutate(`/api/bills/${open.id}/pay`,payment)).bill;
  assert.equal(paid.status,'Paid'); assert.equal(paid.payment.confirmation,'manual');
  assert.equal(paid.payment.amount,open.total); assert.equal(paid.payment.reference,'UTR-ONE');
  assert.equal(paid.receipt.name,'Original test kitchen');assert.equal(paid.receipt.address,'Old test road');assert.equal(paid.receipt.phone,'555-0100');
  await f.mutate('/api/settings',{...f.state.settings,name:'Changed test kitchen',address:'New test road',phone:'555-0200',paperWidth:80});
  assert.deepEqual((await f.mutate(`/api/bills/${open.id}/pay`,payment)).bill,paid);
  await rejectsCode(f.save({id:paid.id,version:paid.version,tableId,lines:paid.lines}),'BILL_CLOSED');
  await rejectsCode(f.mutate(`/api/bills/${paid.id}/pay`,{version:paid.version,method:'UPI'}),'BILL_CLOSED');
  const next=(await f.save({tableId})).bill;
  await rejectsCode(f.mutate(`/api/bills/${next.id}/pay`,{version:next.version,method:'UPI',device:'HDFC counter',reference:'UTR-ONE'}),'REFERENCE_USED');
  assert.equal((await f.service.bill(paid.id)).payment.amount,open.total);
  const reprint=await f.service.bill(paid.id);
  assert.equal(reprint.receipt.name,'Original test kitchen');assert.equal(reprint.receipt.address,'Old test road');assert.equal(reprint.receipt.phone,'555-0100');
  assert.equal((await f.service.state()).settings.name,'Changed test kitchen');
  const summary=(await f.service.state()).summary;
  assert.equal(summary.sales,open.total); assert.equal(summary.upi,open.total); assert.equal(summary.paidCount,1); assert.equal(summary.unpaid,next.total);
});

test('stock purchase adds one linked spending entry; failed adjustments are atomic',async t=>{
  const f=await fixture(t),stockId=(await f.mutate('/api/stock/save',{name:'Rice',unit:'kg',lowAt:2})).id;
  const requestId=randomUUID(),purchase={requestId,stockId,quantity:5.125,amount:72000,date:businessDate(),method:'UPI',note:'Supplier receipt'};
  await f.mutate('/api/stock/purchase',purchase); await f.mutate('/api/stock/purchase',purchase);
  const state=await f.service.state();
  assert.equal(state.stock[0].quantity,5.125); assert.equal(state.expenses.length,1); assert.equal(state.expenses[0].source,'stock'); assert.equal(state.summary.spending,72000);
  await rejectsCode(f.mutate('/api/stock/adjust',{stockId,delta:-6,note:'Incorrect quantity'}),'NEGATIVE_STOCK');
  assert.equal((await f.service.state()).stock[0].quantity,5.125);
  await f.mutate('/api/stock/adjust',{stockId,delta:-0.125,note:'Spillage'});
  assert.equal((await f.service.state()).stock[0].quantity,5);
  await rejectsCode(f.mutate('/api/expenses/save',{id:state.expenses[0].id,date:businessDate(),category:'Stock',amount:1,note:'',method:'UPI'}),'PURCHASE_LINKED');
  assert.equal((await f.store.query('SELECT COUNT(*) AS n FROM stock_movements')).rows[0].n,2);
  await rejectsCode(f.mutate('/api/stock/save',{id:stockId,name:'Rice',unit:'bags',lowAt:2}),'UNIT_IN_USE');
  await f.mutate('/api/stock/adjust',{stockId,delta:-5,note:'Stock fully used'});
  await rejectsCode(f.mutate('/api/stock/save',{id:stockId,name:'Rice',unit:'bags',lowAt:2}),'UNIT_IN_USE');
});

test('spending corrections retain audit while period totals use current amounts',async t=>{
  const f=await fixture(t);
  await f.mutate('/api/expenses/save',{date:businessDate(),category:'Electricity',amount:25000,note:'Meter bill',method:'Cash'});
  const expense=(await f.service.state()).expenses[0];
  await f.mutate('/api/expenses/save',{...expense,amount:23000,note:'Corrected receipt'});
  assert.equal((await f.service.state()).summary.spending,23000);
  const history=await f.store.query('SELECT * FROM audit WHERE entity=? AND entity_id=?',['expense',expense.id]);
  assert.equal(history.rows.length,2); assert.equal(JSON.parse(history.rows[1].before_data).amount,25000);
  const yesterday=new Date(Date.now()-86400000);
  assert.equal((await f.service.state(businessDate(yesterday))).summary.spending,0);
});

test('malformed boundary input fails without changing records',async t=>{
  const f=await fixture(t);
  for(const body of [null,[],{requestId:'x',lines:[]},{requestId:'y',version:0,lines:[{menuId:f.state.menu[0].id,qty:1.5}]}]) await rejectsCode(f.service.mutate('/api/bills/save',body,owner),'INVALID_INPUT');
  await rejectsCode(f.service.state('2026-02-31'),'INVALID_INPUT');
  await rejectsCode(f.mutate('/api/stock/save',{name:'Rice',unit:'kg',lowAt:NaN}),'INVALID_INPUT');
  assert.equal((await f.service.state()).openBills.length,0);
});

test('local standalone reads cannot observe a partially committed transaction',async t=>{
  const f=await fixture(t);
  let entered,release;
  const started=new Promise(resolve=>{entered=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  const pending=f.store.transaction(async tx=>{await tx.query('INSERT INTO dining_tables(id,name) VALUES(?,?)',['atomic-table','Atomic table']); entered(); await gate; throw new Error('Rollback');});
  await started;
  let readFinished=false;
  const read=f.store.query('SELECT * FROM dining_tables WHERE id=?',['atomic-table']).then(result=>{readFinished=true;return result;});
  await Promise.resolve(); assert.equal(readFinished,false);
  release(); await assert.rejects(pending,/Rollback/);
  assert.equal((await read).rows.length,0);
});
