export interface RecallPolicy {version:string;halfLifeMs:number;archiveThreshold:number;minIdleMs:number;protectExplicitConfirmation:boolean;maintenanceMode:"disabled"|"dry-run"|"enabled";batchSize:number}
export interface StrengthState {lastAccessAt:number|null;decayAnchorAt:number;lastCalculatedAt:number;strengthAtLastCalculation:number}
export interface RecallProtection {pinned:boolean;explicitConfirmation:boolean;required:boolean}
export interface RecallDependency {factId:string;revision:number;visibilityRevision:number}
export interface RecallTransport {recallCommand(command:unknown):Promise<unknown>}
export interface RecallFactRef {factId:string;revision:number}
export interface RecallState extends StrengthState {id:string;actorKey:string;factId:string;factRevision:number;projectionRevision:number;visibilityRevision:number;visibility:"normal"|"archived";pinned:boolean;policyVersion:string;archivedAt:number|null;archiveReason:"manual"|"decay"|null;accessCount:number}
export type RecallAction="archive"|"restore"|"pin"|"unpin"|"maintenance";
export interface RecallPreview {action:RecallAction;generation:number;policyVersion:string;policyRevision:number;expiresAt:number;targets:Array<RecallFactRef&{projectionRevision:number;visibilityRevision:number}>;requiredFactRefs:RecallFactRef[];candidates:number;mode:RecallPolicy["maintenanceMode"]}
export interface RecallRank {generation:number;policy:RecallPolicy;items:Array<{fact:import("../../shared/memory-contracts").FactView;state:RecallState;protection:RecallProtection;score:number}>}
export interface RecallMetadata {generation:number;policy:RecallPolicy;targets:RecallState[]}
export function recallFail(code:string):never{throw new Error(code)}
