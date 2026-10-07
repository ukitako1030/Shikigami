import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, 'artifacts');
const runtime = path.join(root, '.runtime');
await fs.mkdir(artifacts, {recursive:true});
await fs.mkdir(runtime, {recursive:true});
const token = randomBytes(24).toString('hex');
const client = new Client({name:'shikigami-probe',version:'0.1.0'});
// Playwright MCP resolves AI-supplied file names against its cwd, so keep it away from the source tree.
const browserWorkspace = path.join(runtime,'probe-workspace');
await fs.mkdir(browserWorkspace,{recursive:true});
const transport = new StdioClientTransport({command:process.execPath,args:[path.join(root,'node_modules/@playwright/mcp/cli.js'),'--headless','--browser','chrome','--isolated','--caps','vision','--viewport-size','1100x740','--timeout-settle','50','--idle-timeout','120000','--output-dir',artifacts],cwd:browserWorkspace,stderr:'pipe'});
await client.connect(transport);
const tools = (await client.listTools()).tools;
const runTool = tools.find(t=>/^browser_run_code(?:_unsafe)?$/.test(t.name))?.name;
const allowedToolNames = new Set([
  'browser_close','browser_resize','browser_console_messages','browser_emulate_media',
  'browser_find','browser_fill_form','browser_press_key','browser_type',
  'browser_mouse_move_xy','browser_mouse_click_xy','browser_mouse_drag_xy',
  'browser_mouse_down','browser_mouse_up','browser_mouse_wheel',
  'browser_navigate','browser_navigate_back','browser_network_requests','browser_network_request',
  'browser_take_screenshot','browser_snapshot','browser_click','browser_drag','browser_hover',
  'browser_select_option','browser_tabs','browser_wait_for'
]);
const exposedTools = tools.filter(t=>allowedToolNames.has(t.name)).map(t=>{const {filename,...properties}=t.inputSchema.properties??{};return {...t,inputSchema:{...t.inputSchema,properties}};});
let latestImage = null, lastReport = null, busy = false, progress = 'テスト待機中', runId = null;
let human = [], operations = [], lastActivity = Date.now(), closed = false;
let chain = Promise.resolve();
function exclusive(fn) { const p = chain.then(fn); chain = p.catch(()=>{}); return p; }
function textOf(r) { return r.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n') ?? ''; }
async function call(name,args={}) {
  if(name==='browser_run_code') name=runTool ?? name;
  lastActivity = Date.now();
  const start=Date.now();
  const r=await client.callTool({name,arguments:args},undefined,{timeout:60000});
  operations.push({name,start,end:Date.now(),ok:!r.isError});
  if(r.isError) throw new Error(textOf(r));
  return r;
}
async function shot(filename='ai-latest.png') {
  const r=await call('browser_take_screenshot',{type:'png',scale:'css',filename:path.join(artifacts,filename)});
  const im=r.content?.find(x=>x.type==='image');
  latestImage=im ? Buffer.from(im.data,'base64') : await fs.readFile(path.join(artifacts,filename));
  return {bytes:latestImage.length};
}
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
async function run(seconds=30, mode='automatic') {
  if(busy) throw new Error('検証中です');
  busy=true;human=[];operations=[];runId=new Date().toISOString().replace(/[:.]/g,'-');
  progress='ブラウザを初期化しています';
  const rawPath=path.join(artifacts,`${runId}-raw.json`), stopPath=path.join(runtime,`${runId}.stop`);
  let observer, observerDone, started=Date.now(), cycles=0, assertions=0, error=null;
  try {
    await call('browser_close'); // Establish a cold baseline; closes only this dedicated context.
    observer=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/observe.ps1'),'-RootPid',String(transport.pid),'-OutputPath',rawPath,'-StopPath',stopPath],{windowsHide:true,stdio:['ignore','pipe','pipe']});
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
async function body(req) { let b=''; for await(const c of req){b+=c;if(b.length>200000)throw new Error('body too large');} return b?JSON.parse(b):{}; }
const app=http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  try {
    if(req.headers.host!==new URL(base).host){res.writeHead(403).end();return;}
    const u=new URL(req.url,base);
    if(/^\/fixture\/\d+$/.test(u.pathname)&&req.method==='GET'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fixture(u.pathname.split('/').pop()));return;}
    if(u.pathname===`/panel/${token}`&&req.method==='GET'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end((await fs.readFile(path.join(root,'src/panel.html'),'utf8')).replaceAll('__TOKEN__',token));return;}
    if(req.headers['x-shikigami-token']!==token){res.writeHead(403).end();return;}
    if(req.headers.origin&&req.headers.origin!==base){res.writeHead(403).end();return;}
    res.setHeader('Content-Type','application/json; charset=utf-8');
    if(u.pathname==='/api/status'&&req.method==='GET'){res.end(JSON.stringify({busy,progress,runId,lastReport,hasImage:!!latestImage}));return;}
    if(u.pathname==='/api/tools'&&req.method==='GET'){res.end(JSON.stringify(tools));return;}
    if(u.pathname==='/api/run'&&req.method==='POST'){if(busy){res.writeHead(409).end('{}');return;}const b=await body(req);const seconds=Math.max(5,Math.min(90,Number(b.seconds)||30));exclusive(()=>run(seconds,b.mode==='human'?'human':'automatic')).catch(e=>{progress=e.message;busy=false;});res.writeHead(202).end('{}');return;}
    if(u.pathname==='/api/events'&&req.method==='POST'){const b=await body(req);if(busy&&Array.isArray(b.events)){for(const e of b.events.slice(0,100)){if(['input','pointermove','pointerdown','wheel','blur','focus','visibility'].includes(e.type)&&Number.isFinite(e.t))human.push({type:e.type,t:e.t});}}res.end('{}');return;}
    if(u.pathname==='/api/preview'&&req.method==='GET'){if(!latestImage){res.writeHead(404).end('{}');return;}res.setHeader('Content-Type','image/png');res.end(latestImage);return;}
    if(u.pathname==='/api/confirm'&&req.method==='POST'){const b=await body(req);if(lastReport&&['none','interference','unsure'].includes(b.result)){lastReport.humanSelfReport={result:b.result,at:Date.now()};await fs.writeFile(path.join(artifacts,'latest-report.json'),JSON.stringify(lastReport,null,2));await fs.writeFile(path.join(artifacts,`${lastReport.runId}-report.json`),JSON.stringify(lastReport,null,2));}res.end('{}');return;}
    if(u.pathname==='/api/close'&&req.method==='POST'){if(busy){res.writeHead(409).end('{}');return;}await exclusive(()=>call('browser_close'));progress='AIブラウザを終了しました';res.end('{}');return;}
    if(u.pathname==='/api/shutdown'&&req.method==='POST'){res.end('{}');setImmediate(shutdown);return;}
    res.writeHead(404).end('{}');
  }catch(e){res.writeHead(500).end(JSON.stringify({error:e.message}));}
});
await new Promise(r=>app.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${app.address().port}`;
const session={pid:process.pid,mcpPid:transport.pid,base,token,panel:`${base}/panel/${token}`,started:new Date().toISOString(),versions:{node:process.version,playwrightMcp:JSON.parse(await fs.readFile(path.join(root,'node_modules/@playwright/mcp/package.json'),'utf8')).version}};
await fs.writeFile(path.join(runtime,`session-${process.pid}.json`),JSON.stringify(session,null,2));
if(!process.argv.includes('--stdio')){await fs.writeFile(path.join(runtime,'session.json'),JSON.stringify(session,null,2));console.log(JSON.stringify({panel:session.panel,pid:process.pid}));}
if(process.argv.includes('--stdio')) {
  const proxy=new Server({name:'shikigami',version:'0.1.0'},{capabilities:{tools:{}},instructions:'Shikigami controls an isolated, headless Google Chrome, without host mouse or keyboard input. Use only this server\'s browser tools for Shikigami work. Call shikigami_workspace for the observer URL; do not open it unless the user wants to watch. Keep at most three tabs. Screenshots without filename are also shown in the observer. Close the dedicated browser when finished. Windows desktop apps are not supported; do not silently switch to desktop computer-use.'});
  const workspaceTool={name:'shikigami_workspace',description:'Get the local observer URL and isolation limits for this AI browser. Does not open a window.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,openWorldHint:false}};
  proxy.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[workspaceTool,...exposedTools]}));
  proxy.setRequestHandler(CallToolRequestSchema,async r=>exclusive(async()=>{if(r.params.name==='shikigami_workspace')return {content:[{type:'text',text:JSON.stringify({panel:session.panel,headless:true,profile:'isolated ephemeral',desktopApps:false,preview:'Call browser_take_screenshot without filename, then open the panel only when requested.'})}]};if(!exposedTools.some(t=>t.name===r.params.name))throw new Error('Tool not exposed');if(r.params.arguments&&'filename' in r.params.arguments)throw new Error('filename is not supported; results are returned inline');const result=await call(r.params.name,r.params.arguments); const im=result.content?.find(x=>x.type==='image');if(im)latestImage=Buffer.from(im.data,'base64');return result;}));
  await proxy.connect(new StdioServerTransport());
  process.stdin.on('end',shutdown);
}
async function shutdown(){if(closed)return;closed=true;try{await client.close();}finally{app.close();process.exit(0);}}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
// Standalone demos expire; stdio connections must survive until their MCP client disconnects.
if(!process.argv.includes('--stdio')) setInterval(()=>{if(!busy&&Date.now()-lastActivity>30*60*1000)shutdown();},30000).unref();
