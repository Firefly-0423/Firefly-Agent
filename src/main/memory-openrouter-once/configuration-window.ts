import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { validKey } from "./session-profile";
const CHANNEL="memory-openrouter-once:prepare";
export function configurationPage():string{return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><title>OpenRouter H 测试 · USD 1</title><style>body{font:15px system-ui,sans-serif;background:#f4f7fa;color:#172b3b;margin:0;padding:32px}h1{font-size:23px;margin:0 0 22px}.box{background:white;border:1px solid #d6dfe7;border-radius:12px;padding:20px;margin:18px 0}p{line-height:1.65;margin:8px 0}.fixed{font-size:13px;overflow-wrap:anywhere}label{display:block;margin:14px 0}input[type=password]{box-sizing:border-box;width:100%;padding:12px;border:1px solid #788fa2;border-radius:6px;font:inherit}button{padding:11px 20px;background:#145b79;color:white;border:0;border-radius:6px;font:inherit;cursor:pointer}button:disabled{opacity:.55;cursor:default}small{display:block;color:#506473;line-height:1.6}#status{min-height:48px}</style></head><body><h1>准备独立测试配置</h1><p>原有 Responses 配置保持不变。本次档案仅在这个测试进程中有效。</p><div class="box fixed"><p><b>平台：</b>OpenRouter · Chat Completions</p><p><b>地址：</b>https://openrouter.ai/api/v1/chat/completions</p><p><b>模型：</b>deepseek/deepseek-v4.1-flash</p><p><b>上游：</b>DeepSeek</p><p><b>总预算：</b>USD 1（含所有请求、失败及费用不确定结果）</p><small>最多两次固定合成请求，无自动重试或模型/供应商回退。</small></div><form id="configuration" autocomplete="off"><label for="key">OpenRouter API 密钥</label><input id="key" type="password" maxlength="512" autocomplete="off" spellcheck="false" required><label><input id="balance" type="checkbox" required> 我确认此 OpenRouter 工作区使用余额计费，未配置 DeepSeek BYOK。</label><small>密钥不保存到磁盘，不读取已有密钥。准备不会验证密钥或发送请求；不执行充值。</small><p><button id="prepare" type="submit">准备配置（不发送）</button></p><p id="status" role="status">准备完成后，请从系统托盘选择“手动发送 H 合成测试”。</p></form></body></html>`;}
interface Owner {mainFrame:unknown;}
interface Sender {sender:unknown;senderFrame:({url:string}|null);}
export function acceptConfigurationMessage(event:Sender,owner:Owner,url:string,payload:unknown,accept:(key:unknown,balance:boolean)=>boolean):{ok:boolean}{
 if(event.sender!==owner||event.senderFrame!==owner.mainFrame||event.senderFrame?.url!==url||!payload||typeof payload!=="object"||Array.isArray(payload))return {ok:false};
 const p=payload as Record<string,unknown>;
 if(Object.keys(p).length!==2||!validKey(p.key)||p.balanceOnly!==true)return {ok:false};
 try{return {ok:accept(p.key,true)===true};}catch{return {ok:false};}
}
export function createConfigurationWindow(){
 // Electron 43: isolate the preload, enable sandbox, validate every IPC sender.
 // https://www.electronjs.org/docs/latest/tutorial/security
 const {app,BrowserWindow,ipcMain,session}=require("electron") as typeof import("electron");
 let window:BrowserWindow|undefined;
 function close(){if(window&&!window.isDestroyed())window.close();}
 function open(accept:(key:unknown,balance:boolean)=>boolean){
  if(window&&!window.isDestroyed()){window.show();window.focus();return;}
  const ses=session.fromPartition(`memory-openrouter-${randomUUID()}`,{cache:false});
  ses.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));ses.setPermissionCheckHandler(()=>false);
  ses.webRequest.onBeforeRequest({urls:["http://*/*","https://*/*","ws://*/*","wss://*/*","file://*/*"]},(_details,callback)=>callback({cancel:true}));
  const win=new BrowserWindow({title:"OpenRouter H 测试 · USD 1",width:620,height:730,resizable:false,show:false,autoHideMenuBar:true,webPreferences:{session:ses,preload:path.join(app.getAppPath(),"dist/preload/preload/memory-openrouter-once.js"),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,devTools:false}});
  window=win;const url="data:text/html;charset=utf-8,"+encodeURIComponent(configurationPage());
  win.webContents.setWindowOpenHandler(()=>({action:"deny"}));win.webContents.on("will-navigate",event=>event.preventDefault());win.webContents.on("will-attach-webview",event=>event.preventDefault());
  ipcMain.handle(CHANNEL,(event:IpcMainInvokeEvent,payload:unknown)=>acceptConfigurationMessage(event,win.webContents,url,payload,accept));
  win.on("closed",()=>{ipcMain.removeHandler(CHANNEL);if(window===win)window=undefined;void ses.clearStorageData().catch(()=>{});});
  win.once("ready-to-show",()=>{win.show();win.focus();});void win.loadURL(url).catch(()=>close());
 }
 return {open,close};
}
