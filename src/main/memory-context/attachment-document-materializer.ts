import type {PendingChatAttachment} from "../../shared/chat-types";
import {enqueueDocumentIndexJob,type EnqueueDocumentIndexJobInput,type DocumentIndexJobResult} from "../rag/document-index-queue";
import {retrieveQueuedDocumentChunks} from "../rag/document-index-worker";
import type {ImportedDocumentChunk} from "../rag";
interface Dependencies {
 enqueue(input:EnqueueDocumentIndexJobInput):Promise<DocumentIndexJobResult>;
 retrieve(result:Extract<DocumentIndexJobResult,{kind:"indexed"}>,query:string):Promise<ImportedDocumentChunk[]|undefined>;
}
/** Called only inside the authenticated attachment projection's materialization guard. */
export function createAttachmentDocumentMaterializer(deps:Dependencies={enqueue:enqueueDocumentIndexJob,retrieve:retrieveQueuedDocumentChunks}) {
 return async(attachment:PendingChatAttachment,userText:string):Promise<string>=>{
  if(attachment.kind!=="document")throw Error("MEMORY_ATTACHMENT_DENIED");
  try{
   const result=await deps.enqueue({filePath:attachment.filePath,query:userText,onProgress:()=>{}});
   if(result.kind==="text")return result.text;
   if(result.kind==="empty")return "附件已读取，内容为空。";
   if(result.kind==="indexed"){
    const chunks=await deps.retrieve(result,userText);
    if(!chunks?.length)return "附件已建立文档索引，但本轮没有取回可用片段；不能据此断言附件无内容。";
    return "仅包含检索到的附件片段，并非完整文件：\n"+chunks.map(chunk=>chunk.text).join("\n\n");
   }
  }catch{/* No raw file path or parser/provider error body enters model context. */}
  throw Error("MEMORY_ATTACHMENT_DOCUMENT_UNAVAILABLE");
 };
}
