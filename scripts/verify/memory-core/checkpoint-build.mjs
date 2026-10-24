import fs from "node:fs";
function replaceOnce(source,from,to){
 if(source.split(from).length!==2)throw new Error("PROBE_INSTRUMENTATION_SEAM_CHANGED");
 return source.replace(from,to);
}
export const checkpointPlugin={name:"memory-checkpoints",setup(build){
 build.onLoad({filter:/[\\/]memory-core[\\/](protected-key|database-auth)\.ts$/},args=>{
  let source=fs.readFileSync(args.path,"utf8");
  const hook=stage=>'globalThis.__memoryProbeStage?.("'+stage+'");';
  if(args.path.endsWith("protected-key.ts")){
   source=replaceOnce(source,"const stage=async(s:KeyStage)=>{","const stage=async(s:KeyStage)=>{globalThis.__memoryProbeStage?.('key-'+s);");
  }else{
   source=replaceOnce(source,'const fd=fs.openSync(pending,"wx");','const fd=fs.openSync(pending,"wx");'+hook("auth-pending-opened"));
   source=replaceOnce(source,'fs.writeFileSync(fd,bytes);fs.fsyncSync(fd)','fs.writeFileSync(fd,bytes);'+hook("auth-pending-written")+'fs.fsyncSync(fd);'+hook("auth-pending-fsynced"));
   source=replaceOnce(source,'const bytes=read(pending),id=decode(bytes,key);flush(pending);','const bytes=read(pending),id=decode(bytes,key);flush(pending);'+hook("auth-pending-validated"));
   source=replaceOnce(source,'fs.linkSync(pending,file);flush(file);','fs.linkSync(pending,file);'+hook("auth-published")+'flush(file);');
   source=replaceOnce(source,'decode(read(file),key);fs.unlinkSync(pending);return id;','decode(read(file),key);fs.unlinkSync(pending);'+hook("auth-ready")+'return id;');
  }
  return {contents:source,loader:"ts"};
 });
}};
