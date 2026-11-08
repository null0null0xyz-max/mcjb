import express from 'express';
import session from 'express-session';
import { Client } from 'ssh2';
import crypto from 'node:crypto';

const app = express();
const port = process.env.PORT || 10000;
const required = ['PANEL_PASSWORD','MC_SSH_HOST','MC_SSH_USER','MC_SSH_PRIVATE_KEY'];
app.use(express.json());
app.use(express.static('public'));
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, secure: 'auto', sameSite: 'lax', maxAge: 86400000 }
}));

function ssh(command) {
  return new Promise((resolve, reject) => {
    const conn = new Client(); let out=''; let err='';
    conn.on('ready', () => conn.exec(command, (e, stream) => {
      if (e) return reject(e);
      stream.on('data', d => out += d).stderr.on('data', d => err += d)
        .on('close', code => { conn.end(); code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`)); });
    })).on('error', reject).connect({
      host: process.env.MC_SSH_HOST, port: Number(process.env.MC_SSH_PORT || 2222),
      username: process.env.MC_SSH_USER, privateKey: process.env.MC_SSH_PRIVATE_KEY.replace(/\\n/g, '\n'), readyTimeout: 12000
    });
  });
}
function auth(req,res,next){ if(req.session.authenticated) return next(); res.status(401).json({error:'Требуется вход'}); }
app.post('/api/login', (req,res) => {
  if (!process.env.PANEL_PASSWORD || req.body.password !== process.env.PANEL_PASSWORD) return res.status(401).json({error:'Неверный пароль'});
  req.session.authenticated = true; res.json({ok:true});
});
app.post('/api/logout', (req,res) => req.session.destroy(() => res.json({ok:true})));
app.get('/api/status', auth, async (req,res) => { try { const x=await ssh('systemctl is-active minecraft || true; uptime -p; free -h | sed -n "2p"'); res.json({ok:true, output:x}); } catch(e){res.status(502).json({error:e.message});} });
app.post('/api/server/:action', auth, async (req,res) => {
  const allowed = new Set(['start','stop','restart']); if(!allowed.has(req.params.action)) return res.sendStatus(400);
  try { const x=await ssh(`sudo systemctl ${req.params.action} minecraft`); res.json({ok:true, output:x || 'Команда выполнена'}); } catch(e){res.status(502).json({error:e.message});}
});
app.get('/healthz', (_,res)=>res.json({ok:true}));
for (const k of required) if(!process.env[k]) console.warn(`Missing environment variable: ${k}`);
app.listen(port, '0.0.0.0', ()=>console.log(`panel listening on ${port}`));
