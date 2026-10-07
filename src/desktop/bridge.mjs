import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import path from 'node:path';

const workerFile=fileURLToPath(new URL('./worker.py',import.meta.url));
function linuxPath(value){
  if(!/^[A-Za-z]:\\/.test(value))throw new Error('WSL prototype requires a local Windows drive path');
  return `/mnt/${value[0].toLowerCase()}/${value.slice(3).replaceAll('\\','/')}`;
}
// wsl.exe writes its own messages as UTF-16LE unless WSL_UTF8=1. Decode across chunk boundaries.
const spawnWorker=(args,stdio)=>spawn(process.platform==='win32'?'wsl.exe':'python3',args,{windowsHide:true,stdio,env:{...process.env,WSL_UTF8:'1'}});
function decodeText(stream,append){const decoder=new StringDecoder('utf8');stream.on('data',chunk=>append(decoder.write(chunk)));stream.on('end',()=>append(decoder.end()));}

export class DesktopBridge {
  constructor({workspaceKey}={}){
    const defaultData=path.resolve(process.env.SHIKIGAMI_DESKTOP_DATA_DIR||fileURLToPath(new URL('../../.runtime/desktop-lab',import.meta.url)));
    this.workspaceKey=workspaceKey||createHash('sha256').update(defaultData).digest('hex').slice(0,24);
    if(!/^[a-f0-9]{24}$/.test(this.workspaceKey))throw new Error('Invalid workspace key');
    this.child=null;this.pending=new Map();this.sequence=0;this.error='';this.sessionId=null;
  }
  workerArgs(extra=[],unbuffered=false){
    const python=[...(unbuffered?['-u']:[]),process.platform==='win32'?linuxPath(workerFile):workerFile,'--workspace',this.workspaceKey,...extra];
    return process.platform==='win32'
      ?['-d',process.env.SHIKIGAMI_WSL_DISTRO||'Ubuntu-22.04','-u','shikigami-lab','--exec','python3',...python]
      :python;
  }
  staticRPC(extra,timeoutMs=30000){
    return new Promise((resolve,reject)=>{
      const child=spawnWorker(this.workerArgs(extra),['ignore','pipe','pipe']);
      let chunks=[],bytes=0,error='',settled=false;
      const finish=(failure,value)=>{if(settled)return;settled=true;clearTimeout(timer);failure?reject(failure):resolve(value);};
      child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>30_000_000){child.kill();finish(new Error('ファイルが読み取り上限を超えました'));}else chunks.push(chunk);});
      decodeText(child.stderr,text=>{error=(error+text).slice(-2000);});
      const timer=setTimeout(()=>{child.kill();finish(new Error('ファイル一覧の取得がタイムアウトしました'));},timeoutMs);
      child.on('error',e=>finish(e));
      // wsl.exe reports its own failures (e.g. missing distro) on stdout.
      child.on('close',code=>{if(code!==0)return finish(new Error(error.trim()||Buffer.concat(chunks).toString('utf8').trim().slice(-2000)||'ファイルを読み取れませんでした'));try{finish(null,JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch(e){finish(new Error('ファイル応答を読み取れませんでした: '+e.message));}});
    });
  }
  readFiles(){return this.staticRPC(['--read-files']);}
  readFile(name){if(typeof name!=='string'||!name||name.length>255)throw new Error('ファイル名を確認してください');return this.staticRPC(['--read-file',name]);}
  async start(){
    if(this.child)return this.request({method:'start'});
    if(this.sessionId)await this.stop();
    const child=spawnWorker(this.workerArgs([],true),['pipe','pipe','pipe']);
    this.child=child;this.error='';
    decodeText(child.stderr,text=>{this.error=(this.error+text).slice(-2000);});
    createInterface({input:child.stdout}).on('line',line=>{
      let value;try{value=JSON.parse(line);}catch{this.error=(this.error+line).slice(-2000);return;}
      if(value.event==='ready'&&/^[a-f0-9]{24}$/.test(value.sessionId)){this.sessionId=value.sessionId;return;}
      const pending=this.pending.get(value.id);if(!pending)return;
      clearTimeout(pending.timer);this.pending.delete(value.id);
      if(value.error)pending.reject(new Error(value.error));else pending.resolve(value.result);
    });
    const ended=error=>{
      if(this.child===child)this.child=null;
      for(const pending of this.pending.values()){
        clearTimeout(pending.timer);pending.reject(new Error(error?.message||this.error||'専用デスクトップとの接続が終了しました'));
      }
      this.pending.clear();
    };
    child.on('error',ended);child.on('exit',()=>ended());
    try{return await this.request({method:'start'});}catch(error){await this.stop();throw error;}
  }
  request(command){
    if(!this.child?.stdin.writable)return Promise.reject(new Error('先に専用デスクトップを起動してください'));
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('専用デスクトップの応答がタイムアウトしました'));},20000);
      this.pending.set(id,{resolve,reject,timer});
      this.child.stdin.write(JSON.stringify({...command,id})+'\n',error=>{
        if(error){clearTimeout(timer);this.pending.delete(id);reject(error);}
      });
    });
  }
  async stop(){
    const child=this.child;
    if(child){
      try{await this.request({method:'stop'});}catch{/* Always verify cleanup, even after a lost response. */}
      child.stdin.end();
    }
    if(child?.exitCode===null)await new Promise(resolve=>{
      const timer=setTimeout(()=>{child.kill();resolve();},4000);
      child.once('exit',()=>{clearTimeout(timer);resolve();});
    });
    if(this.sessionId){
      const args=process.platform==='win32'
        ?['-d',process.env.SHIKIGAMI_WSL_DISTRO||'Ubuntu-22.04','-u','shikigami-lab','--exec','python3',linuxPath(workerFile),'--cleanup',this.sessionId]
        :[workerFile,'--cleanup',this.sessionId];
      const result=await new Promise((resolve,reject)=>{
        const p=spawnWorker(args,['ignore','pipe','pipe']);
        const output=[],errors=[];p.stdout.on('data',b=>output.push(b));p.stderr.on('data',b=>errors.push(b));
        const timer=setTimeout(()=>{p.kill();reject(new Error('専用プロセスの終了を確認できませんでした'));},8000);
        p.on('error',e=>{clearTimeout(timer);reject(e);});
        p.on('close',code=>{clearTimeout(timer);try{if(code!==0)throw new Error((Buffer.concat(errors).toString('utf8').trim()||Buffer.concat(output).toString('utf8').trim()).slice(-2000)||'Cleanup failed');resolve(JSON.parse(Buffer.concat(output).toString('utf8')));}catch(e){reject(e);}});
      });
      if(result.remaining.length)throw new Error('専用プロセスが残っています：'+result.remaining.join(','));
      this.sessionId=null;
    }
  }
}
