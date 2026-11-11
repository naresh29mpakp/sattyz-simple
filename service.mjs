import {createHash, randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {calculateBill} from './bill-model.js';

export const fail = (message, status = 400, code = 'INVALID_INPUT') => { throw Object.assign(new Error(message), {status, code}); };
const object = value => { if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Use an object for this request.'); return value; };
const text = (value, label, max = 120, empty = false) => {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) fail(`${label} is required and must be at most ${max} characters.`);
  return value.trim();
};
const number = (value, label, min = 0) => { if (!Number.isSafeInteger(value) || value < min) fail(`${label} must be a whole number of paise or units.`); return value; };
const milli = (value, label, allowNegative = false) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || (!allowNegative && value < 0) || Math.abs(value * 1000 - Math.round(value * 1000)) > 0.000001 || !Number.isSafeInteger(Math.round(value * 1000))) fail(`${label} must be a number with at most three decimal places.`);
  return Math.round(value * 1000);
};
export const businessDate = (instant = new Date()) => new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Kolkata', year:'numeric', month:'2-digit', day:'2-digit'}).format(instant);
const validDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value + 'T00:00:00Z')) || new Date(value + 'T00:00:00Z').toISOString().slice(0,10) !== value) fail('Choose a valid date.');
  return value;
};
const method = value => { if (!['UPI', 'Cash', 'Card'].includes(value)) fail('Choose UPI, Cash or Card.'); return value; };
const canonical = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const schema = [
  'CREATE TABLE IF NOT EXISTS app_settings (id TEXT PRIMARY KEY, data TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS bill_counter (id TEXT PRIMARY KEY, value INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS menu (id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, variant TEXT NOT NULL, price BIGINT NOT NULL CHECK(price>=0), available INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS dining_tables (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE)',
  "CREATE TABLE IF NOT EXISTS bills (id TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE, version INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('Open','Paid','Cancelled')), table_id TEXT REFERENCES dining_tables(id), lines TEXT NOT NULL, total BIGINT NOT NULL CHECK(total>=0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, paid_date TEXT)",
  "CREATE UNIQUE INDEX IF NOT EXISTS one_open_table ON bills(table_id) WHERE status='Open' AND table_id IS NOT NULL",
  'CREATE INDEX IF NOT EXISTS bills_day ON bills(paid_date, number)',
  'CREATE TABLE IF NOT EXISTS payments (bill_id TEXT PRIMARY KEY REFERENCES bills(id), method TEXT NOT NULL, device TEXT NOT NULL, reference TEXT NOT NULL, confirmed_by TEXT NOT NULL, received_at TEXT NOT NULL, amount BIGINT NOT NULL, confirmation TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS receipt_snapshots (bill_id TEXT PRIMARY KEY REFERENCES bills(id), data TEXT NOT NULL)',
  "CREATE UNIQUE INDEX IF NOT EXISTS payment_reference ON payments(method,device,reference) WHERE reference<>''",
  'CREATE TABLE IF NOT EXISTS stock (id TEXT PRIMARY KEY, name TEXT NOT NULL, unit TEXT NOT NULL, quantity_milli BIGINT NOT NULL CHECK(quantity_milli>=0), low_milli BIGINT NOT NULL CHECK(low_milli>=0))',
  'CREATE TABLE IF NOT EXISTS expenses (id TEXT PRIMARY KEY, date TEXT NOT NULL, category TEXT NOT NULL, amount BIGINT NOT NULL CHECK(amount>=0), note TEXT NOT NULL, method TEXT NOT NULL, source TEXT NOT NULL, stock_id TEXT REFERENCES stock(id), quantity_milli BIGINT, created_at TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS expenses_day ON expenses(date, created_at)',
  'CREATE TABLE IF NOT EXISTS stock_movements (id TEXT PRIMARY KEY, stock_id TEXT NOT NULL REFERENCES stock(id), delta_milli BIGINT NOT NULL, note TEXT NOT NULL, expense_id TEXT REFERENCES expenses(id), created_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, entity TEXT NOT NULL, entity_id TEXT NOT NULL, before_data TEXT, after_data TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL)',
];
const defaults = {name:'Sattyz Kitchen',address:'',phone:'',paperWidth:58,hdfcDevice:'HDFC soundbox / POS'};
const menuRow = row => ({id:row.id,name:row.name,category:row.category,variant:row.variant,price:Number(row.price),available:!!row.available});
const stockRow = row => ({id:row.id,name:row.name,unit:row.unit,quantity:Number(row.quantity_milli)/1000,lowAt:Number(row.low_milli)/1000});
const expenseRow = row => ({id:row.id,date:row.date,category:row.category,amount:Number(row.amount),note:row.note,method:row.method,source:row.source,stockId:row.stock_id,quantity:row.quantity_milli == null ? null : Number(row.quantity_milli)/1000});
const billSelect = 'SELECT b.*,p.method AS pay_method,p.device AS pay_device,p.reference AS pay_reference,p.confirmed_by AS pay_confirmed_by,p.received_at AS pay_received_at,p.amount AS pay_amount,p.confirmation AS pay_confirmation,r.data AS receipt_data FROM bills b LEFT JOIN payments p ON p.bill_id=b.id LEFT JOIN receipt_snapshots r ON r.bill_id=b.id';
const billRow = row => ({id:row.id,number:Number(row.number),version:Number(row.version),status:row.status,tableId:row.table_id,lines:JSON.parse(row.lines),total:Number(row.total),createdAt:row.created_at,updatedAt:row.updated_at,receipt:row.receipt_data?JSON.parse(row.receipt_data):null,payment:row.pay_method?{method:row.pay_method,device:row.pay_device,reference:row.pay_reference,confirmedBy:row.pay_confirmed_by,receivedAt:row.pay_received_at,amount:Number(row.pay_amount),confirmation:row.pay_confirmation}:null});

