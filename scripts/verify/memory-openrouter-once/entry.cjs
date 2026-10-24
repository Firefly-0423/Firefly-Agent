// Entirely synthetic credential and fetch, exercising the real compiled index and preload.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),Module=require('node:module');
const {app,dialog,Tray,BrowserWindow}=require('electron');
const root=process.env.FIREFLY_OPENROUTER_DIAGNOSTIC_ROOT,mode=process.env.FIREFLY_OPENROUTER_CASE;
app.setPath('appData',process.env.APPDATA);
const admission=path.join(root,'fake-admission'),read=fs.readFileSync,write=fs.writeFileSync,load=Module._load;
let reads=0,writes=0,fetches=0,normalLoads=0,dialogs=0,menu,stage='boot',resultDialog;
const runtimeFetch=globalThis.fetch;let localServer,localUrl,localRequests=0;
const secret='SYNTHETIC-OPENROUTER-KEY-ONLY';
Module._load=function(id,parent,...rest){if(/normal-main|identity-preflight|core-bootstrap|background-bootstrap|gpu-sandbox-acl|agent-runtime|settings[\\/]model-settings/.test(String(id))){normalLoads++;throw Error('ORDINARY_FORBIDDEN');}return load.call(this,id,parent,...rest);};
fs.readFileSync=function(file,...rest){if(path.basename(String(file))==='model-settings.json'){reads++;throw Error('CONFIG_READ_FORBIDDEN');}return read.call(this,file,...rest);};
fs.writeFileSync=function(file,...rest){if(path.basename(String(file))==='model-settings.json'){writes++;throw Error('CONFIG_WRITE_FORBIDDEN');}assert.ok(!String(rest[0]).includes(secret),'KEY_DISK_FORBIDDEN');return write.call(this,file,...rest);};
require('./compiled/main/memory-openrouter-once/runner').ADMISSION_ROOT=admission;
const boundary=require('./compiled/main/memory-openrouter-once/boundary');
function completion(){return {id:'synthetic-result',object:'chat.completion',provider:'DeepSeek',model:boundary.MODEL,choices:[{index:0,message:{role:'assistant',content:secret},finish_reason:'stop'}],usage:{is_byok:false,prompt_tokens:100,completion_tokens:20,total_tokens:120,cost:0.000027}};}
globalThis.fetch=async(url,options)=>{
 fetches++;assert.equal(url,boundary.ENDPOINT);assert.equal(options.redirect,'error');assert.equal(require('node:crypto').createHash('sha256').update(options.body).digest('hex'),boundary.BODY_SHA256);const ledger=JSON.parse(read(path.join(admission,'ledger.json'),'utf8'));assert.equal(ledger.reservedNanoUsd,1e9);assert.equal(ledger.attempts.at(-1).status,'pending');
 if(mode==='transport-runtime'){assert.equal(typeof runtimeFetch,'function');return runtimeFetch(localUrl,options);}
 if(mode==='cancel')return new Promise(()=>{});
 if(mode==='network-failure'||(mode==='partial-cost'&&fetches===2))throw new Error(secret);
 if(mode==='http-failure')return new Response(secret,{status:401,headers:{'X-Secret':secret}});
 if(mode==='json-failure')return new Response('{'+secret);
 const raw=completion();if(mode==='uncertain'||mode==='usage-failure')raw.usage={};if(mode==='identity-failure')raw.model=secret;if(mode==='cost-failure')raw.usage.cost=secret;if(mode==='zero-cost')raw.usage.cost=0;
 return new Response(JSON.stringify(raw));
};
dialog.showMessageBox=async options=>{dialogs++;assert.ok(!JSON.stringify(options).includes(secret));if(options.type==='info')resultDialog=options.detail;return {response:mode==='decline'?1:0};};
const setMenu=Tray.prototype.setContextMenu;Tray.prototype.setContextMenu=function(value){menu=value;return setMenu.call(this,value);};
const pause=ms=>new Promise(r=>setTimeout(r,ms));async function until(check){for(let i=0;i<600;i++){if(check())return;await pause(20);}throw Error('TIMEOUT:'+stage);}
function state(){return JSON.parse(read(path.join(root,'readiness.json'),'utf8'));}
function click(index){assert.ok(menu.items[index].enabled,'DISABLED_MENU');menu.items[index].click();}
function untouched(){assert.equal(fs.existsSync(path.join(admission,'boot.json')),!['expired','late-arm'].includes(mode));for(const name of ['spent.json','ledger.json'])assert.equal(fs.existsSync(path.join(admission,name)),false);}
async function verify(){
 if(mode==='transport-runtime'){localServer=require('node:http').createServer((req,res)=>{localRequests++;assert.equal(req.method,'POST');assert.equal(req.headers.authorization,'Bearer '+secret);let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{assert.equal(require('node:crypto').createHash('sha256').update(body).digest('hex'),boundary.BODY_SHA256);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(completion()));});});await new Promise(resolve=>localServer.listen(0,'127.0.0.1',resolve));localUrl='http://127.0.0.1:'+localServer.address().port;}
 stage='window';await until(()=>menu&&BrowserWindow.getAllWindows().some(w=>w.isVisible())&&fs.existsSync(path.join(root,'readiness.json')));
 const win=BrowserWindow.getAllWindows()[0];assert.equal(reads,0);assert.equal(fetches,0);assert.equal(normalLoads,0);assert.equal(menu.items[1].enabled,false);if(mode!=='restart')untouched();
 stage="preferences";const prefs=win.webContents.getLastWebPreferences();assert.equal(prefs.contextIsolation,true);assert.equal(prefs.nodeIntegration,false);assert.equal(prefs.sandbox,true);win.webContents.openDevTools();await pause(50);assert.equal(win.webContents.isDevToolsOpened(),false);
 stage="empty-key";assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#key').value`),'');
 if(mode==='duplicate'){stage='duplicate';await until(()=>fs.existsSync(path.join(root,'quit-verification')));assert.ok(state().duplicateCount>=1);untouched();}
 else if(mode!=='startup'){
  stage='submit';
  if(mode==='bad-input'){
   await win.webContents.executeJavaScript(`document.querySelector('#key').value='bad';document.querySelector('#balance').checked=true;document.querySelector('form').dispatchEvent(new Event('submit',{cancelable:true}));`);
   await until(()=>true);await pause(100);assert.equal(state().prepared,false);assert.equal(fetches,0);untouched();
  }else{
   if(mode==='sender'){
    const other=new BrowserWindow({show:false,webPreferences:{preload:path.join(app.getAppPath(),'dist/preload/preload/memory-openrouter-once.js'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    await other.loadURL('data:text/html,<form id="configuration"><input id="key"><input id="balance" type="checkbox"><button id="prepare"></button><p id="status"></p></form>');
    await other.webContents.executeJavaScript(`document.querySelector('#key').value='${secret}';document.querySelector('#balance').checked=true;document.querySelector('form').dispatchEvent(new Event('submit',{cancelable:true}));`);
    await pause(100);assert.equal(state().prepared,false);other.destroy();
   }
   if(mode==='network')assert.equal(await win.webContents.executeJavaScript(`fetch('https://openrouter.ai/api/v1/models').then(()=>false,()=>true)`),true);
   await win.webContents.executeJavaScript(`document.querySelector('#key').value='${secret}';document.querySelector('#balance').checked=true;document.querySelector('form').dispatchEvent(new Event('submit',{cancelable:true}));`);
   await until(()=>state().prepared===true);assert.equal(fetches,0);if(mode!=='restart')untouched();
   assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#key').value`),'');
   if(mode==='form-close'){stage='form-close';win.close();await pause(150);assert.equal(menu.items[1].enabled,true);assert.equal(state().prepared,true);untouched();}
   if(mode==='late-arm')fs.copyFileSync(path.join(root,'late-arm-fixture.json'),path.join(admission,'arm.json'));
   if(['success','cancel','decline','expired','uncertain','restart','late-arm','transport-runtime','http-failure','json-failure','identity-failure','usage-failure','cost-failure','network-failure','partial-cost','zero-cost'].includes(mode)){
    stage='native-send';click(1);if(menu.items[1].enabled)click(1);
    if(mode==='cancel'){await until(()=>fetches===1);click(2);}
    await until(()=>['finished','cancelled'].includes(state().phase)&&state().prepared===false);
    if(mode==='cancel')await until(()=>!!state().receipt);
    const expected={success:['completed',2],cancel:['cancelled',1],expired:['refused',0],uncertain:['uncertain',1],restart:['refused',0],'late-arm':['refused',0],'transport-runtime':['completed',2],'http-failure':['uncertain',1],'json-failure':['uncertain',1],'identity-failure':['uncertain',1],'usage-failure':['uncertain',1],'cost-failure':['uncertain',1],'network-failure':['uncertain',1],'partial-cost':['uncertain',2],'zero-cost':['completed',2]}[mode];
    if(expected){assert.equal(state().receipt.status,expected[0]);assert.equal(fetches,expected[1]);await until(()=>typeof resultDialog==='string');const r=state().receipt;if(r.costStatus==='unknown'){assert.equal(r.costNanoUsd,null);assert.ok(resultDialog.includes('实际费用：未知'));assert.ok(!resultDialog.includes('已报告扣费：USD 0'));}if(mode==='partial-cost'){assert.equal(r.costStatus,'partial');assert.equal(r.costNanoUsd,27000);assert.ok(resultDialog.includes('总费用：未知；已确认部分：USD 0.000027'));}if(mode==='zero-cost'){assert.equal(r.costStatus,'complete');assert.equal(r.costNanoUsd,0);assert.ok(resultDialog.includes('已报告扣费：USD 0'));}const code={'http-failure':'HTTP_REJECTED','json-failure':'JSON_INVALID','identity-failure':'IDENTITY_MISMATCH','usage-failure':'USAGE_INVALID','cost-failure':'COST_INVALID','network-failure':'NETWORK_FAILED'}[mode];if(code){assert.equal(r.failure.code,code);assert.ok(resultDialog.includes(code));}if(mode==='http-failure')assert.equal(r.failure.httpStatus,401);}
    else {assert.equal(fetches,0);untouched();}
   }
  }
 }
 assert.equal(reads,0);assert.equal(writes,0);assert.equal(normalLoads,0);
 if(localServer){assert.equal(localRequests,2);await new Promise(resolve=>localServer.close(resolve));}
 const result={mode,runtimeFetchType:typeof runtimeFetch,localRequests,resultDialog,isPackaged:app.isPackaged,electron:process.versions.electron,fetches,reads,writes,normalLoads,dialogs,visibleWindowVerified:true,readiness:state(),externalModelRequests:0};
 assert.ok(!JSON.stringify(result).includes(secret));write(path.join(root,'result-'+mode+'.json'),JSON.stringify(result,null,2));click(3);
}
process.on('uncaughtException',()=>{app.exit(1);});
try{require('./compiled/main/index');void verify().catch(error=>{write(path.join(root,'failed.json'),JSON.stringify({failed:true,stage,fetches,reads,writes,normalLoads,code:error.code??'VERIFY_FAILED',windows:BrowserWindow.getAllWindows().map(w=>({visible:w.isVisible(),loading:w.webContents.isLoading(),destroyed:w.isDestroyed(),dataUrl:w.webContents.getURL().startsWith('data:'),prefs:(()=>{const p=w.webContents.getLastWebPreferences();return {sandbox:p.sandbox,contextIsolation:p.contextIsolation,nodeIntegration:p.nodeIntegration,devTools:p.devTools};})()}))}));app.exit(1);});}catch{app.exit(1);}
