// Synthetic preloader requires the actual compiled index; never substitutes startup logic.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),Module=require('node:module');
const {app,dialog,Tray}=require('electron');
const root=process.env.FIREFLY_MEMORY_ONLINE_DIAGNOSTIC_ROOT,mode=process.env.FIREFLY_STARTUP_CASE;
const admission=path.join(root,'fake-admission'),source=path.join(process.env.APPDATA,'Firefly','model-settings.json');
// Windows known-folder lookup can ignore APPDATA. Set Electron's path explicitly before actual index.
const environmentRedirectedAppData=path.resolve(app.getPath('appData')).toLowerCase()===path.resolve(process.env.APPDATA).toLowerCase();
app.setPath('appData',process.env.APPDATA);
assert.equal(path.resolve(app.getPath('appData')).toLowerCase(),path.resolve(process.env.APPDATA).toLowerCase());
let reads=0,writes=0,fetches=0,normalLoads=0,menu,dialogs=0,failed=false,lastDialogDetail="";
const originalLoad=Module._load;
Module._load=function(id,parent,...args){
 const normalized=String(id).replaceAll('\\','/');
 if(/normal-main|identity-preflight|core-bootstrap|background-bootstrap|gpu-sandbox-acl|agent-runtime/.test(normalized)) {normalLoads++;throw Error('ORDINARY_BOOT_FORBIDDEN');}
 return originalLoad.call(this,id,parent,...args);
};
const originalRead=fs.readFileSync,originalWrite=fs.writeFileSync;
fs.readFileSync=function(file,...args){if(path.basename(String(file))==='model-settings.json'){assert.equal(path.resolve(String(file)).toLowerCase(),source.toLowerCase(),'NON_SYNTHETIC_CONFIG_READ_FORBIDDEN');reads++;}return originalRead.call(this,file,...args);};
fs.writeFileSync=function(file,...args){if(path.resolve(String(file))===source){writes++;throw Error('SOURCE_WRITE_FORBIDDEN');}return originalWrite.call(this,file,...args);};
require('./compiled/main/memory-online-once/runner').ADMISSION_ROOT=admission;
const boundary=require('./compiled/main/memory-online-once/boundary');
const secret='SYNTHETIC-H-KEY';
globalThis.fetch=async(url,options)=>{
 fetches++;assert.equal(url,'https://api.deepseek.com/chat/completions');assert.equal(options.redirect,'error');
 assert.equal(require('node:crypto').createHash('sha256').update(options.body).digest('hex'),boundary.BODY_SHA256);
 const ledger=JSON.parse(originalRead(path.join(admission,'ledger.json'),'utf8'));
 assert.equal(ledger.reservedMicroCny,4198400);assert.equal(ledger.attempts.at(-1).status,'pending');
 if(mode==='cancel')return new Promise(()=>{});
 return new Response(JSON.stringify({id:'synthetic',object:'chat.completion',model:'deepseek-flash',choices:[{index:0,message:{role:'assistant',content:secret},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120,prompt_cache_hit_tokens:64,prompt_cache_miss_tokens:36}}));
};
dialog.showMessageBox=async(options)=>{dialogs++;lastDialogDetail=options.detail??"";assert.ok(!JSON.stringify(options).includes(secret));assert.ok(!JSON.stringify(options).includes('synthetic-profile'));assert.ok(!/SYNTHETIC-|synthetic.invalid/.test(JSON.stringify(options)));return {response:options.message==='测试版本已就绪'?1:0};};
const setMenu=Tray.prototype.setContextMenu;
Tray.prototype.setContextMenu=function(value){menu=value;return setMenu.call(this,value);};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check){for(let i=0;i<300;i++){if(check())return;await pause(20);}throw Error('CHECK_TIMEOUT');}
function state(){return JSON.parse(originalRead(path.join(root,'readiness.json'),'utf8'));}
function click(index){assert.ok(menu.items[index].enabled);menu.items[index].click();}
function untouched(){for(const file of ['boot.json','spent.json','ledger.json'])assert.equal(fs.existsSync(path.join(admission,file)),false);assert.ok(fs.existsSync(path.join(admission,'arm.json')));}
function result(){const output={mode,environmentRedirectedAppData,isPackaged:app.isPackaged,electron:process.versions.electron,node:process.versions.node,reads,writes,fetches,normalLoads,dialogs,readiness:state(),realNetworkRequests:0,realConfigurationRead:false};assert.ok(!JSON.stringify(output).includes(secret));assert.ok(!JSON.stringify(output).includes('synthetic-profile'));originalWrite(path.join(root,'result.json'),JSON.stringify(output,null,2));}
async function verify(){
 await until(()=>menu&&fs.existsSync(path.join(root,'readiness.json'))&&state().menuReady);
 assert.equal(reads,0);assert.equal(fetches,0);untouched();assert.equal(menu.items.length,5);
 assert.equal(state().phase,'awaiting-user-preparation');assert.equal(menu.items[1].enabled,false);
 if(mode==='duplicate') {await until(()=>fs.existsSync(path.join(root,'quit-verification')));assert.ok(state().duplicateCount>=1);untouched();assert.equal(reads,0);}
 else if(['provider','model','url','transport','key','empty','read-error'].includes(mode)){
  click(0);await until(()=>state().phase==='refused'&&dialogs>=2);
  const expected={provider:'PROVIDER_MISMATCH',model:'MODEL_MISMATCH',url:'BASE_URL_MISMATCH',transport:'TRANSPORT_MISMATCH',key:'KEY_MISSING',empty:'NO_SAVED_PROFILES','read-error':'CONFIGURATION_UNAVAILABLE'}[mode];
  assert.equal(menu.items[0].enabled,false);assert.equal(menu.items[1].enabled,false);assert.equal(menu.items[2].enabled,true);
  assert.deepEqual(state().preparation.reasons,[{code:expected,count:1}]);assert.ok(lastDialogDetail.includes(expected));
  for(let i=0;i<2;i++){const before=dialogs;click(2);await until(()=>dialogs>before);assert.ok(lastDialogDetail.includes(expected));}
  assert.equal(reads,1);assert.equal(writes,0);assert.equal(fetches,0);untouched();
 }
 else if(mode!=='startup'){
  click(0);await until(()=>state().phase==='ready-to-test');assert.equal(reads,1);assert.equal(writes,0);assert.equal(fetches,0);untouched();
  if(mode==='success'||mode==='cancel'){
   click(1);click(1); // Coalescing may still leave stale Menu until next microtask.
   if(mode==='cancel'){await until(()=>fetches===1);click(3);await until(()=>state().receipt?.status==='cancelled');assert.equal(fetches,1);}
   else {await until(()=>state().phase==='finished');assert.equal(fetches,2);assert.equal(state().receipt.status,'completed');}
   assert.equal(state().receipt.reservedMicroCny,4198400);
   assert.equal(fs.existsSync(path.join(admission,'spent.json')),true);
  }
 }
 assert.equal(normalLoads,0);result();click(4);
}
process.on('uncaughtException',()=>{failed=true;app.exit(1);});
try{require('./compiled/main/index');void verify().catch(()=>{originalWrite(path.join(root,'failed.json'),JSON.stringify({failed:true,reads,writes,fetches,normalLoads}));app.exit(1);});}catch{app.exit(1);}