export async function createService(store) {
  const catalog = JSON.parse(await readFile(new URL('./catalog/sattyz-menu.json', import.meta.url), 'utf8'));
  await store.transaction(async tx => {
    for (const sql of schema) await tx.query(sql);
    await tx.query('INSERT INTO bill_counter(id,value) VALUES(?,?) ON CONFLICT(id) DO NOTHING', ['bill',0]);
    const existing = await tx.query('SELECT id FROM app_settings WHERE id=?', ['main']);
    if (!existing.rows.length) {
      await tx.query('INSERT INTO app_settings(id,data) VALUES(?,?)', ['main',JSON.stringify(defaults)]);
      for (const item of catalog.items) await tx.query('INSERT INTO menu(id,name,category,variant,price,available) VALUES(?,?,?,?,?,?)', [item.id,item.name,item.category,item.variant,item.price,1]);
      for (let i=1;i<=8;i++) await tx.query('INSERT INTO dining_tables(id,name) VALUES(?,?)', ['table-'+i,'Table '+i]);
    }
  });
  const settings = async tx => JSON.parse((await tx.query('SELECT data FROM app_settings WHERE id=?',['main'])).rows[0].data);
  const getBill = async (tx,id) => {
    text(id,'Bill ID',100);
    const row = (await tx.query(billSelect+' WHERE b.id=?',[id])).rows[0];
    if (!row) fail('This bill was not found.',404,'NOT_FOUND');
    return billRow(row);
  };
  const audit = (tx,entity,id,before,after,user) => tx.query('INSERT INTO audit(id,entity,entity_id,before_data,after_data,actor,created_at) VALUES(?,?,?,?,?,?,?)',[randomUUID(),entity,id,before?JSON.stringify(before):null,JSON.stringify(after),user.name||user.email||'Owner',new Date().toISOString()]);
  const countBelow = async (tx,table,limit,where='') => { const count = Number((await tx.query(`SELECT COUNT(*) AS n FROM ${table} ${where}`)).rows[0].n); if(count>=limit) fail(`The ${table==='bills'?'open bill':table} limit (${limit}) has been reached. Finish open work or export records before adding more.`,409,'CAPACITY'); };
  const checkOpen = (bill,version) => {
    number(version,'Bill version',1);
    if(bill.status!=='Open') fail('This bill is already closed. Its saved receipt cannot be changed.',409,'BILL_CLOSED');
    if(bill.version!==version) fail('This bill changed on another screen. Reload it and review your changes.',409,'STALE_BILL');
  };
  async function perform(tx,path,b,user) {
    const now=new Date().toISOString();
    if(path==='/api/bills/save') {
      if(!Array.isArray(b.lines)||!b.lines.length||b.lines.length>100) fail('Add between 1 and 100 bill lines.');
      const id=b.id==null?randomUUID():text(b.id,'Bill ID',100);
      const old=b.id==null?null:await getBill(tx,id);
      if(old) checkOpen(old,b.version); else { number(b.version,'New bill version'); if(b.version!==0) fail('A new bill starts at version zero.'); await countBelow(tx,'bills',500,"WHERE status='Open'"); }
      const tableId=b.tableId==null?null:text(b.tableId,'Table',100);
      if(tableId) {
        if(!(await tx.query('SELECT id FROM dining_tables WHERE id=?',[tableId])).rows.length) fail('This table was not found.',404,'NOT_FOUND');
        if((await tx.query("SELECT number FROM bills WHERE table_id=? AND status='Open' AND id<>?",[tableId,id])).rows.length) fail('This table already has an open bill. Choose another table or No table.',409,'TABLE_BUSY');
      }
      const seen=new Set();
      const lines=[];
      for(const raw of b.lines) {
        const line=object(raw),menuId=text(line.menuId,'Menu item',100),qty=number(line.qty,'Quantity',1);
        if(qty>999) fail('Quantity must be at most 999.');
        let saved;
        if(line.lineId!=null) {
          const lineId=text(line.lineId,'Saved line',100);
          if(seen.has(lineId)) fail('A saved line cannot appear twice.');
          seen.add(lineId);
          saved=old?.lines.find(value=>value.lineId===lineId);
          if(!saved||saved.menuId!==menuId) fail('This saved item does not belong to this bill. Reload the bill.',409,'INVALID_LINE');
        }
        if(saved) lines.push({...saved,qty});
        else {
          const item=(await tx.query('SELECT * FROM menu WHERE id=?',[menuId])).rows[0];
          if(!item||!item.available) fail('A selected item is no longer available. Remove it and try again.',409,'ITEM_UNAVAILABLE');
          lines.push({lineId:randomUUID(),menuId:item.id,name:item.name,variant:item.variant,price:Number(item.price),qty,taxRate:0});
        }
      }
      const calculated=calculateBill(lines);
      if(!Number.isSafeInteger(calculated.total)) fail('This bill amount is too large.');
      const snapshots=calculated.lines.map(({lineId,menuId,name,variant,price,qty,total})=>({lineId,menuId,name,variant,price,qty,total}));
      if(old) await tx.query('UPDATE bills SET version=?,table_id=?,lines=?,total=?,updated_at=? WHERE id=?',[old.version+1,tableId,JSON.stringify(snapshots),calculated.total,now,id]);
      else {
        await tx.query('UPDATE bill_counter SET value=value+1 WHERE id=?',['bill']);
        const n=Number((await tx.query('SELECT value FROM bill_counter WHERE id=?',['bill'])).rows[0].value);
        await tx.query('INSERT INTO bills(id,number,version,status,table_id,lines,total,created_at,updated_at,paid_date) VALUES(?,?,?,?,?,?,?,?,?,?)',[id,n,1,'Open',tableId,JSON.stringify(snapshots),calculated.total,now,now,null]);
      }
      const bill=await getBill(tx,id); await audit(tx,'bill',id,old,bill,user); return {bill};
    }
    const action=path.match(/^\/api\/bills\/([^/]+)\/(pay|cancel)$/);
    if(action) {
      const bill=await getBill(tx,action[1]); checkOpen(bill,b.version);
      if(action[2]==='pay') {
        const paymentMethod=method(b.method),config=await settings(tx);
        const device=paymentMethod==='Cash'?'Cash':text(b.device??config.hdfcDevice,'Payment device',100);
        const reference=text(b.reference??'','Reference',120,true);
        if(reference&&(await tx.query('SELECT bill_id FROM payments WHERE method=? AND device=? AND reference=?',[paymentMethod,device,reference])).rows.length) fail('That payment reference is already attached to another bill.',409,'REFERENCE_USED');
        await tx.query('INSERT INTO payments(bill_id,method,device,reference,confirmed_by,received_at,amount,confirmation) VALUES(?,?,?,?,?,?,?,?)',[bill.id,paymentMethod,device,reference,user.name||user.email||'Owner',now,bill.total,'manual']);
        await tx.query('INSERT INTO receipt_snapshots(bill_id,data) VALUES(?,?)',[bill.id,JSON.stringify(config)]);
        await tx.query('UPDATE bills SET status=?,version=?,updated_at=?,paid_date=? WHERE id=?',['Paid',bill.version+1,now,businessDate(),bill.id]);
      } else await tx.query('UPDATE bills SET status=?,version=?,updated_at=? WHERE id=?',['Cancelled',bill.version+1,now,bill.id]);
      const after=await getBill(tx,bill.id); await audit(tx,'bill',bill.id,bill,after,user); return {bill:after};
    }
    if(path==='/api/menu/save') {
      const id=b.id==null?randomUUID():text(b.id,'Menu ID',100);
      const previous=(await tx.query('SELECT * FROM menu WHERE id=?',[id])).rows[0];
      if(b.id&&!previous) fail('This menu item was not found.',404,'NOT_FOUND');
      if(!previous) await countBelow(tx,'menu',1000);
      if(typeof b.available!=='boolean') fail('Availability must be true or false.');
      const item={id,name:text(b.name,'Food name'),category:text(b.category,'Category'),variant:text(b.variant??'','Variant',100,true),price:number(b.price,'Price'),available:b.available};
      if(previous) await tx.query('UPDATE menu SET name=?,category=?,variant=?,price=?,available=? WHERE id=?',[item.name,item.category,item.variant,item.price,item.available?1:0,id]);
      else await tx.query('INSERT INTO menu(id,name,category,variant,price,available) VALUES(?,?,?,?,?,?)',[id,item.name,item.category,item.variant,item.price,item.available?1:0]);
      await audit(tx,'menu',id,previous,item,user); return {ok:true,item};
    }
    if(path==='/api/tables/save') {
      const id=b.id==null?randomUUID():text(b.id,'Table ID',100),name=text(b.name,'Table name',50);
      const previous=(await tx.query('SELECT * FROM dining_tables WHERE id=?',[id])).rows[0];
      if(b.id&&!previous) fail('This table was not found.',404,'NOT_FOUND');
      if(!previous) await countBelow(tx,'dining_tables',100);
      if((await tx.query('SELECT id FROM dining_tables WHERE name=? AND id<>?',[name,id])).rows.length) fail('A table already has that name.',409,'TABLE_NAME_USED');
      if(previous) await tx.query('UPDATE dining_tables SET name=? WHERE id=?',[name,id]);
      else await tx.query('INSERT INTO dining_tables(id,name) VALUES(?,?)',[id,name]);
      await audit(tx,'table',id,previous,{id,name},user); return {ok:true};
    }
    if(path==='/api/stock/save') {
      const id=b.id==null?randomUUID():text(b.id,'Stock ID',100),name=text(b.name,'Stock name'),unit=text(b.unit,'Unit',30),low=milli(b.lowAt,'Low-stock level');
      const previous=(await tx.query('SELECT * FROM stock WHERE id=?',[id])).rows[0];
      if(b.id&&!previous) fail('This stock item was not found.',404,'NOT_FOUND');
      if(!previous) await countBelow(tx,'stock',1000);
      if(previous&&previous.unit!==unit) {
        const history=await tx.query('SELECT id FROM stock_movements WHERE stock_id=? LIMIT 1',[id]);
        if(Number(previous.quantity_milli)!==0||history.rows.length) fail('This item has stock history. Add a new stock item to use another unit.',409,'UNIT_IN_USE');
      }
      if(previous) await tx.query('UPDATE stock SET name=?,unit=?,low_milli=? WHERE id=?',[name,unit,low,id]);
      else await tx.query('INSERT INTO stock(id,name,unit,quantity_milli,low_milli) VALUES(?,?,?,?,?)',[id,name,unit,0,low]);
      await audit(tx,'stock',id,previous,{id,name,unit,lowAt:b.lowAt},user); return {ok:true,id};
    }
    if(path==='/api/stock/purchase'||path==='/api/stock/adjust') {
      const id=text(b.stockId,'Stock item',100),previous=(await tx.query('SELECT * FROM stock WHERE id=?',[id])).rows[0];
      if(!previous) fail('This stock item was not found.',404,'NOT_FOUND');
      const purchase=path.endsWith('/purchase'),delta=purchase?milli(b.quantity,'Purchase quantity'):milli(b.delta,'Adjustment',true);
      if((purchase&&delta<=0)||(!purchase&&delta===0)) fail('Enter a non-zero stock quantity.');
      const quantity=Number(previous.quantity_milli)+delta;
      if(!Number.isSafeInteger(quantity)||quantity<0) fail('This adjustment would make stock negative.',409,'NEGATIVE_STOCK');
      const note=text(b.note??'','Note',500,purchase),expenseId=purchase?randomUUID():null;
      if(purchase) await tx.query('INSERT INTO expenses(id,date,category,amount,note,method,source,stock_id,quantity_milli,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',[expenseId,validDate(b.date),'Stock purchase',number(b.amount,'Amount'),note,method(b.method),'stock',id,delta,now]);
      await tx.query('UPDATE stock SET quantity_milli=? WHERE id=?',[quantity,id]);
      await tx.query('INSERT INTO stock_movements(id,stock_id,delta_milli,note,expense_id,created_at) VALUES(?,?,?,?,?,?)',[randomUUID(),id,delta,note,expenseId,now]);
      await audit(tx,'stock',id,previous,{quantity:quantity/1000,note,expenseId},user); return {ok:true};
    }
    if(path==='/api/expenses/save') {
      const id=b.id==null?randomUUID():text(b.id,'Spending ID',100),previous=(await tx.query('SELECT * FROM expenses WHERE id=?',[id])).rows[0];
      if(b.id&&!previous) fail('This spending entry was not found.',404,'NOT_FOUND');
      if(previous?.source==='stock') fail('This entry belongs to a stock purchase and cannot be edited separately.',409,'PURCHASE_LINKED');
      const entry={id,date:validDate(b.date),category:text(b.category,'Category',80),amount:number(b.amount,'Amount'),note:text(b.note??'','Note',500,true),method:method(b.method)};
      if(previous) await tx.query('UPDATE expenses SET date=?,category=?,amount=?,note=?,method=? WHERE id=?',[entry.date,entry.category,entry.amount,entry.note,entry.method,id]);
      else await tx.query('INSERT INTO expenses(id,date,category,amount,note,method,source,stock_id,quantity_milli,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',[id,entry.date,entry.category,entry.amount,entry.note,entry.method,'manual',null,null,now]);
      await audit(tx,'expense',id,previous,entry,user); return {ok:true};
    }
    if(path==='/api/settings') {
      const previous=await settings(tx);
      if(![58,80].includes(b.paperWidth)) fail('Choose 58 mm or 80 mm paper.');
      const next={name:text(b.name,'Restaurant name'),address:text(b.address??'','Address',400,true),phone:text(b.phone??'','Phone',50,true),paperWidth:b.paperWidth,hdfcDevice:text(b.hdfcDevice,'HDFC device name',100)};
      await tx.query('UPDATE app_settings SET data=? WHERE id=?',[JSON.stringify(next),'main']); await audit(tx,'settings','main',previous,next,user); return {ok:true};
    }
    fail('This action was not found.',404,'NOT_FOUND');
  }
  const billPage=async ({date=businessDate(),page=1}={},tx=store) => {
    validDate(date); number(page,'Page',1); if(page>100000) fail('Page is too large.');
    const result=await tx.query(billSelect+' WHERE b.paid_date=? ORDER BY b.number DESC LIMIT 51 OFFSET ?',[date,(page-1)*50]);
    return {bills:result.rows.slice(0,50).map(billRow),hasMore:result.rows.length>50};
  };
  return {
    bill: id=>getBill(store,id),
    bills:billPage,
    async state(date=businessDate()) {
      validDate(date);
      return store.transaction(async tx => {
      const [config,menu,tables,stock,open,recent,expenses,sales,spending,unpaid]=await Promise.all([
        settings(tx),tx.query('SELECT * FROM menu ORDER BY category,name,variant'),tx.query('SELECT * FROM dining_tables ORDER BY name'),tx.query('SELECT * FROM stock ORDER BY name'),
        tx.query(billSelect+" WHERE b.status='Open' ORDER BY b.number DESC"),billPage({date,page:1},tx),tx.query('SELECT * FROM expenses WHERE date=? ORDER BY created_at DESC LIMIT 100',[date]),
        tx.query("SELECT COALESCE(SUM(p.amount),0) AS sales,COUNT(*) AS count,COALESCE(SUM(CASE WHEN p.method='UPI' THEN p.amount ELSE 0 END),0) AS upi,COALESCE(SUM(CASE WHEN p.method='Cash' THEN p.amount ELSE 0 END),0) AS cash,COALESCE(SUM(CASE WHEN p.method='Card' THEN p.amount ELSE 0 END),0) AS card FROM payments p JOIN bills b ON b.id=p.bill_id WHERE b.paid_date=?",[date]),
        tx.query('SELECT COALESCE(SUM(amount),0) AS amount,COUNT(*) AS count FROM expenses WHERE date=?',[date]),tx.query("SELECT COALESCE(SUM(total),0) AS amount FROM bills WHERE status='Open'"),
      ]);
      const totals=sales.rows[0];
      return {settings:config,menu:menu.rows.map(menuRow),tables:tables.rows,stock:stock.rows.map(stockRow),openBills:open.rows.map(billRow),recentBills:recent.bills,expenses:expenses.rows.map(expenseRow),summary:{sales:Number(totals.sales),upi:Number(totals.upi),cash:Number(totals.cash),card:Number(totals.card),spending:Number(spending.rows[0].amount),unpaid:Number(unpaid.rows[0].amount),paidCount:Number(totals.count)},businessDate:date,coverage:{recentBillsHasMore:recent.hasMore,expensesShown:expenses.rows.length,expenseCount:Number(spending.rows[0].count)}};
      });
    },
    async mutate(path,body,user) {
      const b=object(body); object(user); text(user.name||user.email||'Owner','Operator',200);
      const requestId=text(b.requestId,'Request ID',128);
      const fingerprint=createHash('sha256').update(JSON.stringify(canonical({path,body:b}))).digest('hex');
      try {
        return await store.transaction(async tx=>{
          const saved=(await tx.query('SELECT * FROM operations WHERE id=?',[requestId])).rows[0];
          if(saved) { if(saved.fingerprint!==fingerprint) fail('This request ID was already used for different details. Refresh and try again.',409,'REQUEST_REUSED'); return JSON.parse(saved.response); }
          const response=await perform(tx,path,b,user);
          await tx.query('INSERT INTO operations(id,fingerprint,response,created_at) VALUES(?,?,?,?)',[requestId,fingerprint,JSON.stringify(response),new Date().toISOString()]);
          return response;
        });
      } catch(error) {
        if(error.code==='23505'||error.code==='ERR_SQLITE_ERROR'&&/UNIQUE constraint failed/.test(error.message)) fail('Another bill or entry already uses those details. Refresh and review.',409,'CONFLICT');
        throw error;
      }
    },
  };
}
