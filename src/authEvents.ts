export const SESSION_EXPIRED_MESSAGE='Session unavailable. Sign in again.'
let epoch=0
const listeners=new Set<()=>void>()
export const authRequestEpoch=()=>epoch
export const advanceAuthEpoch=()=>++epoch
export function onSessionExpired(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener)}}
export function expireAuthSession(requestEpoch:number):boolean{if(requestEpoch!==epoch||listeners.size===0)return false;for(const listener of [...listeners])listener();return true}
