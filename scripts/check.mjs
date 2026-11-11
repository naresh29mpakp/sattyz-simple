import {spawnSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const files=readdirSync(root).filter(p=>p.endsWith('.mjs')||p.endsWith('.js'));
files.push(...readdirSync(new URL('../public/',import.meta.url)).filter(p=>p.endsWith('.js')).map(p=>'public/'+p));
for(const file of files){const result=spawnSync(process.execPath,['--check',file],{cwd:root,stdio:'inherit'});if(result.status!==0)process.exit(result.status||1);}
console.log(`Syntax checked ${files.length} source files.`);
