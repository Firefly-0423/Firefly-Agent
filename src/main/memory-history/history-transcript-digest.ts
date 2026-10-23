import {createHash} from 'node:crypto';
import {canonicalJson} from '../memory-core/repository-types';
import type {HistoryDocument} from './history-contracts';
/** The provider projection is shared by trusted Main acquisition and Worker binding. */
export function historyTranscriptDigest(d:HistoryDocument):string {
 const projection={id:d.id,incarnation:d.incarnation,revision:d.revision,origin:d.origin,sourceDeps:d.sourceDeps,messages:d.messages,vector:null,...(d.classification===undefined?{}:{classification:d.classification}),...(d.provenance===undefined?{}:{provenance:d.provenance})};
 return createHash('sha256').update(canonicalJson(projection)).digest('hex');
}
