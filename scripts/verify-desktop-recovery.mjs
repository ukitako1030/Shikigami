import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'shikigami-recovery-'));
const sessionFile=path.join(temp,'session.json');
const controlFile=path.join(temp,'mock-control.json');
const configFile=path.join(temp,'config.toml');
await fs.writeFile(controlFile,JSON.stringify({failStop:true}));

// The child service imports this bridge through a Node ESM hook. No WSL process is started.
const mockBridge=`
  import fs from 'node:fs';
  export class DesktopBridge {
    constructor(){ this.sessionId=null; this.child=null; }
    async start(){ this.sessionId='0123456789abcdef01234567'; throw new Error('mock start failed after acquiring session'); }
    async stop(){
      if(JSON.parse(fs.readFileSync(process.env.SHIKIGAMI_RECOVERY_CONTROL,'utf8')).failStop)throw new Error('mock cleanup failed');
      this.sessionId=null; this.child=null;
    }
  }
`;
const mockUrl='data:text/javascript;base64,'+Buffer.from(mockBridge).toString('base64');
const preload=`
  import {registerHooks} from 'node:module';
  const mockUrl=${JSON.stringify(mockUrl)};
  registerHooks({resolve(specifier,context,nextResolve){
    if(specifier==='./bridge.mjs' && context.parentURL?.endsWith('/src/desktop/service.mjs'))return {url:mockUrl,shortCircuit:true};
    return nextResolve(specifier,context);
  }});
`;
process.env.SHIKIGAMI_DESKTOP_DATA_DIR=temp;
process.env.SHIKIGAMI_RECOVERY_CONTROL=controlFile;
process.env.SHIKIGAMI_CODEX_CONFIG=configFile;
process.env.NODE_OPTIONS='--import=data:text/javascript;base64,'+Buffer.from(preload).toString('base64');
const {ensureDesktopService}=await import('../src/desktop/service.mjs');
let session;
async function api(route){
  const response=await fetch(session.base+'/api/'+route,{method:route==='status'||route==='health'?'GET':'POST',headers:{'X-Shikigami-Token':session.token,'Content-Type':'application/json'},body:route==='status'||route==='health'?undefined:'{}',signal:AbortSignal.timeout(5000)});
  return {status:response.status,body:await response.json()};
}
async function request(route,{token=session.token,method='GET',body}={}){
  const response=await fetch(session.base+route,{method,headers:{...(token?{'X-Shikigami-Token':token}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
  return {status:response.status,headers:response.headers,text:await response.text()};
}
const exists=file=>fs.stat(file).then(()=>true,()=>false);
try{
  session=await ensureDesktopService();
  const failedStart=await api('start');
  assert.equal(failedStart.status,500);
  assert.match(failedStart.body.error,/mock start failed/);
  const stranded=await api('status');
  assert.equal(stranded.body.needsCleanup,true);
  assert.equal(stranded.body.running,false);
  const deniedRestart=await api('start');
  assert.equal(deniedRestart.status,409);
  const failedStop=await api('stop');
  assert.equal(failedStop.status,500);
  assert.equal((await api('status')).body.needsCleanup,true);
  const failedShutdown=await api('shutdown');
  assert.equal(failedShutdown.status,409);
  assert.equal((await api('health')).status,200);
  assert.equal(JSON.parse(await fs.readFile(sessionFile,'utf8')).instanceId,session.instanceId);
  await fs.writeFile(controlFile,JSON.stringify({failStop:false}));
  const recovered=await api('stop');
  assert.equal(recovered.status,200);
  assert.equal(recovered.body.needsCleanup,false);
  assert.equal((await api('status')).body.needsCleanup,false);

  // The AI-facing workspace URL is view-only and never carries the admin token.
  const workspace=await request('/api/mcp/call',{method:'POST',body:{name:'desktop_workspace',arguments:{}}});
  assert.equal(workspace.status,200);assert(!workspace.text.includes(session.token));
  const view=JSON.parse(JSON.parse(workspace.text).content[0].text).panel;
  assert.match(view,/^http:\/\/127\.0\.0\.1:\d+\/view\/[a-f0-9]{48}$/);
  const viewToken=view.split('/').pop();assert.notEqual(viewToken,session.token);
  const viewPage=await request(new URL(view).pathname,{token:null});
  assert.equal(viewPage.status,200);assert(viewPage.text.includes('class="role-view"'));assert(!viewPage.text.includes(session.token));
  for(const [name,value] of [['x-frame-options','DENY'],['content-security-policy',"frame-ancestors 'none'"],['referrer-policy','no-referrer']])assert.equal(viewPage.headers.get(name),value);
  assert((await request('/panel/'+session.token,{token:null})).text.includes('class="role-admin"'));
  assert.equal((await request('/panel/'+viewToken,{token:null})).status,403);
  assert.equal((await request('/view/'+session.token,{token:null})).status,403);
  assert.equal((await request('/api/status',{token:viewToken})).status,200);
  assert.notEqual((await request('/api/files',{token:viewToken})).status,403);
  const adminOnly=[['GET','/api/health'],['GET','/api/config'],['GET','/api/tools'],['POST','/api/connect-codex',{approveDesktopOperations:true}],['POST','/api/export',{name:'note.txt'}],['POST','/api/file',{name:'note.txt'}],['POST','/api/start'],['POST','/api/action',{method:'key',key:'ctrl+s'}],['POST','/api/demo',{seconds:10}],['POST','/api/events',{events:[]}],['POST','/api/confirm',{result:'none'}],['POST','/api/mcp/register'],['POST','/api/mcp/call',{name:'desktop_workspace'}],['POST','/api/shutdown']];
  for(const [method,route,body] of adminOnly){
    const denied=await request(route,{token:viewToken,method,body:method==='POST'?body||{}:undefined});
    assert.equal(denied.status,403,route);assert.equal(denied.headers.get('x-frame-options'),'DENY');
  }
  assert.equal(await exists(configFile),false,'View token must not write Codex config');
  assert.equal((await request('/api/stop',{token:viewToken,method:'POST',body:{}})).status,200);

  // Codex config goes through the shared writer: backup, idempotence, and conflicts reported as 409.
  const original='model = "keep"\r\n\r\n[mcp_servers.other]\r\ncommand = "x"\r\n';
  await fs.writeFile(configFile,original);
  assert.equal((await request('/api/connect-codex',{method:'POST',body:{}})).status,400);
  const connected=JSON.parse((await request('/api/connect-codex',{method:'POST',body:{approveDesktopOperations:true}})).text);
  assert.equal(connected.updated,true);assert(path.basename(connected.backup).startsWith('config.toml.shikigami-desktop-backup-'));
  assert.equal(await fs.readFile(connected.backup,'utf8'),original);
  const written=await fs.readFile(configFile,'utf8');
  assert(written.startsWith(original.trimEnd()));assert(written.includes('[mcp_servers.shikigami_desktop.tools.desktop_type]\r\napproval_mode = "approve"'));
  assert.equal(JSON.parse((await request('/api/connect-codex',{method:'POST',body:{approveDesktopOperations:true}})).text).updated,false);
  const foreign='mcp_servers.shikigami_desktop.command = "elsewhere"\n';
  await fs.writeFile(configFile,foreign);
  assert.equal((await request('/api/connect-codex',{method:'POST',body:{approveDesktopOperations:true}})).status,409);
  assert.equal(await fs.readFile(configFile,'utf8'),foreign);

  const shutdown=await api('shutdown');
  assert.equal(shutdown.status,200);
  for(let i=0;i<50;i++){if(!await fs.stat(sessionFile).catch(()=>null))break;await new Promise(resolve=>setTimeout(resolve,50));}
  assert.equal(await fs.stat(sessionFile).catch(()=>null),null);
  console.log(JSON.stringify({ok:true,restartBlocked:true,cleanupRetried:true,failedShutdownKeptService:true,viewTokenScoped:true,codexConfigWriter:true,normalShutdown:true}));
}finally{
  if(session&&await fs.stat(sessionFile).catch(()=>null)){
    await fs.writeFile(controlFile,JSON.stringify({failStop:false}));
    await api('shutdown').catch(()=>{});
  }
  if(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(temp).startsWith('shikigami-recovery-'))await fs.rm(temp,{recursive:true,force:true});
}
