import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.SHIKIGAMI_DATA_DIR || path.join(root, '.runtime'));
const artifactDir = path.resolve(process.env.SHIKIGAMI_DATA_DIR ? path.join(dataDir, 'artifacts') : path.join(root, 'artifacts'));
const sessionFile = path.join(dataDir, 'session.json');
const lockFile = path.join(dataDir, 'startup.lock');
const allowed = new Set([
  'browser_close','browser_resize','browser_console_messages','browser_emulate_media',
  'browser_find','browser_fill_form','browser_press_key','browser_type',
  'browser_mouse_move_xy','browser_mouse_click_xy','browser_mouse_drag_xy',
  'browser_mouse_down','browser_mouse_up','browser_mouse_wheel',
  'browser_navigate','browser_navigate_back','browser_network_requests','browser_network_request',
  'browser_take_screenshot','browser_snapshot','browser_click','browser_drag','browser_hover',
  'browser_select_option','browser_tabs','browser_wait_for'
]);

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const fileExists = async file => fs.stat(file).then(() => true, () => false);
function textResult(text) { return {content:[{type:'text',text}]}; }
function toolError(message) { return {isError:true,content:[{type:'text',text:message}]}; }
function tomlString(value) { return JSON.stringify(value); }
function json(res, code, value) { res.writeHead(code, {'Content-Type':'application/json; charset=utf-8'}).end(JSON.stringify(value)); }

async function readSession() {
  try { return JSON.parse(await fs.readFile(sessionFile, 'utf8')); } catch { return null; }
}
async function liveSession(session) {
  if (!session || !Number.isInteger(session.pid) || !/^http:\/\/127\.0\.0\.1:\d+$/.test(session.base) || !/^[a-f0-9]{48}$/.test(session.token) || !/^[a-f0-9]{32}$/.test(session.instanceId)) return false;
  try {
    const r = await fetch(`${session.base}/api/health`, {headers:{'X-Shikigami-Token':session.token},signal:AbortSignal.timeout(800)});
    return r.ok && (await r.json()).instanceId === session.instanceId;
  } catch { return false; }
}

// A filesystem lock makes first launch deterministic across the app and multiple MCP clients.
export async function ensureService() {
  await fs.mkdir(dataDir, {recursive:true});
  const current = await readSession();
  if (await liveSession(current)) return current;
  let lock;
  const started = Date.now();
  while (!lock) {
    try { lock = await fs.open(lockFile, 'wx'); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await readSession();
      if (await liveSession(existing)) return existing;
      const stat = await fs.stat(lockFile).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > 20000) await fs.unlink(lockFile).catch(() => {});
      if (Date.now() - started > 30000) throw new Error('Shikigami の起動がタイムアウトしました');
      await delay(150);
    }
  }
  try {
    const existing = await readSession();
    if (await liveSession(existing)) return existing;
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--serve'], {
      cwd:root, env:{...process.env,SHIKIGAMI_DATA_DIR:dataDir},
      detached:true, windowsHide:true, stdio:'ignore'
    });
    child.unref();
    for (let i=0; i<150; i++) {
      const fresh = await readSession();
      if (fresh?.pid === child.pid && await liveSession(fresh)) return fresh;
      if (child.exitCode !== null) break;
      await delay(100);
    }
    throw new Error('Shikigami 共有サービスを起動できませんでした');
  } finally { await lock.close(); await fs.unlink(lockFile).catch(() => {}); }
}

async function readBody(req) {
  let bytes = 0, chunks=[];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 1_000_000) throw Object.assign(new Error('request too large'), {status:413});
    chunks.push(chunk);
  }
  if (!bytes) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('invalid JSON'), {status:400}); }
}

