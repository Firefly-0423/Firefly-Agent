import type {HistoryMessage} from './history-contracts';
/** Count every quoted tool field as well as visible text against the excerpt budget. */
export function historyMessageChars(message:HistoryMessage):number {
 return message.text.length+(message.name?.length??0)+(message.toolCallId?.length??0)
  +(message.toolCallIds?.reduce((sum,id)=>sum+id.length,0)??0)
  +(message.toolCalls?.reduce((sum,call)=>sum+call.id.length+call.name.length+call.arguments.length,0)??0);
}