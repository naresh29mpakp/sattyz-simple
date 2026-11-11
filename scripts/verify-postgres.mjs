// Isolated cloud verification only. Receives credentials through hidden stdin.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openStore} from '../store.mjs';
import {createService} from '../service.mjs';

async function input(){
  if(process.stdin.isTTY)process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');process.stdin.resume();
  console.log('Ready for verification JSON on hidden stdin.');
  return new Promise((resolve,reject)=>{
    let buffer='';
    const receive=chunk=>{
      buffer+=chunk;
      if(buffer.length>20000){process.stdin.pause();reject(new Error('Input too large'));return;}
      if(/[\r\n]/.test(buffer)){
        process.stdin.off('data',receive);process.stdin.pause();
        try{resolve(JSON.parse(buffer.trim()));}catch{reject(new Error('Invalid input'));}
      }
    };
    process.stdin.on('data',receive);
  });
}
let store;
try{
  const config=await input();
  assert.equal(new URL(config.databaseUrl).hostname,config.expectedHost,'Verification host must be explicitly selected.');
  store=await openStore({databaseUrl:config.databaseUrl});
  const service=await createService(store);
  const before=await service.state();assert.equal(before.menu.length,100);
  const user={name:'Isolated cloud verification',email:'qa@localhost'};
  const save={requestId:randomUUID(),id:null,version:0,tableId:null,lines:[{menuId:before.menu[0].id,qty:2}]};
  const created=await service.mutate('/api/bills/save',save,user);
  const repeated=await service.mutate('/api/bills/save',save,user);assert.equal(created.bill.id,repeated.bill.id);
  const payment={requestId:randomUUID(),version:created.bill.version,method:'UPI',device:'QA HDFC record only',reference:randomUUID()};
  const paid=await service.mutate(`/api/bills/${created.bill.id}/pay`,payment,user);
  assert.equal(paid.bill.status,'Paid');assert.equal(paid.bill.payment.confirmation,'manual');
  const paidRetry=await service.mutate(`/api/bills/${created.bill.id}/pay`,payment,user);assert.equal(paidRetry.bill.id,paid.bill.id);
  const stock=await service.mutate('/api/stock/save',{requestId:randomUUID(),name:'QA rice '+Date.now(),unit:'kg',lowAt:2},user);
  const stockId=stock.stock?.id||stock.id||stock.item?.id;
  assert.ok(stockId,'Stock response needs its item identity.');
  const purchase={requestId:randomUUID(),stockId,quantity:5,amount:10000,date:before.businessDate,method:'UPI',note:'Isolated QA purchase'};
  await service.mutate('/api/stock/purchase',purchase,user);await service.mutate('/api/stock/purchase',purchase,user);
  const after=await service.state();
  assert.equal(after.summary.sales,before.summary.sales+paid.bill.total);
  assert.equal(after.summary.spending,before.summary.spending+10000);
  assert.equal(after.stock.find(row=>row.id===stockId).quantity,5);
  assert.equal((await service.bill(paid.bill.id)).payment.amount,paid.bill.total);
  console.log(JSON.stringify({ok:true,storage:'real PostgreSQL',catalogItems:after.menu.length,billRetry:true,paymentRetry:true,savedReceipt:true,purchaseCountedOnce:true,scope:'isolated verification branch; manual payment record only'}));
}catch(error){console.error('Database verification failed:',error.code||error.name, String(error.message).replace(/postgres(?:ql)?:\/\/\S+/g,'[redacted connection]'));process.exitCode=1;}
finally{if(store)await store.close();}
