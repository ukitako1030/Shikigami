import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {DesktopBridge} from './bridge.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const data=path.resolve(process.env.SHIKIGAMI_DESKTOP_DATA_DIR||path.join(root,'.runtime','desktop-lab'));
const sessionFile=path.join(data,'session.json');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const object=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
const tools=[
  {name:'desktop_workspace',description:'Read the Shikigami Linux desktop status and optional preview URL. This is not the host Windows desktop.',inputSchema:object()},
  {name:'desktop_start',description:'Start the dedicated hidden Linux desktop. No host input or Windows applications.',inputSchema:object()},
  {name:'desktop_screenshot',description:'Capture only the dedicated Linux screen (1100×740).',inputSchema:object()},
  {name:'desktop_windows',description:'List visible application windows inside the dedicated Linux desktop.',inputSchema:object()},
  {name:'desktop_launch',description:'Open the native editor or calculator in the dedicated desktop.',inputSchema:object({app:{type:'string',enum:['editor','calculator']}},['app'])},
  {name:'desktop_click',description:'Click coordinates in the dedicated Linux screen. Never moves the host pointer.',inputSchema:object({x:{type:'integer',minimum:0,maximum:1099},y:{type:'integer',minimum:0,maximum:739},button:{type:'integer',enum:[1,3]}},['x','y'])},
  {name:'desktop_type',description:'Paste text into the focused Linux application using the private display clipboard.',inputSchema:object({text:{type:'string',maxLength:10000}},['text'])},
  {name:'desktop_key',description:'Send a key combination inside the dedicated desktop only.',inputSchema:object({key:{type:'string',enum:['ctrl+a','ctrl+s','ctrl+o','ctrl+n','ctrl+z','ctrl+y','ctrl+f','Return','Escape','Tab','BackSpace','Delete','Home','End','Up','Down','Left','Right','Page_Up','Page_Down','alt+F4']}},['key'])},
  {name:'desktop_scroll',description:'Scroll at the private Linux pointer position.',inputSchema:object({direction:{type:'string',enum:['up','down']},steps:{type:'integer',minimum:1,maximum:20}},['direction'])},
  {name:'desktop_stop',description:'Stop only the dedicated desktop processes. Unsaved app changes are lost; saved notes remain.',inputSchema:object()}
];

