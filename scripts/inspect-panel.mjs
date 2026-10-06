// Visual check only: never type into the human test or start its test automatically.
import {chromium} from 'playwright';
import fs from 'node:fs/promises';
const s=JSON.parse(await fs.readFile('.runtime/session.json','utf8'));
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
  const page=await browser.newPage({viewport:{width:1360,height:1000}});
  await page.goto(s.panel);
  await page.getByRole('button',{name:'直近のAI画面を見る'}).waitFor();
  const status=await(await fetch(s.base+'/api/status',{headers:{'X-Shikigami-Token':s.token}})).json();
  if(status.busy) throw new Error('Human or automatic run active; do not interact during measurement');
  await page.screenshot({path:'artifacts/panel-desktop.png',fullPage:true});
  await page.getByRole('button',{name:'直近のAI画面を見る'}).click();
  await page.locator('#preview').waitFor({state:'visible'});
  await page.screenshot({path:'artifacts/panel-preview.png',fullPage:true});
  await page.getByRole('button',{name:'画面を隠す',exact:true}).click();
  if(await page.locator('#preview').isVisible())throw new Error('Preview remained visible');
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'artifacts/panel-mobile.png',fullPage:true});
  if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error('Horizontal overflow');
  console.log(JSON.stringify({desktopScreenshot:true,mobileScreenshot:true,previewShowHide:true,horizontalOverflow:false,humanInputSimulated:false}));
}finally{await browser.close();}
