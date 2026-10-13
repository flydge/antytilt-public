import type {Request,Response} from 'express'
export function resolveAuthCookieName(configured?:string):string {
 const name=configured===undefined?'antytilt_auth':configured
 if(!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name))throw Error('AUTH_COOKIE_NAME must be a valid cookie token name')
 return name
}
export function createSessionCookie(configured:string|undefined,options:{secure:boolean;maxAge:number}){
 const name=resolveAuthCookieName(configured)
 return {
  read(request:Request){for(const cookie of request.headers.cookie?.split(';')??[]){const[key,...value]=cookie.trim().split('=');if(key===name)return decodeURIComponent(value.join('='))}return undefined},
  set(response:Response,token:string){response.cookie(name,token,{httpOnly:true,sameSite:'strict',secure:options.secure,maxAge:options.maxAge,path:'/'})},
  clear(response:Response){response.clearCookie(name,{httpOnly:true,sameSite:'strict',secure:options.secure,path:'/'})},
 }
}