function configToml(approve=false){
  let value=`[mcp_servers.shikigami_desktop]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(path.join(root,'src','desktop','mcp.mjs'))}]\nstartup_timeout_sec = 30\ntool_timeout_sec = 90\ndefault_tools_approval_mode = "writes"\n\n[mcp_servers.shikigami_desktop.env]\nSHIKIGAMI_DESKTOP_DATA_DIR = ${JSON.stringify(data)}\n`;
  if(approve)for(const tool of tools)value+=`\n[mcp_servers.shikigami_desktop.tools.${tool.name}]\napproval_mode = "approve"\n`;
  return value;
}
async function connectCodex(){
  const config=path.resolve(process.env.SHIKIGAMI_CODEX_CONFIG||path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'config.toml'));
  await fs.mkdir(path.dirname(config),{recursive:true});
  const read=()=>fs.readFile(config,'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e;});
  const original=await read();let own=false;const keep=[];
  for(const line of original.split(/\r?\n/)){
    const heading=/^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
    if(heading){const name=heading[1].replace(/["'\s]/g,'');own=name==='mcp_servers.shikigami_desktop'||name.startsWith('mcp_servers.shikigami_desktop.');}
    if(!own)keep.push(line);
  }
  const updated=keep.join('\n').trimEnd()+'\n\n'+configToml(true);
  if(original.replace(/\r\n/g,'\n')===updated)return {ok:true,updated:false,config,requiresReload:true};
  if(await read()!==original)throw new Error('設定が別の処理で更新されました。再試行してください');
  const backup=original?`${config}.shikigami-desktop-backup-${Date.now()}`:null;
  if(backup)await fs.writeFile(backup,original,{flag:'wx'});
  const temporary=`${config}.shikigami-desktop-${randomBytes(8).toString('hex')}.tmp`;
  try{await fs.writeFile(temporary,updated,{flag:'wx'});if(await read()!==original)throw new Error('設定が同時に更新されました。再試行してください');await fs.rename(temporary,config);}
  finally{await fs.unlink(temporary).catch(()=>{});}
  return {ok:true,updated:true,config,backup,requiresReload:true};
}

async function alive(session){
  if(!session||!/^http:\/\/127\.0\.0\.1:\d+$/.test(session.base)||!/^[a-f0-9]{48}$/.test(session.token))return false;
  try{const r=await fetch(session.base+'/api/health',{headers:{'X-Shikigami-Token':session.token},signal:AbortSignal.timeout(1000)});return r.ok&&(await r.json()).instanceId===session.instanceId;}catch{return false;}
}
export async function ensureDesktopService(){
  await fs.mkdir(data,{recursive:true});
  const read=()=>fs.readFile(sessionFile,'utf8').then(JSON.parse).catch(()=>null);
  let session=await read();if(await alive(session))return session;
  const lockPath=path.join(data,'startup.lock');let lock;
  for(let i=0;i<150;i++){
    try{lock=await fs.open(lockPath,'wx');break;}catch(e){if(e.code!=='EEXIST')throw e;}
    session=await read();if(await alive(session))return session;
    const stat=await fs.stat(lockPath).catch(()=>null);
    if(stat&&Date.now()-stat.mtimeMs>30000)await fs.unlink(lockPath).catch(()=>{});
    await sleep(200);
  }
  if(!lock)throw new Error('専用スペース管理の起動がタイムアウトしました');
  try{
    session=await read();if(await alive(session))return session;
    const p=spawn(process.execPath,[fileURLToPath(import.meta.url),'--serve'],{cwd:root,env:{...process.env,SHIKIGAMI_DESKTOP_DATA_DIR:data},windowsHide:true,detached:true,stdio:'ignore'});p.unref();
    for(let i=0;i<100;i++){session=await read();if(session?.pid===p.pid&&await alive(session))return session;await sleep(100);}
    throw new Error('デスクトップ管理を起動できませんでした');
  }finally{await lock.close();await fs.unlink(lockPath).catch(()=>{});}
}

async function serve(){
  await fs.mkdir(data,{recursive:true});
  const token=randomBytes(24).toString('hex'),instanceId=randomBytes(16).toString('hex');
  let base,session,bridge=null,cached=null,busy=false,phase='起動するとエディターと電卓を使えます',epoch=0,queue=Promise.resolve(),previewAt=null,lastReport=null,humanReport=null,demoRunning=false,closing=false,activity=Date.now(),events=[];
  const agents=new Map();
  const status=()=>({running:Boolean(cached?.running&&bridge?.child),needsCleanup:Boolean(bridge?.sessionId&&!bridge.child),busy,phase,connections:agents.size,memory:cached?.running?cached.memory:null,lastReport,humanReport,previewAt});
  const serialized=fn=>{const next=queue.then(fn,fn);queue=next.catch(()=>{});return next;};
  async function start(){
    if(demoRunning)throw Object.assign(new Error('デモの終了後に起動してください'),{status:409});
    const generation=epoch;
    return serialized(async()=>{
      if(generation!==epoch)throw new Error('起動を取り消しました');
      busy=true;phase='専用Linuxデスクトップを起動しています';
      try{bridge ||= new DesktopBridge();cached=await bridge.start();phase='専用デスクトップの準備ができました';return status();}
      catch(e){bridge=null;cached=null;phase='起動できませんでした。セットアップ状況を確認してください';throw e;}
      finally{busy=false;}
    });
  }
  async function stop(){
    epoch++;phase='専用プロセスを停止しています';busy=true;
    return serialized(async()=>{
      try{await bridge?.stop();bridge=null;cached=null;previewAt=null;phase='停止しました。保存済みのメモはLinux側に残ります';}
      catch(e){phase='停止を確認できませんでした。もう一度停止してください';throw e;}
      finally{busy=false;}
      return status();
    });
  }
  async function operation(body,{internal=false}={}){
    const methods=['launch','capture','windows','click','type','key','scroll'];
    if(!methods.includes(body.method))throw new Error('未対応の操作です');
    if(demoRunning&&!internal)throw Object.assign(new Error('デモの終了後に操作してください'),{status:409});
    const generation=epoch;
    return serialized(async()=>{
      if(generation!==epoch||!bridge||!cached?.running)throw new Error('専用デスクトップは停止中です');
      if(!internal)busy=true;
      try{
        const result=await bridge.request(body);
        if(body.method==='capture')previewAt=result.capturedAt;
        return result;
      }finally{if(!internal&&!demoRunning)busy=false;}
    });
  }
  async function updateStatus(){
    if(bridge?.child)try{cached=await bridge.request({method:'status'});}catch{cached=null;}
    return status();
  }
  async function saveReport(){if(lastReport)await fs.writeFile(path.join(data,'latest-report.json'),JSON.stringify({...lastReport,humanReport},null,2));}
  async function demo(seconds){
    const generation=epoch,began=Date.now(),runId=randomBytes(8).toString('hex');
    events=[];humanReport=null;lastReport=null;demoRunning=true;busy=true;
    const report={success:false,cancelled:false,runId,durationSeconds:0,actions:0,cycles:0,savedVerified:false,peakPssMiB:0,peakRssMiB:0,humanEvents:{input:0,pointermove:0,pointerdown:0,wheel:0},humanConcurrencyVerified:false};
    let observer=null;
    const stopFile=path.join(data,`${runId}-observe.stop`),observeFile=path.join(data,`${runId}-observe.json`);
    if(process.platform==='win32')observer=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts','observe.ps1'),'-RootPid',String(process.pid),'-OutputPath',observeFile,'-StopPath',stopFile],{windowsHide:true,stdio:'ignore'});
    const guard=()=>{if(epoch!==generation||!bridge)throw Object.assign(new Error('利用者が停止しました'),{cancelled:true});};
    const perform=async body=>{guard();const r=await operation(body,{internal:true});report.actions++;return r;};
    try{
      do{
        phase=`自動デモ ${report.cycles+1} 回目：エディターで入力・保存`;
        await perform({method:'launch',app:'editor'});
        await perform({method:'click',x:220,y:180,button:1});
        await perform({method:'key',key:'ctrl+a'});
        const text=`Shikigami — AI専用デスクトップ\n\nこれはブラウザの中の編集画面ではありません。\nLinuxのエディターを、専用画面で操作しています。\n\n日本語の入力と保存：${report.cycles+1} 回目\nあなたは普段のWindowsで作業を続けられます。\n\n${Array.from({length:28},(_,i)=>`記録 ${i+1}：非表示の専用スペースで作業中。`).join('\n')}\n`;
        await perform({method:'type',text});
        await perform({method:'key',key:'ctrl+s'});
        await sleep(200);guard();
        const saved=await serialized(()=>bridge.request({method:'read_test_note'}));
        if(saved.text!==text)throw new Error('エディターで保存した文章が一致しません');
        report.savedVerified=true;
        await perform({method:'scroll',direction:'up',steps:8});
        phase=`自動デモ ${report.cycles+1} 回目：電卓へ切り替え`;
        await perform({method:'launch',app:'calculator'});
        // Positions are from the fixed-size calculator in this prototype; the agent uses screenshots.
        for(const [x,y] of [[1021,240],[963,528],[1023,528],[963,528],[1023,559]])await perform({method:'click',x,y,button:1});
        guard();cached=await bridge.request({method:'status'});
        report.peakPssMiB=Math.max(report.peakPssMiB,cached.memory.pssMiB);
        report.peakRssMiB=Math.max(report.peakRssMiB,cached.memory.rssMiB);
        report.cycles++;
        await sleep(500);
      }while(Date.now()-began<seconds*1000);
      report.success=true;phase='自動デモ完了：日本語入力・保存・アプリ切り替えを確認しました';
    }catch(e){report.cancelled=Boolean(e.cancelled||epoch!==generation);report.error=e.message;if(!report.cancelled)phase='デモでエラーが発生しました：'+e.message;}
    finally{
      report.durationSeconds=Math.round((Date.now()-began)/100)/10;
      for(const event of events)if(event.type in report.humanEvents)report.humanEvents[event.type]++;
      if(observer){
        await fs.writeFile(stopFile,'stop');
        if(observer.exitCode===null)await Promise.race([new Promise(r=>observer.once('exit',r)),sleep(8000)]);
        try{
          const observed=JSON.parse((await fs.readFile(observeFile,'utf8')).replace(/^\uFEFF/,''));
          const owned=new Set(observed.memory.flatMap(m=>m.pids));
          report.windowsObservation={samples:observed.samples.length,aiForegroundSamples:observed.samples.filter(s=>owned.has(s.foregroundPid)).length,visibleAiWindowSamples:observed.memory.filter(m=>m.visiblePids.length).length,cursorChanges:observed.samples.filter((s,i,a)=>i&&(s.x!==a[i-1].x||s.y!==a[i-1].y)).length,foregroundChanges:observed.samples.filter((s,i,a)=>i&&s.foregroundHandle!==a[i-1].foregroundHandle).length,maxSamplingGapMs:Math.max(0,...observed.samples.slice(1).map((s,i)=>s.t-observed.samples[i].t)),note:'Windows observation covers the manager and WSL launcher, not all Linux processes. Cursor changes may be human input. Not proof of zero interference.'};
        }catch(e){report.observationError=e.message;}
      }
      lastReport=report;demoRunning=false;if(generation===epoch)busy=false;
      await saveReport();
    }
  }
  async function callTool(name,args){
    try{
      if(!tools.some(t=>t.name===name))throw new Error('Unknown desktop tool');
      let result;
      if(name==='desktop_workspace')result={...await updateStatus(),panel:session.panel,platform:'Linux on WSL 2',windowsAppsSupported:false,inputIsolation:true,securitySandbox:false};
      else if(name==='desktop_start')result=await start();
      else if(name==='desktop_stop')result=await stop();
      else{
        const method=name==='desktop_screenshot'?'capture':name.slice('desktop_'.length);
        result=await operation({...args,method});
        if(method==='capture')return {content:[{type:'image',data:result.image,mimeType:'image/png'},{type:'text',text:JSON.stringify({width:result.width,height:result.height,capturedAt:result.capturedAt})}]};
      }
      return {content:[{type:'text',text:JSON.stringify(result)}]};
    }catch(e){return {isError:true,content:[{type:'text',text:e.message}]};}
  }
  const reply=(res,code,value)=>res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'}).end(JSON.stringify(value));
  async function body(req){let bytes=0,chunks=[];for await(const c of req){bytes+=c.length;if(bytes>100000)throw Object.assign(new Error('Request too large'),{status:413});chunks.push(c);}try{return bytes?JSON.parse(Buffer.concat(chunks).toString('utf8')):{};}catch{throw Object.assign(new Error('Invalid JSON'),{status:400});}}
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    try{
      if(req.headers.host!==new URL(base).host||req.headers.origin&&req.headers.origin!==base)return reply(res,403,{error:'Invalid host or origin'});
      const url=new URL(req.url,base);
      if(req.method==='GET'&&url.pathname===`/panel/${token}`){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end((await fs.readFile(path.join(root,'src','desktop','panel.html'),'utf8')).replaceAll('__TOKEN__',token));return;}
      if(req.method==='GET'&&url.pathname==='/assets/shikigami-spirit.png'){res.writeHead(200,{'Content-Type':'image/png'}).end(await fs.readFile(path.join(root,'src','assets','shikigami-spirit.png')));return;}
      if(req.headers['x-shikigami-token']!==token)return reply(res,403,{error:'Invalid token'});
      activity=Date.now();const route=url.pathname;
      if(req.method==='GET'){
        if(route==='/api/health')return reply(res,200,{instanceId,pid:process.pid});
        if(route==='/api/status')return reply(res,200,await updateStatus());
        if(route==='/api/tools')return reply(res,200,{tools});
        if(route==='/api/config')return reply(res,200,{configToml:configToml()});
      }
      if(req.method==='POST'){
        const value=await body(req);
        if(route==='/api/connect-codex'){
          if(value.approveDesktopOperations!==true)return reply(res,400,{error:'専用Linuxデスクトップの操作を許可するチェックが必要です'});
          return reply(res,200,await connectCodex());
        }
        if(route==='/api/start')return reply(res,200,await start());
        if(route==='/api/stop')return reply(res,200,await stop());
        if(route==='/api/capture'){
          // Read-only preview may share the serialized pipe with a demo.
          if(!bridge||!cached?.running)return reply(res,409,{error:'専用スペースは停止中です'});
          const generation=epoch;
          const image=await serialized(()=>generation===epoch&&bridge?bridge.request({method:'capture'}):Promise.reject(new Error('停止しました')));
          if(generation!==epoch)throw new Error('停止したため画像を破棄しました');
          previewAt=image.capturedAt;return reply(res,200,image);
        }
        if(route==='/api/action')return reply(res,200,await operation(value));
        if(route==='/api/demo'){
          if(busy||demoRunning||!cached?.running)return reply(res,409,{error:'専用スペースを起動し、操作が終わってから試してください'});
          const seconds=value.seconds===60?60:10;demo(seconds).catch(e=>{phase=e.message;busy=false;demoRunning=false;});return reply(res,202,{ok:true});
        }
        if(route==='/api/events'){
          if(demoRunning&&Array.isArray(value.events))for(const e of value.events.slice(0,100))if(['input','pointermove','pointerdown','wheel'].includes(e.type)&&Number.isFinite(e.t))events.push({type:e.type,t:e.t});
          return reply(res,200,{});
        }
        if(route==='/api/confirm'){
          if(lastReport&&['none','interference','unsure'].includes(value.result)){humanReport=value.result;await saveReport();}return reply(res,200,{});
        }
        if(route==='/api/mcp/register'){const id=randomBytes(12).toString('hex');agents.set(id,Date.now());return reply(res,200,{id});}
        if(route==='/api/mcp/heartbeat'){if(agents.has(value.id))agents.set(value.id,Date.now());return reply(res,200,{});}
        if(route==='/api/mcp/unregister'){agents.delete(value.id);return reply(res,200,{});}
        if(route==='/api/mcp/call')return reply(res,200,await callTool(value.name,value.arguments||{}));
        if(route==='/api/shutdown'){reply(res,200,{ok:true});setImmediate(shutdown);return;}
      }
      return reply(res,404,{error:'Not found'});
    }catch(e){return reply(res,e.status||500,{error:e.message});}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;
  session={pid:process.pid,base,token,instanceId,panel:`${base}/panel/${token}`,started:new Date().toISOString(),dataDir:data};
  await fs.writeFile(sessionFile,JSON.stringify(session,null,2));
  async function shutdown(){if(closing)return;closing=true;await stop().catch(()=>{});server.close();await fs.unlink(sessionFile).catch(()=>{});process.exit(0);}
  process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
  setInterval(()=>{
    for(const [id,t]of agents)if(Date.now()-t>90000)agents.delete(id);
    if(!busy&&agents.size===0&&Date.now()-activity>15*60_000)shutdown();
  },30000).unref();
}
if(process.argv.includes('--serve'))serve().catch(e=>{console.error(e);process.exitCode=1;});
if(process.argv.includes('--start'))console.log(JSON.stringify(await ensureDesktopService()));
