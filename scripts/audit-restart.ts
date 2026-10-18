import { chooseBrowser } from '../browser/chooseBrowser';
import { writeFile } from 'node:fs/promises';
const d=await chooseBrowser('visible',true,'working-holiday',65163);
console.log(await d.executeScript(`return {path:location.pathname,title:document.title,text:document.body.innerText.slice(0,10000),links:Array.from(document.querySelectorAll('a[href*="CountryId"],a[id*="editHyperLink"]')).map(e=>({text:e.innerText,path:new URL(e.href).pathname}))};`));
await writeFile('data/verification/restart-failure.png',Buffer.from(await d.takeScreenshot(),'base64'));await d.quit();
