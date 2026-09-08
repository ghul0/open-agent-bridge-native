import { readFile, writeFile, chmod } from 'node:fs/promises';
import { WebSocket } from 'ws';
const [bindingPath,outputPath]=process.argv.slice(2);
if(!bindingPath||!outputPath)throw new Error('Expected binding and private evidence output');
const binding=JSON.parse(await readFile(bindingPath,'utf8'));
const ws=new WebSocket(binding.appServerUrl);let id=0;const pending=new Map();
const request=(method,params)=>new Promise((resolve,reject)=>{const key=++id;const timer=setTimeout(()=>{pending.delete(key);reject(new Error('RPC timeout'));},10000);pending.set(key,{resolve,reject,timer});ws.send(JSON.stringify({id:key,method,params}));});
ws.on('message',raw=>{const m=JSON.parse(String(raw));if(m.id!==undefined&&m.method){ws.send(JSON.stringify({id:m.id,error:{code:-32601,message:'Evidence collector does not approve runtime requests'}}));return;}const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}});
await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});
try{await request('initialize',{clientInfo:{name:'nab-evidence',version:'0.1.0'},capabilities:{experimentalApi:true}});ws.send(JSON.stringify({method:'initialized'}));const result=await request('thread/read',{threadId:binding.threadId,includeTurns:true});if(result.thread?.id!==binding.threadId)throw new Error('Thread mismatch');await writeFile(outputPath,JSON.stringify({binding,at:new Date().toISOString(),...result},null,2),{mode:0o600});await chmod(outputPath,0o600);console.log(JSON.stringify({threadId:binding.threadId,turns:result.thread.turns?.length,outputPath}));}finally{ws.close();}
