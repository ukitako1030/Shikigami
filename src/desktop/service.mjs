import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {DesktopBridge} from './bridge.mjs';
import {upsertCodexServer} from '../codex-config.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const data=path.resolve(process.env.SHIKIGAMI_DESKTOP_DATA_DIR||path.join(root,'.runtime','desktop-lab'));
const exportDir=path.resolve(process.env.SHIKIGAMI_EXPORT_DIR||path.join(os.homedir(),'Documents','Shikigami','成果物'));
const workspaceKey=createHash('sha256').update(data).digest('hex').slice(0,24);
const sessionFile=path.join(data,'session.json');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const object=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
function clipUnits(value,limit){let out='';for(const char of value){if(out.length+char.length>limit)break;out+=char;}return out;}
function exportName(name,attempt){
  let clean=name.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'');
  if(!clean)clean='file';
  let ext=path.win32.extname(clean);
  if(ext.length>40)ext='';
  let stem=ext?clean.slice(0,-ext.length):clean;
  if(/^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(stem))stem='_'+stem;
  const suffix=attempt===1?'':`-${attempt}`;
  stem=clipUnits(stem,180-ext.length-suffix.length).replace(/[. ]+$/g,'')||'file';
  return stem+suffix+ext;
}
const tools=[
  {name:'desktop_workspace',description:'Read the Shikigami Linux desktop status and an optional view-only preview URL for the user. This is not the host Windows desktop.',inputSchema:object(),annotations:{readOnlyHint:true,openWorldHint:false}},
  {name:'desktop_start',description:'Start the dedicated hidden Linux desktop. No host input or Windows applications.',inputSchema:object()},
  {name:'desktop_screenshot',description:'Capture only the dedicated Linux screen (1100×740).',inputSchema:object(),annotations:{readOnlyHint:true,openWorldHint:false}},
  {name:'desktop_windows',description:'List visible application windows inside the dedicated Linux desktop.',inputSchema:object(),annotations:{readOnlyHint:true,openWorldHint:false}},
  {name:'desktop_files',description:'List files saved in this dedicated Linux workspace, including while the desktop is stopped.',inputSchema:object(),annotations:{readOnlyHint:true,openWorldHint:false}},
  {name:'desktop_read_file',description:'Read one named file from this dedicated Linux workspace (up to 20 MiB).',inputSchema:object({name:{type:'string',minLength:1,maxLength:255}},['name']),annotations:{readOnlyHint:true,openWorldHint:false}},
  {name:'desktop_launch',description:'Open Chrome, the native editor, calculator, or file manager in the dedicated desktop.',inputSchema:object({app:{type:'string',enum:['chrome','editor','calculator','files']}},['app'])},
  {name:'desktop_navigate',description:'Navigate the dedicated Chrome to an http:// or https:// URL.',inputSchema:object({url:{type:'string',pattern:'^https?://',maxLength:2048}},['url'])},
  {name:'desktop_click',description:'Click coordinates in the dedicated Linux screen. Never moves the host pointer.',inputSchema:object({x:{type:'integer',minimum:0,maximum:1099},y:{type:'integer',minimum:0,maximum:739},button:{type:'integer',enum:[1,3]}},['x','y'])},
  {name:'desktop_type',description:'Paste text into the focused Linux application using the private display clipboard.',inputSchema:object({text:{type:'string',maxLength:10000}},['text'])},
  {name:'desktop_key',description:'Send a key combination inside the dedicated desktop only.',inputSchema:object({key:{type:'string',enum:['ctrl+a','ctrl+s','ctrl+o','ctrl+n','ctrl+z','ctrl+y','ctrl+f','ctrl+l','Return','Escape','Tab','BackSpace','Delete','Home','End','Up','Down','Left','Right','Page_Up','Page_Down','alt+F4']}},['key'])},
  {name:'desktop_scroll',description:'Scroll at the private Linux pointer position.',inputSchema:object({direction:{type:'string',enum:['up','down']},steps:{type:'integer',minimum:1,maximum:20}},['direction'])},
  {name:'desktop_stop',description:'Stop only the dedicated desktop processes. Unsaved app changes are lost; saved notes remain.',inputSchema:object()}
];

