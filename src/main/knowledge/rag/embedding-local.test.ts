import {expect,it,vi} from 'vitest';
vi.mock('./model-status',()=>({getProjectModelBaseDir:()=> 'E:/synthetic-models',checkEmbeddingModelInstalled:()=>true}));
import {decodeLocalEmbeddingBatch,createLocalEmbeddingProvider} from './embedding';
it('local embedding requires exact finite normalized CLS tensor rows and versioned identity',()=>{
 const provider=createLocalEmbeddingProvider('bgem3')!;expect(provider.cacheIdentity!.model).toContain('cls');expect(provider.cacheIdentity!.model).toContain('4de13258303883538bd53b696b452bf8099f0858');
 const row=new Float32Array(1024);row[0]=1;expect(decodeLocalEmbeddingBatch({dims:[1,1024],data:row},1,1024)[0]).toHaveLength(1024);
 for(const tensor of [{dims:[1,768],data:row},{dims:[2,1024],data:row},{dims:[1,1024],data:new Float32Array(1024)},{dims:[1,1024],data:[...row.slice(0,1023),NaN]}])expect(()=>decodeLocalEmbeddingBatch(tensor,1,1024)).toThrow();
});

import {withLocalModelLoad} from './embedding';
it('serializes complete file-loading phases across different roots and releases the lock after failure',async()=>{
 let release!:()=>void,started!:()=>void;const entered=new Promise<void>(r=>{started=r}),gate=new Promise<void>(r=>{release=r}),seen:string[]=[];let modelRoot='';
 const first=withLocalModelLoad(async()=>{modelRoot='root-a';seen.push('a-tokenizer');started();await gate;seen.push(modelRoot+':a-model');throw Error('load-failed')});const failure=expect(first).rejects.toThrow('load-failed');await entered;
 const second=withLocalModelLoad(async()=>{modelRoot='root-b';seen.push(modelRoot+':b-model');return modelRoot});await Promise.resolve();expect(seen).toEqual(['a-tokenizer']);release();await failure;expect(await second).toBe('root-b');expect(seen).toEqual(['a-tokenizer','root-a:a-model','root-b:b-model']);
});