function connectionConfig(approve=false) {
  let section=`[mcp_servers.shikigami]\ncommand = ${tomlString(process.execPath)}\nargs = [${tomlString(path.join(root,'src','mcp.mjs'))}]\nstartup_timeout_sec = 30\ntool_timeout_sec = 90\ndefault_tools_approval_mode = "writes"\n\n[mcp_servers.shikigami.env]\nSHIKIGAMI_DATA_DIR = ${tomlString(dataDir)}\n`;
  if(approve)for(const name of ['shikigami_workspace',...allowed])section+=`\n[mcp_servers.shikigami.tools.${name}]\napproval_mode = "approve"\n`;
  return section;
}
async function connectCodex(session) {
  const config = path.resolve(process.env.SHIKIGAMI_CODEX_CONFIG || path.join(process.env.CODEX_HOME || path.join(os.homedir(),'.codex'),'config.toml'));
  await fs.mkdir(path.dirname(config), {recursive:true});
  for (let attempt=0; attempt<3; attempt++) {
    const original = await fs.readFile(config, 'utf8').catch(error => { if (error.code==='ENOENT') return ''; throw error; });
    const section = connectionConfig(true);
    const lines = original.split(/\r?\n/);
    let inOwnSection = false;
    const preserved=[];
    for (const line of lines) {
      const match = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
      if (match) {const name=match[1].replace(/["'\s]/g,'');inOwnSection = name === 'mcp_servers.shikigami' || name.startsWith('mcp_servers.shikigami.');}
      if (!inOwnSection) preserved.push(line);
    }
    const updated = `${preserved.join('\n').trimEnd()}\n\n${section}`;
    if (original.replace(/\r\n/g,'\n') === updated) return {ok:true,updated:false,config,requiresReload:true};
    const latest = await fs.readFile(config,'utf8').catch(error => { if(error.code==='ENOENT') return ''; throw error; });
    if (createHash('sha256').update(latest).digest('hex') !== createHash('sha256').update(original).digest('hex')) continue;
    const backup=original?`${config}.shikigami-backup-${Date.now()}`:null;
    if (backup) await fs.writeFile(backup, original, {flag:'wx'});
    const temporary = `${config}.shikigami-${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
    try { await fs.writeFile(temporary,updated,{flag:'wx'});if(await fs.readFile(config,'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e;})!==original)continue;await fs.rename(temporary,config); }
    finally { await fs.unlink(temporary).catch(()=>{}); }
    return {ok:true,updated:true,config,backup,requiresReload:true};
  }
  throw Object.assign(new Error('設定ファイルが同時に更新されています。再試行してください'),{status:409});
}

async function serve() {
  await fs.mkdir(dataDir,{recursive:true});
  await fs.mkdir(artifactDir,{recursive:true});
  const token = randomBytes(24).toString('hex');
  const instanceId = randomBytes(16).toString('hex');
  const upstream = new Client({name:'shikigami-shared',version:'1.0.0'});
  const transport = new StdioClientTransport({command:process.execPath,args:[path.join(root,'node_modules/@playwright/mcp/cli.js'),'--headless','--browser','chrome','--isolated','--caps','vision','--viewport-size','1100x740','--timeout-settle','50','--idle-timeout','120000','--output-dir',artifactDir],cwd:root,stderr:'pipe'});
  await upstream.connect(transport);
  const allTools = (await upstream.listTools()).tools;
  const tools = allTools.filter(tool => allowed.has(tool.name));
  const workspaceTool={name:'shikigami_workspace',description:'専用Chromeの接続状態と確認画面URLを取得します。画面は開きません。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,openWorldHint:false}};
  let latestImage=null, lastCaptureAt=null, lastReport=null, busy=false, diagnosticRunning=false, progress='待機中', runId=null, stopped=false, browserOpen=false, lastBrowserUse=0, lastAgentActivity=null, activity=Date.now(), closing=false;
  const agents=new Map();
  let queue=Promise.resolve(), epoch=0, activeAbort=null;
  async function upstreamTool(name,args,timeout=60000){
    const controller=new AbortController();activeAbort=controller;
    try{return await upstream.callTool({name,arguments:args},undefined,{timeout,signal:controller.signal});}
    finally{if(activeAbort===controller)activeAbort=null;}
  }
  const serialized = fn => { const operation=queue.then(fn); queue=operation.catch(()=>{}); return operation; };
  const status=()=>({busy,diagnosticRunning,progress,runId,lastReport,hasImage:!!latestImage,lastCaptureAt,agentConnections:[...agents.values()].filter(t=>Date.now()-t<90000).length,lastAgentActivity,browserOpen:browserOpen && Date.now()-lastBrowserUse<120000,stopped});
  let base, session;
  async function callTool(name,args={}) {
    if (name === 'shikigami_workspace') return textResult(JSON.stringify({panel:session.panel,headless:true,profile:'isolated ephemeral',desktopApps:false,preview:'browser_take_screenshot を filename なしで呼んだ後、利用者が希望した場合だけ確認画面を開きます。'}));
    if (!allowed.has(name) || !tools.some(tool=>tool.name===name)) return toolError('この操作は Shikigami で許可されていません');
    if (stopped) return toolError('AIブラウザーは停止中です。Shikigami アプリから再開してください');
    const calledAt = epoch;
    return serialized(async()=>{
      if (stopped || calledAt !== epoch) return toolError('AIブラウザーは停止中です。操作を破棄しました');
      const actionNames={browser_navigate:'ページを開いています',browser_fill_form:'フォームに入力しています',browser_click:'ページを操作しています',browser_type:'文字を入力しています',browser_tabs:'タブを整理しています',browser_take_screenshot:'画面を確認しています',browser_snapshot:'ページを確認しています',browser_close:'専用Chromeを閉じています'};
      busy=true; progress=actionNames[name]||'専用Chromeで作業しています'; runId=`tool-${Date.now()}`; activity=Date.now();
      try {
        const result=await upstreamTool(name,args,60000);
        if (!result.isError) {
          browserOpen=name!=='browser_close'; lastBrowserUse=Date.now();
          const image=result.content?.find(item=>item.type==='image');
          if (image?.data) {latestImage=Buffer.from(image.data,'base64');lastCaptureAt=Date.now();}
          progress=name==='browser_close'?'AIブラウザーを閉じました':'待機中';
        } else progress=`${name} でエラーが発生しました`;
        return result;
      } catch(error) { progress=`${name} でエラーが発生しました`; return toolError(error.message); }
      finally {busy=false;activity=Date.now();}
    });
  }

  const artifacts=artifactDir, runtime=dataDir;
  const runTool=allTools.find(t=>/^browser_run_code(?:_unsafe)?$/.test(t.name))?.name;
  let human=[], operations=[];
  async function call(name,args={}) {
    if(stopped)throw new Error('検証を停止しました');
    if(name==='browser_run_code')name=runTool;
    if(!name)throw new Error('検証用ツールがありません');
    const start=Date.now();
    const r=await upstreamTool(name,args,60000);
    operations.push({name,start,end:Date.now(),ok:!r.isError});
    if(r.isError)throw new Error(r.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n'));
    browserOpen=name!=='browser_close';lastBrowserUse=Date.now();
    return r;
  }
  async function shot(){const r=await call('browser_take_screenshot',{type:'png',scale:'css'});const im=r.content?.find(x=>x.type==='image');if(im){latestImage=Buffer.from(im.data,'base64');lastCaptureAt=Date.now();}}

function fixture(n) {
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><title>AI試験ページ ${n}</title><style>body{font:18px system-ui;background:#eef3f1;color:#183b33;margin:0;padding:48px}main{max-width:720px;margin:auto}h1{font-size:34px}label,input,button{display:block;margin:16px 0}input,button{font:inherit;padding:12px;border:1px solid #748c83;border-radius:8px}button{background:#1b6955;color:white}article{height:850px;padding:24px;background:white;border-radius:12px;margin:28px 0}</style><main><small>SHIKIGAMI · AI専用 / ${n}</small><h1>非表示でも、作業は進む。</h1><form><label for="name">テスト入力</label><input id="name" autocomplete="off"><button>記録する</button><output id="result">まだ記録されていません</output></form><a id="next" href="/fixture/${Number(n)+1}">次のページへ</a><article>スクロールの検証領域<p>これはローカルの試験ページです。外部への送信はありません。</p></article><p id="bottom">ページ下端</p></main><script>document.querySelector('form').onsubmit=e=>{e.preventDefault();document.querySelector('#result').textContent='記録済み：'+document.querySelector('#name').value;};</script></html>`;
}
function summarize(raw, started, ended) {
  const mem=raw.memory??[], samples=(raw.samples??[]).filter(s=>s.t>=started&&s.t<=ended);
  const ids=new Set(mem.flatMap(x=>x.pids));
  const moves=samples.slice(1).filter((s,i)=>s.x!==samples[i].x||s.y!==samples[i].y).length;
  const switches=samples.slice(1).filter((s,i)=>s.foregroundHandle!==samples[i].foregroundHandle).length;
  const events=human.filter(e=>e.t>=started&&e.t<=ended);
  return {
    sampleCount:samples.length, sampling:raw.sampling,
    aiForegroundSamples:samples.filter(s=>ids.has(s.foregroundPid)).length,
    aiVisibleWindowSamples:mem.filter(m=>m.visiblePids.length).length,
    cursorPositionChanges:moves,foregroundWindowChanges:switches,
    memorySamples:mem.length,
    workingSetMiB:mem.map(m=>Math.round(m.workingSetBytes/1048576*10)/10),
    privateMiB:mem.map(m=>Math.round(m.privateBytes/1048576*10)/10),
    freePhysicalMiB:mem.map(m=>Math.round(m.freePhysicalBytes/1048576)),
    humanEvents:{input:events.filter(e=>e.type==='input').length,pointermove:events.filter(e=>e.type==='pointermove').length,pointerdown:events.filter(e=>e.type==='pointerdown').length,wheel:events.filter(e=>e.type==='wheel').length,blur:events.filter(e=>e.type==='blur').length,focus:events.filter(e=>e.type==='focus').length},
    overlapOperationCount:operations.filter(o=>events.some(e=>e.t>=o.start&&e.t<=o.end)).length,
    humanTestStatus:events.some(e=>e.type==='input')&&events.some(e=>['pointerdown','pointermove'].includes(e.type))?'入力とポインターイベントを観測。人間による操作か、体感上の干渉の有無は本人確認が必要':'未検証：人間の同時入力・マウス操作がそろっていません',
    caution:'50ms目標の標本観測（CIM取得時に間隔が延びる）。瞬間的な干渉を完全否定しない。カーソル移動やフォーカス変更は人間の操作も含む。Working Set合計は共有ページの重複を含み、システム全体の増分ではない。'
  };
}
async function runDiagnostic(seconds=30, mode='automatic') {
  if(busy) throw new Error('検証中です');
  busy=true;human=[];operations=[];runId=new Date().toISOString().replace(/[:.]/g,'-');
  progress='ブラウザを初期化しています';
  const rawPath=path.join(artifacts,`${runId}-raw.json`), stopPath=path.join(runtime,`${runId}.stop`);
  let observer, observerDone, started=Date.now(), cycles=0, assertions=0, error=null;
  try {
    await call('browser_close'); // Establish a cold baseline; closes only this dedicated context.
    observer=spawn('powershell.exe',['-NoProfile','-File',path.join(root,'scripts/observe.ps1'),'-RootPid',String(transport.pid),'-OutputPath',rawPath,'-StopPath',stopPath],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let observerErr=''; observer.stderr.on('data',d=>observerErr+=d);
    observerDone=new Promise((resolve,reject)=>{observer.on('error',reject);observer.on('close',c=>c===0?resolve():reject(new Error(observerErr||`Observer ${c}`)));});
    observerDone.catch(()=>{});
    await new Promise(r=>setTimeout(r,3500));
    started=Date.now();
    await call('browser_navigate',{url:`${base}/fixture/1`});
    await call('browser_run_code',{code:`async (page) => { const context = page.context(); for (let i=2;i<=3;i++) { const p=await context.newPage(); await p.goto('${base}/fixture/'+i); } return {tabs:context.pages().length}; }`});
    const deadline=Date.now()+seconds*1000;
    do {
      progress=`非表示の3タブで巡回・入力中 · ${cycles+1}周目`;
      await call('browser_run_code',{code:`async (page) => { const pages=page.context().pages(); if(pages.length!==3) throw new Error('tab count'); let checks=0; for(let i=0;i<pages.length;i++) { const p=pages[i]; await p.goto('${base}/fixture/'+(i+1)); await p.locator('#name').click(); await p.keyboard.type('AI-${cycles}-tab-'+i, {delay:8}); await p.locator('button').click(); if(await p.locator('#result').textContent()!=='記録済み：AI-${cycles}-tab-'+i) throw new Error('form mismatch'); checks++; await p.mouse.move(450,450); await p.mouse.wheel(0,700); await p.waitForFunction(()=>window.scrollY>100); checks++; await p.locator('#next').click(); if(!p.url().endsWith('/fixture/'+(i+2))) throw new Error('navigation mismatch'); checks++; } return {tabs:pages.length,checks}; }`});
      cycles++;assertions+=9;
      if(cycles===1) await shot();
      await new Promise(r=>setTimeout(r,250));
    } while(Date.now()<deadline);
    // Exercise MCP's explicit tab tool, coordinate click and DOM-free keyboard dispatch too.
    await call('browser_tabs',{action:'select',index:1});
    await call('browser_run_code',{code:`async(page)=>{await page.locator('#name').click();await page.keyboard.type('Shikigami MCP verified');await page.locator('button').click();return await page.locator('#result').textContent();}`});
    await shot();
    await call('browser_tabs',{action:'close',index:2});
    await call('browser_tabs',{action:'list'});
  } catch(e) { error=String(e.stack??e); }
  const ended=Date.now();
  await fs.writeFile(stopPath,'stop');
  let raw={};
  try { if(observerDone) await observerDone; raw=JSON.parse((await fs.readFile(rawPath,'utf8')).replace(/^\uFEFF/,'')); }
  catch(e) { error=[error,`Measurement: ${e.message}`].filter(Boolean).join('\n'); }
  lastReport={runId,mode,started,ended,durationSeconds:Math.round((ended-started)/100)/10,cycles,assertions,success:!error,error,headless:true,profile:'isolated ephemeral; no personal profile',mcp:'Microsoft @playwright/mcp over stdio',browser:'Installed Google Chrome',operations,measurement:summarize(raw,started,ended),nodeRssMiB:Math.round(process.memoryUsage().rss/1048576),humanSelfReport:null};
  await fs.writeFile(path.join(artifacts,`${runId}-report.json`),JSON.stringify(lastReport,null,2));
  await fs.writeFile(path.join(artifacts,'latest-report.json'),JSON.stringify(lastReport,null,2));
  busy=false; progress=error?'検証でエラーが発生しました':'検証完了';
  return lastReport;
}

  async function stop() {
    stopped=true;epoch++;progress='停止しています';activeAbort?.abort();
    await serialized(async()=>{
      try { await upstream.callTool({name:'browser_close',arguments:{}},undefined,{timeout:30000}); } catch {}
      browserOpen=false; latestImage=null; busy=false; progress='停止中';
    });
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    try {
      if(req.headers.host!==new URL(base).host) return json(res,403,{error:'invalid host'});
      if(req.headers.origin && req.headers.origin!==base) return json(res,403,{error:'invalid origin'});
      const url=new URL(req.url,base);
      if(req.method==='GET' && url.pathname==='/assets/shikigami-spirit.png') {
        const image=await fs.readFile(path.join(root,'src','assets','shikigami-spirit.png'));
        return res.writeHead(200,{'Content-Type':'image/png'}).end(image);
      }
      if(req.method==='GET' && url.pathname===`/panel/${token}`) {
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end((await fs.readFile(path.join(root,'src','panel.html'),'utf8')).replaceAll('__TOKEN__',token)); return;
      }
      if(req.method==='GET' && /^\/fixture\/\d+$/.test(url.pathname)){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end(fixture(url.pathname.split('/').pop()));return;}
      if(req.headers['x-shikigami-token']!==token) return json(res,403,{error:'invalid token'});
      activity=Date.now();
      if(req.method==='GET' && url.pathname==='/api/health') return json(res,200,{instanceId,pid:process.pid});
      if(req.method==='GET' && url.pathname==='/api/status') return json(res,200,status());
      if(req.method==='GET' && url.pathname==='/api/tools') return json(res,200,[workspaceTool,...tools]);
      if(req.method==='GET' && url.pathname==='/api/connection') return json(res,200,{name:'shikigami',command:process.execPath,args:[path.join(root,'src','mcp.mjs')],configToml:connectionConfig(),env:{SHIKIGAMI_DATA_DIR:dataDir},configPath:path.resolve(process.env.SHIKIGAMI_CODEX_CONFIG || path.join(process.env.CODEX_HOME || path.join(os.homedir(),'.codex'),'config.toml')),connected:status().agentConnections>0});
      if(req.method==='POST' && url.pathname==='/api/connect-codex') {
        const body=await readBody(req);
        if(body.approveBrowserOperations!==true) return json(res,400,{error:'Chrome操作の承認が必要です'});
        return json(res,200,await connectCodex(session));
      }
      if(req.method==='POST' && url.pathname==='/api/mcp/register') {const id=randomBytes(12).toString('hex');agents.set(id,Date.now());lastAgentActivity=Date.now();return json(res,200,{id});}
      if(req.method==='POST' && url.pathname==='/api/mcp/heartbeat') {const body=await readBody(req);if(!agents.has(body.id))return json(res,404,{error:'unknown connection'});agents.set(body.id,Date.now());return json(res,200,{});}
      if(req.method==='POST' && url.pathname==='/api/mcp/unregister') {const body=await readBody(req);agents.delete(body.id);return json(res,200,{});}
      if(req.method==='GET' && url.pathname==='/api/mcp/tools') return json(res,200,{tools:[workspaceTool,...tools]});
      if(req.method==='POST' && url.pathname==='/api/mcp/call') {
        const body=await readBody(req);
        if(typeof body.name!=='string'||!body.arguments||typeof body.arguments!=='object'||Array.isArray(body.arguments))return json(res,400,{error:'invalid call'});
        lastAgentActivity=Date.now();
        return json(res,200,await callTool(body.name,body.arguments));
      }
      if(req.method==='POST' && url.pathname==='/api/run') {
        if(busy||stopped)return json(res,409,{error:stopped?'先に作業スペースを再開してください':'現在の操作が終わってから試してください'});
        const body=await readBody(req);const seconds=Math.max(5,Math.min(90,Number(body.seconds)||60));
        busy=true;diagnosticRunning=true;
        serialized(async()=>{busy=false;await runDiagnostic(seconds,body.mode==='human'?'human':'automatic');}).catch(error=>{busy=false;progress=error.message;}).finally(()=>{diagnosticRunning=false;});
        return json(res,202,{ok:true});
      }
      if(req.method==='POST' && url.pathname==='/api/events') {
        const body=await readBody(req);
        if(busy&&Array.isArray(body.events))for(const event of body.events.slice(0,100))if(['input','pointermove','pointerdown','wheel','blur','focus','visibility'].includes(event.type)&&Number.isFinite(event.t))human.push({type:event.type,t:event.t});
        return json(res,200,{});
      }
      if(req.method==='POST' && url.pathname==='/api/confirm') {
        const body=await readBody(req);if(lastReport&&['none','interference','unsure'].includes(body.result)){lastReport.humanSelfReport={result:body.result,at:Date.now()};await fs.writeFile(path.join(artifactDir,'latest-report.json'),JSON.stringify(lastReport,null,2));await fs.writeFile(path.join(artifactDir,`${lastReport.runId}-report.json`),JSON.stringify(lastReport,null,2));}
        return json(res,200,{});
      }
      if(req.method==='POST' && url.pathname==='/api/capture') {
        if(stopped)return json(res,409,{error:'AIブラウザーは停止中です'});
        if(!status().browserOpen)return json(res,409,{error:'表示できるAIブラウザーがありません。AIがページを開いてから再試行してください'});
        const result=await callTool('browser_take_screenshot',{type:'png',scale:'css'});
        return json(res,result.isError?500:200,{ok:!result.isError,error:result.isError?result.content?.[0]?.text:null,hasImage:!!latestImage});
      }
      if(req.method==='GET' && url.pathname==='/api/preview') {
        if(!latestImage)return json(res,404,{error:'撮影した画面はありません'});
        return res.writeHead(200,{'Content-Type':'image/png'}).end(latestImage);
      }
      if(req.method==='POST' && url.pathname==='/api/stop') {await stop();return json(res,200,status());}
      if(req.method==='POST' && url.pathname==='/api/close') {const result=await callTool('browser_close');return json(res,result.isError?409:200,result);}
      if(req.method==='POST' && url.pathname==='/api/resume') {stopped=false;progress='待機中';return json(res,200,status());}
      if(req.method==='POST' && url.pathname==='/api/shutdown') {json(res,200,{ok:true});setImmediate(shutdown);return;}
      return json(res,404,{error:'not found'});
    } catch(error) {return json(res,error.status||500,{error:error.message});}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  base=`http://127.0.0.1:${server.address().port}`;
  session={pid:process.pid,mcpPid:transport.pid,base,token,instanceId,panel:`${base}/panel/${token}`,started:new Date().toISOString(),dataDir};
  await fs.writeFile(sessionFile,JSON.stringify(session,null,2));
  if(process.argv.includes('--serve')) console.log(session.panel);
  async function shutdown() {if(closing)return;closing=true;await upstream.close().catch(()=>{});server.close();await fs.unlink(sessionFile).catch(()=>{});process.exit(0);}
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
  setInterval(()=>{
    for(const [id,time] of agents)if(Date.now()-time>90000)agents.delete(id);
    if(!busy&&agents.size===0&&Date.now()-activity>30*60_000)shutdown();
  },30000).unref();
}

if(process.argv.includes('--serve')) serve().catch(error=>{console.error(error);process.exitCode=1;});
