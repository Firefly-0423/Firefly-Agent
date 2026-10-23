import type { MessageBoxOptions } from "electron";
import type { ProbeReceipt } from "./runner";
interface NativeProbeDependencies {
  onReceipt?(receipt:ProbeReceipt):void;
  listProfileIds():string[];
  runner:{start(id:string):Promise<ProbeReceipt>;cancel():void};
  show(options:MessageBoxOptions):Promise<{response:number}>;
}
const statusLabels:Record<ProbeReceipt["status"],string>={completed:"已完成",refused:"已拒绝：缓存、预算凭证或请求条件不满足",uncertain:"已停止：响应或费用不确定，保留全部预算预留",cancelled:"已取消"};
function detail(receipt:ProbeReceipt):string {
  return ["请求次数："+receipt.attempts,"预算预留（微元）："+receipt.reservedMicroCny,"费用上界（微元）："+receipt.upperMicroCny,
    ...receipt.usage.map((u,i)=>`第${i+1}次：输入 ${u.promptTokens}，输出 ${u.completionTokens}，总计 ${u.totalTokens}`+(u.cacheHitTokens===undefined?"":`，缓存命中 ${u.cacheHitTokens}，未命中 ${u.cacheMissTokens}`))].join("\n");
}
export function createNativeProbeEntry(deps:NativeProbeDependencies) {
  let action:Promise<void>|undefined;
  async function execute():Promise<void> {
    try {
      const ids=[...deps.listProfileIds()];
      if(ids.length===0 || ids.length>10) {
        await deps.show({type:"info",title:"记忆 H 在线测试",message:"没有可用的已加载 DeepSeek Flash 配置，或配置超过10项。",buttons:["关闭"]});return;
      }
      const choice=await deps.show({type:"question",title:"记忆 H：一次性在线测试",message:"选择现有 DeepSeek Flash 配置",detail:"只发送固定合成样本，最多两次相同请求；总预算上限 ¥5。结果只显示用量。预算凭证必须有效，取消或完成后本入口不会重试。",buttons:[...ids.map((_,i)=>`DeepSeek Flash 配置 ${i+1}`),"取消"],defaultId:ids.length,cancelId:ids.length,noLink:true});
      if(!Number.isInteger(choice.response) || choice.response<0 || choice.response>=ids.length){deps.runner.cancel();return;}
      const receipt=await deps.runner.start(ids[choice.response]);
      deps.onReceipt?.(receipt);
      await deps.show({type:"info",title:"记忆 H 在线测试结果",message:statusLabels[receipt.status],detail:detail(receipt),buttons:["关闭"]});
    } catch {deps.runner.cancel();/* no raw native/config/network errors reach UI or logs */}
  }
  return {run():Promise<void>{if(!action)action=execute();return action;},cancel:()=>deps.runner.cancel()};
}
