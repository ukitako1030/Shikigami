import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ensureService } from './service.mjs';

const instructions = 'Shikigami は独立した一時プロファイルの非表示Chromeを操作します。普段のChrome、OSのマウス・キーボード、Windowsアプリの操作には切り替えないでください。最初に shikigami_workspace で接続を確認してください。確認画面は利用者が見たい場合だけ案内してください。タブは原則3枚以内とし、作業後は browser_close で専用ブラウザーを閉じてください。';
const server = new Server({name:'shikigami',version:'1.0.0'},{capabilities:{tools:{}},instructions});
let session=await ensureService();
async function request(method,route,body) {
  const response=await fetch(`${session.base}${route}`,{
    method, headers:{'X-Shikigami-Token':session.token,...(body===undefined?{}:{'Content-Type':'application/json'})},
    body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(100000)
  });
  const result=await response.json();
  if(!response.ok) throw new Error(result.error||`Shikigami HTTP ${response.status}`);
  return result;
}
let registration=await request('POST','/api/mcp/register',{});
const heartbeat=setInterval(()=>request('POST','/api/mcp/heartbeat',{id:registration.id}).catch(()=>{}),30000);
heartbeat.unref();
server.setRequestHandler(ListToolsRequestSchema,async()=>request('GET','/api/mcp/tools'));
server.setRequestHandler(CallToolRequestSchema,async r=>request('POST','/api/mcp/call',{name:r.params.name,arguments:r.params.arguments||{}}));
await server.connect(new StdioServerTransport());
let closed=false;
async function shutdown() {
  if(closed)return;closed=true;clearInterval(heartbeat);
  await request('POST','/api/mcp/unregister',{id:registration.id}).catch(()=>{});
  await server.close().catch(()=>{});
}
process.stdin.on('end',shutdown);
process.on('SIGINT',shutdown);
process.on('SIGTERM',shutdown);
