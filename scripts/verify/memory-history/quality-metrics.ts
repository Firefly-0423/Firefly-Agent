export interface JudgedDocument {id:string;grade:number;group:string}
/** Groups are authored equivalence classes, never supplied to the retriever. */
export function scoreHits(docs:JudgedDocument[],ids:string[],k:number){
 if(!Number.isSafeInteger(k)||k<1||new Set(docs.map(d=>d.id)).size!==docs.length||docs.some(d=>!Number.isInteger(d.grade)||d.grade<0||d.grade>3||!d.group)||new Set(ids).size!==ids.length||ids.some(id=>!docs.some(d=>d.id===id)))throw new Error('INVALID_EVAL_INPUT');
 const byId=new Map(docs.map(d=>[d.id,d])),relevant=new Map<string,number>();
 for(const d of docs)if(d.grade>0)relevant.set(d.group,Math.max(relevant.get(d.group)??0,d.grade));
 const seen=new Set<string>(),retrieved=new Set<string>();let dcg=0,duplicates=0;
 const top=ids.slice(0,k);
 top.forEach((id,i)=>{const d=byId.get(id)!;if(seen.has(d.group)){duplicates++;return}seen.add(d.group);if(d.grade>0){retrieved.add(d.group);dcg+=(2**d.grade-1)/Math.log2(i+2)}});
 const ideal=[...relevant.values()].sort((a,b)=>b-a).slice(0,k).reduce((s,g,i)=>s+(2**g-1)/Math.log2(i+2),0);
 return {recall:relevant.size?retrieved.size/relevant.size:0,ndcg:ideal?dcg/ideal:0,duplicateRate:top.length?duplicates/top.length:0,top1Grade:top.length?byId.get(top[0])!.grade:0};
}
