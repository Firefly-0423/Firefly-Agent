import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

const {values}=parseArgs({options:{repo:{type:'string'},deps:{type:'string'},out:{type:'string'},edge:{type:'string'},probe:{type:'boolean',default:false}}});
const repo=path.resolve(values.repo??fileURLToPath(new URL('../../',import.meta.url)));
const deps=path.resolve(values.deps??repo);
if(!values.out)throw Error('Pass --out with a scratch directory outside the source tree.');
const out=path.resolve(values.out);
fs.mkdirSync(path.join(out,'frames'),{recursive:true});
const {chromium}=await import(pathToFileURL(path.join(deps,'node_modules/playwright/index.mjs')));
const modelRoot=path.join(repo,'src/renderer/public/models/firefly');
const frameCount=155;
const duration=JSON.parse(fs.readFileSync(path.join(modelRoot,'Motions/Motions_Tick2_0_File_0.json'),'utf8')).Meta.Duration;
const dt=duration*1000/frameCount;
const files={
 '/core.js':path.join(repo,'src/renderer/public/live2dcubismcore.min.js'),
 '/pixi.js':path.join(deps,'node_modules/pixi.js/dist/pixi.min.js'),
 '/cubism4.js':path.join(deps,'node_modules/pixi-live2d-display/dist/cubism4.min.js'),
};
const html=`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}canvas{display:block}</style>
<script src="/core.js"></script><script src="/pixi.js"></script><script>window.process={env:{NODE_ENV:"production"}};</script><script src="/cubism4.js"></script><canvas id="c"></canvas><script>
(async()=>{try{
 const app=new PIXI.Application({view:document.getElementById('c'),width:600,height:600,backgroundAlpha:0,antialias:true,preserveDrawingBuffer:true,resolution:2});app.ticker.stop();
 const model=await PIXI.live2d.Live2DModel.from('/model/Firefly.model3.json',{ticker:app.ticker,autoUpdate:false,autoHitTest:false,autoFocus:false});
 model.anchor.set(.5,.5);model.scale.set(Math.min(550/model.width,550/model.height));model.position.set(300,300);app.stage.addChild(model);
 const internal=model.internalModel,core=internal.coreModel,partIndex=Array.from(core._model.parts.ids).indexOf('Part55');
 if(!internal.physics)throw Error('Native model physics did not load');
 if(partIndex<0)throw Error('Missing expected scene part Part55');
 const hiddenSceneIds=new Set(['ArtMesh153','ArtMesh154','ArtMesh155','ArtMesh156','ArtMesh157']);
 const sceneIndices=Array.from(core._model.drawables.ids).flatMap((id,i)=>hiddenSceneIds.has(id)?[i]:[]);
 const sceneIds=sceneIndices.map(i=>core._model.drawables.ids[i]).sort();
 if(JSON.stringify(sceneIds)!==JSON.stringify([...hiddenSceneIds].sort()))throw Error('Unexpected scene meshes: '+sceneIds);
 // Same opacity-getter mechanism used by the application's model-regions.ts;
 // the documentation recorder also removes the chair and ground shadow.
 const sceneSet=new Set(sceneIndices),getOpacity=core.getDrawableOpacity.bind(core);
 core.getDrawableOpacity=i=>sceneSet.has(i)?0:getOpacity(i);
 // The authored looping Idle motion supplies breathing; suppress the separate
 // oscillator whose unrelated period would add a second loop seam.
 internal.breath=undefined;
 let applied;internal.on('beforeModelUpdate',()=>{core.setPartOpacityByIndex(partIndex,0);applied=Object.fromEntries(['Param40','Param','Param2','Param3','Param4','Param5','Param8','Param9','Param10','Param11','ParamEyeLOpen','ParamEyeROpen'].map(id=>[id,core.getParameterValueById(id)]));});
 const motions=[];internal.motionManager.on('motionStart',(group,index)=>motions.push({group,index}));
 await model.motion('Idle',0,1);
 const idle=internal.motionManager.motionGroups.Idle[0];
 // Honor the authored Meta.Loop=true, which the installed wrapper does not set.
 idle.setIsLoop(true);idle.setIsLoopFadeIn(false);
 internal.motionManager.startRandomMotion=()=>Promise.resolve(false);
 await model.expression('expression00');
 window.preview={app,model,core,partIndex,sceneIndices,motions,getApplied:()=>applied};window.ready=true;
}catch(e){window.failure=e.stack;}})();
</script>`;
const served=new Set();
const server=http.createServer((req,res)=>{try{
 const url=new URL(req.url,'http://127.0.0.1');
 if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end(html);return;}
 let file=files[url.pathname];
 if(url.pathname.startsWith('/model/')){
  file=path.resolve(modelRoot,decodeURIComponent(url.pathname.slice(7)));
  if(!file.startsWith(modelRoot+path.sep)){res.writeHead(403);res.end();return;}
 }
 if(!file){res.writeHead(404);res.end();return;}
 served.add(file);const ext=path.extname(file);res.setHeader('Content-Type',ext==='.png'?'image/png':ext==='.js'?'application/javascript':ext==='.json'?'application/json':'application/octet-stream');res.end(fs.readFileSync(file));
}catch(e){res.writeHead(500);res.end(String(e));}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin='http://127.0.0.1:'+server.address().port;
const launch={headless:true};if(values.edge)launch.executablePath=values.edge;
const browser=await chromium.launch(launch);
try{
 const ctx=await browser.newContext({viewport:{width:600,height:600},deviceScaleFactor:1});const page=await ctx.newPage(),errors=[],blocked=[];
 page.on('pageerror',e=>errors.push(e.message));
 await ctx.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():(blocked.push(r.request().url()),r.abort()));
 await page.goto(origin);await page.waitForFunction(()=>window.ready||window.failure,{},{timeout:30000});
 const failure=await page.evaluate(()=>window.failure);if(failure)throw Error(failure);
 await page.evaluate(({steps,dt})=>{for(let i=0;i<steps;i++){preview.model.update(dt);preview.app.render();}},{steps:frameCount*5,dt});
 if(values.probe){
  const probes=[];
  for(const name of ['expression00',...Array.from({length:10},(_,i)=>'expression'+(i+1))]){
   await page.evaluate(()=>preview.model.expression('expression00'));
   await page.evaluate(dt=>{for(let i=0;i<45;i++){preview.model.update(dt);preview.app.render();}},dt);
   if(name!=='expression00'){
    const ok=await page.evaluate(name=>preview.model.expression(name),name);if(!ok)throw Error('Expression unavailable: '+name);
   }
   const f=await page.evaluate(dt=>{for(let i=0;i<45;i++){preview.model.update(dt);preview.app.render();}return {png:document.getElementById('c').toDataURL('image/png'),parameters:preview.getApplied()};},dt);
   fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(f.png.split(',')[1],'base64'));probes.push({name,parameters:f.parameters});
  }
  fs.writeFileSync(path.join(out,'expression-probes.json'),JSON.stringify(probes,null,2));console.log(JSON.stringify({probe:true,expressions:probes.map(x=>x.name),errors,blocked}));
 }else{
  // Sequence matches the existing banner: idle, ears, sunglasses, question,
  // closed-eye expression, then restore idle before the loop boundary.
  const sequence=JSON.parse(fs.readFileSync(path.join(repo,'readme-assets/sources/animation-sequence.json'),'utf8'));
  const events=new Map(sequence.events.map(x=>[x.frame,x.expression]));const records=[];
  for(let i=0;i<=frameCount;i++){
   if(events.has(i)){const name=events.get(i);const ok=await page.evaluate(name=>preview.model.expression(name),name);if(!ok)throw Error('Expression unavailable: '+name);}
   const f=await page.evaluate(({dt,i})=>{
    preview.model.update(dt);preview.app.render();const {core,sceneIndices,partIndex,model}=preview;
    const scene=sceneIndices.map(j=>({id:core._model.drawables.ids[j],opacity:core.getDrawableOpacity(j)}));
    if(core.getPartOpacityByIndex(partIndex)!==0||scene.some(x=>x.opacity!==0))throw Error('Scene visible in frame '+i);
    return {png:document.getElementById('c').toDataURL('image/png'),record:{frame:i,native_time_ms:i*dt,display_time_ms:i*80,applied_parameters:preview.getApplied(),scene,transform:{x:model.x,y:model.y,scale_x:model.scale.x,scale_y:model.scale.y}}};
   },{dt,i});
   fs.writeFileSync(path.join(out,'frames',String(i).padStart(3,'0')+'.png'),Buffer.from(f.png.split(',')[1],'base64'));records.push(f.record);
  }
  const runtime=await page.evaluate(()=>({pixi:PIXI.VERSION,motions:preview.motions,physics_loaded:!!preview.model.internalModel.physics}));
  if(errors.length||blocked.length||runtime.motions.some(x=>x.group!=='Idle'||x.index!==0))throw Error(JSON.stringify({errors,blocked,runtime}));
  const sources=[...served].filter(f=>f.startsWith(repo+path.sep)).sort().map(file=>({file:path.relative(repo,file).split(path.sep).join('/'),sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}));
  const evidence={frame_count:frameCount,native_duration_seconds:duration,display_duration_ms:12400,native_dt_ms:dt,pixel_dimensions:[1200,1200],warmup_periods:5,sequence,runtime,errors,blocked,source_files:sources,records};
  fs.writeFileSync(path.join(out,'capture-evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({frames:frameCount,display_duration_ms:12400,runtime,errors,blocked,sources:sources.length}));
 }
}finally{await browser.close();await new Promise(r=>server.close(r));}
