/** Narrow Main composition, invoked by the native app startup only. */
import type { MessageBoxOptions } from "electron";
import { eligibleProfile } from "./boundary";
import { createNativeProbeEntry } from "./native-entry";
import { createProbeRunner, type ProbeReceipt, type ProbeRunnerDependencies } from "./runner";
interface MainProbeDependencies extends ProbeRunnerDependencies {
  onReceipt?(receipt:ProbeReceipt):void;
  listProfileIds():string[];
  show(options:MessageBoxOptions):Promise<{response:number}>;
}
export function createMainProbeEntry(enabled:boolean,deps:MainProbeDependencies) {
  if(!enabled)return undefined;
  const runner=createProbeRunner(deps);
  return createNativeProbeEntry({runner,listProfileIds:()=>deps.listProfileIds().filter(id=>{
    const profile=deps.resolveProfile(id);return profile!==undefined && profile.id===id && eligibleProfile(profile);
  }),show:deps.show,onReceipt:deps.onReceipt});
}
