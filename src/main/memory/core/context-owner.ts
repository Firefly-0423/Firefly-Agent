/** 一份上下文记录的归属：哪个用户、哪个来源提供方、哪个会话、哪次启动。上下文库和记录账本共用。 */
export interface ContextOwner {actorKey:string;providerId:string;sessionId:string;bootId:string}
