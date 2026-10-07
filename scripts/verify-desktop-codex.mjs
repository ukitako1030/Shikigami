// A real Codex model operates a fresh private desktop through MCP only.
// Overrides are scoped to this child invocation; user configuration is not changed.
import {spawn,execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const {cli}=JSON.parse(execFileSync(process.execPath,[path.join(root,'scripts','verify-codex.mjs'),'--check-cli'],{encoding:'utf8',windowsHide:true}));
process.env.SHIKIGAMI_DESKTOP_DATA_DIR=path.join(root,'.runtime',`desktop-codex-${Date.now()}`);
await fs.mkdir(path.join(root,'artifacts'),{recursive:true});
const {ensureDesktopService}=await import('../src/desktop/service.mjs');
const session=await ensureDesktopService();
const api=async(route,body)=>{const r=await fetch(session.base+'/api/'+route,{method:body===undefined?'GET':'POST',headers:{'X-Shikigami-Token':session.token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(!r.ok)throw new Error(await r.text());return r.json();};
const tools=(await api('tools')).tools;
const table={command:process.execPath,args:[path.join(root,'src','desktop','mcp.mjs')],env:{SHIKIGAMI_DESKTOP_DATA_DIR:process.env.SHIKIGAMI_DESKTOP_DATA_DIR},startup_timeout_sec:30,tool_timeout_sec:90,default_tools_approval_mode:'writes',tools:Object.fromEntries(tools.map(t=>[t.name,{approval_mode:'approve'}]))};
const toml=value=>typeof value==='string'?JSON.stringify(value):typeof value==='number'?String(value):Array.isArray(value)?'['+value.map(toml).join(',')+']':'{'+Object.entries(value).map(([k,v])=>JSON.stringify(k)+'='+toml(v)).join(',')+'}';
const prompt='これはユーザーが依頼したShikigami実証の限定テストです。使ってよい操作はshikigami_desktop MCPのみ。シェル、他のMCP、ホストのcomputer-useは禁止。desktop_workspaceを読み、起動し、専用Chromeでhttps://example.com/ を表示してスクリーンショットで見出しを実際に確認してください。次に専用エディターを開き、画面を確認して、空の作業メモ.txtへ「Shikigami 実作業の確認」という見出しと、確認したページの見出しおよび内容の短い日本語説明、識別文字列SHIKIGAMI-DESKTOP-CODEX-OKを書いて保存してください。desktop_filesとdesktop_read_fileで保存内容を確認してください。最後に専用デスクトップだけ停止し、停止後にもファイルを読み取れることを確認してください。短く日本語で成否を報告。ツールが拒否されたら回避せず理由を報告して終了。';
const args=[...(cli.endsWith('.js')?[cli]:[]),'exec','--ephemeral','--ignore-user-config','--skip-git-repo-check','--sandbox','read-only','-C',root,'--json','-c','mcp_servers.shikigami_desktop='+toml(table),'-o',path.join(root,'artifacts','desktop-codex-final.txt'),prompt];
const child=spawn(cli.endsWith('.js')?process.execPath:cli,args,{cwd:root,env:process.env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
const timer=setTimeout(()=>child.kill(),240000);
try{
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
 clearTimeout(timer);
 await fs.writeFile(path.join(root,'artifacts','desktop-codex-events.jsonl'),stdout);
 await fs.writeFile(path.join(process.env.SHIKIGAMI_DESKTOP_DATA_DIR,'codex-stderr.log'),stderr);
 const events=stdout.split(/\r?\n/).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
 const calls=events.map(e=>e.item).filter(i=>i?.type==='mcp_tool_call'&&i.status!=='in_progress');
 const file=await api('file',{name:'作業メモ.txt'}).catch(()=>null);
 const text=file?Buffer.from(file.data,'base64').toString('utf8'):'';
 const verified=code===0&&text.includes('SHIKIGAMI-DESKTOP-CODEX-OK')&&text.includes('Example Domain')&&calls.some(i=>i.tool==='desktop_stop'&&i.status==='completed')&&!calls.some(i=>i.status==='failed'||i.result?.isError);
 const report={verified,exitCode:code,toolCalls:calls.map(i=>({tool:i.tool,status:i.status,error:i.error})),savedText:text,final:events.filter(e=>e.item?.type==='agent_message').map(e=>e.item.text).join('\n'),usage:events.find(e=>e.type==='turn.completed')?.usage,dataDir:process.env.SHIKIGAMI_DESKTOP_DATA_DIR};
 await fs.writeFile(path.join(root,'artifacts','desktop-codex.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));process.exitCode=verified?0:1;
}finally{clearTimeout(timer);await api('shutdown',{}).catch(()=>{});}
