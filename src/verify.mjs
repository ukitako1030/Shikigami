import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {replaceServerSection} from './codex-config.mjs';

// Exercises the same path Codex uses (src/mcp.mjs -> shared service) in a throwaway data folder.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'shikigami-verify-'));
const data=path.join(temp,'data'), codexConfig=path.join(temp,'config.toml');
const originalConfig='model = "unchanged"\n';
await fs.writeFile(codexConfig,originalConfig);
const env={...process.env,SHIKIGAMI_DATA_DIR:data,SHIKIGAMI_CODEX_CONFIG:codexConfig};
const client=new Client({name:'shikigami-contract-check',version:'0.2.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'src','mcp.mjs')],cwd:root,env,stderr:'pipe'});
const exists=file=>fs.stat(file).then(()=>true,()=>false);
let s;
async function api(token,method,route,body){const r=await fetch(s.base+route,{method,headers:{'X-Shikigami-Token':token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return r.status;}
function rawStatus(route,headers){return new Promise((resolve,reject)=>{const u=new URL(s.base);http.get({host:u.hostname,port:u.port,path:route,headers},r=>{r.resume();resolve(r.statusCode);}).on('error',reject);});}
try{
await client.connect(transport);
s=JSON.parse(await fs.readFile(path.join(data,'session.json'),'utf8'));
const viewToken=new URL(s.view).pathname.split('/').pop();
const listed=await client.listTools();
assert(listed.tools.some(t=>t.name==='browser_navigate'));
assert(listed.tools.some(t=>t.name==='browser_take_screenshot'));
for(const name of ['browser_run_code','browser_run_code_unsafe','browser_evaluate','browser_file_upload','browser_drop','browser_handle_dialog'])assert(!listed.tools.some(t=>t.name===name),name);
assert(!listed.tools.some(t=>'filename' in (t.inputSchema.properties??{})),'File-writing arguments must not be offered to the AI');

const workspace=JSON.parse((await client.callTool({name:'shikigami_workspace',arguments:{}})).content[0].text);
assert.equal(workspace.panel,s.view);
assert(!workspace.panel.includes(s.token),'The AI must not receive the admin token');

const nav=await client.callTool({name:'browser_navigate',arguments:{url:s.base+'/fixture/9'}});assert(!nav.isError,JSON.stringify(nav));
const fill=await client.callTool({name:'browser_fill_form',arguments:{fields:[{target:'#name',name:'テスト入力',type:'textbox',value:'MCP接続確認'}]}});assert(!fill.isError,JSON.stringify(fill));
const click=await client.callTool({name:'browser_click',arguments:{target:'button'}});assert(!click.isError,JSON.stringify(click));
const snap=await client.callTool({name:'browser_snapshot',arguments:{}});assert(!snap.isError,JSON.stringify(snap));assert(JSON.stringify(snap).includes('記録済み：MCP接続確認'));

const written='shikigami-write-check.txt';
for(const [name,args] of [['browser_snapshot',{filename:written}],['browser_network_request',{index:1,part:'response-body',filename:written}],['browser_take_screenshot',{type:'png',filename:path.join(root,'src',written)}]]){
  const r=await client.callTool({name,arguments:args});assert.equal(r.isError,true,`${name} must reject filename`);
}
for(const dir of [root,path.join(root,'src'),path.join(data,'browser-workspace'),path.join(data,'browser-output')])assert(!await exists(path.join(dir,written)),`unexpected file in ${dir}`);

let rejected=false;try{const denied=await client.callTool({name:'browser_evaluate',arguments:{function:'()=>42'}});rejected=denied.isError===true;}catch{rejected=true;}assert(rejected,'Direct calls to unexposed tools must be rejected');
const shot=await client.callTool({name:'browser_take_screenshot',arguments:{type:'png',scale:'css'}});assert(!shot.isError);assert(shot.content.some(c=>c.type==='image'));
await fs.mkdir(path.join(root,'artifacts'),{recursive:true});
await fs.writeFile(path.join(root,'artifacts','mcp-contract.png'),Buffer.from(shot.content.find(c=>c.type==='image').data,'base64'));

assert.equal((await fetch(s.base+'/api/status')).status,403);
assert.equal((await fetch(s.base+'/api/close',{method:'POST',headers:{'X-Shikigami-Token':s.token,Origin:'https://example.invalid'},body:'{}'})).status,403);
assert.equal(await rawStatus('/api/status',{'X-Shikigami-Token':s.token,Host:`localhost:${new URL(s.base).port}`}),403,'Wrong Host must be rejected');
assert.equal(await api(viewToken,'GET','/api/status'),200);
for(const [method,route,body] of [['POST','/api/connect-codex',{approveBrowserOperations:true}],['POST','/api/resume',{}],['POST','/api/confirm',{result:'none'}],['POST','/api/shutdown',{}],['GET','/api/connection'],['POST','/api/mcp/call',{name:'browser_close',arguments:{}}]])assert.equal(await api(viewToken,method,route,body),403,`view token must not reach ${route}`);
assert.equal(await fs.readFile(codexConfig,'utf8'),originalConfig);
const viewPage=await fetch(s.view);assert.equal(viewPage.status,200);assert(!(await viewPage.text()).includes(s.token));
assert.notEqual((await fetch(`${s.base}/panel/${viewToken}`)).status,200);

const section='[mcp_servers.shikigami]\ncommand = "node"\n';
assert.equal(replaceServerSection('a = 1\r\n[[profiles]]\r\nname = "x"\r\n',`shikigami`,section),'a = 1\r\n[[profiles]]\r\nname = "x"\r\n\r\n[mcp_servers.shikigami]\r\ncommand = "node"\r\n');
assert.equal(replaceServerSection('[mcp_servers.shikigami]\nold = 1\n[mcp_servers.shikigami.env]\nX = "1"\n[[after]]\nkeep = 1\n','shikigami',section),'[[after]]\nkeep = 1\n\n[mcp_servers.shikigami]\ncommand = "node"\n');
assert.throws(()=>replaceServerSection('[mcp_servers]\nshikigami = { command = "node" }\n','shikigami',section),/別の書き方/);
assert.throws(()=>replaceServerSection('mcp_servers.shikigami.command = "node"\n','shikigami',section),/別の書き方/);
assert.doesNotThrow(()=>replaceServerSection('[mcp_servers]\nshikigami_desktop = { command = "node" }\n','shikigami',section));

const result={ok:true,toolCount:listed.tools.length,checked:['MCP initialize via src/mcp.mjs','tools/list without file-writing arguments','navigation','Japanese form input and submission','filename arguments rejected and nothing written','unexposed tool rejected','screenshot returned as MCP image','unauthenticated, cross-origin and wrong-Host requests rejected','AI receives only the view-only panel URL','view token cannot change settings or call tools','Codex config editor keeps other tables and line endings'],at:new Date().toISOString()};
await fs.writeFile(path.join(root,'artifacts','mcp-contract.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{
  await client.close().catch(()=>{});
  if(s)await api(s.token,'POST','/api/shutdown',{}).catch(()=>{});
  await new Promise(r=>setTimeout(r,500));
  await fs.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200}).catch(()=>{});
}
