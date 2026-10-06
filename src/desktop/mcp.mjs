import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {ensureDesktopService} from './service.mjs';

const session=await ensureDesktopService();
async function api(route,body){
  const r=await fetch(session.base+'/api/'+route,{method:body===undefined?'GET':'POST',headers:{'X-Shikigami-Token':session.token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(90000)});
  const value=await r.json();if(!r.ok)throw new Error(value.error);return value;
}
const registration=await api('mcp/register',{});
const server=new Server({name:'shikigami-desktop-lab',version:'0.1.0'},
  {capabilities:{tools:{}},instructions:'Operate only the dedicated Linux desktop using desktop_* tools. Read desktop_workspace first. Start explicitly when needed. Use screenshots to locate controls. This is not Windows; never fall back to host computer-use. Preview is opt-in. No security sandbox claim. Do not stop the workspace while the user is using it.'});
server.setRequestHandler(ListToolsRequestSchema,()=>api('tools'));
server.setRequestHandler(CallToolRequestSchema,r=>api('mcp/call',{name:r.params.name,arguments:r.params.arguments||{}}));
const heartbeat=setInterval(()=>api('mcp/heartbeat',{id:registration.id}).catch(()=>{}),30000);heartbeat.unref();
await server.connect(new StdioServerTransport());
let closed=false;
async function close(){if(closed)return;closed=true;clearInterval(heartbeat);await api('mcp/unregister',{id:registration.id}).catch(()=>{});await server.close().catch(()=>{});}
process.stdin.on('end',close);process.on('SIGINT',close);process.on('SIGTERM',close);
