import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
const {values}=parseArgs({options:{repo:{type:'string'},deps:{type:'string'},out:{type:'string'},edge:{type:'string'}}});
if(!values.repo||!values.out)throw Error('Pass --repo and --out');
const repo=path.resolve(values.repo),out=path.resolve(values.out);fs.mkdirSync(out,{recursive:true});
const {chromium}=await import(pathToFileURL(path.join(values.deps??repo,'node_modules/playwright/index.mjs')));
const launch={headless:true};if(values.edge)launch.executablePath=values.edge;
const browser=await chromium.launch(launch);
try{const page=await browser.newPage({viewport:{width:1792,height:468},deviceScaleFactor:1});
for(const lang of ['zh','en'])for(const theme of ['light','dark']){
 const name='banner-'+theme+(lang==='en'?'.en':'')+'.svg';
 let svg=fs.readFileSync(path.join(repo,'readme-assets/sources',name),'utf8').replace('width="896" height="234"','width="1792" height="468"');
 await page.setContent('<!doctype html><meta charset="utf-8"><style>html,body{margin:0}svg{display:block}</style>'+svg);
 await page.evaluate(()=>document.fonts.ready);
 await page.screenshot({path:path.join(out,'background-'+theme+'.'+lang+'.png')});
}console.log(JSON.stringify({backgrounds:4,dimensions:[1792,468]}));}finally{await browser.close();}
