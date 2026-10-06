import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

const workerFile=fileURLToPath(new URL('./worker.py',import.meta.url));
function linuxPath(value){
  if(!/^[A-Za-z]:\\/.test(value))throw new Error('WSL prototype requires a local Windows drive path');
  return `/mnt/${value[0].toLowerCase()}/${value.slice(3).replaceAll('\\','/')}`;
}

export class DesktopBridge {
  constructor(){this.child=null;this.pending=new Map();this.sequence=0;this.error='';this.sessionId=null;}
  async start(){
    if(this.child)return this.request({method:'start'});
    if(this.sessionId)await this.stop();
    const command=process.platform==='win32'?'wsl.exe':'python3';
    const args=process.platform==='win32'
      ?['-d',process.env.SHIKIGAMI_WSL_DISTRO||'Ubuntu-22.04','-u','shikigami-lab','--exec','python3','-u',linuxPath(workerFile)]
      :['-u',workerFile];
    const child=spawn(command,args,{windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.child=child;this.error='';
    child.stderr.on('data',chunk=>{this.error=(this.error+chunk.toString()).slice(-2000);});
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
        const p=spawn(process.platform==='win32'?'wsl.exe':'python3',args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
        let output='',error='';p.stdout.on('data',b=>output+=b);p.stderr.on('data',b=>error+=b);
        const timer=setTimeout(()=>{p.kill();reject(new Error('専用プロセスの終了を確認できませんでした'));},8000);
        p.on('error',e=>{clearTimeout(timer);reject(e);});
        p.on('exit',code=>{clearTimeout(timer);try{if(code!==0)throw new Error(error||'Cleanup failed');resolve(JSON.parse(output));}catch(e){reject(e);}});
      });
      if(result.remaining.length)throw new Error('専用プロセスが残っています：'+result.remaining.join(','));
      this.sessionId=null;
    }
  }
}
