import {readFile,mkdir,readdir,writeFile} from 'node:fs/promises';
import sharp from 'sharp';
const root=new URL('../',import.meta.url);
const originals=new URL('output/photo-originals/',root),destination=new URL('public/photos/',root);
await mkdir(destination,{recursive:true});
let before=0,after=0;
for(const file of await readdir(originals)){
  if(!file.endsWith('.png'))continue;
  const bytes=await readFile(new URL(file,originals));before+=bytes.length;
  const encoded=await sharp(bytes).resize({width:480,withoutEnlargement:true}).webp({quality:78}).toBuffer();
  await writeFile(new URL(file.replace(/\.png$/,'.webp'),destination),encoded);after+=encoded.length;
}
console.log(JSON.stringify({sourceBytes:before,thumbnailBytes:after}));
