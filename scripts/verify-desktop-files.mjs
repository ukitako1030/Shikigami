import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {DesktopBridge} from '../src/desktop/bridge.mjs';
const workspaceKey=randomBytes(12).toString('hex');
const bridge=new DesktopBridge({workspaceKey});
assert.deepEqual((await bridge.readFiles()).files,[]);
const fixture=`import pathlib,os,sys
p=pathlib.Path.home()/'workspaces'/sys.argv[1]/'files'
(p/'example.txt').write_text('日本語ファイル検証',encoding='utf-8')
(p/'link.txt').symlink_to(p/'example.txt')
os.mkfifo(p/'pipe.txt')
with (p/'large.bin').open('wb') as f: f.truncate(21*1024*1024)
`;
execFileSync('wsl.exe',['-d',process.env.SHIKIGAMI_WSL_DISTRO||'Ubuntu-22.04','-u','shikigami-lab','--exec','python3','-c',fixture,workspaceKey],{windowsHide:true});
const names=(await bridge.readFiles()).files.map(f=>f.name);
assert(names.includes('example.txt'));assert(!names.includes('link.txt'));assert(!names.includes('pipe.txt'));
assert.equal(Buffer.from((await bridge.readFile('example.txt')).data,'base64').toString('utf8'),'日本語ファイル検証');
for(const name of ['link.txt','pipe.txt','large.bin','../.lock','..\\.lock'])await assert.rejects(()=>bridge.readFile(name));
console.log(JSON.stringify({ok:true,symlinkRefused:true,fifoRefused:true,oversizeRefused:true,traversalRefused:true,stoppedRead:true}));
