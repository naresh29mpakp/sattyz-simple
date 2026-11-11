/** Shared deterministic split of the already-calculated line GST, in paise. */
export function gstSplit(order){const cgst=order.lines.reduce((sum,line)=>sum+Math.floor(line.tax/2),0);return {cgst,sgst:order.tax-cgst};}

const roundRatio=(amount,numerator,denominator)=>Number((BigInt(amount)*BigInt(numerator)+BigInt(denominator)/2n)/BigInt(denominator));
/** Allocate whole paise proportionally; deterministic largest-remainder rounding. */
export function allocate(amount,weights){
 const sum=weights.reduce((a,b)=>a+b,0);if(!sum)return weights.map(()=>0);
 const parts=weights.map((w,i)=>({i,value:Number(BigInt(amount)*BigInt(w)/BigInt(sum)),remainder:BigInt(amount)*BigInt(w)%BigInt(sum)}));
 let left=amount-parts.reduce((n,p)=>n+p.value,0);const ranked=[...parts].sort((a,b)=>a.remainder===b.remainder?a.i-b.i:a.remainder>b.remainder?-1:1);for(let i=0;i<left;i++)ranked[i].value++;
 return parts.map(p=>p.value);
}
/** Prices/rates are integer paise/basis points. Locked split lines retain original allocations. */
export function calculateBill(source,{taxMode='exclusive',discount=null}={}){
 const listed=source.map(l=>l.price*l.qty),listedSubtotal=listed.reduce((a,b)=>a+b,0);
 const requested=discount?.kind==='percent'?roundRatio(listedSubtotal,discount.value,10000):discount?.kind==='fixed'?discount.value:0;
 if(!Number.isSafeInteger(requested)||requested<0||requested>listedSubtotal)throw new Error('Discount exceeds the listed bill amount');
 const shares=allocate(requested,listed);
 const lines=source.map((line,i)=>{if(line.locked&&!discount)return {...line};const after=listed[i]-shares[i],rate=line.taxRate||0,tax=taxMode==='inclusive'?roundRatio(after,rate,10000+rate):roundRatio(after,rate,10000);return {...line,locked:false,discount:shares[i],net:taxMode==='inclusive'?after-tax:after,tax,total:taxMode==='inclusive'?after:after+tax};});
 return {lines,listedSubtotal,discountAmount:lines.reduce((s,l)=>s+(l.discount||0),0),subtotal:lines.reduce((s,l)=>s+l.net,0),tax:lines.reduce((s,l)=>s+l.tax,0),total:lines.reduce((s,l)=>s+l.total,0)};
}
/** Partition one saved line without changing its total tax or discount by even one paisa. */
export function partitionLine(line,quantity){
 if(!Number.isInteger(quantity)||quantity<1||quantity>line.qty)throw new Error('Invalid split quantity');
 const selected={...line,qty:quantity,locked:true},remaining={...line,qty:line.qty-quantity,locked:true};
 for(const key of ['discount','net','tax','total']){const amount=line[key]??(key==='net'?line.price*line.qty:key==='total'?line.price*line.qty+line.tax:0);const part=allocate(amount,[quantity,line.qty-quantity])[0];selected[key]=part;remaining[key]=amount-part;}
 selected.total=selected.net+selected.tax;remaining.total=remaining.net+remaining.tax;
 return {selected,remaining};
}
