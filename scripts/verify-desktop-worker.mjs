import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {DesktopBridge} from '../src/desktop/bridge.mjs';
const bridge=new DesktopBridge();
try{
  console.log('start',await bridge.start());
  console.log('editor',await bridge.request({method:'launch',app:'editor'}));
  await bridge.request({method:'click',x:250,y:180,button:1});
  await bridge.request({method:'type',text:'Shikigami desktop\n日本語の入力と保存を確認します。\n'});
  await bridge.request({method:'key',key:'ctrl+s'});
  await new Promise(r=>setTimeout(r,400));
  const saved=await bridge.request({method:'read_test_note'});
  assert(saved.text.includes('日本語の入力と保存を確認します。'),JSON.stringify(saved));
  console.log('saved',saved);
  console.log('calculator',await bridge.request({method:'launch',app:'calculator'}));
  const shot=await bridge.request({method:'capture'});
  await fs.mkdir('artifacts',{recursive:true});
  await fs.writeFile('artifacts/desktop-first.png',Buffer.from(shot.image,'base64'));
  console.log('status',await bridge.request({method:'status'}));
  await assert.rejects(()=>bridge.request({method:'click',x:-1,y:0}));
  console.log('verified native editor, Japanese text, saved file, calculator, capture, invalid-coordinate refusal');
  bridge.child.kill();
  await new Promise(r=>setTimeout(r,500));
  await bridge.stop();
  assert.equal(bridge.sessionId,null);
  console.log('verified session-scoped cleanup after launcher termination');
}finally{await bridge.stop();}
