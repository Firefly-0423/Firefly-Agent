const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const repo = path.resolve(__dirname, '../..');
const { _electron } = require(path.join(repo, 'node_modules/playwright'));
const full = process.argv.includes('--full');
const output = path.join(repo, 'output', full ? 'plugin-electron-ui-'+Date.now() : 'plugin-electron-ui');
const root = path.join(output, 'isolated');
for (const dir of ['profile', 'appdata', 'localappdata', 'temp', 'cache', 'logs', 'early']) fs.mkdirSync(path.join(root, dir), {recursive:true});
const entry = path.join(output, 'entry.cjs');
fs.writeFileSync(entry, `
const {app,session,dialog,shell}=require('electron');
app.setAppPath(${JSON.stringify(repo)});
global.__pluginQa={blockedRequests:[],dialogs:[],zip:null,holdDialog:false};
dialog.showOpenDialog=async()=>{global.__pluginQa.dialogs.push({kind:'open'});while(global.__pluginQa.holdDialog)await new Promise(r=>setTimeout(r,50));return {canceled:!global.__pluginQa.zip,filePaths:global.__pluginQa.zip?[global.__pluginQa.zip]:[]};};
dialog.showMessageBox=async options=>{global.__pluginQa.dialogs.push({title:options.title,message:options.message});return {response:1,checkboxChecked:false};};
shell.openExternal=async()=>{throw Error('QA_EXTERNAL_LINK_BLOCKED')};
app.whenReady().then(()=>session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,done)=>{global.__pluginQa.blockedRequests.push(details.url);done({cancel:true})}));
require(${JSON.stringify(path.join(repo,'dist/main/main/index.js'))});
`);
const env = {...process.env, VITE_DEV:'', ELECTRON_RUN_AS_NODE:'', FIREFLY_RUNTIME_PROFILE:'test', FIREFLY_ISOLATION_ROOT:path.join(root,'profile'), APPDATA:path.join(root,'appdata'), LOCALAPPDATA:path.join(root,'localappdata'), TEMP:path.join(root,'temp'), TMP:path.join(root,'temp'), TMPDIR:path.join(root,'temp'), ELECTRON_LOG_FILE:path.join(root,'logs','electron.log'), CHROME_LOG_FILE:path.join(root,'logs','chromium.log')};
delete env.ELECTRON_RUN_AS_NODE;
// No production credentials or external catalog are required.
let electron;
let rawChild;
const report={output,checks:[],screenshots:[],failures:[]};
const record=(name,details={})=>{report.checks.push({name,...details});fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log('PASS',name)};
async function shot(page,name){await page.screenshot({path:path.join(output,name+'.png')});report.screenshots.push(name+'.png');}
async function start(early=false){
  electron = await _electron.launch({executablePath:path.join(repo,'node_modules/electron/dist/electron.exe'),args:[entry,'--firefly-profile=test','--firefly-isolation-root='+path.join(root,'profile'),'--user-data-dir='+path.join(root,'early'),'--disk-cache-dir='+path.join(root,'cache'),'--crash-dumps-dir='+path.join(root,'logs','crashes')],cwd:repo,env,timeout:45000});
  const processLog = fs.createWriteStream(path.join(output,'process.log'),{flags:'a'});
  electron.process().stdout?.pipe(processLog); electron.process().stderr?.pipe(processLog);
  const paths = await electron.evaluate(({app})=>({appPath:app.getAppPath(),userData:app.getPath('userData'),sessionData:app.getPath('sessionData'),logs:app.getPath('logs')}));
  assert.equal(paths.appPath,repo); assert.equal(paths.userData,path.join(root,'profile','Firefly-test'));
  console.log('ISOLATION_VERIFIED',JSON.stringify(paths));
  if(early)return;
  let chat;for(let i=0;i<150;i++){chat=electron.windows().find(p=>p.url().includes('/react/index.html'));if(chat)break;await new Promise(r=>setTimeout(r,200));}
  assert.ok(chat,'No real React window');
  chat.setDefaultTimeout(12000);
  await chat.waitForLoadState('domcontentloaded');
  await chat.locator('body').waitFor();
  await chat.waitForFunction(()=>typeof window.plugins?.list==='function',null,{timeout:15000});
  for(let i=0;i<150;i++){if(await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.webContents.getURL().includes('/react/index.html')&&w.isVisible())))break;await new Promise(r=>setTimeout(r,100));}
  await chat.waitForFunction(async()=>{try{return !!(await window.plugins.list()).plugins}catch{return false}},null,{timeout:20000});
  return chat;
}
async function stop(){if(rawChild&&rawChild.exitCode===null){try{require('node:child_process').execFileSync('C:\\Windows\\System32\\taskkill.exe',['/PID',String(rawChild.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}}rawChild=null;if(electron){await electron.close();electron=null;}}
const messages = require(path.join(repo,'src/renderer/react/i18n/zh-CN.json'));
const t=messages.pluginPanel;
async function plugins(chat){await chat.getByRole('button',{name:'插件',exact:true}).click();await chat.locator('.plugin-panel').waitFor();}
const card=(chat,id='QA 面板')=>chat.locator('article.plugin-card-ui').filter({has:chat.locator('.plugin-card-ui__name',{hasText:id})});
async function overview(chat){return chat.evaluate(()=>window.plugins.list());}
async function expectVersion(chat,expected){await chat.waitForFunction(async expected=>{const p=(await window.plugins.list()).plugins.find(p=>p.id==='qa-panel');return p&&Object.entries(expected).every(([k,v])=>p[k]===v)},expected,{timeout:20000});}
const stateFile=path.join(root,'profile','Firefly-test','plugin-install-state','qa-panel.json');
const state=()=>JSON.parse(fs.readFileSync(stateFile,'utf8'));
async function importZip(chat,zip){await electron.evaluate((_,zip)=>{global.__pluginQa.zip=zip},zip);await chat.getByRole('button',{name:t.add,exact:true}).click();await chat.getByRole('button',{name:t.add,exact:true}).waitFor({state:'visible'});await chat.waitForFunction(()=>!document.querySelector('.plugin-panel__header-actions button:last-child').disabled);}
async function makeZip(version,behavior='good'){
  const JSZip=require(path.join(repo,'node_modules/jszip'));const zip=new JSZip();
  zip.file('manifest.json',JSON.stringify({apiVersion:1,id:'qa-panel',name:'QA 面板',version,description:'隔离验收自写插件',author:'QA fixture',entry:'index.cjs',defaultEnabled:false,settingsPanel:'panel.html',settingsSection:'plugins'}));
  const register=behavior==='fail'?"throw Error('QA_CANDIDATE_FAILURE')":behavior==='slow'?"await new Promise(r=>setTimeout(r,20000));ctx.registerIpc('version',()=>'3.0.0');":"ctx.registerIpc('version',()=>"+JSON.stringify(version)+");";
  zip.file('index.cjs',`module.exports={async register(ctx){${register}},unregister(){}};`);
  zip.file('panel.html',`<!doctype html><html><body><h2>QA panel ${version}</h2><button id="invoke">读取运行版本</button><output id="result"></output><script>document.getElementById('invoke').onclick=()=>parent.postMessage({protocol:'firefly-panel/1',kind:'invoke',seq:1,channel:'version',args:[]},'*');window.addEventListener('message',e=>{if(e.data.kind==='invoke-result')document.getElementById('result').textContent=JSON.stringify(e.data)});</script></body></html>`);
  const file=path.join(output,'fixture-'+version+'.zip');fs.writeFileSync(file,await zip.generateAsync({type:'nodebuffer'}));return file;
}
(async()=>{
  let chat=await start();
  if(!full){
  const list = await overview(chat);
  fs.writeFileSync(path.join(output,'probe.json'),JSON.stringify({list,body:await chat.locator('body').innerText(),buttons:await chat.getByRole('button').allTextContents(),urls:electron.windows().map(p=>p.url())},null,2));
  await chat.screenshot({path:path.join(output,'00-chat.png')});
  console.log('PROBE_OK',JSON.stringify({plugins:list.plugins.length,output}));
  return;}
  record('real-electron-isolation');
  await plugins(chat); await shot(chat,'01-installed-empty');
  await chat.getByRole('button',{name:t.market.toggle,exact:true}).click();
  await chat.locator('.plugin-card-ui__name').filter({hasText:'文本统计'}).waitFor();
  assert.match(await chat.locator('.plugin-panel').innerText(),/离线|随应用/);
  await shot(chat,'02-market');
  await chat.locator('.plugin-panel__search').fill('no-such-fixture');assert.equal(await chat.locator('article.plugin-card-ui').count(),0);
  await chat.locator('.plugin-panel__search').fill('text-stats');assert.equal(await chat.locator('article.plugin-card-ui').count(),1);
  await chat.getByRole('button',{name:t.market.back,exact:true}).click();
  await chat.getByRole('button',{name:t.market.toggle,exact:true}).click();await chat.locator('article.plugin-card-ui').waitFor();
  record('market-search-source-return');
  await chat.locator('article.plugin-card-ui').getByRole('button',{name:t.market.install,exact:true}).click();
  const confirm=chat.getByRole('dialog');await confirm.waitFor();
  assert.match(await confirm.innerText(),/Node.js/);
  assert.equal(await chat.getByRole('button',{name:t.add,exact:true}).isDisabled(),true);
  await confirm.getByRole('button',{name:/取\s*消/}).click();
  assert.equal((await overview(chat)).plugins.length,0);
  await chat.locator('article.plugin-card-ui').getByRole('button',{name:t.market.install,exact:true}).click();
  await chat.getByRole('dialog').getByRole('button',{name:/安\s*装/}).click();
  await chat.getByRole('button',{name:/已安装 v/}).waitFor();
  await chat.waitForFunction(async()=>!!(await window.plugins.list()).plugins.find(p=>p.id==='text-stats'));
  const marketPlugin=(await overview(chat)).plugins.find(p=>p.id==='text-stats');assert.equal(marketPlugin.status,'disabled');assert.equal(marketPlugin.sourceKind,'bundled');
  await shot(chat,'03-market-installed-disabled');record('market-cancel-confirm-install-disabled');
  await chat.getByRole('button',{name:t.market.back,exact:true}).click();
  await importZip(chat,await makeZip('1.0.0'));await expectVersion(chat,{status:'disabled',installedVersion:'1.0.0',activeVersion:null});
  assert.match(await card(chat).innerText(),/本地/);
  const dialogCount=await electron.evaluate(()=>{global.__pluginQa.zip=null;global.__pluginQa.holdDialog=true;return global.__pluginQa.dialogs.length});
  const add=chat.getByRole('button',{name:t.add,exact:true});await add.click();assert.equal(await add.isDisabled(),true);
  assert.equal(await card(chat).getByRole('button',{name:t.enable,exact:true}).isDisabled(),true);await add.evaluate(button=>button.click());
  await electron.evaluate(()=>{global.__pluginQa.holdDialog=false});await chat.waitForFunction(()=>!document.querySelector('.plugin-panel__header-actions button:last-child').disabled);
  assert.equal(await electron.evaluate(()=>global.__pluginQa.dialogs.length),dialogCount+1);await expectVersion(chat,{status:'disabled',installedVersion:'1.0.0'});record('pending-import-blocks-repeat-and-mutations-cancel-preserves-state');
  await card(chat).getByRole('button',{name:t.enable,exact:true}).click();await expectVersion(chat,{status:'running',activeVersion:'1.0.0'});
  record('zip-install-disabled-enable');await shot(chat,'04-running-local');
  await chat.evaluate(()=>window.sidebar.openSettings('plugins'));
  let settings;for(let i=0;i<60;i++){settings=electron.windows().find(p=>p.url().includes('/settings/index.html'));if(settings)break;await new Promise(r=>setTimeout(r,100));}assert.ok(settings);settings.setDefaultTimeout(12000);
  const panel=settings.frameLocator('iframe.plugin-panel-card__frame');await panel.locator('#invoke').click();await panel.locator('#result').filter({hasText:'1.0.0'}).waitFor();
  await shot(settings,'05-live-settings-panel');record('real-panel-protocol-invoke');
  const denied=await settings.evaluate(()=>window.plugins.setEnabled('qa-panel',false));assert.equal(denied.ok,false);
  const allowedRead=await settings.evaluate(()=>window.plugins.list());assert.ok(allowedRead.plugins.length);
  const forbiddenPatch=await settings.evaluate(async()=>{try{await window.settings.saveGeneral({plugins:{'qa-panel':false}});return 'unexpected-success'}catch(e){return String(e)}});assert.match(forbiddenPatch,/PLUGINS_FORBIDDEN/);
  record('settings-read-allowed-management-and-generic-write-denied');
  const untrustedFile=path.join(output,'untrusted.html');fs.writeFileSync(untrustedFile,'<!doctype html><body>QA untrusted local document</body>');
  const untrustedId=await electron.evaluate(async({BrowserWindow},input)=>{const w=new BrowserWindow({show:false,webPreferences:{preload:input.preload,contextIsolation:true,nodeIntegration:false,sandbox:false}});await w.loadFile(input.file);return w.id},{file:untrustedFile,preload:path.join(repo,'dist/preload/preload/index.js')});
  const untrusted=electron.windows().find(p=>p.url().endsWith('/untrusted.html'));assert.ok(untrusted);assert.equal((await untrusted.evaluate(()=>window.plugins.list())).ok,false);assert.equal((await untrusted.evaluate(()=>window.plugins.marketList())).ok,false);assert.equal((await untrusted.evaluate(()=>window.plugins.setEnabled('qa-panel',false))).ok,false);
  await electron.evaluate(({BrowserWindow},id)=>BrowserWindow.fromId(id).destroy(),untrustedId);
  await electron.evaluate(async({BrowserWindow},file)=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/react/index.html'));await w.loadFile(file)},untrustedFile);
  await chat.waitForFunction(()=>!!window.plugins);assert.equal((await chat.evaluate(()=>window.plugins.list())).ok,false);assert.equal((await chat.evaluate(()=>window.plugins.rescan())).ok,false);
  await electron.evaluate(async({BrowserWindow},file)=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/untrusted.html'));await w.loadFile(file)},path.join(repo,'dist/renderer/react/index.html'));
  await plugins(chat);await expectVersion(chat,{status:'running'});record('other-window-and-same-host-wrong-document-denied');
  await card(chat).getByRole('button',{name:t.disable,exact:true}).click();await settings.locator('iframe.plugin-panel-card__frame').waitFor({state:'detached'});
  assert.equal((await settings.evaluate(()=>window.pluginPanel.invoke('qa-panel','version',[]))).ok,false);
  record('disable-destroys-panel-rejects-stale-bridge');await shot(settings,'06-panel-destroyed');
  await card(chat).getByRole('button',{name:t.enable,exact:true}).click();await expectVersion(chat,{status:'running'});
  await importZip(chat,await makeZip('2.0.0','fail'));await expectVersion(chat,{selectedVersion:'1.0.0',activeVersion:'1.0.0',pendingVersion:'2.0.0',restartRequired:true});
  const repeated=await chat.evaluate(()=>window.plugins.importZip());assert.equal(repeated.ok,false);assert.equal(state().pending.version,'2.0.0');
  await shot(chat,'07-update-pending');record('update-preserves-running-repeated-install-rejected');
  await stop();chat=await start();await plugins(chat);await expectVersion(chat,{status:'failed',selectedVersion:'1.0.0',activeVersion:null,restartRequired:true});
  assert.match(await card(chat).innerText(),/QA_CANDIDATE_FAILURE/);await shot(chat,'08-failed-candidate');
  await card(chat).getByRole('button',{name:'重试',exact:true}).click();await expectVersion(chat,{activeVersion:null,restartRequired:true});record('restart-failure-visible-old-selection-no-hot-rollback');
  await stop();chat=await start();await plugins(chat);await expectVersion(chat,{status:'running',activeVersion:'1.0.0'});record('following-restart-restores-old-code');
  await importZip(chat,await makeZip('3.0.0','slow'));await expectVersion(chat,{pendingVersion:'3.0.0'});await stop();
  // Playwright's launch handshake can outlast startup activation; raw spawn lets
  // the parent observe the durable state while Main is still registering code.
  const child=rawChild=require('node:child_process').spawn(path.join(repo,'node_modules/electron/dist/electron.exe'),[entry,'--firefly-profile=test','--firefly-isolation-root='+path.join(root,'profile'),'--user-data-dir='+path.join(root,'early'),'--disk-cache-dir='+path.join(root,'cache'),'--crash-dumps-dir='+path.join(root,'logs','crashes')],{cwd:repo,env,windowsHide:true,stdio:'ignore'});
  const ended=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});
  for(let i=0;i<150&&state().phase!=='activating';i++)await new Promise(r=>setTimeout(r,100));
  assert.equal(state().phase,'activating');
  const pid=child.pid;require('node:child_process').execFileSync('C:\\Windows\\System32\\taskkill.exe',['/PID',String(pid),'/T','/F'],{windowsHide:true});await ended;rawChild=null;
  record('owned-electron-killed-during-activating',{pid});
  chat=await start();await plugins(chat);await expectVersion(chat,{status:'running',activeVersion:'1.0.0',pendingVersion:null});assert.match(state().error,/Interrupted/);record('interrupted-activation-restored-on-real-restart');await shot(chat,'09-interrupted-restored');
  const privateDir=path.join(root,'profile','Firefly-test','plugin-data','qa-panel');fs.mkdirSync(privateDir,{recursive:true});fs.writeFileSync(path.join(privateDir,'retain'),'private-fixture');
  await card(chat).getByRole('button',{name:t.delete,exact:true}).click();await chat.getByRole('dialog').getByRole('button',{name:/取\s*消/}).click();assert.ok((await overview(chat)).plugins.find(p=>p.id==='qa-panel'));
  await card(chat).getByRole('button',{name:t.delete,exact:true}).click();await chat.getByRole('dialog').getByRole('button',{name:/删\s*除/}).click();await card(chat).waitFor({state:'detached'});
  assert.equal(fs.readFileSync(path.join(privateDir,'retain'),'utf8'),'private-fixture');await stop();chat=await start();await plugins(chat);
  assert.ok(!(await overview(chat)).plugins.find(p=>p.id==='qa-panel'));assert.equal(fs.readFileSync(path.join(privateDir,'retain'),'utf8'),'private-fixture');record('uninstall-cancel-confirm-restart-retains-private-data');await shot(chat,'10-final');
  report.ok=true;report.blockedRequests=await electron.evaluate(()=>global.__pluginQa.blockedRequests);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2));
  console.log('FULL_UI_OK',output);
})().catch(async error=>{report.failures.push({message:error.message,stack:error.stack});fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2));if(electron){for(const [i,p]of electron.windows().filter(p=>/\/(react|settings)\/index.html/.test(p.url())).entries()){try{await p.screenshot({path:path.join(output,'failure-'+i+'.png'),timeout:3000});fs.writeFileSync(path.join(output,'failure-'+i+'.txt'),await p.locator('body').innerText({timeout:3000}));}catch{}}}console.error(error);process.exitCode=1}).finally(stop);
