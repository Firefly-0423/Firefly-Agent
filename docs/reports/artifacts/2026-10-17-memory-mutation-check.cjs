// Offline, in-memory mutants only. No production source or emitted file is changed.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),assert=require('node:assert/strict'),ts=require('typescript');
require.extensions['.ts']=(mod,file)=>mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);
const file=path.resolve('src/main/memory-policy/natural-protocol.ts'),source=fs.readFileSync(file,'utf8');
function load(input){const mod=new Module(file,module);mod.filename=file;mod.paths=Module._nodeModulePaths(path.dirname(file));mod._compile(ts.transpileModule(input,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);return mod.exports;}
const text='I no longer use Vim',raw=JSON.stringify({facts:[{subject:'user',attribute:'tool',value:'Vim',polarity:'positive',status:'asserted',quote:text,reason:'test'}]});
const polarityCheck=p=>assert.equal(p.validateNaturalResponse(raw,text,'synthetic').length,0);
const identityCheck=p=>assert.equal(p.typedUserFact('actor',{attribute:'tool',value:'Vim',polarity:'positive'}).slotKey,p.typedUserFact('actor',{attribute:'tool',value:'Ｖｉｍ',polarity:'positive'}).slotKey);
polarityCheck(load(source));identityCheck(load(source));
const mutants=[
 ['polarity-validation',source.replace(/  if\(NEGATIVE\.test\(c\.evidence\.quote\)[^\n]+return \[\];/,'  // mutant: omitted polarity guard'),polarityCheck],
 ['canonical-identity',source.replace('const canonicalValue=cardinality==="many"?normalize(value).replace(/\\s+/g," "):value;','const canonicalValue=value;'),identityCheck],
];
for(const [name,input,check] of mutants){assert.notEqual(input,source,'mutant must change the in-memory source');assert.throws(()=>check(load(input)),assert.AssertionError);console.log(name+': killed');}
console.log('Unmodified checks passed; 2/2 in-memory mutants killed.');
