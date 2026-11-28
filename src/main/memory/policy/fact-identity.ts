import {createHash} from "node:crypto";
import {canonicalJson} from "../core/repository-types";
import type {Attribute} from "../core/extractor";
import type {ContextKey} from "./maintenance-extractor";

/** Compatibility v1: keep these bytes stable, including for existing deletion markers. */
export function policySubjectKey(actor:string,attribute:Attribute,context:ContextKey="default",cardinality:"one"|"many"="one",value:string|null=null,project?:string):string {
 return "actor-attribute-"+createHash("sha256").update(canonicalJson({actor,attribute,...(context!=="default"?{context}:{}),...(cardinality==="many"?{cardinality,value}:{}),...(project!==undefined?{project}:{})})).digest("hex");
}
