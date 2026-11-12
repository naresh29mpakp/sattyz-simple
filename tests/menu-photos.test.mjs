import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {photoFor} from '../public/menu-photos.js';
test('every seeded menu entry has a valid local WebP serving suggestion',async()=>{
 const catalog=JSON.parse(await readFile(new URL('../catalog/sattyz-menu.json',import.meta.url),'utf8'));
 const paths=new Set(catalog.items.map(photoFor));
 for(const path of paths){const data=await readFile(new URL('../public'+path,import.meta.url));assert.equal(data.toString('ascii',0,4),'RIFF',path);assert.equal(data.toString('ascii',8,12),'WEBP',path);}
 assert.equal(catalog.items.length,100);
 assert.notEqual(photoFor({name:'Veg Soup',category:'Soup'}),photoFor({name:'Chicken Soup',category:'Soup'}));
 assert.notEqual(photoFor({name:'Fried Rice',variant:'Veg'}),photoFor({name:'Fried Rice',variant:'Chicken'}));
});
