import express from 'express';
import session from 'express-session';
import { Client } from 'ssh2';
import crypto from 'node:crypto';

const app = express();
const port = process.env.PORT || 10000;
const isPublicOnly = process.env.PUBLIC_ONLY === 'true';
app.use(express.json());
app.use(express.static('public'));
app.use(session({ secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'), resave:false, saveUninitialized:false, cookie:{httpOnly:true,secure:'auto',sameSite:'lax',maxAge:86400000} }));

function ssh(command) {
  return new Promise((resolve,reject)=>{
    const conn = new Client(); let out=''; let err=''; let settled=false;
    const fail = e => { if(!settled){ settled=true; try{conn.end()}catch{} reject(e instanceof Error?e:new Error(String(e))); } };
    conn.on('ready',()=>conn.exec(command,(e,stream)=>{
      if(e) return fail(e);
      stream.on('data',d=>out+=d.toString()).stderr.on('data',d=>err+=d.toString());
      stream.on('exit',(code,signal)=>{ if(code !== 0 && code !== null) fail(new Error(err.trim() || `SSH-команда завершилась с кодом ${code}`)); else { settled=true; conn.end(); resolve(out); } });
      stream.on('error',fail);
    })).on('error',fail).connect({host:process.env.MC_SSH_HOST,port:Number(process.env.MC_SSH_PORT||2222),username:process.env.MC_SSH_USER,privateKey:Buffer.from(process.env.MC_SSH_PRIVATE_KEY_B64||'','base64').toString('utf8'),readyTimeout:15000});
  });
}
function auth(req,res,next){ if(req.session.authenticated)return next(); res.status(401).json({error:'Требуется вход в админ-панель'}); }
async function run(res,cmd){try{res.json({ok:true,output:await ssh(cmd)})}catch(e){res.status(502).json({ok:false,error:e.message})}}
app.post('/api/login',(req,res)=>{if(!process.env.PANEL_PASSWORD||req.body.password!==process.env.PANEL_PASSWORD)return res.status(401).json({error:'Неверный пароль'});req.session.authenticated=true;res.json({ok:true})});
app.post('/api/logout',(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get('/api/status',auth,(req,res)=>run(res,"printf 'Сервис: '; systemctl is-active minecraft || true; printf '\\nUptime: '; uptime -p; printf '\\nПамять: '; free -h | awk 'NR==2{print $3 \" / \" $2}'; printf '\\nДиск: '; df -h /opt/minecraft | awk 'NR==2{print $3 \" / \" $2 \" (\" $5 \")\"}'"));
app.get('/api/players',auth,(req,res)=>run(res,"screen -S minecraft -X stuff 'list\\r' 2>/dev/null || true; sleep 1; journalctl -u minecraft -n 80 --no-pager | grep -E 'There are|joined the game|left the game' | tail -n 30"));
app.get('/api/logs',auth,(req,res)=>run(res,'journalctl -u minecraft -n 120 --no-pager'));
app.get('/api/plugins',auth,(req,res)=>run(res,"find /opt/minecraft/plugins -maxdepth 1 -type f -printf '%f\\n' | sort"));
app.get('/api/worlds',auth,(req,res)=>run(res,"du -sh /opt/minecraft/world* 2>/dev/null || true"));
app.post('/api/server/:action',auth,async(req,res)=>{if(!['start','stop','restart'].includes(req.params.action))return res.sendStatus(400);await run(res,`sudo systemctl ${req.params.action} minecraft`)});
app.post('/api/command',auth,async(req,res)=>{const c=String(req.body.command||'').trim();if(!/^(list|tps|save-all|say |whitelist |time |weather )/i.test(c))return res.status(400).json({error:'Команда запрещена в панели'});await run(res,`screen -S minecraft -X stuff ${JSON.stringify(c+'\\r')}`)});
app.post('/api/public/start',(req,res)=>{if(!isPublicOnly)return res.status(404).end();run(res,'sudo systemctl start minecraft')});
app.get('/healthz',(_,res)=>res.json({ok:true,mode:isPublicOnly?'public-launcher':'admin'}));
app.listen(port,'0.0.0.0',()=>console.log(`panel listening on ${port}`));
