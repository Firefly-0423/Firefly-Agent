import {expect,it} from "vitest";
import * as automation from "./natural-automation";
import type {NaturalProposal} from "./natural-protocol";

const proposal=(text:string,attribute:NaturalProposal["attribute"],value:string):NaturalProposal=>({attribute,value,polarity:"positive",quote:text,span:{start:0,end:text.length}});
function eligible(text:string,proposals:readonly NaturalProposal[]):NaturalProposal|null {
 const fn=(automation as {automaticNaturalProposal?:((text:string,proposals:readonly NaturalProposal[])=>NaturalProposal|null)}).automaticNaturalProposal;
 expect(fn).toBeTypeOf("function");return fn!(text,proposals);
}

// Returning the model's category/value without independently grounding it in this
// entire user statement must break these acceptance and hostile-input cases.
it.each([
 ["我一直用中文交流","language","zh","zh"],
 ["我长期偏好用英语交流","language","en","en"],
 ["我一直偏好简洁的回复","response-style","concise","concise"],
 ["我一直偏好详细的回复","response-style","detailed","detailed"],
 ["I always prefer English for our chats.","language","English","en"],
 ["I always prefer Chinese for our chats.","language","zh","zh"],
 ["I always prefer concise replies.","response-style","concise","concise"],
 ["I always prefer detailed replies.","response-style","detailed","detailed"],
 ["I always prefer Ｅｎｇｌｉｓｈ for our chats.","language","en","en"],
] as const)("program admits only the grounded durable fact: %s",(text,attribute,value,want)=>{
 expect(eligible(text,[proposal(text,attribute,value)])).toEqual({attribute,value:want,polarity:"positive",quote:text,span:{start:0,end:text.length}});
});

it.each([
 ["请用中文回复","language","zh"],
 ["我今天用中文交流","language","zh"],
 ["“我一直用中文交流”","language","zh"],
 ["如果我一直用中文交流","language","zh"],
 ["我一直不用中文交流","language","zh"],
 ["你说我一直偏好用英语交流","language","en"],
 ["I always use Vim.","tool","Vim"],
 ["I always prefer tea.","preference","tea"],
 ["Call me Sparrow.","address","Sparrow"],
 ["I always prefer French for our chats.","language","French"],
 ["我一直用中文交流，也偏好简洁回复","language","zh"],
 ["I always prefer English for our chats.","language","zh"],
 ["I taught Alice to prefer English for our chats.","language","en"],
 ["＂I always prefer English for our chats.＂","language","en"],
 ["I always prefer concise replies today.","response-style","concise"],
 ["I always prefer concise replies?","response-style","concise"],
] as const)("program refuses non-whitelisted or ambiguous source: %s",(text,attribute,value)=>{
 expect(eligible(text,[proposal(text,attribute,value)])).toBeNull();
});

it.each([{confidence:1},{scope:"global"},{auto:true}])("model authority fields cannot authorize %j",extra=>{
 const text="I always prefer English for our chats.";
 expect(eligible(text,[{...proposal(text,"language","en"),...extra}])).toBeNull();
});
it("requires one whole literal evidence span, not a model-selected substring",()=>{
 const text="If I say I always prefer English for our chats.",quote="I always prefer English for our chats.";
 expect(eligible(text,[{...proposal(quote,"language","en"),span:{start:9,end:text.length}}])).toBeNull();
 const own="I always prefer concise replies.",p=proposal(own,"response-style","concise");
 expect(eligible(own,[{...p,span:{start:0,end:own.length-1}}])).toBeNull();
 expect(eligible(own,[p,p])).toBeNull();
 expect(eligible(own,[])).toBeNull();
});
