export function dispatchMainEntry(diagnostic:boolean,paths:{diagnostic():void;ordinary():void;openrouter?():void},openrouter=false):void {
 if(openrouter){if(diagnostic||!paths.openrouter)throw new Error("DIAGNOSTIC_MODE_CONFLICT");paths.openrouter();}
 else if(diagnostic)paths.diagnostic();
 else paths.ordinary();
}
