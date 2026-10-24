import {expect,it} from 'vitest';
import {decodeRerankerScores} from './reranker';
it('paired reranker uses one finite logit per document with sigmoid rather than sole-class softmax',()=>{
 expect(decodeRerankerScores({dims:[3,1],data:[0,2,-2]},3)).toEqual([.5,1/(1+Math.exp(-2)),Math.exp(-2)/(1+Math.exp(-2))]);
 for(const tensor of [{dims:[2,2],data:[0,1,2,3]},{dims:[1,1],data:[0]},{dims:[2,1],data:[0,NaN]},{dims:[2,1],data:[0,Infinity]},{dims:[2,1],data:[0]}])expect(()=>decodeRerankerScores(tensor,2)).toThrow('RERANKER_OUTPUT_INVALID');
 expect(decodeRerankerScores({dims:[2,1],data:[-1000,1000]},2)).toEqual([0,1]);
});
