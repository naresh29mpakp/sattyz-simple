/** AI-generated illustrative serving suggestions. Variants may share a photograph.
 * This is the single photo-selection boundary; photos do not establish ingredients,
 * dietary labels, recipes or the actual appearance of Sattyz's food.
 */
export function photoKey(item){
  const name=String(item.name||'').toLowerCase(),category=String(item.category||'').toLowerCase();
  if(/bir[iy]y?ani|biryani/.test(name))return 'biryani';
  if(/shawarma/.test(name))return 'shawarma';
  if(/grill/.test(name))return 'grill';
  if(/soup/.test(category)||/soup|manchow|hot & sour/.test(name))return name.includes('veg')?'veg-soup':'soup';
  if(/milk shake|milkshake/.test(name))return 'milkshake';
  if(category.includes('chill-o-chill'))return 'drink';
  if(/naan|roti/.test(name))return 'naan';
  if(/sandwich|twister/.test(name))return 'sandwich';
  if(/fries|nachos/.test(name))return 'fries';
  if(/noodle/.test(name))return item.variant?.toLowerCase()==='veg'?'veg-noodles':'noodles';
  if(/curd rice/.test(name))return 'curd-rice';
  if(/rice/.test(name))return item.variant?.toLowerCase()==='chicken'||item.variant?.toLowerCase()==='egg'||name.includes('chicken')?'rice':'veg-rice';
  if(/cashew fry/.test(name))return 'cashew';
  if(/channa/.test(name))return 'channa';
  if(/dal/.test(name))return 'dal';
  if(/egg/.test(name))return 'egg';
  if(category.includes('curries')||/masala|chettinad|hyderabadi|pallipalayam/.test(name)){
    if(name.includes('paneer'))return 'paneer-curry';
    if(name.includes('chicken'))return 'chicken-curry';
    return 'veg-curry';
  }
  if(name.includes('paneer'))return 'paneer-fry';
  if(/gobi|babycorn|mushroom/.test(name)||category.includes('veg starters'))return 'vegetable-fry';
  if(name.includes('chicken')||category.includes('chicken'))return 'chicken-fry';
  return 'veg-curry';
}
export const photoFor=item=>`/photos/${photoKey(item)}-v1.webp`;
