import express from 'express';
import session from 'express-session';
import { Client } from 'ssh2';
import crypto from 'node:crypto';

const app = express();
const port = process.env.PORT || 10000;
const isPublicOnly = process.env.PUBLIC_ONLY === 'true';
const minecraftRoot = '/opt/minecraft';
app.use(express.json({ limit: '64kb' }));
app.use(express.static('public'));
app.use(session({ secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'), resave:false, saveUninitialized:false, cookie:{httpOnly:true,secure:'auto',sameSite:'lax',maxAge:86400000} }));

function ssh(command) {
  return new Promise((resolve,reject)=>{
    const conn = new Client(); let out=''; let err=''; let settled=false;
    const fail = e => { if(!settled){ settled=true; try{conn.end()}catch{} reject(e instanceof Error?e:new Error(String(e))); } };
    conn.on('ready',()=>conn.exec(command,(e,stream)=>{
      if(e) return fail(e);
      stream.on('data',d=>out+=d.toString()).stderr.on('data',d=>err+=d.toString());
      stream.on('exit',(code)=>{ if(code !== 0 && code !== null) fail(new Error(err.trim() || `SSH-команда завершилась с кодом ${code}`)); else { settled=true; conn.end(); resolve(out); } });
      stream.on('error',fail);
    })).on('error',fail).connect({host:process.env.MC_SSH_HOST,port:Number(process.env.MC_SSH_PORT||2222),username:process.env.MC_SSH_USER,privateKey:Buffer.from(process.env.MC_SSH_PRIVATE_KEY_B64||'','base64').toString('utf8'),readyTimeout:15000});
  });
}
function auth(req,res,next){ if(req.session.authenticated)return next(); res.status(401).json({error:'Требуется вход в админ-панель'}); }
async function run(res,cmd){try{res.json({ok:true,output:await ssh(cmd)})}catch(e){res.status(502).json({ok:false,error:e.message})}}
function safeName(value){ const name=String(value||'').trim(); if(!/^[A-Za-z0-9_А-Яа-яёЁ-]{1,32}$/.test(name)) throw new Error('Некорректное имя игрока'); return name; }
function q(value){ return `'${String(value).replaceAll("'","'\\''")}'`; }
function rcon(command){ return `python3 /opt/minecraft/rcon-client.py ${q(command)}`; }
function remotePython(code){ return `python3 -c ${q(code)}`; }
function proxySquaremap(req,res){
  const conn = new Client(); let done=false;
  const fail = e => { if(done)return; done=true; try{conn.end()}catch{}; if(!res.headersSent)res.status(502).send(`Карта временно недоступна: ${e.message}`); else res.destroy(); };
  conn.on('ready',()=>conn.forwardOut('127.0.0.1',0,'127.0.0.1',8080,(e,stream)=>{
    if(e)return fail(e);
    let header=Buffer.alloc(0); let parsed=false;
    stream.on('data',chunk=>{
      if(parsed){res.write(chunk);return;}
      header=Buffer.concat([header,chunk]); const i=header.indexOf('\r\n\r\n');
      if(i<0)return;
      parsed=true; const text=header.subarray(0,i).toString(); const lines=text.split('\r\n'); const status=Number((lines[0].match(/\s(\d{3})\s/)||[])[1]||502); res.status(status);
      for(const line of lines.slice(1)){const n=line.indexOf(':');if(n>0){const k=line.slice(0,n).toLowerCase();if(['connection','transfer-encoding','content-length','content-type','cache-control','etag','last-modified'].includes(k))res.setHeader(k,line.slice(n+1).trim())}}
      res.write(header.subarray(i+4));
    }).on('end',()=>{done=true;res.end();conn.end()}).on('error',fail);
    const path=(req.path||'/')+(req.originalUrl.includes('?')?`?${req.originalUrl.split('?')[1]}`:'');
    stream.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
  })).on('error',fail).connect({host:process.env.MC_SSH_HOST,port:Number(process.env.MC_SSH_PORT||2222),username:process.env.MC_SSH_USER,privateKey:Buffer.from(process.env.MC_SSH_PRIVATE_KEY_B64||'','base64').toString('utf8'),readyTimeout:15000});
}

app.post('/api/login',(req,res)=>{if(!process.env.PANEL_PASSWORD||req.body.password!==process.env.PANEL_PASSWORD)return res.status(401).json({error:'Неверный пароль'});req.session.authenticated=true;res.json({ok:true})});
app.post('/api/logout',(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get('/api/status',auth,(req,res)=>run(res,"printf 'Сервис: '; systemctl is-active minecraft || true; printf '\\nUptime: '; uptime -p; printf '\\nПамять: '; free -h | awk 'NR==2{print $3 \" / \" $2}'; printf '\\nДиск: '; df -h /opt/minecraft | awk 'NR==2{print $3 \" / \" $2 \" (\" $5 \")\"}'; printf '\\nJava/Paper: '; pgrep -af 'paper.jar' | head -1 || true"));
app.use('/map',auth,proxySquaremap);
app.get('/api/players',auth,(req,res)=>run(res,remotePython("import sqlite3,json; c=sqlite3.connect('/opt/minecraft/plugins/AuthMe/authme.db'); c.row_factory=sqlite3.Row; rows=[dict(r) for r in c.execute('select username,realname,lastlogin,x,y,z,world,isLogged from authme order by lastlogin desc')]; print(json.dumps(rows,ensure_ascii=False))")));
app.get('/api/players/recent',auth,(req,res)=>run(res,`${rcon('list')}; echo; echo 'Последние события:'; journalctl -u minecraft -n 300 --no-pager | grep -E 'joined the game|left the game' | tail -n 50 || true`));
app.get('/api/logs',auth,(req,res)=>run(res,'journalctl -u minecraft -n 180 --no-pager'));
app.get('/api/plugins',auth,(req,res)=>run(res,"find /opt/minecraft/plugins -maxdepth 1 -type f -name '*.jar' -printf '%f\\n' | sort; printf '\\nOptional modules:\\n'; for p in CoreProtect BlueMap Plan SuperVanish spark; do test -e /opt/minecraft/plugins/$p -o -e /opt/minecraft/plugins/$p.jar && echo \"$p: installed\" || echo \"$p: not installed\"; done"));
app.get('/api/worlds',auth,(req,res)=>run(res,"du -sh /opt/minecraft/world* 2>/dev/null || true; printf '\\nMap viewers:\\n'; find /opt/minecraft/plugins/squaremap/web -maxdepth 2 -type f -iname '*.png' -o -iname 'index.html' 2>/dev/null | head -20; printf '\\nMap web: '; ss -lntup | grep ':8080' || true"));
app.get('/api/diagnostics',auth,(req,res)=>run(res,"printf 'CoreProtect: '; test -e /opt/minecraft/plugins/CoreProtect -o -e /opt/minecraft/plugins/CoreProtect.jar && echo installed || echo missing; printf 'squaremap: '; test -e /opt/minecraft/plugins/squaremap -o -e /opt/minecraft/plugins/squaremap*.jar && echo installed || echo missing; printf 'Plan: '; test -e /opt/minecraft/plugins/Plan -o -e /opt/minecraft/plugins/Plan.jar && echo installed || echo missing; printf 'Vanish: '; test -e /opt/minecraft/plugins/SuperVanish -o -e /opt/minecraft/plugins/SuperVanish.jar && echo installed || echo missing; printf '\\nServer port: '; ss -lntup | grep -E ':25565|:19132|:8080' || true"));
app.get('/api/chunks',auth,(req,res)=>run(res,`${rcon('paper chunkinfo')}; echo; ${rcon('forceload query')}`));
app.get('/api/player/:player/inventory',auth,(req,res)=>{let p;try{p=safeName(req.params.player)}catch(e){return res.status(400).json({error:e.message})}run(res,`echo 'Инвентарь игрока ${p} (игрок должен быть онлайн):'; ${rcon(`data get entity ${p} Inventory`)}`)});
app.get('/api/player/:player/enderchest',auth,(req,res)=>{let p;try{p=safeName(req.params.player)}catch(e){return res.status(400).json({error:e.message})}run(res,`echo 'Эндер-сундук игрока ${p} (игрок должен быть онлайн):'; ${rcon(`data get entity ${p} EnderItems`)}`)});
app.get('/api/player/:player/stats',auth,(req,res)=>{let p;try{p=safeName(req.params.player)}catch(e){return res.status(400).json({error:e.message})}run(res,`echo 'Статистика ${p}:'; find /opt/minecraft/world*/stats -type f -iname ${q(p+'.json')} -print -exec cat {} \\; 2>/dev/null || echo 'Файл статистики не найден. Игрок должен хотя бы один раз войти.'`)});
app.post('/api/player/:player/vanish',auth,(req,res)=>{let p;try{p=safeName(req.params.player)}catch(e){return res.status(400).json({error:e.message})}const action=req.body.enabled?'vanish':'unvanish';run(res,`${rcon(`${action} ${p}`)}; echo 'Команда ${action} отправлена. Для полноценного vanish нужен SuperVanish/EssentialsX.'`)});
app.post('/api/player/:player/password-reset',auth,(req,res)=>{let p,password;try{p=safeName(req.params.player);password=String(req.body.password||'')}catch(e){return res.status(400).json({error:e.message})}if(password.length<8||password.length>64||/[\r\n]/.test(password))return res.status(400).json({error:'Новый пароль должен содержать 8–64 символа без переноса строки'});run(res,`${rcon(`authme changepassword ${p} ${password}`)}; echo 'Пароль сброшен. Исходный пароль восстановить невозможно.'`)});
app.post('/api/observe',auth,(req,res)=>{let admin,target;try{admin=safeName(req.body.admin);target=req.body.target?safeName(req.body.target):''}catch(e){return res.status(400).json({error:e.message})}const mode=req.body.mode==='top'?'top':'follow';if(mode==='follow'&&!target)return res.status(400).json({error:'Укажите игрока для наблюдения'});const command=mode==='follow'?`gamemode spectator ${admin}; spectate ${target}`:`gamemode spectator ${admin}; tp ${admin} ${Number(req.body.x)||0} ${Number(req.body.y)||200} ${Number(req.body.z)||0}`;run(res,`${rcon(command)}; echo 'Режим наблюдения ${mode} отправлен'`)});
app.post('/api/rollback',auth,(req,res)=>{let p;try{p=req.body.player?safeName(req.body.player):''}catch(e){return res.status(400).json({error:e.message})}if(!p)return res.status(400).json({error:'Укажите игрока'});const radius=Math.min(Math.max(Number(req.body.radius)||10,1),100);const minutes=Math.min(Math.max(Number(req.body.minutes)||30,1),10080);run(res,`${rcon(`co rollback u:${p} t:${minutes} r:${radius}`)}; echo 'Откат отправлен CoreProtect'`)});
app.get('/api/xray',auth,(req,res)=>run(res,"if [ -d /opt/minecraft/plugins/CoreProtect ]; then echo 'X-ray анализ: CoreProtect найден, но процент вероятности требует отдельного анализа добычи руды.'; find /opt/minecraft/plugins/CoreProtect -maxdepth 2 -type f | head -20; else echo 'X-ray модуль не установлен.'; fi"));
app.post('/api/server/:action',auth,async(req,res)=>{if(!['start','stop','restart'].includes(req.params.action))return res.sendStatus(400);await run(res,`sudo systemctl ${req.params.action} minecraft`)});
app.post('/api/command',auth,async(req,res)=>{const c=String(req.body.command||'').trim();if(!/^(list|tps|save-all|say |whitelist |time |weather )/i.test(c))return res.status(400).json({error:'Команда запрещена в панели'});await run(res,rcon(c))});
app.post('/api/console',auth,async(req,res)=>{const c=String(req.body.command||'').trim();if(!c||c.length>500||/[\r\n]/.test(c))return res.status(400).json({error:'Команда пустая, слишком длинная или содержит перенос строки'});await run(res,rcon(c))});
app.post('/api/public/start',(req,res)=>{if(!isPublicOnly)return res.status(404).end();run(res,'sudo systemctl start minecraft')});
app.get('/healthz',(_,res)=>res.json({ok:true,mode:isPublicOnly?'public-launcher':'admin'}));
app.listen(port,'0.0.0.0',()=>console.log(`panel listening on ${port}`));
