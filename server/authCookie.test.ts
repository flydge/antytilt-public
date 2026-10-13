import {test} from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import {spawnSync} from 'node:child_process'
import type {AddressInfo} from 'node:net'
import {createSessionCookie,resolveAuthCookieName} from './authCookie'

test('unset namespace retains the original name; configured token name is exact and invalid names fail without echoing it',()=>{assert.equal(resolveAuthCookieName(undefined),'antytilt_auth');assert.equal(resolveAuthCookieName('antytilt_15173_auth'),'antytilt_15173_auth');for(const input of['',' spaced','bad;name','bad=name','bad\r\nSet-Cookie:token','имя'])assert.throws(()=>resolveAuthCookieName(input),e=>e instanceof Error&&e.message==='AUTH_COOKIE_NAME must be a valid cookie token name')})
test('configured public auth reads/sets/clears its cookie only; sibling default clear leaves the working session authenticated',async()=>{
 process.env.AUTH_COOKIE_NAME='antytilt_15173_auth'
 const {app}=await import('./index'),{closeDatabase}=await import('./postgres'),{closeRedis}=await import('./redis')
 const listener=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>listener.once('listening',resolve));const base=`http://127.0.0.1:${(listener.address() as AddressInfo).port}`
 const sibling=express(),originalCookie=createSessionCookie(undefined,{secure:false,maxAge:30*24*60*60*1000});sibling.delete('/logout',(_request,response)=>{originalCookie.clear(response);response.status(204).end()});const oldListener=sibling.listen(0,'127.0.0.1');await new Promise<void>(resolve=>oldListener.once('listening',resolve));const oldBase=`http://127.0.0.1:${(oldListener.address() as AddressInfo).port}`
 const request=(path:string,options?:RequestInit)=>fetch(base+path,{...options,headers:{origin:'http://localhost:5173','Content-Type':'application/json',...options?.headers}})
 try{
  const registered=await request('/api/auth/register',{method:'POST',body:JSON.stringify({email:'isolated-cookie@example.com',password:'synthetic-cookie-password'})});assert.equal(registered.status,201)
  const set=registered.headers.get('set-cookie')!;assert.ok(set.startsWith('antytilt_15173_auth='));assert.match(set,/Max-Age=2592000/);assert.match(set,/Path=\//);assert.match(set,/HttpOnly/);assert.match(set,/SameSite=Strict/);assert.doesNotMatch(set,/Secure/)
  const working=set.split(';')[0],old=working.replace(/^antytilt_15173_auth=/,'antytilt_auth=')
  assert.equal((await(await request('/api/auth/session',{headers:{cookie:old}})).json()).authenticated,false)
  assert.equal((await request('/api/risk/profile',{headers:{cookie:old}})).status,401)
  assert.equal((await(await request('/api/auth/session',{headers:{cookie:working}})).json()).authenticated,true)
  const clearedOld=await fetch(oldBase+'/logout',{method:'DELETE',headers:{cookie:`${old}; ${working}`}}),oldClear=clearedOld.headers.get('set-cookie')!;assert.ok(oldClear.startsWith('antytilt_auth='));assert.doesNotMatch(oldClear,/antytilt_15173_auth/)
  const jar=new Map([old,working].map(pair=>{const at=pair.indexOf('=');return[pair.slice(0,at),pair.slice(at+1)]}));jar.delete(oldClear.split('=')[0]);const remaining=[...jar].map(([name,value])=>`${name}=${value}`).join('; ')
  assert.equal((await(await request('/api/auth/session',{headers:{cookie:remaining}})).json()).authenticated,true)
  const loggedOut=await request('/api/auth/logout',{method:'DELETE',headers:{cookie:remaining}});assert.equal(loggedOut.status,204);assert.ok(loggedOut.headers.get('set-cookie')?.startsWith('antytilt_15173_auth='));assert.equal((await(await request('/api/auth/session',{headers:{cookie:working}})).json()).authenticated,false)
 }finally{await Promise.all([new Promise<void>(resolve=>listener.close(()=>resolve())),new Promise<void>(resolve=>oldListener.close(()=>resolve()))]);await closeRedis();await closeDatabase();delete process.env.AUTH_COOKIE_NAME}
})

test('invalid AUTH_COOKIE_NAME rejects actual app startup before listening without printing the configured value',()=>{const invalid='bad;cookie-name';const started=spawnSync(process.execPath,['--import','tsx','--input-type=module','--eval',"await import('./server/index.ts')"],{cwd:process.cwd(),env:{...process.env,NODE_ENV:'test',AUTH_COOKIE_NAME:invalid},encoding:'utf8'});assert.notEqual(started.status,0);assert.match(started.stderr,/AUTH_COOKIE_NAME must be a valid cookie token name/);assert.equal(started.stderr.includes(invalid),false);assert.equal(started.stdout.includes(invalid),false)})
