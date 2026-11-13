import {it,expect} from 'vitest';
import {historyTranscriptDigest} from './history-transcript-digest';
it('projection ignores bound ref and vector but binds original identity, body and classification',()=>{
 const d:any={id:'doc',incarnation:'inc',revision:1,origin:'canonical',sourceDeps:[],vector:null,messages:[{id:'u',role:'user',text:'original',occurredAt:null,timeZone:null}],classification:'raw-history'};
 const original=historyTranscriptDigest(d);
 expect(historyTranscriptDigest({...d,transcriptRef:{headId:'head',revision:1,digest:'a'.repeat(64)},vector:{identity:'x',values:[1]}})).toBe(original);
 for(const mutation of [{id:'other'},{revision:2},{classification:'unverified'},{messages:[{...d.messages[0],text:'forged'}]},{provenance:[]}])expect(historyTranscriptDigest({...d,...mutation})).not.toBe(original);
});
