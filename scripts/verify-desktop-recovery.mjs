import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'shikigami-recovery-'));
const sessionFile=path.join(temp,'session.json');
const controlFile=path.join(temp,'mock-control.json');
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
process.env.NODE_OPTIONS='--import=data:text/javascript;base64,'+Buffer.from(preload).toString('base64');
const {ensureDesktopService}=await import('../src/desktop/service.mjs');
let session;
async function api(route){
  const response=await fetch(session.base+'/api/'+route,{method:route==='status'||route==='health'?'GET':'POST',headers:{'X-Shikigami-Token':session.token,'Content-Type':'application/json'},body:route==='status'||route==='health'?undefined:'{}',signal:AbortSignal.timeout(5000)});
  return {status:response.status,body:await response.json()};
}
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
  const shutdown=await api('shutdown');
  assert.equal(shutdown.status,200);
  for(let i=0;i<50;i++){if(!await fs.stat(sessionFile).catch(()=>null))break;await new Promise(resolve=>setTimeout(resolve,50));}
  assert.equal(await fs.stat(sessionFile).catch(()=>null),null);
  console.log(JSON.stringify({ok:true,restartBlocked:true,cleanupRetried:true,failedShutdownKeptService:true,normalShutdown:true}));
}finally{
  if(session&&await fs.stat(sessionFile).catch(()=>null)){
    await fs.writeFile(controlFile,JSON.stringify({failStop:false}));
    await api('shutdown').catch(()=>{});
  }
  if(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(temp).startsWith('shikigami-recovery-'))await fs.rm(temp,{recursive:true,force:true});
}
