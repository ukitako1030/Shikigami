import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {ensureDesktopService} from './service.mjs';

let session=await ensureDesktopService(),registration,reconnecting=null;
async function requestOnce(route,body){
  const r=await fetch(session.base+'/api/'+route,{method:body===undefined?'GET':'POST',headers:{'X-Shikigami-Token':session.token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(90000)});
  const value=await r.json();if(!r.ok){const error=new Error(value.error||`HTTP ${r.status}`);error.httpResponse=true;throw error;}return value;
}
async function api(route,body){
  try{return await requestOnce(route,body);}
  catch(error){
    if(error.httpResponse)throw error;
    const readOnly=route==='tools'||route==='mcp/call'&&['desktop_workspace','desktop_files','desktop_read_file'].includes(body?.name);
    if(!readOnly)throw new Error('専用スペースとの接続が切れました。この操作は自動再実行しません。状態を確認してから再試行してください。');
    reconnecting ||= (async()=>{session=await ensureDesktopService();registration=await requestOnce('mcp/register',{});})().finally(()=>{reconnecting=null;});
    await reconnecting;
    return requestOnce(route,body);
  }
}
registration=await requestOnce('mcp/register',{});
const server=new Server({name:'shikigami-desktop-lab',version:'0.1.0'},
  {capabilities:{tools:{}},instructions:'Shikigami はWindowsとは独立した専用Linuxデスクトップです。最初に desktop_workspace を読んでください。必要なら desktop_start で起動し、画面取得で操作対象を確認してください。Chrome は desktop_launch({app:"chrome"}) と desktop_navigate で操作できます。保存ファイルは desktop_files と desktop_read_file で停止中も読み取れます。普段のWindowsアプリやホスト入力に切り替えないでください。確認画面は利用者が希望した場合だけ案内してください。安全な隔離環境であるとは主張しないでください。利用者の作業中に専用スペースを停止しないでください。接続断後、書き込み操作は自動再実行されません。'});
server.setRequestHandler(ListToolsRequestSchema,()=>api('tools'));
server.setRequestHandler(CallToolRequestSchema,r=>api('mcp/call',{name:r.params.name,arguments:r.params.arguments||{}}));
const heartbeat=setInterval(()=>requestOnce('mcp/heartbeat',{id:registration.id}).catch(()=>{}),30000);heartbeat.unref();
await server.connect(new StdioServerTransport());
let closed=false;
async function close(){if(closed)return;closed=true;clearInterval(heartbeat);await requestOnce('mcp/unregister',{id:registration.id}).catch(()=>{});await server.close().catch(()=>{});}
process.stdin.on('end',close);process.on('SIGINT',close);process.on('SIGTERM',close);
