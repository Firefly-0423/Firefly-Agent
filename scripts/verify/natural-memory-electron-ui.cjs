// Actual compiled application QA. Conversation data, model responses and storage are synthetic.
// The process still runs as the current OS account; this is profile isolation, not an OS sandbox.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const repo = path.resolve(__dirname, '../..');
const { _electron } = require(path.join(repo, 'node_modules/playwright'));
const maskedToolHistory = process.argv.includes('--masked-tool-history');
const output = path.join(repo, '.verification', 'electron-memory-ui-' + Date.now());
const root = path.join(output, 'isolated');
const profile = path.join(root, 'profile');
const homeDir = path.join(root, 'synthetic-user');
for (const dir of [profile, homeDir, path.join(homeDir,'AppData','Roaming'), path.join(homeDir,'AppData','Local'), path.join(root,'temp'), path.join(root,'cache'), path.join(root,'logs'), path.join(root,'early')]) fs.mkdirSync(dir,{recursive:true});
const userData = path.join(profile,'Firefly-test');
fs.mkdirSync(userData,{recursive:true});
const model = {provider:'OpenRouter',baseUrl:'https://memory-qa.invalid/v1',model:'openai/gpt-6-luna',apiKey:'synthetic-only-not-a-real-key',explicitTransport:'openai',contextWindowTokens:128000};
fs.writeFileSync(path.join(userData,'model-settings.json'),JSON.stringify({schemaVersion:2,contextWindowVersion:2,mode:'manual',...model,perProvider:{OpenRouter:model},modelProfiles:[{id:'offline-memory-qa',...model,displayName:'Offline synthetic QA'}],defaultModelProfileId:'offline-memory-qa',chatRequestTimeoutSec:60,rerankerMode:'none'},null,2));
fs.writeFileSync(path.join(userData,'app-settings.json'),JSON.stringify({locale:'zh-CN',autoCheckUpdates:false}));
const original = '小雀是我习惯用的称呼，以后这样叫我';
const entry = path.join(output,'qa-main.cjs');
fs.writeFileSync(entry,`
const fs=require('node:fs'),path=require('node:path');
const {app,session,dialog,shell}=require('electron');
app.setAppPath(${JSON.stringify(repo)});
app.setPath('home',${JSON.stringify(homeDir)});
app.setPath('appData',${JSON.stringify(path.join(homeDir,'AppData','Roaming'))});
global.__memoryQa={requests:[],blocked:[],backgroundSuppressed:[],dialogs:[]};
const qa=global.__memoryQa;
dialog.showErrorBox=(title,content)=>{qa.dialogs.push({title,content});console.error('QA_ERROR_BOX',title,content)};
shell.openExternal=async()=>{throw Error('QA_EXTERNAL_LINK_BLOCKED')};
globalThis.fetch=async(input,init)=>{
 const request=new Request(input,init);const url=new URL(request.url);
 if(url.hostname!=='memory-qa.invalid'){qa.blocked.push({layer:'fetch',origin:url.origin});throw Error('QA_NETWORK_BLOCKED')}
 const body=JSON.parse(await request.text());const natural=JSON.stringify(body.messages||[]).includes('Protocol: user-fact-v2');
 const item={kind:natural?'natural':'chat',path:url.pathname,body};qa.requests.push(item);
 fs.appendFileSync(${JSON.stringify(path.join(output,'model-requests.ndjson'))},JSON.stringify(item)+'\\n');
 const seed=natural&&(body.messages||[]).some(m=>m.role==='user'&&String(m.content).includes(${JSON.stringify(original)}));
 const facts=seed?[{subject:'user',attribute:'form-of-address',value:'小雀',polarity:'positive',status:'asserted',quote:${JSON.stringify(original)},reason:'Synthetic direct self statement'}]:[];
 if(natural||body.stream!==true)return Response.json({id:'qa-offline',object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:natural?JSON.stringify({facts}):'离线验收响应。'},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}});
 const chunk=(delta,finish_reason=null)=>JSON.stringify({id:'qa-offline',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason}]});
 return new Response('data: '+chunk({role:'assistant',content:'离线验收响应。'})+'\\n\\ndata: '+chunk({},'stop')+'\\n\\ndata: [DONE]\\n\\n',{headers:{'content-type':'text/event-stream'}});
};
for(const name of ['node:http','node:https']){const mod=require(name);for(const method of ['request','get'])mod[method]=()=>{qa.blocked.push({layer:name,method});throw Error('QA_NATIVE_HTTP_BLOCKED')}}
function blockSession(s){s.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,done)=>{qa.blocked.push({layer:'chromium',origin:new URL(details.url).origin});done({cancel:true})});}
app.on('session-created',blockSession);app.whenReady().then(()=>blockSession(session.defaultSession));
const net=require('electron').net;
for(const method of ['request','fetch'])net[method]=()=>{qa.blocked.push({layer:'electron-net',method});throw Error('QA_ELECTRON_NET_BLOCKED')};
// Preserve the application's required identity preflight before loading any storage consumer.
require(${JSON.stringify(path.join(repo,'dist/main/main/identity-preflight.js'))});
const bg=require(${JSON.stringify(path.join(repo,'dist/main/main/application/background.js'))});
const realStart=bg.startBackground;
bg.startBackground=deps=>{
 const guarded={...deps,channels:{...deps.channels,start:async()=>{},stop:async()=>{}},scheduler:{...deps.scheduler,start:()=>{},stop:async()=>{}}};
 for(const key of ['pruneRemovedMcp','syncBuiltInMcp','restoreMcp','scheduleEmbeddingRefresh','initializeReranker','prewarmScreenshot','scheduleUpdateCheck','startProactiveTrigger'])guarded[key]=async()=>{qa.backgroundSuppressed.push(key)};
 const handle=realStart(guarded);handle.settled.then(()=>{qa.ready=true});return handle;
};
require(${JSON.stringify(path.join(repo,'dist/main/main/index.js'))});
qa.getTarget=()=>require(${JSON.stringify(path.join(repo,'dist/main/main/plugin-host/active-chat-target.js'))}).activeChatTargetRegistry.getActive();
// A host-owned synthetic transcript fixture, never an actual command or credential read.
qa.stageMaskedTool=async()=>{
 const target=qa.getTarget();if(!target)throw Error('QA_TARGET_MISSING');
 const store=require(${JSON.stringify(path.join(repo,'dist/main/main/orchestrator/conversation-transcript-store.js'))}).getConversationTranscriptStore(app.getPath('userData'));
 const call={id:'qa-masked-call',name:'run_shell',arguments:JSON.stringify({command:'synthetic_probe_not_executed'})};
 const at=Date.now(),mask='gho_'+'*'.repeat(36);
 await store.append(target.sessionId,{id:'qa-masked-assistant',at,kind:'assistant',runId:'qa-masked-run',payload:{role:'assistant',content:'',toolCalls:[call]}});
 await store.append(target.sessionId,{id:'qa-masked-result',at:at+1,kind:'tool_result',runId:'qa-masked-run',payload:{assistantEntryId:'qa-masked-assistant',toolCallId:call.id,outcome:'success',message:{role:'tool',toolCallId:call.id,name:call.name,content:JSON.stringify({outcome:'success',output:JSON.stringify({success:true,exitCode:0,stdout:'github.com\\n  - Active account: true\\n  - Token: '+mask+'\\n  - Token scopes: repo',stderr:''})})}}});
 return {sessionId:target.sessionId,mask};
};
`);
const env={};
for(const name of ['PATH','SystemRoot','WINDIR','ComSpec','PATHEXT']) if(process.env[name]) env[name]=process.env[name];
Object.assign(env,{USERPROFILE:homeDir,APPDATA:path.join(homeDir,'AppData','Roaming'),LOCALAPPDATA:path.join(homeDir,'AppData','Local'),TEMP:path.join(root,'temp'),TMP:path.join(root,'temp'),TMPDIR:path.join(root,'temp'),FIREFLY_RUNTIME_PROFILE:'test',FIREFLY_ISOLATION_ROOT:profile,ELECTRON_LOG_FILE:path.join(root,'logs','electron.log'),CHROME_LOG_FILE:path.join(root,'logs','chromium.log')});
const report={output,head:cp.execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),maskedToolHistory,checks:[],screenshots:[],failures:[],pid:[],launches:[],sessions:[]};
function save(){fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2));}
function record(name,details={}){report.checks.push({name,...details});save();console.log('PASS',name,JSON.stringify(details));}
let electron;
async function shot(page,name){await page.screenshot({path:path.join(output,name+'.png')});report.screenshots.push(name+'.png');save();}
async function start(){
 electron=await _electron.launch({executablePath:path.join(repo,'node_modules/electron/dist/electron.exe'),args:[entry,'--firefly-profile=test','--firefly-isolation-root='+profile,'--user-data-dir='+path.join(root,'early'),'--disk-cache-dir='+path.join(root,'cache'),'--crash-dumps-dir='+path.join(root,'logs','crashes')],cwd:repo,env,timeout:45000});
 report.pid.push(electron.process().pid);save();
 const log=fs.createWriteStream(path.join(output,'process.log'),{flags:'a'});electron.process().stdout?.pipe(log);electron.process().stderr?.pipe(log);
 const actual=await electron.evaluate(({app})=>({appPath:app.getAppPath(),userData:app.getPath('userData'),sessionData:app.getPath('sessionData'),logs:app.getPath('logs'),home:app.getPath('home'),appData:app.getPath('appData'),version:process.versions.electron,pid:process.pid}));
 assert.equal(actual.appPath,repo);assert.equal(actual.userData,userData);
 for(const key of ['userData','sessionData','logs','home','appData'])assert.ok(path.resolve(actual[key]).startsWith(path.resolve(root)+path.sep),key+' escaped synthetic root');
 record('real-electron-synthetic-isolation',actual);
 for(let n=0;n<180;n++){
  const chat=electron.windows().find(p=>/\/react\/index\.html/.test(p.url()));
  if(chat){await chat.waitForLoadState('domcontentloaded');await chat.waitForFunction(()=>typeof window.chatStore?.create==='function',null,{timeout:20000});for(let i=0;i<150;i++){if(await electron.evaluate(()=>global.__memoryQa.ready===true))break;await chat.waitForTimeout(100);}assert.equal(await electron.evaluate(()=>global.__memoryQa.ready),true);chat.setDefaultTimeout(15000);chat.on('pageerror',error=>{report.rendererErrors??=[];report.rendererErrors.push(error.message);save();});return chat;}
  await new Promise(r=>setTimeout(r,200));
 }
 throw Error('QA_CHAT_WINDOW_MISSING '+JSON.stringify(await electron.evaluate(()=>global.__memoryQa)));
}
async function stop(){if(electron){const own=electron,child=own.process(),pid=child.pid;electron=null;const boundaries=await own.evaluate(()=>({pid:process.pid,blocked:global.__memoryQa.blocked,backgroundSuppressed:global.__memoryQa.backgroundSuppressed,dialogs:global.__memoryQa.dialogs,requestKinds:global.__memoryQa.requests.map(r=>r.kind)})).catch(error=>({snapshotError:error.message}));report.launches.push(boundaries);save();let timer;const graceful=own.close();const timedOut=await Promise.race([graceful.then(()=>false),new Promise(r=>{timer=setTimeout(()=>r(true),15000)})]);clearTimeout(timer);if(timedOut){child.kill();await graceful.catch(()=>{});throw Error('QA_GRACEFUL_SHUTDOWN_TIMEOUT '+pid)}record('own-electron-closed',{pid,forcedAfterTimeout:false});assert.equal(boundaries.dialogs?.length,0,'unexpected dialog or missing per-launch evidence');assert.ok(boundaries.blocked.every(b=>b.layer==='chromium'&&b.origin==='https://fonts.googleapis.com'),'unexpected outbound attempt');}}
async function newChat(chat,title){await chat.getByRole('button',{name:'新对话',exact:true}).click();await chat.locator('textarea.ant-sender-input').waitFor();await chat.waitForTimeout(400);record('new-chat-ui',{title,url:chat.url()});}
async function send(chat,text,allowExistingSession=false){
 const before=await electron.evaluate(()=>global.__memoryQa.requests.filter(r=>r.kind==='chat').length);
 await chat.locator('textarea.ant-sender-input').fill(text);
 await chat.locator('textarea.ant-sender-input').press('Enter');
 for(let n=0;n<150;n++){
  const requests=await electron.evaluate(()=>global.__memoryQa.requests.filter(r=>r.kind==='chat'));
  if(requests.length<=before){await chat.waitForTimeout(200);continue;}
  const target=await electron.evaluate(()=>global.__memoryQa.getTarget());
  const id=target?.sessionId;
  assert.ok(id,'actual Main-owned UI target missing');assert.equal(target.mode,'chat');
  if(!allowExistingSession)assert.ok(!report.sessions.some(s=>s.id===id),'new-chat action reused prior session');
  let session,answer,user;
  for(let turn=0;turn<150;turn++){
   session=await chat.evaluate(id=>window.chatStore.get(id),id);
   user=session.messages.find(m=>m.role==='user'&&(m.content===text||m.rawContent===text));
   answer=session.messages.find(m=>m.role==='model'&&m.answersUserMessageId===user?.id&&m.content==='离线验收响应。'&&m.runSnapshot?.status==='terminal'&&m.runSnapshot.terminalStatus==='success'&&(!m.sSettlement||m.sSettlement.state==='success'));
   if(user&&answer)break;
   await chat.waitForTimeout(200);
  }
  assert.ok(user,'actual session did not persist submitted user text');
  if(!answer){report.failedSession=session;save();}assert.ok(answer,'actual assistant reply did not settle successfully');
  assert.equal(answer.answersUserMessageId,user.id,'assistant reply belongs to another turn');
  await chat.getByText('离线验收响应。',{exact:true}).last().waitFor();
  report.sessions.push({id,text,webContentsId:target.webContentsId,userMessageId:user.id,assistantMessageId:answer.id,runId:answer.runSnapshot.runId,terminalStatus:answer.runSnapshot.terminalStatus,settlement:answer.sSettlement?.state??'not-exposed'});
  save();return requests.at(-1);
 }
 throw Error('QA_MAIN_REQUEST_MISSING '+await chat.locator('body').innerText());
}
async function memoryPage(chat){await chat.evaluate(()=>window.sidebar.openSettings('memory'));let settings;for(let n=0;n<100;n++){settings=electron.windows().find(p=>/\/settings\/index\.html/.test(p.url()));if(settings)break;await chat.waitForTimeout(100)}assert.ok(settings,'settings window missing');await settings.waitForLoadState('domcontentloaded');await settings.waitForFunction(()=>typeof window.memoryPanel?.getState==='function',null,{timeout:20000});await settings.locator('#memory-entries-body').waitFor();settings.setDefaultTimeout(15000);return settings;}
async function state(settings){return settings.evaluate(()=>window.memoryPanel.getState());}
function memoryFrom(request){return (request.body.messages||[]).filter(m=>m.role==='user'&&typeof m.content==='string'&&m.content.startsWith('User-stated memory with source and time metadata:\n'));}
(async()=>{
 try{
  let chat=await start();
  if(process.argv.includes('--probe')){await shot(chat,'00-chat-probe');report.probe={body:await chat.locator('body').innerText(),buttons:await chat.getByRole('button').allTextContents(),urls:electron.windows().map(p=>p.url()),qa:await electron.evaluate(()=>global.__memoryQa)};record('probe-rendered');return;}
  await newChat(chat,'Synthetic natural-memory origin');
  const first=await send(chat,original);assert.equal(memoryFrom(first).length,0);record('natural-utterance-sent-without-preexisting-memory');
  let settings=await memoryPage(chat);let pending;
  for(let n=0;n<120;n++){pending=await state(settings);if(pending.candidates?.length)break;await settings.waitForTimeout(250)}
  assert.equal(pending.facts.length,0);assert.equal(pending.candidates.length,1);assert.match(pending.candidates[0].assertion,/小雀/);record('natural-proposal-pending-only',{state:pending});
  // Reload the actual settings page so its card list refreshes after asynchronous extraction.
  await settings.reload();await settings.locator('article.memory-record [data-memory-action="confirm"]').waitFor();await shot(settings,'01-pending-candidate');
  await settings.locator('article.memory-record').filter({hasText:'小雀'}).locator('[data-memory-action="confirm"]').click();
  await settings.waitForFunction(async()=>{const s=await window.memoryPanel.getState();return s.facts.length===1&&s.candidates.length===0});
  const confirmed=await state(settings);report.factId=confirmed.facts[0].factId;assert.equal(confirmed.facts[0].revision,1);record('ui-confirmed-real-sqlite-fact',{state:confirmed});await shot(settings,'02-confirmed');
  await stop();
  chat=await start();await newChat(chat,'Synthetic recall after restart');
  const recalled=await send(chat,'按习惯称呼我，给一句学习建议');const memories=memoryFrom(recalled);assert.equal(memories.length,1);assert.match(JSON.stringify(memories),/小雀/);const selected=JSON.parse(memories[0].content.split('\n').slice(1).join('\n'));assert.equal(selected[0].factId,report.factId);assert.equal(selected[0].revision,1);assert.ok(!(recalled.body.messages||[]).some(m=>['system','developer'].includes(m.role)&&JSON.stringify(m).includes('小雀')));record('reopened-new-session-actual-request-recall',{memory:memories});await shot(chat,'03-new-session-recall');
  settings=await memoryPage(chat);await settings.locator('article.memory-record').filter({hasText:'小雀'}).locator('[data-memory-action="correct"]').click();const row=settings.locator('article.memory-record').filter({hasText:'小雀'});await row.locator('textarea').fill('小禾');await row.locator('[data-memory-action="save-correction"]').click();
  await settings.waitForFunction(async()=>{const s=await window.memoryPanel.getState();return s.facts.length===1&&s.facts[0].assertion.includes('小禾')});const edited=await state(settings);assert.equal(edited.facts[0].factId,report.factId);assert.equal(edited.facts[0].revision,2);record('ui-correction-synchronous',{state:edited});await shot(settings,'04-corrected');
  await newChat(chat,'Synthetic corrected recall');const corrected=await send(chat,'按习惯称呼我，给一句阅读建议');assert.match(JSON.stringify(memoryFrom(corrected)),/小禾/);assert.doesNotMatch(JSON.stringify(corrected.body),/小雀/);const selectedEdit=JSON.parse(memoryFrom(corrected)[0].content.split('\n').slice(1).join('\n'));assert.equal(selectedEdit[0].factId,report.factId);assert.equal(selectedEdit[0].revision,2);assert.ok(!(corrected.body.messages||[]).some(m=>['system','developer'].includes(m.role)&&JSON.stringify(m).includes('小禾')));record('corrected-value-selected-in-new-session',{memory:memoryFrom(corrected)});
  await settings.locator('article.memory-record').filter({hasText:'小禾'}).locator('[data-memory-action="forget"]').click();await settings.waitForFunction(async()=>{const s=await window.memoryPanel.getState();return s.facts.length===0});record('ui-forget-synchronous',{state:await state(settings)});await shot(settings,'05-forgotten');
  await newChat(chat,'Synthetic forgotten recall');const forgotten=await send(chat,'按习惯称呼我，给一句休息建议');assert.equal(memoryFrom(forgotten).length,0);assert.doesNotMatch(JSON.stringify(forgotten.body),/小雀|小禾/);record('forgotten-value-absent-from-all-request-roles');
  if(maskedToolHistory){
   const fixture=await electron.evaluate(()=>global.__memoryQa.stageMaskedTool());
   const followup=await send(chat,'继续分析这份合成工具结果',true);
   assert.equal(report.sessions.at(-1).id,fixture.sessionId);
   const tools=followup.body.messages.filter(m=>m.role==='tool');
   assert.ok(tools.some(m=>JSON.stringify(m).includes(fixture.mask)),'fully masked tool fixture missing from actual next-turn request');
   assert.equal(memoryFrom(followup).length,0);assert.doesNotMatch(JSON.stringify(followup.body),/小雀|小禾/);
   const after=await state(settings);assert.equal(after.facts.length,0);
   assert.ok(!after.candidates.some(c=>/gho_|synthetic_probe/.test(c.value??'')),'tool output became a personal fact candidate');
   record('masked-tool-history-survives-actual-next-turn-without-memory-resurrection',{sessionId:fixture.sessionId,toolRoles:tools.length});
   await shot(chat,'06-masked-tool-next-turn');
  }
  await stop();chat=await start();settings=await memoryPage(chat);assert.equal((await state(settings)).facts.length,0);record('forget-survives-second-restart');
  await stop();assert.equal(report.launches.length,3);assert.equal(report.sessions.length,maskedToolHistory?5:4);assert.equal(new Set(report.sessions.map(s=>s.id)).size,4);assert.equal(report.rendererErrors?.length??0,0);record('offline-full-closure-complete');
 }catch(error){report.failures.push({message:error.message,stack:error.stack});if(electron){report.failureState=await electron.evaluate(()=>global.__memoryQa).catch(()=>null);for(const [i,p]of electron.windows().entries()){report['window'+i]={url:p.url(),body:await p.locator('body').innerText().catch(()=>null)};await shot(p,'failure-'+i).catch(()=>{})}}console.error(error.stack);process.exitCode=1;}
 finally{save();await stop().catch(error=>{report.failures.push({shutdown:error.message});save();process.exitCode=1});console.log('QA_OUTPUT',output);}
})();