function configToml(approve=false){
  let value=`[mcp_servers.shikigami_desktop]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(path.join(root,'src','desktop','mcp.mjs'))}]\nstartup_timeout_sec = 30\ntool_timeout_sec = 90\ndefault_tools_approval_mode = "writes"\n\n[mcp_servers.shikigami_desktop.env]\nSHIKIGAMI_DESKTOP_DATA_DIR = ${JSON.stringify(data)}\n`;
  if(approve)for(const tool of tools)value+=`\n[mcp_servers.shikigami_desktop.tools.${tool.name}]\napproval_mode = "approve"\n`;
  return value;
}
// The shared writer keeps backups as config.toml.shikigami-desktop-backup-<time> and reports conflicts as 409.
const connectCodex=()=>upsertCodexServer({server:'shikigami_desktop',section:configToml(true),backupTag:'shikigami-desktop'});
const sameToken=(value,expected)=>{const a=Buffer.from(typeof value==='string'?value:''),b=Buffer.from(expected);return a.length===b.length&&timingSafeEqual(a,b);};
// The view role is the read-only panel handed to AI agents: status, preview, file names, and Stop.
const viewRoutes=new Set(['GET /api/status','GET /api/files','POST /api/capture','POST /api/stop']);

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
  const token=randomBytes(24).toString('hex'),viewToken=randomBytes(24).toString('hex'),instanceId=randomBytes(16).toString('hex');
  const roleOf=value=>sameToken(value,token)?'admin':sameToken(value,viewToken)?'view':null;
  const restored=await fs.readFile(path.join(data,'latest-report.json'),'utf8').then(JSON.parse).catch(()=>null);
  let base,session,bridge=null,cached=null,busy=false,phase='起動するとChrome、エディター、電卓、ファイル管理を使えます',epoch=0,queue=Promise.resolve(),previewAt=null,lastReport=restored&&typeof restored==='object'?restored:null,humanReport=restored?.humanReport??null,demoRunning=false,closing=false,activity=Date.now(),events=[];
  if(lastReport)delete lastReport.humanReport;
  const filesBridge=new DesktopBridge({workspaceKey});
  const agents=new Map();
  const status=()=>({running:Boolean(cached?.running&&bridge?.child),needsCleanup:Boolean(!busy&&bridge&&(bridge.sessionId||bridge.child)&&!cached?.running),busy,phase,connections:agents.size,memory:cached?.running?cached.memory:null,lastReport,humanReport,previewAt,workspaceKey});
  const serialized=fn=>{const next=queue.then(fn,fn);queue=next.catch(()=>{});return next;};
  async function start(){
    if(demoRunning)throw Object.assign(new Error('デモの終了後に起動してください'),{status:409});
    if(status().needsCleanup)throw Object.assign(new Error('先に専用プロセスの停止を再試行してください'),{status:409});
    const generation=epoch;
    return serialized(async()=>{
      if(generation!==epoch)throw new Error('起動を取り消しました');
      busy=true;phase='専用Linuxデスクトップを起動しています';
      try{bridge ||= new DesktopBridge({workspaceKey});cached=await bridge.start();phase='専用デスクトップの準備ができました';return status();}
      catch(e){
        // start() may have failed while its cleanup also failed. Keep the session ID
        // so a later Stop can retry cleanup of this dedicated process group.
        if(!bridge?.sessionId&&!bridge?.child)bridge=null;
        cached=null;phase=bridge?'起動に失敗しました。専用プロセスの停止を再試行してください':'起動できませんでした。セットアップ状況を確認してください';throw e;
      }
      finally{busy=false;}
    });
  }
  async function stop(){
    epoch++;phase='専用プロセスを停止しています';busy=true;
    return serialized(async()=>{
      try{await bridge?.stop();bridge=null;cached=null;previewAt=null;phase='停止しました。保存済みのメモはLinux側に残ります';}
      catch(e){cached=null;phase='停止を確認できませんでした。もう一度停止してください';throw e;}
      finally{busy=false;}
      return status();
    });
  }
  async function operation(body,{internal=false}={}){
    const methods=['launch','navigate','capture','windows','click','type','key','scroll'];
    if(!methods.includes(body.method))throw new Error('未対応の操作です');
    if(!internal&&body.test!==undefined)throw new Error('テスト用ファイルは自動デモからのみ開けます');
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
  async function listFiles(){
    const result=await filesBridge.readFiles();
    if(!Array.isArray(result?.files)||typeof result.workspacePath!=='string')throw new Error('ファイル一覧の応答が不正です');
    return result;
  }
  async function readFile(name){
    const result=await filesBridge.readFile(name);
    if(result?.name!==name||typeof result.mimeType!=='string'||typeof result.data!=='string'||!Number.isInteger(result.size)||result.size<0||result.size>20*1024*1024)throw new Error('ファイル応答が不正です');
    if(Buffer.from(result.data,'base64').length!==result.size)throw new Error('ファイル内容の長さが一致しません');
    return result;
  }
  async function exportFile(name){
    const result=await readFile(name);
    const bytes=Buffer.from(result.data,'base64');
    await fs.mkdir(exportDir,{recursive:true});
    for(let attempt=1;attempt<=100;attempt++){
      const savedName=exportName(result.name,attempt);
      const destination=path.join(exportDir,savedName);
      let handle;
      try{handle=await fs.open(destination,'wx');}
      catch(error){if(error.code==='EEXIST')continue;throw error;}
      try{await handle.writeFile(bytes);await handle.close();}
      catch(error){await handle.close().catch(()=>{});await fs.unlink(destination).catch(()=>{});throw error;}
      // Mark-of-the-Web: Windows treats exports like downloads (SmartScreen, Office Protected View). Best effort on non-NTFS.
      if(process.platform==='win32')await fs.writeFile(destination+':Zone.Identifier','[ZoneTransfer]\r\nZoneId=3\r\n').catch(()=>{});
      return {name:savedName,path:destination,size:bytes.length};
    }
    throw Object.assign(new Error('同名の成果物が100件あります。保存先を整理して再試行してください'),{status:409});
  }
  function assessHumanConcurrency(){
    if(!lastReport)return;
    const input=(lastReport.humanEvents?.input||0)>0;
    const pointer=(lastReport.humanEvents?.pointermove||0)+(lastReport.humanEvents?.pointerdown||0)>0;
    lastReport.humanConcurrentInputObserved=Boolean(lastReport.humanEventWindow==='ai-operations'&&input&&pointer&&lastReport.actions>0);
    lastReport.humanConcurrencyVerified=Boolean(lastReport.mode==='human'&&lastReport.humanEventWindow==='ai-operations'&&lastReport.success&&lastReport.humanConcurrentInputObserved&&humanReport==='none');
    lastReport.humanConcurrencyScope=lastReport.humanEventWindow==='ai-operations'
      ?'専用パネル上のAI操作実行中の入力・ポインター操作と、利用者の干渉なしという自己申告に限ります。他のWindowsアプリや一般的な非干渉を保証しません。'
      :'以前の報告に操作時刻の照合情報がないため、同時操作の判定はできません。記録済みの操作数と自己申告は保持しています。';
  }
  if(lastReport)assessHumanConcurrency();
  async function saveReport(){if(lastReport){assessHumanConcurrency();await fs.writeFile(path.join(data,'latest-report.json'),JSON.stringify({...lastReport,humanReport},null,2));}}
  async function demo(seconds){
    const generation=epoch,began=Date.now(),runId=randomBytes(8).toString('hex');
    events=[];humanReport=null;lastReport=null;demoRunning=true;busy=true;
    const aiWindows=[];
    const report={success:false,cancelled:false,mode:seconds===60?'human':'automatic',humanEventWindow:'ai-operations',runId,durationSeconds:0,actions:0,cycles:0,savedVerified:false,peakPssMiB:0,peakRssMiB:0,humanEvents:{input:0,pointermove:0,pointerdown:0,wheel:0},humanConcurrencyVerified:false};
    let observer=null;
    const stopFile=path.join(data,`${runId}-observe.stop`),observeFile=path.join(data,`${runId}-observe.json`);
    if(process.platform==='win32')observer=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts','observe.ps1'),'-RootPid',String(process.pid),'-OutputPath',observeFile,'-StopPath',stopFile],{windowsHide:true,stdio:'ignore'});
    const guard=()=>{if(epoch!==generation||!bridge)throw Object.assign(new Error('利用者が停止しました'),{cancelled:true});};
    const perform=async body=>{
      guard();const started=Date.now();
      try{const result=await operation(body,{internal:true});report.actions++;return result;}
      finally{aiWindows.push([started,Date.now()]);}
    };
    try{
      do{
        phase=`自動デモ ${report.cycles+1} 回目：エディターで入力・保存`;
        await perform({method:'launch',app:'editor',test:true});
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
      for(const event of events){
        if(event.type in report.humanEvents&&aiWindows.some(([start,end])=>event.t>=start&&event.t<=end))report.humanEvents[event.type]++;
      }
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
      if(name==='desktop_workspace')result={...await updateStatus(),panel:session.view,panelAccess:'view-only',platform:'Linux on WSL 2',windowsAppsSupported:false,inputIsolation:true,securitySandbox:false};
      else if(name==='desktop_files')result=await listFiles();
      else if(name==='desktop_read_file'){
        result=await readFile(args.name);
        const metadata={name:result.name,mimeType:result.mimeType,size:result.size};
        if(/^text\//.test(result.mimeType)||/^(application\/(?:json|xml|javascript))$/.test(result.mimeType))return {content:[{type:'text',text:JSON.stringify(metadata)},{type:'text',text:Buffer.from(result.data,'base64').toString('utf8')}]};
        if(/^image\/(?:png|jpeg|gif|webp)$/.test(result.mimeType))return {content:[{type:'text',text:JSON.stringify(metadata)},{type:'image',data:result.data,mimeType:result.mimeType}]};
        return {content:[{type:'text',text:JSON.stringify(metadata)},{type:'resource',resource:{uri:`shikigami-desktop://file/${encodeURIComponent(result.name)}`,mimeType:result.mimeType,blob:result.data}}]};
      }
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
    res.setHeader('X-Frame-Options','DENY');res.setHeader('Content-Security-Policy',"frame-ancestors 'none'");
    try{
      if(req.headers.host!==new URL(base).host||req.headers.origin&&req.headers.origin!==base)return reply(res,403,{error:'Invalid host or origin'});
      const url=new URL(req.url,base);
      const page=req.method==='GET'&&/^\/(panel|view)\/([a-f0-9]{48})$/.exec(url.pathname);
      if(page&&roleOf(page[2])===(page[1]==='panel'?'admin':'view')){
        const html=(await fs.readFile(path.join(root,'src','desktop','panel.html'),'utf8')).replaceAll('__TOKEN__',page[2]).replaceAll('__ROLE__',page[1]==='panel'?'admin':'view');
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end(html);return;
      }
      if(req.method==='GET'&&url.pathname==='/assets/shikigami-spirit.png'){res.writeHead(200,{'Content-Type':'image/png'}).end(await fs.readFile(path.join(root,'src','assets','shikigami-spirit.png')));return;}
      const role=roleOf(req.headers['x-shikigami-token']);
      if(!role)return reply(res,403,{error:'Invalid token'});
      const route=url.pathname;
      if(role!=='admin'&&!viewRoutes.has(`${req.method} ${route}`))return reply(res,403,{error:'確認用の画面では操作できません。Shikigamiの管理画面から行ってください'});
      activity=Date.now();
      if(req.method==='GET'){
        if(route==='/api/health')return reply(res,200,{instanceId,pid:process.pid});
        if(route==='/api/status')return reply(res,200,await updateStatus());
        if(route==='/api/files'){const listed=await listFiles();return reply(res,200,role==='admin'?listed:{files:listed.files.map(({name,size,modifiedAt})=>({name,size,modifiedAt})),workspacePath:listed.workspacePath});}
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
        if(route==='/api/file')return reply(res,200,await readFile(value.name));
        if(route==='/api/export')return reply(res,200,await exportFile(value.name));
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
        if(route==='/api/shutdown'){await shutdown(res);return;}
      }
      return reply(res,404,{error:'Not found'});
    }catch(e){return reply(res,e.status||500,{error:e.message});}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;
  session={pid:process.pid,base,token,instanceId,panel:`${base}/panel/${token}`,view:`${base}/view/${viewToken}`,started:new Date().toISOString(),dataDir:data};
  await fs.writeFile(sessionFile,JSON.stringify(session,null,2));
  async function shutdown(res){
    if(closing){if(res)reply(res,202,{ok:true,closing:true});return;}
    closing=true;
    try{await stop();}
    catch(error){
      closing=false;activity=Date.now();
      if(res)reply(res,409,{error:'専用プロセスの停止を確認できませんでした。停止を再試行してください: '+error.message});
      else console.error('Shikigami cleanup failed:',error);
      return;
    }
    if(res)reply(res,200,{ok:true});
    await new Promise(resolve=>server.close(resolve));
    await fs.unlink(sessionFile).catch(()=>{});
    process.exit(0);
  }
  process.on('SIGTERM',()=>{shutdown().catch(console.error);});process.on('SIGINT',()=>{shutdown().catch(console.error);});
  setInterval(()=>{
    for(const [id,t]of agents)if(Date.now()-t>90000)agents.delete(id);
    if(!busy&&agents.size===0&&Date.now()-activity>15*60_000)shutdown().catch(console.error);
  },30000).unref();
}
if(process.argv.includes('--serve'))serve().catch(e=>{console.error(e);process.exitCode=1;});
if(process.argv.includes('--start'))console.log(JSON.stringify(await ensureDesktopService()));
