/** Credential entry only. No settings bridge, credential readback, or send capability. */
import { ipcRenderer } from "electron";
window.addEventListener("DOMContentLoaded",()=>{
 const form=document.getElementById("configuration") as HTMLFormElement;
 const input=document.getElementById("key") as HTMLInputElement;
 const balance=document.getElementById("balance") as HTMLInputElement;
 const button=document.getElementById("prepare") as HTMLButtonElement;
 const status=document.getElementById("status")!;
 let pending=false,prepared=false;
 form.addEventListener("submit",async event=>{
  event.preventDefault();if(pending||prepared||!balance.checked)return;pending=true;button.disabled=true;
  let key=input.value;input.value="";
  try{const result=await ipcRenderer.invoke("memory-openrouter-once:prepare",{key,balanceOnly:balance.checked});prepared=result?.ok===true;status.textContent=prepared?"配置已准备，尚未发送。请关闭此窗口，从系统托盘手动发送测试。":"配置未接受。请检查密钥格式及余额计费确认。";}
  catch{status.textContent="配置未接受，请关闭测试窗口。";}
  finally{key="";pending=false;button.disabled=prepared;input.disabled=prepared;balance.disabled=prepared;}
 });
});
