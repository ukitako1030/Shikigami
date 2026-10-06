import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const client=new Client({name:'shikigami-contract-check',version:'0.1.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'src/probe.mjs'),'--stdio'],cwd:root,stderr:'pipe'});
try{
await client.connect(transport);
const listed=await client.listTools();
assert(listed.tools.some(t=>t.name==='browser_navigate'));
assert(listed.tools.some(t=>t.name==='browser_take_screenshot'));
let s;for(let i=0;i<20;i++){try{s=JSON.parse(await fs.readFile(path.join(root,`.runtime/session-${transport.pid}.json`),'utf8'));break;}catch{await new Promise(r=>setTimeout(r,100));}}
assert(s);
const workspace=await client.callTool({name:'shikigami_workspace',arguments:{}});assert(JSON.stringify(workspace).includes(s.panel));
const nav=await client.callTool({name:'browser_navigate',arguments:{url:s.base+'/fixture/9'}});assert(!nav.isError,JSON.stringify(nav));
const fill=await client.callTool({name:'browser_fill_form',arguments:{fields:[{target:'#name',name:'テスト入力',type:'textbox',value:'MCP接続確認'}]}});assert(!fill.isError,JSON.stringify(fill));
const click=await client.callTool({name:'browser_click',arguments:{target:'button'}});assert(!click.isError,JSON.stringify(click));
const r=await client.callTool({name:'browser_snapshot',arguments:{}});assert(!r.isError,JSON.stringify(r));assert(JSON.stringify(r).includes('記録済み：MCP接続確認'));
for(const name of ['browser_run_code_unsafe','browser_evaluate','browser_file_upload','browser_drop','browser_handle_dialog'])assert(!listed.tools.some(t=>t.name===name));
let rejected=false;try{const denied=await client.callTool({name:'browser_evaluate',arguments:{function:'()=>42'}});rejected=denied.isError===true;}catch{rejected=true;}assert(rejected,'Direct calls to unexposed tools must be rejected');
const shot=await client.callTool({name:'browser_take_screenshot',arguments:{type:'png',scale:'css'}});assert(!shot.isError);assert(shot.content.some(c=>c.type==='image'));
await fs.writeFile(path.join(root,'artifacts','mcp-contract.png'),Buffer.from(shot.content.find(c=>c.type==='image').data,'base64'));
const forbidden=await fetch(s.base+'/api/status');assert.equal(forbidden.status,403);
const crossOrigin=await fetch(s.base+'/api/close',{method:'POST',headers:{'X-Shikigami-Token':s.token,Origin:'https://example.invalid'},body:'{}'});assert.equal(crossOrigin.status,403);
const result={ok:true,toolCount:listed.tools.length,checked:['MCP initialize','tools/list','navigation','Japanese form input and submission','screenshot returned as MCP image','unauthenticated API rejected','cross-origin mutation rejected'],at:new Date().toISOString()};
await fs.writeFile(path.join(root,'artifacts','mcp-contract.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await client.close();}
