// Real Codex -> registered Shikigami MCP check. No config writes and no desktop input.
import {spawn,execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function findCli(){
  if(process.env.SHIKIGAMI_CODEX_CLI){const p=path.resolve(process.env.SHIKIGAMI_CODEX_CLI);await fs.access(p);return p;}
  const candidates=[path.join(path.dirname(process.execPath),'node_modules','@openai','codex','bin','codex.js')];
  if(process.platform==='win32'){
    try{for(const p of execFileSync('where.exe',['codex'],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/)){
      if(p.endsWith('.exe'))candidates.push(p);
      candidates.push(path.join(path.dirname(p),'node_modules','@openai','codex','bin','codex.js'));
    }}catch{}
  }
  for(const p of candidates){try{await fs.access(p);return p;}catch{}}
  throw new Error('Codex CLIが見つかりません。SHIKIGAMI_CODEX_CLIにcodex.exeまたはbin/codex.jsの絶対パスを指定してください。');
}
const cli=await findCli();
if(process.argv.includes('--check-cli')){console.log(JSON.stringify({cli}));process.exit(0);}
const nodeCli=cli.endsWith('.js')||cli.endsWith('.mjs');
await fs.mkdir(path.join(root,'artifacts'),{recursive:true});
await fs.mkdir(path.join(root,'.runtime'),{recursive:true});
const prompt=`This is a bounded integration test. Use ONLY Shikigami MCP tools, never shell, ordinary browser/computer-use tools, or other agents. Call shikigami_workspace. Derive /fixture/7 from the origin of its panel URL and navigate the dedicated browser there. Fill the visible test input with SHIKIGAMI-CODEX-OK, click 記録する, and verify the visible page contains 記録済み：SHIKIGAMI-CODEX-OK. Then close only the dedicated browser with browser_close. Do not open the panel. Finish with a short Japanese report saying whether the exact marker was verified. Stop if Shikigami tools are unavailable; do not use a fallback.`;
const args=[...(nodeCli?[cli]:[]),'exec','--ephemeral','--skip-git-repo-check','--sandbox','read-only','-C',root,'--json','-o',path.join(root,'artifacts','codex-integration-final.txt')];
if(process.env.SHIKIGAMI_TEST_MODEL)args.push('--model',process.env.SHIKIGAMI_TEST_MODEL);
args.push(prompt);
const child=spawn(nodeCli?process.execPath:cli,args,{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
let out='',err='';
child.stdout.on('data',d=>{out+=d;});child.stderr.on('data',d=>{err+=d;});
child.on('error',e=>{console.error(e.message);process.exitCode=1;});
const code=await new Promise(r=>child.on('close',r));
await fs.writeFile(path.join(root,'artifacts','codex-integration-events.jsonl'),out);
await fs.writeFile(path.join(root,'.runtime','codex-integration-stderr.log'),err);
const events=out.split(/\r?\n/).filter(Boolean).flatMap(s=>{try{return [JSON.parse(s)];}catch{return [];}});
const calls=events.map(e=>e.item).filter(i=>i?.type==='mcp_tool_call');
const final=events.map(e=>e.item).filter(i=>i?.type==='agent_message').map(i=>i.text).join('\n');
const completed=calls.filter(i=>i.status==='completed');
const actionFailures=calls.filter(i=>i.status==='failed'||i.result?.isError);
const marker='記録済み：SHIKIGAMI-CODEX-OK';
const visibleMatch=completed.some(i=>{
  const text=i.result?.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n')||'';
  if(['browser_click','browser_snapshot'].includes(i.tool))return text.includes(marker);
  return i.tool==='browser_find'&&/Found [1-9]\d* match/.test(text)&&text.includes(': '+marker);
});
const verified=code===0&&actionFailures.length===0&&completed.some(i=>i.tool==='browser_navigate')&&completed.some(i=>i.tool==='browser_close')&&visibleMatch;
const result={verified,exitCode:code,toolCalls:calls.map(i=>({server:i.server,tool:i.tool,status:i.status,error:i.error})),final,errors:events.filter(e=>e.type==='error'||e.type==='turn.failed'),usage:events.find(e=>e.type==='turn.completed')?.usage,at:new Date().toISOString()};
await fs.writeFile(path.join(root,'artifacts','codex-integration.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
process.exitCode=verified?0:1;
