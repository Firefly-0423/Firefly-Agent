import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {afterEach,it,expect} from 'vitest';
import {recallFixture} from '../../../scripts/verify/memory-recall/recall-fixture';
import {createHistoryMigration} from './history-migration';
import {DEFAULT_HISTORY_SETTINGS} from './history-contracts';
const fixtures:ReturnType<typeof recallFixture>[]=[];
function fixture(){const f=recallFixture();fixtures.push(f);const migration=createHistoryMigration({actorAuthority:f.authority,transport:{historyCommand:async(c:any)=>f.repo.historyCommand(c)}});const query=()=>f.repo.historyCommand({kind:'query',scopeKey:'scope-a',body:{actorKey:'actor-a',providerId:'synthetic',sessionId:'session-a',sessions:[{providerId:'synthetic',sessionId:'session-a'}],query:'cat',settings:DEFAULT_HISTORY_SETTINGS}});return {...f,migration,query}}
afterEach(()=>{for(const f of fixtures.splice(0))f.close()});
const exported=(ids=['export-source-1'])=>({format:'firefly-history-synthetic-v1',records:ids.map(sourceId=>({sourceId,sourceProvider:'synthetic',sourceSession:'session-a',revision:1,incarnation:'original-event-1',messages:[{id:'user1',role:'user',text:'cat imported history',occurredAt:1000,timeZone:'Asia/Shanghai'}]}))});
it('preview has no canonical writes and its ticket is never an apply authorization',async()=>{
 const f=fixture(),wal=()=>fs.existsSync(f.databasePath+'-wal')?fs.readFileSync(f.databasePath+'-wal'):Buffer.alloc(0),before=wal(),p=await f.migration.preview(f.actor,exported());expect(p.report).toMatchObject({new:1,duplicates:0,conflicts:0});expect(wal()).toEqual(before);expect(f.query().hits).toEqual([]);await expect(f.migration.apply(f.actor,p.ticket)).rejects.toThrow('MEMORY_HISTORY_APPLY_DENIED');
});
it('separate Main apply capability applies idempotently without any M supports',async()=>{
 const f=fixture(),p=await f.migration.preview(f.actor,exported()),cap=f.migration.authorizeApply(f.actor,p.ticket);expect(await f.migration.apply(f.actor,cap)).toMatchObject({status:'complete',inserted:1});expect(f.query().hits).toHaveLength(1);expect(await f.migration.apply(f.actor,cap)).toMatchObject({status:'complete',inserted:1});const next=await f.migration.preview(f.actor,exported());expect(next.report.duplicates).toBe(1);expect(await f.migration.apply(f.actor,f.migration.authorizeApply(f.actor,next.ticket))).toMatchObject({inserted:0,duplicates:1});const db=new DatabaseSync(f.databasePath,{readOnly:true});try{expect(db.prepare('SELECT count(*) AS n FROM fact_supports').get()?.n).toBe(0);expect(db.prepare('SELECT count(*) AS n FROM current_facts').get()?.n).toBe(0)}finally{db.close()}
});
it('same source identity with a different digest is quarantined, never last-import-wins',async()=>{
 const f=fixture(),p=await f.migration.preview(f.actor,exported());await f.migration.apply(f.actor,f.migration.authorizeApply(f.actor,p.ticket));const changed=exported();changed.records[0].messages[0].text='cat conflicting secret';const conflict=await f.migration.preview(f.actor,changed);expect(conflict.report.conflicts).toBe(1);expect(await f.migration.apply(f.actor,f.migration.authorizeApply(f.actor,conflict.ticket))).toMatchObject({quarantined:1});expect(f.query().hits[0].document.messages[0].text).toBe('cat imported history');
});
it.each(['actorKey','confirmation','provenance'])('export self-declared %s cannot establish actor identity or M support',async key=>{
 const f=fixture();await expect(f.migration.preview(f.actor,{...exported(),[key]:'forged-direct-user'})).rejects.toThrow();
});
it('preview binds an immutable digest and retains original event time, not import time',async()=>{
 const f=fixture(),data=exported(),p=await f.migration.preview(f.actor,data);data.records[0].messages[0].text='forged later text';await f.migration.apply(f.actor,f.migration.authorizeApply(f.actor,p.ticket));expect(f.query().hits[0].document.messages[0]).toMatchObject({text:'cat imported history',occurredAt:1000,timeZone:'Asia/Shanghai'});
});
it('bounded apply cancellation preserves completed batches and restart preview is idempotent',async()=>{
 const f=fixture(),data=exported(Array.from({length:18},(_,i)=>'source-'+i)),p=await f.migration.preview(f.actor,data),abort=new AbortController();const original=f.repo.historyCommand.bind(f.repo);let applies=0;f.repo.historyCommand=(c:any)=>{const r=original(c);if(c.kind==='migrationApply'&&++applies===1)abort.abort();return r};const cap=f.migration.authorizeApply(f.actor,p.ticket);expect(await f.migration.apply(f.actor,cap,{signal:abort.signal})).toMatchObject({status:'cancelled',inserted:16});f.reopen();const second=await f.migration.preview(f.actor,data);expect(second.report.duplicates).toBe(16);expect(await f.migration.apply(f.actor,f.migration.authorizeApply(f.actor,second.ticket))).toMatchObject({inserted:2,duplicates:16});
});
it('forget between preview and apply refuses stale capability and cannot revive imported history',async()=>{
 const f=fixture(),p=await f.migration.preview(f.actor,exported()),a=await f.active();await f.policy.act(f.actor,await f.policy.event(f.actor,{kind:'forget',nonce:randomUUID(),factId:a.factId,revision:1}));await expect(f.migration.apply(f.actor,f.migration.authorizeApply(f.actor,p.ticket))).rejects.toThrow('MEMORY_HISTORY_STALE');const next=await f.migration.preview(f.actor,exported());expect(await f.migration.apply(f.actor,f.migration.authorizeApply(f.actor,next.ticket))).toMatchObject({inserted:0,quarantined:1});expect(f.query().hits).toEqual([]);
});
it('wrong format and incomplete tool results fail preview before any write',async()=>{
 const f=fixture();await expect(f.migration.preview(f.actor,{...exported(),format:'other-product'})).rejects.toThrow();const bad=exported() as any;bad.records[0].messages.push({id:'toolcall',role:'assistant',text:'cat',occurredAt:null,timeZone:null,toolCallIds:['t']});await expect(f.migration.preview(f.actor,bad)).rejects.toThrow('MEMORY_CONTEXT_TOOL_PAIR_INVALID');expect(f.query().hits).toEqual([]);
});
it('original export session/provider attribution is mandatory and cannot grant another partition',async()=>{
 const f=fixture(),data=exported() as any;data.records[0].sourceProvider='synthetic';data.records[0].sourceSession='session-a';const p=await f.migration.preview(f.actor,data);expect(p.report.new).toBe(1);data.records[0].sourceSession='unauthorized-session';await expect(f.migration.preview(f.actor,data)).rejects.toThrow('MEMORY_HISTORY_ACCESS_DENIED');
});
