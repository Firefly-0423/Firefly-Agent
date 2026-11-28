// M 影子抽取：用用户自己接入的模型从聊天里抽取低敏感的个人事实，只写影子记录，不进正式事实库、不参与回答。
// 本目录只放纯逻辑：请求构造与对模型输出的校验。模型输出一律当作不可信数据。

/** 第一批只收这些低敏感类别。健康、过敏、财务、证件、住址、他人隐私等一律不收。 */
export const SHADOW_ATTRIBUTES=['preference','tool','form-of-address','response-style','language'] as const;
export type ShadowAttribute=typeof SHADOW_ATTRIBUTES[number];

export interface ShadowCandidate {
 attribute:ShadowAttribute;
 value:string;
 /** "不喜欢 / 不用"保留为 negative，不能记反。 */
 polarity:'positive'|'negative';
 /** 用户只是附和、或表述含糊时只能是 needs-confirmation。 */
 status:'asserted'|'needs-confirmation';
 /** 证据只能指向用户自己的消息，quote 必须是其中逐字存在的片段。 */
 evidence:{messageId:string;quote:string};
 reason:string;
}

/** 一轮输入：用户原话；上一条助手回复只用来理解语境，不能作为证据。 */
export interface ShadowTurn {user:{id:string;text:string};previousAssistant?:{id:string;text:string}}

export const SHADOW_LIMITS=Object.freeze({maxCandidates:5,maxValueChars:80,maxQuoteChars:200,minQuoteChars:2,maxReasonChars:200,maxUserChars:4000,maxAssistantChars:2000});

export type ShadowDropReason='schema'|'quote-not-in-user'|'sensitive'|'temporary'|'about-other'|'duplicate'|'over-limit';
export const SHADOW_DROP_REASONS:ReadonlyArray<ShadowDropReason>=['schema','quote-not-in-user','sensitive','temporary','about-other','duplicate','over-limit'];
export interface ShadowValidation {
 candidates:ShadowCandidate[];
 /** 每类丢弃原因的条数，只有数字。 */
 dropped:Record<ShadowDropReason,number>;
 /** 被强制改为 needs-confirmation 的条数。 */
 downgraded:number;
}
