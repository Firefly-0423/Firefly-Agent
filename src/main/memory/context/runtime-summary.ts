import type {createMainContext} from "./main-context";
import {contextFail,type SummaryReceipt} from "./context-contracts";

/**
 * Select complete historical turns under the Main-owned S budget; never generate new text.
 * The host excludes active/protected recent turns and invokes this only inside its active
 * model-call capture, where prepareS and the model counter are authorized. Keep existing
 * tokens and summary IDs unchanged when the receipt reports no benefit.
 */
export async function prepareRuntimeSummary(
 context:ReturnType<typeof createMainContext>,actor:object,
 input:{sessionId:string;transcriptTokens:object[];summaryIds:string[];leaseMs:number},signal?:AbortSignal,
):Promise<SummaryReceipt>{
 if(signal?.aborted)contextFail("MEMORY_CONTEXT_CANCELLED");
 const lease=await context.prepareSummary(actor,input,signal);
 // Read only authorized, complete canonical turns. Selection never creates new text or roles.
 await context.readSummaryInput(actor,lease,signal);
 const selected=await context.selectSummaryInput(actor,lease,signal);
 if(signal?.aborted)contextFail("MEMORY_CONTEXT_CANCELLED");
 if(!selected.segments)return {status:"no-benefit",summaryId:null,counting:selected.counting};
 return context.commitSummary(actor,lease,{segments:selected.segments},signal);
}
