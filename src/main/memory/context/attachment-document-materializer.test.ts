import {expect,it,vi} from "vitest";
import {createAttachmentDocumentMaterializer} from "./attachment-document-materializer";
it("uses the existing Main document pipeline and labels retrieved excerpts",async()=>{
 const enqueue=vi.fn(async()=>({kind:"indexed" as const,name:"synthetic.txt",chunks:4,importId:"synthetic-import"})),retrieve=vi.fn(async()=>[{text:"synthetic excerpt",score:1}]);
 const materialize=createAttachmentDocumentMaterializer({enqueue,retrieve});
 const text=await materialize({kind:"document",name:"synthetic.txt",filePath:"/synthetic/input.txt"} as never,"question");
 expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({filePath:"/synthetic/input.txt",query:"question"}));expect(text).toContain("仅包含检索到的附件片段");expect(text).toContain("synthetic excerpt");
});
it("preserves direct plain text and does not reinterpret it as memory facts",async()=>{
 const materialize=createAttachmentDocumentMaterializer({enqueue:async()=>({kind:"text",name:"a",text:"synthetic original"}),retrieve:vi.fn()});
 expect(await materialize({kind:"document",name:"a",filePath:"/synthetic/a"} as never,"q")).toBe("synthetic original");
});
it("reports missing document content without leaking raw paths/errors",async()=>{
 const materialize=createAttachmentDocumentMaterializer({enqueue:async()=>({kind:"error",name:"a",reason:"PRIVATE_PATH_CANARY"}),retrieve:vi.fn()});
 await expect(materialize({kind:"document",name:"a",filePath:"/synthetic/a"} as never,"q")).rejects.toThrow(/^MEMORY_ATTACHMENT_DOCUMENT_UNAVAILABLE$/);
});
