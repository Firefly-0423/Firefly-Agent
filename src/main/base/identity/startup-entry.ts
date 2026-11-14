/** 一次性诊断启动参数只在开发版生效；安装版忽略它们，按正常启动处理。 */
export function diagnosticSwitchesAllowed(isPackaged:boolean):boolean{return !isPackaged;}
export function dispatchMainEntry(diagnostic:boolean,paths:{diagnostic():void;ordinary():void;openrouter?():void;ignored?():void},openrouter=false,allowDiagnostics=true):void {
 if(!allowDiagnostics){if(diagnostic||openrouter)paths.ignored?.();paths.ordinary();return;}
 if(openrouter){if(diagnostic||!paths.openrouter)throw new Error("DIAGNOSTIC_MODE_CONFLICT");paths.openrouter();}
 else if(diagnostic)paths.diagnostic();
 else paths.ordinary();
}
