/** Offline acceptance against the built application, real preload/IPC, Worker and SQLite. */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const { _electron: electron } = require("playwright");

const repo = path.resolve(__dirname, "../..");
const output = path.join(repo, ".verification", `electron-history-precise-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
const isolation = path.join(output, "isolated"), profile = path.join(isolation, "profile", "Firefly-test");
for (const dir of [profile, "synthetic-user", "appdata", "localappdata", "temp", "cache"].map(dir => path.isAbsolute(dir) ? dir : path.join(isolation, dir))) fs.mkdirSync(dir, { recursive: true });
const config = { provider: "OpenRouter", baseUrl: "https://memory-qa.invalid/v1", model: "openai/gpt-6.1-sol", apiKey: "synthetic-only-not-a-real-key", explicitTransport: "openai", contextWindowTokens: 128000 };
fs.writeFileSync(path.join(profile, "model-settings.json"), JSON.stringify({ schemaVersion: 2, contextWindowVersion: 2, mode: "manual", ...config, perProvider: { OpenRouter: config }, modelProfiles: [{ id: "offline-phase3", ...config }], defaultModelProfileId: "offline-phase3", chatRequestTimeoutSec: 30, rerankerMode: "none" }));
fs.writeFileSync(path.join(profile, "app-settings.json"), JSON.stringify({ locale: "zh-CN", autoCheckUpdates: false }));
const seeds = [
 ["2025-01-01 to 2025-01-31, I prefer English", "language", "English"],
 ["2025-02-01 to 2025-02-28, I prefer Chinese", "language", "Chinese"],
];
const wrapper = path.join(output, "qa-main.cjs"), requestLog = path.join(output, "model-requests.ndjson");
fs.writeFileSync(wrapper, `
const fs=require('node:fs'),path=require('node:path');
const {app,session,dialog,shell,BrowserWindow}=require('electron');
const repo=${JSON.stringify(repo)},output=${JSON.stringify(output)},isolation=${JSON.stringify(isolation)};
app.setAppPath(repo);app.setPath('home',path.join(isolation,'synthetic-user'));app.setPath('appData',path.join(isolation,'appdata'));
// These are only the newly launched synthetic process's windows.
app.on('browser-window-created',(_event,win)=>win.webContents.setBackgroundThrottling(false));
const qa=global.__memoryQa={requests:[],blocked:[],dialogs:[],suppressed:[]};
dialog.showErrorBox=(title,content)=>qa.dialogs.push({title,content});shell.openExternal=async()=>{throw Error('QA_EXTERNAL_BLOCKED')};
const seeds=${JSON.stringify(seeds)};
globalThis.fetch=async(input,init)=>{
 const request=new Request(input,init),url=new URL(request.url);
 if(url.hostname!=='memory-qa.invalid'){qa.blocked.push({layer:'fetch',origin:url.origin});throw Error('QA_NETWORK_BLOCKED')}
 const body=JSON.parse(await request.text()),natural=JSON.stringify(body.messages||[]).includes('Protocol: user-fact-v2');
 const item={kind:natural?'natural':'chat',body};qa.requests.push(item);fs.appendFileSync(${JSON.stringify(requestLog)},JSON.stringify(item)+'\\n');
 const seed=natural&&seeds.find(s=>(body.messages||[]).some(m=>m.role==='user'&&String(m.content).includes(s[0])));
 const facts=seed?[{subject:'user',attribute:seed[1],value:seed[2],polarity:'positive',status:'asserted',quote:seed[0],reason:'Synthetic direct durable user statement'}]:[];
 const usage={prompt_tokens:100,completion_tokens:20,total_tokens:120};
 if(natural||body.stream!==true)return Response.json({choices:[{index:0,message:{role:'assistant',content:natural?JSON.stringify({facts}):'离线验收响应。'},finish_reason:'stop'}],usage});
 const chunk=(delta,finish_reason=null)=>JSON.stringify({id:'qa-offline',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason}],...(finish_reason?{usage}:{})});
 return new Response('data: '+chunk({role:'assistant',content:'离线验收响应。'})+'\\n\\ndata: '+chunk({},'stop')+'\\n\\ndata: [DONE]\\n\\n',{headers:{'content-type':'text/event-stream'}});
};
for(const name of ['node:http','node:https']){const mod=require(name);for(const method of ['request','get'])mod[method]=()=>{qa.blocked.push({layer:name,method});throw Error('QA_HTTP_BLOCKED')}}
function blockSession(s){s.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,done)=>{qa.blocked.push({layer:'chromium',origin:new URL(details.url).origin});done({cancel:true})});}
app.on('session-created',blockSession);app.whenReady().then(()=>blockSession(session.defaultSession));
for(const method of ['request','fetch'])require('electron').net[method]=()=>{qa.blocked.push({layer:'electron-net',method});throw Error('QA_NET_BLOCKED')};
const main=path.join(repo,'dist','main','main');require(path.join(main,'identity-preflight.js'));
const bg=require(path.join(main,'application','background.js')),realStart=bg.startBackground;
bg.startBackground=deps=>{const guarded={...deps,channels:{...deps.channels,start:async()=>{},stop:async()=>{}},scheduler:{...deps.scheduler,start:()=>{},stop:async()=>{}}};for(const key of ['pruneRemovedMcp','syncBuiltInMcp','restoreMcp','scheduleEmbeddingRefresh','initializeReranker','prewarmScreenshot','scheduleUpdateCheck','startProactiveTrigger'])guarded[key]=async()=>{qa.suppressed.push(key)};const handle=realStart(guarded);handle.settled.then(()=>{qa.ready=true});return handle};
require(path.join(main,'index.js'));
qa.showChat=id=>require(path.join(main,'windows','create-aux-windows.js')).showReactChatWindow(id);
qa.showSettings=()=>require(path.join(main,'windows','create-aux-windows.js')).createSettingsWindow('memory');
qa.target=()=>require(path.join(main,'plugin-host','active-chat-target.js')).activeChatTargetRegistry.getActive();
`);

const env = {};
for (const name of ["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "ProgramFiles", "ProgramFiles(x86)", "NUMBER_OF_PROCESSORS"]) if (process.env[name]) env[name] = process.env[name];
Object.assign(env, { USERPROFILE: path.join(isolation, "synthetic-user"), APPDATA: path.join(isolation, "appdata"), LOCALAPPDATA: path.join(isolation, "localappdata"), TEMP: path.join(isolation, "temp"), TMP: path.join(isolation, "temp"), TMPDIR: path.join(isolation, "temp"), XDG_CACHE_HOME: path.join(isolation, "cache"), CI: "1" });
const evidence = { head: cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), output, checks: [], launches: [], screenshots: [], failures: [] };
let application, chat, settings;
const record = (name, detail = {}) => { evidence.checks.push({ name, ...detail }); console.log("CHECK", name); };
const eventually = async (read, check, label) => {
  for (let i = 0; i < 160; i++) { const value = await read(); if (check(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error(`QA_TIMEOUT: ${label}`);
};
const memoryState = () => settings.evaluate(() => window.memoryPanel.getState());
const automationState = () => settings.evaluate(() => window.memoryAutomation.state());
async function screenshot(name) { await settings.screenshot({ path: path.join(output, name) }); evidence.screenshots.push(name); }
async function open() {
  application = await electron.launch({ executablePath: require("electron"), args: [wrapper, "--firefly-profile=test", `--firefly-isolation-root=${path.join(isolation, "profile")}`], cwd: repo, env, timeout: 30000 });
  application.process().stdout?.on("data", data => fs.appendFileSync(path.join(output, "process.log"), data));
  application.process().stderr?.on("data", data => fs.appendFileSync(path.join(output, "process.log"), data));
  await eventually(() => application.evaluate(() => !!global.__memoryQa.ready), Boolean, "application ready");
  await application.evaluate(() => global.__memoryQa.showChat());
  chat = await eventually(async () => application.windows().find(page => page.url().includes("/react/")), Boolean, "chat window");
  chat.setDefaultTimeout(15000);
  await chat.waitForFunction(() => !!window.chatStore && !!window.agui);
  await application.evaluate(() => global.__memoryQa.showSettings());
  settings = await eventually(async () => application.windows().find(page => page.url().includes("/settings/")), Boolean, "settings window");
  settings.setDefaultTimeout(15000);
  await settings.locator("#memory-automation-language").waitFor();
  const identity = await application.evaluate(({ app }) => ({ pid: process.pid, version: process.versions.electron, userData: app.getPath("userData"), sessionData: app.getPath("sessionData"), home: app.getPath("home"), appPath: app.getAppPath() }));
  for (const key of ["userData", "sessionData", "home"]) assert.ok(identity[key].startsWith(isolation + path.sep), key);
  assert.equal(identity.appPath, repo); record("real-electron-private-profile", identity);
  await chat.evaluate(() => { window.__phase3Events = []; window.agui.onEvent(event => window.__phase3Events.push(event)); });
}
async function close() {
  if (!application) return;
  const qa = await application.evaluate(() => ({ blocked: global.__memoryQa.blocked, dialogs: global.__memoryQa.dialogs, suppressed: global.__memoryQa.suppressed, requestKinds: global.__memoryQa.requests.map(r => r.kind) }));
  assert.deepEqual(qa.dialogs, []); evidence.launches.push(qa);
  const owned = application; application = undefined;
  const exit = new Promise(resolve => owned.process().once("exit", (code, signal) => resolve({ code, signal })));
  await owned.evaluate(({ app }) => { setImmediate(() => app.quit()); });
  let timer; const status = await Promise.race([exit, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("QA_OWN_PROCESS_DID_NOT_EXIT")), 15000); })]).finally(() => clearTimeout(timer));
  assert.equal(status.code, 0); record("owned-process-and-worker-closed", status);
}
async function turn(text, { temporary = false } = {}) {
  const mode = chat.locator(".ff-mode-menu__trigger:visible").first();
  if (!(await mode.innerText()).includes("Chat")) {
    await mode.click(); await chat.getByRole("menuitemradio", { name: /^Chat/ }).click();
    await eventually(() => mode.innerText(), label => label.includes("Chat"), "explicit Chat mode selection");
  }
  console.log("STEP", temporary ? "new temporary chat" : "new Chat draft");
  const previous = await application.evaluate(() => global.__memoryQa.target()?.sessionId);
  await chat.getByRole("button", { name: temporary ? "临时聊天" : "新对话", exact: true }).click();
  // New-chat opens a draft; the real session and its Main target exist only after first submit.
  await chat.evaluate(() => { window.__phase3Events = []; });
  const before = await application.evaluate(() => global.__memoryQa.requests.length);
  const input = chat.locator("textarea").first(); await input.fill(text); await input.press("Enter");
  console.log("STEP", "submitted synthetic user text");
  const events = await eventually(() => chat.evaluate(() => window.__phase3Events), events => events.some(event => ["RUN_FINISHED", "RUN_ERROR"].includes(event.type)), "terminal AG-UI event");
  const terminal = events.find(event => ["RUN_FINISHED", "RUN_ERROR"].includes(event.type)); assert.equal(terminal.type, "RUN_FINISHED", JSON.stringify(terminal));
  const target = await eventually(() => application.evaluate(() => global.__memoryQa.target()), target => target?.mode === "chat" && target.sessionId !== previous, "submitted chat UI target");
  const session = { id: target.sessionId }; await chat.evaluate(({ id, title }) => window.chatStore.rename(id, title), { id: session.id, title: `Offline phase3 ${evidence.checks.length}` });
  const requests = await eventually(() => application.evaluate((_electron, start) => global.__memoryQa.requests.slice(start), before), requests => requests.some(request => request.kind === "chat"), "actual model request");
  const request = requests.find(request => request.kind === "chat").body;
  record("real-ui-turn-finished", { sessionId: session.id, temporary, runId: terminal.runId }); return request;
}
function selected(request, assertion) {
  const messages = request.messages || [], memory = messages.find(message => typeof message.content === "string" && message.content.startsWith("User-stated memory with source and time metadata") && message.content.includes(assertion));
  assert.ok(memory, `No selected memory: ${assertion}`); assert.equal(memory.role, "user");
  assert.ok(messages.filter(message => message.role === "system").every(message => !JSON.stringify(message).includes(assertion)));
}
async function refreshEntries() { await settings.reload(); await settings.locator("#memory-entries-body").waitFor(); }
const card = assertion => settings.locator("#memory-entries-body article").filter({ has: settings.locator("h3", { hasText: assertion }) });

(async () => {
  console.log("OUTPUT", output);
  try {

    await open(); assert.deepEqual((await automationState()).config, {revision:0,language:false,responseStyle:false});
    await turn('harbor sapphire independent note');await turn('harbor emerald independent note');
    await turn(seeds[0][0]);
    let state=await eventually(memoryState,s=>s.candidates.some(c=>c.value==='en'),'dated candidate');
    const pending=state.candidates.find(c=>c.value==='en');assert.ok(pending.time.validFrom<pending.time.validTo);assert.equal(state.facts.length,0);
    record('temporal-fact-pending-with-bound-period',{time:pending.time});
    await refreshEntries();assert.match(await card('用户回复语言：en').innerText(),/生效于/);assert.match(await card('用户回复语言：en').innerText(),/有效至/);await screenshot('01-dated-candidate.png');
    await card('用户回复语言：en').locator('[data-memory-action="confirm"]').click();
    state=await eventually(memoryState,s=>s.facts.some(f=>f.assertion==='用户回复语言：en'),'confirmed historical record');
    const fact=state.facts.find(f=>f.assertion==='用户回复语言：en');assert.deepEqual(fact.time,pending.time);record('confirmed-history-visible-for-management',{factId:fact.factId,time:fact.time});
    await close();await open();
    let request=await turn('What language do I prefer?');assert.ok(!JSON.stringify(request).includes('用户回复语言：en'));record('ordinary-current-question-omits-expired-fact');
    request=await turn('What language did I prefer on 2025-01-15?');selected(request,'用户回复语言：en');assert.ok(JSON.stringify(request).includes('temporalQuery'));record('cold-reopen-historical-fact-in-actual-user-role-context');
    await turn(seeds[1][0]);await eventually(memoryState,s=>s.candidates.some(c=>c.value==='zh'),'second nonoverlapping candidate');await refreshEntries();await card('用户回复语言：zh').locator('[data-memory-action="confirm"]').click();
    state=await eventually(memoryState,s=>s.facts.length===2,'two disjoint intervals');record('same-slot-nonoverlapping-periods-coexist');
    request=await turn('English Chinese historical statements');assert.ok(JSON.stringify(request).includes(seeds[0][0]));assert.ok(JSON.stringify(request).includes(seeds[1][0]));record('normal-temporal-change-retains-original-histories');
    request=await turn('What language did I prefer on 2025-02-15?');selected(request,'用户回复语言：zh');assert.ok(!JSON.stringify(request).includes('用户回复语言：en'));record('historical-question-selects-matching-period');
    const beforeTemporary=await eventually(automationState,s=>s.counts.unsent===0&&s.counts['result-unknown']===0&&s.counts['result-saved']===0,'prior durable jobs drained'),beforeCount=await application.evaluate(()=>global.__memoryQa.requests.filter(r=>r.kind==='natural').length);
    await turn(seeds[0][0],{temporary:true});assert.deepEqual(await automationState(),beforeTemporary);assert.equal(await application.evaluate(()=>global.__memoryQa.requests.filter(r=>r.kind==='natural').length),beforeCount);record('temporary-dated-statement-no-journal');
    await refreshEntries();await card('用户回复语言：en').locator('[data-memory-action="correct"]').click();await card('用户回复语言：en').locator('textarea').fill('Chinese');await card('用户回复语言：en').locator('[data-memory-action="save-correction"]').click();
    state=await eventually(memoryState,s=>s.facts.some(f=>f.factId===fact.factId&&f.revision===2),'correct past fact');const corrected=state.facts.find(f=>f.factId===fact.factId);assert.equal(corrected.assertion,'用户回复语言：zh');assert.equal(corrected.time.validFrom,fact.time.validFrom);assert.equal(corrected.time.validTo,fact.time.validTo);record('historical-correction-preserves-period');await screenshot('02-corrected-periods.png');
    request=await turn('What language did I prefer on 2025-01-15?');selected(request,'用户回复语言：zh');assert.ok(!JSON.stringify(request).includes('用户回复语言：en'));record('incorrect-old-revision-never-recalled-as-history');
    request=await turn('harbor sapphire emerald');for(const value of ['harbor sapphire independent note','harbor emerald independent note'])assert.ok(JSON.stringify(request).includes(value));assert.ok(!JSON.stringify(request).includes(seeds[0][0]));record('two-pre-correction-independent-histories-reach-wire');
    await refreshEntries();await card('用户回复语言：zh').first().locator('[data-memory-action="forget"]').click();await eventually(memoryState,s=>s.facts.length===0,'whole canonical slot forgotten');record('forget-synchronously-hides-all-periods');await turn('harbor amber new history');await screenshot('03-forgotten.png');
    await close();await open();assert.deepEqual((await memoryState()).facts,[]);request=await turn('What language did I prefer on 2025-01-15?');for(const value of ['用户回复语言：en','用户回复语言：zh',seeds[0][0],seeds[1][0]])assert.ok(!JSON.stringify(request).includes(value),'forgotten content '+value);record('second-cold-reopen-no-revival');
    request=await turn('harbor sapphire emerald amber');for(const value of ['harbor sapphire independent note','harbor emerald independent note','harbor amber new history'])assert.ok(JSON.stringify(request).includes(value));for(const value of [seeds[0][0],seeds[1][0]])assert.ok(!JSON.stringify(request).includes(value));record('cold-reopen-old-independent-and-new-history-reach-wire');
    await close();record('offline-history-precise-closure-complete');
  } catch (error) {
    evidence.failures.push({ message: error.message, stack: error.stack }); process.exitCode = 1;
    if (application) { try { evidence.diagnostic = await application.evaluate(({ app, BrowserWindow }) => ({ ready: app.isReady(), qa: global.__memoryQa, target: global.__memoryQa.target?.(), windows: BrowserWindow.getAllWindows().map(win => ({ url: win.webContents.getURL(), title: win.getTitle() })) })); evidence.renderer = chat && await chat.locator("body").innerText(); } catch {} }
  }
  finally {
    if (application) { try { await application.close(); } catch {} }
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(evidence, null, 2));
    console.log("RESULT", JSON.stringify({ output, head: evidence.head, checks: evidence.checks.length, failures: evidence.failures.map(f => f.message) }));
  }
})();
