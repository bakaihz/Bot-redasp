'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   RedasP — server.js  v3.1  (corrigido, sem proxy, captcha fake, URLs Sala do Futuro)
   Automação de REDAÇÕES da Sala do Futuro SP
═══════════════════════════════════════════════════════════════════════════ */

const express = require('express');
const https   = require('https');
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

/* ─── Config ────────────────────────────────────────────────────────────── */
const CFG_PATH = path.join(__dirname, 'config.json');
let CFG;
try {
  CFG = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
} catch (e) {
  console.error('[REDASP] ERRO: config.json não encontrado:', e.message);
  process.exit(1);
}

const PORT          = (CFG.server?.port || 3000) + 1; // 3001
const EDUSP         = 'https://saladofuturo.educacao.sp.gov.br'; // URL fixa correta
const SED_URL       = 'https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/credenciais/api/LoginCompletoToken';
const SED_OCP_KEY   = CFG.sed?.ocp_key || 'd701a2043aa24d7ebb37e9adf60d043b';
const AI1_URL       = CFG.ai.scrapper1.url;
const AI2_URL       = CFG.ai.scrapper2.url;
const DISCORD_TOKEN = CFG.owner?.discord_token || '';
const LOG_DIR       = path.resolve(CFG.logs?.dir || './logs');
const DATA_DIR      = path.resolve(CFG.database?.dir || './data');
const BACKUP_DIR    = path.resolve(CFG.database?.backup_dir || './data/backups');
const ESSAYS_FILE   = path.join(DATA_DIR, 'essays_db.json');

[LOG_DIR, DATA_DIR, BACKUP_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

/* ═══════════════════════════════════════════════════════════════════════════
   LOGGER
═══════════════════════════════════════════════════════════════════════════ */
const C = {
  reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m',
  red:'\x1b[31m', green:'\x1b[32m', yellow:'\x1b[33m',
  blue:'\x1b[34m', cyan:'\x1b[36m', white:'\x1b[37m',
  gold:'\x1b[38;2;200;169;110m', orange:'\x1b[38;2;212;148;90m', magenta:'\x1b[35m',
};
const SRC_COLOR = {
  SYS:'', AI1:C.gold, AI2:C.blue, AUTH:C.green,
  DB:C.orange, ESSAY:C.cyan, NET:C.yellow, BACKUP:C.magenta,
};
const LVL = {
  debug:{c:C.dim+C.white,l:'DEBUG'}, info:{c:C.cyan,l:'INFO '},
  ok:{c:C.green,l:' OK  '}, warn:{c:C.yellow,l:'WARN '},
  error:{c:C.red,l:'ERROR'}, fatal:{c:C.bold+C.red,l:'FATAL'},
};
let _logStream = null;
function getLogStream() {
  const date = new Date().toISOString().slice(0,10);
  const file = path.join(LOG_DIR, `redasp-${date}.log`);
  if (!_logStream || _logStream._path !== file) {
    if (_logStream) _logStream.end();
    _logStream = fs.createWriteStream(file, {flags:'a'});
    _logStream._path = file;
  }
  return _logStream;
}
function logger(src, msg, level='info') {
  const lv = LVL[level] || LVL.info;
  const now = new Date();
  const ts  = now.toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const sc  = SRC_COLOR[src] || '';
  console.log(`${C.dim}${ts}${C.reset} ${lv.c}[${lv.l}]${C.reset} ${sc}[${src.padEnd(5)}]${C.reset} ${msg}`);
  try { getLogStream().write(`[${now.toISOString()}] [${lv.l}] [${src}] ${msg}\n`); } catch(_) {}
}
const log = {
  debug:(s,m)=>logger(s,m,'debug'), info:(s,m)=>logger(s,m,'info'),
  ok:(s,m)=>logger(s,m,'ok'),       warn:(s,m)=>logger(s,m,'warn'),
  error:(s,m)=>logger(s,m,'error'), fatal:(s,m)=>logger(s,m,'fatal'),
};

/* ═══════════════════════════════════════════════════════════════════════════
   ESSAYS DB
═══════════════════════════════════════════════════════════════════════════ */
let _essaysCache = null;
let _essaysDirty = false;
let _flushTimer  = null;

function dbGet() {
  if (_essaysCache === null) {
    try {
      _essaysCache = fs.existsSync(ESSAYS_FILE)
        ? JSON.parse(fs.readFileSync(ESSAYS_FILE, 'utf8'))
        : {};
    } catch(e) { log.error('DB', 'Leitura: '+e.message); _essaysCache = {}; }
  }
  return _essaysCache;
}
function dbSet(data) {
  _essaysCache = data; _essaysDirty = true;
  if (!_flushTimer) _flushTimer = setTimeout(() => {
    _flushTimer = null;
    if (!_essaysDirty || !_essaysCache) return;
    try { fs.writeFileSync(ESSAYS_FILE, JSON.stringify(_essaysCache, null, 2), 'utf8'); _essaysDirty = false; }
    catch(e) { log.error('DB', 'Flush: '+e.message); }
  }, 500);
}
function flushSync() {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  if (_essaysDirty && _essaysCache)
    try { fs.writeFileSync(ESSAYS_FILE, JSON.stringify(_essaysCache, null, 2), 'utf8'); } catch(_){}
}

const EssaysDB = {
  save(taskId, title, text, status='generated') {
    const db = dbGet(); const was = db[String(taskId)];
    db[String(taskId)] = {
      taskId, title, text, status,
      wordCount: text.split(/\s+/).filter(Boolean).length,
      savedAt:   new Date().toISOString(),
      useCount:  (was?.useCount||0)+1,
    };
    dbSet(db);
    log.ok('DB', `Salvo: tarefa ${taskId} ("${title.slice(0,40)}")`);
  },
  markDelivered(taskId) {
    const db = dbGet();
    if (db[String(taskId)]) {
      db[String(taskId)].status      = 'delivered';
      db[String(taskId)].deliveredAt = new Date().toISOString();
      dbSet(db);
    }
  },
  get(taskId)    { return dbGet()[String(taskId)] || null; },
  delete(taskId) { const db=dbGet(); delete db[String(taskId)]; dbSet(db); },
  list()         { return Object.values(dbGet()).map(e=>({taskId:e.taskId,title:e.title,status:e.status,wordCount:e.wordCount,savedAt:e.savedAt})); },
  stats()        { const e=Object.values(dbGet()); return {total:e.length,generated:e.filter(x=>x.status==='generated').length,delivered:e.filter(x=>x.status==='delivered').length}; },
  clear()        { dbSet({}); log.warn('DB','EssaysDB limpo'); },
};

/* Backup */
function makeBackup() {
  flushSync();
  const ts   = new Date().toISOString().replace(/[:.]/g,'-')+'-'+Date.now();
  const bDir = path.join(BACKUP_DIR, ts);
  try {
    fs.mkdirSync(bDir,{recursive:true});
    if (fs.existsSync(ESSAYS_FILE)) fs.copyFileSync(ESSAYS_FILE, path.join(bDir,'essays_db.json'));
    log.ok('BACKUP','Backup: '+bDir);
    const dirs = fs.readdirSync(BACKUP_DIR).sort();
    if (dirs.length>200) dirs.slice(0,dirs.length-200).forEach(d=>{try{fs.rmSync(path.join(BACKUP_DIR,d),{recursive:true});}catch(_){}});
  } catch(e) { log.error('BACKUP','Erro: '+e.message); }
}
const _backupInterval = setInterval(makeBackup, (CFG.database?.backup_interval_minutes||60)*60*1000);

/* ═══════════════════════════════════════════════════════════════════════════
   HTTP HELPER
═══════════════════════════════════════════════════════════════════════════ */
function httpRequest(url, method='GET', headers={}, body=null, timeoutMs=25000, _redirects=0) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch(e) { return reject(new Error('URL invalida: '+url)); }
    const isHttps = parsed.protocol === 'https:';
    const lib     = isHttps ? https : http;
    const buf     = body ? Buffer.from(JSON.stringify(body),'utf8') : null;
    const opts    = {
      hostname: parsed.hostname, port: parsed.port||(isHttps?443:80),
      path: parsed.pathname+parsed.search, method,
      headers: {
        'Accept': 'application/json',
        ...(buf ? {'Content-Type':'application/json','Content-Length':buf.length} : {}),
        ...headers,
      },
      timeout: timeoutMs,
    };
    const req = lib.request(opts, res => {
      if ([301,302,307,308].includes(res.statusCode) && res.headers.location) {
        if (_redirects >= 10) return reject(new Error(`Redirect loop em: ${url}`));
        const nu = res.headers.location.startsWith('http') ? res.headers.location : `${parsed.protocol}//${parsed.host}${res.headers.location}`;
        return httpRequest(nu,method,headers,body,timeoutMs,_redirects+1).then(resolve,reject);
      }
      const chunks=[];
      res.on('data',c=>chunks.push(c));
      res.on('end',()=>{
        const raw=Buffer.concat(chunks).toString('utf8'); let b=null;
        try{b=JSON.parse(raw);}catch(_){}
        resolve({status:res.statusCode,headers:res.headers,body:b,raw});
      });
    });
    req.on('timeout',()=>{req.destroy();reject(new Error(`Timeout (${timeoutMs}ms): ${url}`));});
    req.on('error',reject);
    if(buf) req.write(buf);
    req.end();
  });
}
async function httpRetry(url,method,headers,body,timeoutMs,maxRetries=3,baseDelay=1000) {
  let lastErr;
  for (let a=0;a<=maxRetries;a++) {
    if (a>0) {
      const d=Math.min(baseDelay*Math.pow(2,a-1),16000);
      log.warn('NET',`Retry ${a}/${maxRetries} em ${d}ms`);
      await sleep(d);
    }
    try {
      const r=await httpRequest(url,method,headers,body,timeoutMs);
      if (r.status===429) { const w=parseInt(r.headers?.['retry-after']||'5')*1000; await sleep(w); continue; }
      return r;
    } catch(e) { lastErr=e; log.warn('NET',`Tentativa ${a+1}: ${e.message}`); }
  }
  throw lastErr||new Error('Todas as tentativas falharam');
}
function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

/* ═══════════════════════════════════════════════════════════════════════════
   DUAL AI ENGINE
═══════════════════════════════════════════════════════════════════════════ */
const aiStatus = {scrapper1:'unknown',scrapper2:'unknown'};

async function callAI1(prompt) {
  log.info('AI1',`Prompt ${prompt.length} chars → Scrapper1`);
  try {
    const r = await httpRetry(AI1_URL,'POST',{},{message:prompt},CFG.ai.scrapper1.timeout_ms||22000,2);
    const t = r.body?.response||r.body?.reply||r.body?.message||r.body?.text||r.body?.content||'';
    if (t) { log.ok('AI1',`OK ${t.length} chars`); aiStatus.scrapper1='online'; return t; }
    log.warn('AI1',`HTTP ${r.status} — vazio`);
  } catch(e) { log.error('AI1',e.message); }
  aiStatus.scrapper1='offline'; return '';
}
async function callAI2(prompt) {
  log.info('AI2','Scrapper2');
  try {
    const r = await httpRetry(AI2_URL,'POST',{},{message:prompt},CFG.ai.scrapper2.timeout_ms||20000,2);
    const t = r.body?.reply||r.body?.response||r.body?.message||r.body?.text||r.body?.content||'';
    if (t) { log.ok('AI2',`OK ${t.length} chars`); aiStatus.scrapper2='online'; return t; }
    log.warn('AI2',`HTTP ${r.status} — vazio`);
  } catch(e) { log.warn('AI2',e.message); }
  aiStatus.scrapper2='offline'; return '';
}
async function callAI(prompt) {
  log.info('SYS','=== Dual AI ===');
  const ai1P = callAI1(prompt);
  const ai2P = callAI2(prompt);

  const winner = await Promise.race([
    ai1P.then(t=>({text:t,source:'scrapper1'})),
    ai2P.then(t=>({text:t,source:'scrapper2'})),
    new Promise(r=>setTimeout(()=>r(null),12000)),
  ]);

  if (winner && winner.text) {
    const otherP = winner.source === 'scrapper1' ? ai2P : ai1P;
    const otherText = await Promise.race([otherP, new Promise(r=>setTimeout(()=>r(null),2000))]);
    if (otherText && otherText.length > winner.text.length) {
      const otherSource = winner.source === 'scrapper1' ? 'scrapper2' : 'scrapper1';
      log.info('SYS',`Escolhido ${otherSource} por maior resposta (${otherText.length} chars)`);
      return {text:otherText,source:otherSource};
    }
    return winner;
  }

  log.warn('SYS','AI1 lenta (>12s) → aguardando ambas as IAs');
  const [r1, r2] = await Promise.all([ai1P, ai2P]);
  const candidates = [
    {text:r1,source:'scrapper1'},
    {text:r2,source:'scrapper2'},
  ].filter(c=>c.text && c.text.trim().length > 0);
  if (candidates.length) {
    candidates.sort((a,b)=>b.text.length - a.text.length);
    log.info('SYS',`Escolhido ${candidates[0].source} por maior resposta (${candidates[0].text.length} chars)`);
    return candidates[0];
  }

  log.error('SYS','Ambos falharam');
  return {text:'',source:'none'};
}
async function healthCheck() {
  const p='Responda apenas: OK';
  try { const r=await httpRequest(AI1_URL,'POST',{},{message:p},7000); aiStatus.scrapper1=(r.body?.response||r.body?.reply||r.body?.message)?'online':'offline'; } catch(_){aiStatus.scrapper1='offline';}
  try { const r=await httpRequest(AI2_URL,'POST',{},{message:p},7000); aiStatus.scrapper2=(r.body?.reply||r.body?.response||r.body?.message||r.body?.content)?'online':'offline'; } catch(_){aiStatus.scrapper2='offline';}
  log.info('SYS',`AI: S1=${aiStatus.scrapper1} S2=${aiStatus.scrapper2}`);
}
healthCheck();
const _healthInterval = setInterval(healthCheck, 5*60*1000);

/* ═══════════════════════════════════════════════════════════════════════════
   HEADERS PARA SED E EDUSP (sem proxy)
═══════════════════════════════════════════════════════════════════════════ */
function buildSedHeaders(captchaToken) {
  const rid = crypto.randomBytes(16).toString('hex');
  const spn = crypto.randomBytes(8).toString('hex');
  return {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'pt-BR,pt;q=0.7',
    'Content-Type': 'application/json',
    'Ocp-Apim-Subscription-Key': SED_OCP_KEY,
    'Origin': 'https://saladofuturo.educacao.sp.gov.br',
    'Referer': 'https://saladofuturo.educacao.sp.gov.br/',
    'Request-Id': `|${rid}.${spn}`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    'X-Captcha-Token': captchaToken,
    'X-Product-Name': 'SalaDoFuturo',
    'sec-ch-ua': '"Chromium";v="148", "Brave";v="148", "Not/A)Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'traceparent': `00-${rid}-${spn}-01`,
  };
}

function buildEduspHeaders(token) {
  const rid = crypto.randomBytes(16).toString('hex');
  const spn = crypto.randomBytes(8).toString('hex');
  const headers = {
    'accept': 'application/json',
    'accept-language': 'pt-BR,pt;q=0.7',
    'content-type': 'application/json',
    'origin': 'https://saladofuturo.educacao.sp.gov.br',
    'referer': 'https://saladofuturo.educacao.sp.gov.br/',
    'request-id': `|${rid}.${spn}`,
    'traceparent': `00-${rid}-${spn}-01`,
    'x-api-platform': 'webclient',
    'x-api-realm': 'edusp',
    'sec-ch-ua': '"Chromium";v="148", "Brave";v="148", "Not/A)Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  };
  if (token) headers['x-api-key'] = token;
  return headers;
}

/* ─── CAPTCHA FAKE ──────────────────────────────────────────────────────── */
async function getCaptchaToken() {
  const fakeToken = crypto.randomUUID().replace(/-/g, '');
  log.info('AUTH', `Token CAPTCHA fake gerado: ${fakeToken.slice(0,8)}...`);
  return fakeToken;
}

/* ─── LOGIN DIRETO (sem proxy) ────────────────────────────────────────── */
async function sedLogin(ra, senha) {
  const captchaToken = await getCaptchaToken();
  log.info('AUTH', `Captcha fake OK — SED login: ${ra}`);

  const sedHeaders = buildSedHeaders(captchaToken);
  const w = await httpRequest(
    SED_URL,
    'POST',
    sedHeaders,
    { user: ra, senha },
    20000
  );
  log.info('AUTH', `SED resp HTTP ${w.status}: ${JSON.stringify(w.body).slice(0,200)}`);
  const sedTok = (w.body?.token || '').trim();
  if (!sedTok) {
    const msg = w.body?.message || w.body?.error || w.body?.title || `HTTP ${w.status}`;
    throw new Error(`SED login falhou — ${msg}`);
  }
  log.ok('AUTH', 'SED token OK');

  const eduspHeaders = buildEduspHeaders(); // sem token ainda
  const e = await httpRequest(
    `${EDUSP}/registration/edusp/token`,
    'POST',
    eduspHeaders,
    { token: sedTok },
    20000
  );
  log.info('AUTH', `EDUSP token resp HTTP ${e.status}: ${JSON.stringify(e.body).slice(0,200)}`);
  const auth = (e.body?.auth_token || '').trim();
  if (!auth) {
    const msg = e.body?.message || e.body?.error || `HTTP ${e.status}`;
    throw new Error(`EDUSP token não retornado — ${msg}`);
  }
  const nick = e.body?.nick || e.body?.nickname || e.body?.login || ra;
  log.ok('AUTH', `EDUSP auth_token OK — nick: ${nick}`);
  return { auth, nick, sedTok };
}

/* ═══════════════════════════════════════════════════════════════════════════
   ESSAY ENGINE — funções essenciais (prompts, geração, submissão)
═══════════════════════════════════════════════════════════════════════════ */
function cleanHtml(h) {
  return (h||'').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&')
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'")
    .replace(/\s{2,}/g,' ').trim();
}

function wc(text) { return String(text||'').split(/\s+/).filter(Boolean).length; }

function getEssayContext(task) {
  const q      = (task.questions||[]).find(q=>q.type==='essay')||task.questions?.[0]||{};
  const opts   = q.options||{};
  const genre  = opts.genre||{};
  const title  = cleanHtml(task.title||'Redação').slice(0,120);
  const stmt   = cleanHtml(q.statement||opts.statement||'').slice(0,5000);
  const support= cleanHtml(opts.support_text||'').slice(0,3000);
  const minWords = opts.min_word_count || genre.min_word || 0;
  const maxWords = opts.max_word_count || genre.max_word || 0;
  const skills = (opts.assessed_skills||[]).map(s=>{
    const desc = (s.description||'').replace(/#[^\n]+\n?/g,'').trim();
    return `• ${s.statement}:\n${desc.slice(0,600)}`;
  }).join('\n\n').slice(0,3000);
  let tipo = 'dissertativo-argumentativo';
  const stmtLower = (stmt+' '+title+' '+(genre.statement||genre.name||'')).toLowerCase();
  if (/crônica|cronica/.test(stmtLower)) tipo = 'crônica';
  else if (/carta/.test(stmtLower)) tipo = 'carta argumentativa';
  else if (/artigo de opini/.test(stmtLower)) tipo = 'artigo de opinião';
  else if (/conto|narrativ/.test(stmtLower)) tipo = 'conto/narrativa';
  else if (/poema|poesia/.test(stmtLower)) tipo = 'poema';
  else if (/relatório|relatorio/.test(stmtLower)) tipo = 'relatório';
  return {title, stmt, support, tipo, minWords, maxWords, skills};
}

function studentHeader(tipo) {
  const estilos = {
    'crônica': [
      '  • Tom narrativo com leveza e ironia suave, observando o cotidiano',
      '  • Mistura de narração + reflexão pessoal — como se estivesse contando uma história real',
    ],
    'carta argumentativa': [
      '  • Dirige-se a um destinatário claro (ex.: autoridade, sociedade, empresa)',
      '  • Tom respeitoso mas firme, com argumentos concretos e bem encadeados',
    ],
    'artigo de opinião': [
      '  • Tom assertivo e analítico, com posição clara desde a introdução',
      '  • Argumentos embasados em fatos, dados ou exemplos verificáveis',
    ],
    'conto/narrativa': [
      '  • Narrador definido (1ª ou 3ª pessoa), ambiente e personagens apresentados',
      '  • Conflito central claro, com desenvolvimento e desfecho',
    ],
    'dissertativo-argumentativo': [
      '  • Estrutura clássica: tese → argumentos → proposta de intervenção',
      '  • Cada parágrafo com um argumento único, apoiado por exemplo ou dado',
    ],
  };
  const estiloLinhas = estilos[tipo] || estilos['dissertativo-argumentativo'];
  return [
    '╔══════════════════════════════════════════════════════════════╗',
    '║                  QUEM VOCÊ É                                ║',
    '╚══════════════════════════════════════════════════════════════╝',
    '',
    'Você é um estudante do 1º ano do Ensino Médio da rede estadual de São Paulo.',
    'Tem 15-16 anos, mora em São Paulo, usa transporte público, acompanha notícias pelo celular.',
    'Você escreve bem — não é um gênio literário, mas é um aluno dedicado que:',
    '  • Usa vocabulário culto mas acessível, sem rebuscamento desnecessário',
    '  • Constrói frases variadas: longas para argumentar, curtas para impactar',
    '  • Fundamenta opiniões com exemplos reais: notícias, situações cotidianas,',
    '    dados que aprendeu na escola ou viu na mídia',
    '  • Conecta ideias com coesão — nunca deixa um parágrafo solto sem transição',
    `Tipo de texto que você vai escrever: ${tipo.toUpperCase()}`,
    'Características desse tipo:',
    ...estiloLinhas,
    '',
  ].join('\n');
}

function buildHalfPrompt(task, half) {
  const {title, stmt, support, tipo, minWords, maxWords, skills} = getEssayContext(task);
  const lines = [studentHeader(tipo)];
  lines.push('╔══════════════════════════════════════════════════════════════╗');
  lines.push('║                    PROPOSTA DE REDAÇÃO                      ║');
  lines.push('╚══════════════════════════════════════════════════════════════╝');
  lines.push('');
  lines.push(`Tema: "${title}"`);
  lines.push(`Gênero textual: ${tipo}`);
  if (minWords||maxWords) {
    const wMin = minWords ? `mínimo ${minWords}` : '';
    const wMax = maxWords ? `máximo ${maxWords}` : '';
    lines.push(`Extensão: ${[wMin,wMax].filter(Boolean).join(' — ')} palavras`);
  }
  lines.push('');
  if (support) { lines.push('── Texto de Apoio ──'); lines.push(support); lines.push(''); }
  if (stmt) { lines.push('── Enunciado / Proposta ──'); lines.push(stmt); lines.push(''); }
  if (skills) { lines.push('── Critérios de avaliação ──'); lines.push(skills); lines.push(''); }
  lines.push('╔══════════════════════════════════════════════════════════════╗');
  if (half === 1) {
    lines.push('║           SUA TAREFA — PRIMEIRA PARTE DA REDAÇÃO            ║');
    lines.push('╚══════════════════════════════════════════════════════════════╝');
    lines.push('Escreva a PRIMEIRA PARTE da redação (título + introdução + primeiro desenvolvimento).');
    lines.push('⚠ NÃO escreva conclusão. Pare após o primeiro parágrafo de desenvolvimento.');
  } else {
    lines.push('║           SUA TAREFA — SEGUNDA PARTE DA REDAÇÃO             ║');
    lines.push('╚══════════════════════════════════════════════════════════════╝');
    lines.push('Escreva a SEGUNDA PARTE da redação, continuando de onde a primeira parou.');
    lines.push('⚠ NÃO escreva título. Comece diretamente com o próximo parágrafo.');
  }
  lines.push('');
  lines.push('Regras: parágrafos LONGOS, linguagem culta, responda à proposta, retorne SOMENTE o texto.');
  lines.push('Escreva agora:');
  return lines.join('\n');
}

function buildFullPrompt(task) {
  const {title, stmt, support, tipo, minWords, maxWords, skills} = getEssayContext(task);
  const lines = [studentHeader(tipo)];
  lines.push('╔══════════════════════════════════════════════════════════════╗');
  lines.push('║                    PROPOSTA DE REDAÇÃO                      ║');
  lines.push('╚══════════════════════════════════════════════════════════════╝');
  lines.push('');
  lines.push(`Tema: "${title}"`);
  lines.push(`Gênero textual: ${tipo}`);
  if (minWords||maxWords) {
    const wMin = minWords ? `mínimo ${minWords}` : '';
    const wMax = maxWords ? `máximo ${maxWords}` : '';
    lines.push(`Extensão: ${[wMin,wMax].filter(Boolean).join(' — ')} palavras`);
  }
  lines.push('');
  if (support) { lines.push('── Texto de Apoio ──'); lines.push(support); lines.push(''); }
  if (stmt) { lines.push('── Enunciado / Proposta ──'); lines.push(stmt); lines.push(''); }
  if (skills) { lines.push('── Critérios de avaliação ──'); lines.push(skills); lines.push(''); }
  lines.push('╔══════════════════════════════════════════════════════════════╗');
  lines.push('║               SUA TAREFA — REDAÇÃO COMPLETA                 ║');
  lines.push('╚══════════════════════════════════════════════════════════════╝');
  lines.push('Escreva uma redação COMPLETA, com título, introdução, desenvolvimento (2 a 3 parágrafos) e conclusão.');
  lines.push('Regras: parágrafos LONGOS, linguagem culta, retorne APENAS o texto.');
  lines.push('Escreva agora:');
  return lines.join('\n');
}

function normalizeEssayText(text) {
  return String(text||'').trim()
    .replace(/^```[\w]*\n?/gm, '').replace(/\n?```/g, '')
    .replace(/^#{1,6}\s*/gm, '').replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
    .replace(/^(título|title|redação|texto):?\s*/gim, '')
    .replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n')
    .replace(/[^\S\n]{2,}/g, ' ').trim();
}

function extractTitle(text) {
  const norm = text.trim();
  const paras = norm.split(/\n\n+/);
  const firstPara = (paras[0]||'').trim();
  const firstLine = firstPara.split('\n')[0].trim();
  const isTitleLike = firstLine.length > 0 && wc(firstLine) <= 12 && !/\.{1}$/.test(firstLine) && paras.length > 1;
  if (isTitleLike) {
    const restOfFirst = firstPara.split('\n').slice(1).join('\n').trim();
    const body = [restOfFirst, ...paras.slice(1)].filter(Boolean).join('\n\n');
    return {title: firstLine, body: body.trim()};
  }
  return {title: null, body: norm};
}

function mergeHalves(half1, half2) {
  const {title, body: body1} = extractTitle(half1);
  const {body: body2raw} = extractTitle(half2);
  let body2 = body2raw.trim();
  const lastSentence = body1.trim().split(/[.!?]\s+/).filter(Boolean).pop()||'';
  if (lastSentence.length > 20 && body2.startsWith(lastSentence.slice(0,30))) {
    body2 = body2.slice(lastSentence.length).trimStart();
  }
  const parts = [body1.trim(), body2].filter(Boolean);
  const bodyMerged = parts.join('\n\n');
  const full = title ? `${title}\n\n${bodyMerged}` : bodyMerged;
  return normalizeEssayText(full);
}

function pickBestParagraphs(textA, textB) {
  const {title: titleA, body: bodyA} = extractTitle(textA);
  const {title: titleB, body: bodyB} = extractTitle(textB);
  const bestTitle = (titleA && titleB) ? (wc(titleA) >= wc(titleB) ? titleA : titleB) : (titleA || titleB || null);
  const parasA = bodyA.split(/\n\n+/).filter(p=>p.trim().length>30);
  const parasB = bodyB.split(/\n\n+/).filter(p=>p.trim().length>30);
  const len = Math.max(parasA.length, parasB.length);
  const chosen = [];
  for (let i=0; i<len; i++) {
    const a = (parasA[i]||'').trim();
    const b = (parasB[i]||'').trim();
    if (!a && !b) continue;
    if (!a) { chosen.push(b); continue; }
    if (!b) { chosen.push(a); continue; }
    const margin = i === len-1 ? 10 : 15;
    const pick = wc(b) > wc(a) + margin ? b : a;
    chosen.push(pick);
  }
  const body = chosen.join('\n\n');
  return bestTitle ? `${bestTitle}\n\n${body}` : body;
}

async function generateEssayText(task) {
  const {title: taskTitle, tipo} = getEssayContext(task);
  log.info('ESSAY', `Estratégia dupla: AI1→metade1 | AI2→metade2 | tipo=${tipo}`);

  const prompt1 = buildHalfPrompt(task, 1);
  const prompt2 = buildHalfPrompt(task, 2);
  const [res1, res2] = await Promise.allSettled([
    callAI1(prompt1),
    callAI2(prompt2),
  ]);
  const getText = (res, label) => {
    if (res.status==='rejected') { log.warn('ESSAY',`${label} falhou: ${res.reason?.message}`); return ''; }
    return normalizeEssayText(res.value||'');
  };
  let half1 = getText(res1, 'AI1-metade1');
  let half2 = getText(res2, 'AI2-metade2');
  log.info('ESSAY', `Metade1=${wc(half1)}p Metade2=${wc(half2)}p`);

  if (!half1 || wc(half1) < 50) {
    log.warn('ESSAY','Metade1 inválida → AI2 refaz');
    try { half1 = normalizeEssayText(await callAI2(prompt1)); } catch(_){}
  }
  if (!half2 || wc(half2) < 50) {
    log.warn('ESSAY','Metade2 inválida → AI1 refaz');
    try { half2 = normalizeEssayText(await callAI1(prompt2)); } catch(_){}
  }

  let merged = '';
  if (half1 && half2) {
    merged = mergeHalves(half1, half2);
    log.ok('ESSAY', `Etapa 3 — merge: ${wc(merged)} palavras`);
  } else if (half1) {
    merged = normalizeEssayText(half1);
  } else if (half2) {
    merged = normalizeEssayText(half2);
  }

  if (merged && wc(merged) >= 300) {
    const {title, body} = extractTitle(merged);
    if (!title) merged = `${taskTitle}\n\n${merged}`;
    log.ok('ESSAY', `Final merge: "${extractTitle(merged).title||taskTitle}" — ${wc(merged)} palavras ✓`);
    return merged;
  }

  log.warn('ESSAY', `Merge insuficiente (${wc(merged)} palavras) — fallback texto completo`);
  const promptFull = buildFullPrompt(task);
  const [fa, fb] = await Promise.allSettled([
    callAI1(promptFull),
    callAI2(promptFull),
  ]);
  const ta = normalizeEssayText((fa.status==='fulfilled'?fa.value:'')||'');
  const tb = normalizeEssayText((fb.status==='fulfilled'?fb.value:'')||'');
  log.info('ESSAY', `Fallback AI1=${wc(ta)}p AI2=${wc(tb)}p`);
  let best = '';
  if (ta && tb) {
    best = pickBestParagraphs(ta, tb);
  } else if (ta) best = ta;
  else if (tb) best = tb;
  else if (merged) best = merged;
  if (!best || wc(best) < 10) throw new Error('IA não gerou texto válido');
  const {title: ft} = extractTitle(best);
  if (!ft) best = `${taskTitle}\n\n${best}`;
  return normalizeEssayText(best);
}

async function processOneEssay(sess, taskId, waitSeconds, mode) {
  const tid = String(taskId);
  log.info('ESSAY',`━━━ Redação ${tid} ━━━`);

  // Apply
  let applied = null;
  try {
    const r = await httpRetry(`${EDUSP}/tms/task/${taskId}/apply?preview_mode=false&token_code=null`,'GET',buildEduspHeaders(sess.auth),null,15000,1);
    if (r.status===200) { applied={data:r.body,slug:'',taskToken:r.body?.token||r.body?.task_token||null}; log.ok('ESSAY','Apply OK (sem slug)'); }
  } catch(_){}
  if (!applied) {
    for (const slug of sess.slugs) {
      try {
        const url=`${EDUSP}/tms/task/${taskId}/apply?preview_mode=false&token_code=null&room_name=${encodeURIComponent(slug)}`;
        let r=await httpRequest(url,'GET',buildEduspHeaders(sess.auth),null,15000);
        if (r.status===403) { const ok=await renewAuth(sess); if(ok) r=await httpRequest(url,'GET',buildEduspHeaders(sess.auth),null,15000); }
        if (r.status===200) { applied={data:r.body,slug,taskToken:r.body?.token||r.body?.task_token||null}; log.ok('ESSAY',`Apply OK slug=${slug}`); break; }
      } catch(e) { log.warn('ESSAY',`slug=${slug}: ${e.message}`); }
    }
  }
  if (!applied) { log.error('ESSAY',`Apply falhou — ${tid}`); return {taskId,ok:false,msg:'Apply falhou em todos os slugs'}; }

  const {data:taskData,slug:usedSlug,taskToken} = applied;
  const taskTitle  = taskData.title||tid;
  const answerId   = taskData.answer?.id||taskData.answer?.answer_id||taskData.answer_id||null;
  const essayQ     = (taskData.questions||[]).find(q=>q.type==='essay');
  const questionId = essayQ?.id??null;
  log.info('ESSAY',`"${taskTitle}" qid=${questionId} answerId=${answerId}`);

  // Gera texto (cache)
  const cached  = EssaysDB.get(taskId);
  const isDraft = taskData.answer?.status === 'draft';
  let essayText;
  if (cached?.text && cached.status!=='delivered' && !isDraft) {
    essayText = cached.text;
    log.ok('DB',`Cache: "${taskTitle}" (${cached.wordCount} palavras)`);
  } else {
    if (isDraft) log.info('ESSAY',`Rascunho "${taskTitle}" — gerando texto novo (cache ignorado)`);
    try {
      essayText = await generateEssayText(taskData);
      EssaysDB.save(taskId, taskTitle, essayText, 'generated');
    } catch(e) {
      log.error('ESSAY','Falha IA: '+e.message);
      return {taskId,taskTitle,ok:false,msg:'IA falhou: '+e.message};
    }
  }

  // Delay
  const ws = Math.max(0, Number(waitSeconds)||0);
  if (ws > 0) { log.info('ESSAY',`Aguardando ${ws}s...`); await sleep(ws*1000); }
  await proactiveRenewIfNeeded(sess);

  // Payload
  const normText   = normalizeEssayText(essayText||'');
  const {title: extTitle, body: extBody} = extractTitle(normText);
  const sendTitle  = extTitle || taskTitle;
  const sendBody   = extBody  || normText;
  const answerEntry = {
    question_id:   questionId,
    question_type: 'essay',
    answer: { title: sendTitle, body: sendBody },
  };
  const answers = questionId!==null
    ? {[String(questionId)]:answerEntry}
    : {'0':{...answerEntry,question_id:0}};
  const status   = mode==='draft' ? 'draft' : 'submitted';
  const duration = Math.round((ws + 20 + Math.random()*10)*100)/100;
  const execOn   = usedSlug||(sess.slugs[0]||'');
  const payload  = {status,answers,accessed_on:'room',executed_on:execOn,duration};
  if (taskToken && taskData?.enable_token) payload.token = taskToken;

  log.info('ESSAY',`Enviando "${taskTitle}" modo=${status} palavras=${essayText.split(/\s+/).filter(Boolean).length}`);

  // Submit
  const doSubmit = async () => {
    if (answerId) {
      let r=await httpRetry(`${EDUSP}/tms/task/${taskId}/answer/${answerId}`,'PUT',buildEduspHeaders(sess.auth),payload,25000,2);
      if (r.status===404||r.status===422) { log.warn('ESSAY',`answerId ${answerId} inválido → POST`); r=await httpRetry(`${EDUSP}/tms/task/${taskId}/answer`,'POST',buildEduspHeaders(sess.auth),payload,25000,2); }
      return r;
    }
    return httpRetry(`${EDUSP}/tms/task/${taskId}/answer`,'POST',buildEduspHeaders(sess.auth),payload,25000,2);
  };

  try {
    let r = await doSubmit();
    if (r.status===400 && typeof r.raw==='string' && r.raw.includes('"executed_on"')) {
      log.warn('ESSAY','executed_on inválido — retry'); payload.executed_on=''; r=await doSubmit();
    }
    if (r.status===403||(r.status===400&&Array.isArray(r.body?.errors)&&r.body.errors.some(e=>e.field==='token'))) {
      log.warn('ESSAY','Token expirado no submit'); const ok=await renewAuth(sess); if(ok){await sleep(400);r=await doSubmit();}
    }
    const httpOk = r.status===200||r.status===201||r.status===204;
    const bodyConfirmed = !httpOk ? false :
      (r.status===204) ? true :
      !!(r.body?.id || r.body?.answer_id || r.body?.status || r.body?.success===true || r.body?.ok===true);
    const ok  = bodyConfirmed;
    const msg = ok ? 'Entregue' :
      httpOk ? `HTTP ${r.status} sem confirmacao no body — raw: ${String(r.raw||'').slice(0,80)}` :
      (r.body?.message||r.raw?.slice(0,120)||`HTTP ${r.status}`);
    if (ok)      { log.ok('ESSAY',`OK "${taskTitle}" (HTTP ${r.status})`); EssaysDB.markDelivered(taskId); }
    else if (httpOk) { log.warn('ESSAY',`HTTP ${r.status} sem confirmacao: ${msg}`); }
    else         { log.error('ESSAY',`FALHOU "${taskTitle}": ${msg}`); }
    return {taskId,taskTitle,ok,msg,httpStatus:r.status,wordCount:essayText.split(/\s+/).filter(Boolean).length,preview:essayText.slice(0,120)+(essayText.length>120?'...':'')};
  } catch(e) {
    log.error('ESSAY','Submit exception: '+e.message);
    return {taskId,taskTitle,ok:false,msg:e.message};
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   SESSION STORE
═══════════════════════════════════════════════════════════════════════════ */
const sessions = new Map();
function makeSessionId() { return crypto.randomBytes(24).toString('hex'); }

async function renewAuth(sess) {
  if (sess._renewPromise) { log.info('AUTH',`Aguardando renovação...`); return sess._renewPromise; }
  sess._renewPromise = (async()=>{
    log.info('AUTH',`Renovando ${sess.ra}...`);
    try {
      const {auth} = await sedLogin(sess.ra, sess._pw);
      sess.auth = auth;
      sess._tokenRenewedAt = Date.now();
      log.ok('AUTH','Token renovado');
      return true;
    } catch(e){log.error('AUTH','Renewal: '+e.message);return false;}
    finally{sess._renewPromise=null;}
  })();
  return sess._renewPromise;
}
async function proactiveRenewIfNeeded(sess) {
  const age=Date.now()-(sess._tokenRenewedAt||sess.createdAt||0);
  if (age>45*60*1000){log.info('AUTH',`Token ${Math.round(age/60000)}min — renovação proativa`);await renewAuth(sess);}
}

/* TTL sessão */
setInterval(()=>{
  const now=Date.now(); let r=0;
  for(const[id,s]of sessions.entries())if(now-(s.createdAt||0)>6*60*60*1000){sessions.delete(id);r++;}
  if(r) log.info('AUTH',`Sessões expiradas: ${r}`);
},30*60*1000);

/* Rate limit login */
const loginAttempts=new Map();
function checkLoginRate(ip){
  const now=Date.now(),e=loginAttempts.get(ip);
  if(!e||now-e.first>15*60*1000){loginAttempts.set(ip,{count:1,first:now});return true;}
  e.count++; return e.count<=10;
}
setInterval(()=>{const now=Date.now();for(const[ip,e]of loginAttempts.entries())if(now-e.first>15*60*1000)loginAttempts.delete(ip);},30*60*1000);

function processRooms(sess, body) {
  const rooms=body?.rooms||(Array.isArray(body)?body:[]);
  const targets=[],slugs=[],seen=new Set();
  const add=v=>{const s=String(v);if(!seen.has(s)){seen.add(s);targets.push(s);}};
  for(const room of rooms){
    if(typeof room==='string'){add(room);continue;}
    const inner=(typeof room.room==='object'&&room.room)?room.room:{};
    const rname=room.name||room.room_name||room.code||inner.room_name||inner.name||'';
    const rid=room.id||inner.id;
    if(rname){add(rname);if(/^r[0-9a-f]+-l$/i.test(rname))slugs.push(rname);}
    if(rid!=null) add(rid);
    for(const gc of(room.group_categories||[]))if(gc?.id!=null)add(gc.id);
    for(const fk of['publication_id','class_id','group_id','category_id']){const fv=room[fk]||inner[fk];if(fv!=null)add(fv);}
  }
  sess.targets=targets; sess.slugs=slugs;
  log.ok('PROXY',`${targets.length} targets, ${slugs.length} slugs`);
}

/* Avatar Discord */
let _avatarUrl = 'https://cdn.discordapp.com/embed/avatars/0.png';
(async()=>{
  if (!DISCORD_TOKEN) return;
  try {
    const r=await httpRequest('https://discord.com/api/v10/users/@me','GET',{'Authorization':DISCORD_TOKEN,'User-Agent':'DiscordBot (RedasP, 1.0)'},null,8000);
    if(r.status===200&&r.body?.avatar&&r.body?.id)
      _avatarUrl=`https://cdn.discordapp.com/avatars/${r.body.id}/${r.body.avatar}.png?size=128`;
  } catch(_){}
})();

/* ═══════════════════════════════════════════════════════════════════════════
   EXPRESS ROTAS
═══════════════════════════════════════════════════════════════════════════ */
const app = express();
app.use(express.json({limit:'2mb'}));
app.get('/config.json', (_req,res) => res.status(403).end());
app.use(express.static(__dirname));
app.get('/', (_req,res) => res.sendFile(path.join(__dirname,'redasp.html')));

app.get('/api/avatar', (_req,res) => res.json({url:_avatarUrl,owner:CFG.owner?.name}));

app.get('/api/status', (_req,res) => res.json({
  scrapper1:  aiStatus.scrapper1,
  scrapper2:  aiStatus.scrapper2,
  essays_db:  EssaysDB.stats(),
  uptime:     Math.round(process.uptime()),
}));

/* ─── ROTA LOGIN ──────────────────────────────────────────────────────── */
app.post('/api/login', async(req,res)=>{
  const {ra,senha}=req.body;
  if(!ra||!senha) return res.status(400).json({error:'RA e senha obrigatórios'});
  const ip=req.ip||req.socket?.remoteAddress||'unknown';
  if(!checkLoginRate(ip)) return res.status(429).json({error:'Muitas tentativas. Aguarde 15 min.'});
  log.info('AUTH',`Login: ${ra}`);
  try {
    const {auth, nick: loginNick} = await sedLogin(ra, senha);
    const nick = loginNick || ra;
    const sessionId=makeSessionId();
    sessions.set(sessionId,{ra,nick,auth,targets:[],slugs:[],_pw:senha,createdAt:Date.now(),_tokenRenewedAt:Date.now()});
    log.ok('AUTH',`Autenticado: ${nick}`);
    // Carrega rooms automaticamente
    try {
      const rr=await httpRetry(`${EDUSP}/room/user?list_all=true&with_cards=true`,'GET',buildEduspHeaders(auth),null,15000,2);
      if(rr.status===200) processRooms(sessions.get(sessionId),rr.body);
    } catch(_){log.warn('AUTH','Rooms não carregados no login');}
    res.json({sessionId,nick,ra});
  } catch(e){log.error('AUTH',e.message);res.status(500).json({error:e.message});}
});

app.post('/api/logout', (req,res)=>{sessions.delete(req.body.sessionId);res.json({ok:true});});

/* ─── ROTA ESSAYS ────────────────────────────────────────────────────── */
app.post('/api/essays', async(req,res)=>{
  const {sessionId}=req.body;
  const sess=sessions.get(sessionId);
  if(!sess) return res.status(401).json({error:'Sessão inválida'});
  log.info('PROXY',`Essays: ${sess.nick}`);
  try {
    const p=new URLSearchParams();
    p.append('expired_only','false');
    p.append('limit','100');
    p.append('offset','0');
    p.append('filter_expired','true');
    p.append('is_exam','false');
    p.append('with_answer','true');
    p.append('is_essay','true');
    p.append('answer_statuses','draft');
    p.append('answer_statuses','pending');
    p.append('with_apply_moment','true');
    for(const t of sess.targets) p.append('publication_target',t);
    let r=await httpRetry(`${EDUSP}/tms/task/todo?${p}`,'GET',buildEduspHeaders(sess.auth),null,20000,2);
    if(r.status===403){
      const ok=await renewAuth(sess);
      if(!ok) return res.json({tasks:[]});
      r=await httpRequest(`${EDUSP}/tms/task/todo?${p}`,'GET',buildEduspHeaders(sess.auth),null,20000);
      if(r.status!==200) return res.json({tasks:[]});
    }
    const tasks=Array.isArray(r.body)?r.body:(r.body?.tasks||r.body?.data||[]);
    log.ok('PROXY',`${tasks.length} redação(ões) (pending+draft+expired)`);
    const enriched=tasks.map(t=>{
      const c=EssaysDB.get(t.id||t.task_id);
      return {...t,_cached:c?{wordCount:c.wordCount,status:c.status}:null};
    });
    res.json({tasks:enriched});
  } catch(e){log.error('PROXY','essays: '+e.message);res.json({tasks:[]});}
});

/* ─── ROTA GENERATE-ESSAY ───────────────────────────────────────────── */
app.post('/api/generate-essay', async(req,res)=>{
  const {sessionId, taskData, forceFresh} = req.body;
  if(!sessions.has(sessionId)) return res.status(401).json({error:'Sessão inválida'});
  if(!taskData) return res.status(400).json({error:'taskData obrigatório'});
  const taskId    = String(taskData.id||taskData.task_id||'');
  const taskTitle = taskData.title||`Redação ${taskId}`;
  const isDraft   = taskData.answer?.status==='draft' || !!forceFresh;
  if(taskId && !isDraft){
    const cached=EssaysDB.get(taskId);
    if(cached?.text && cached.status!=='delivered'){
      log.ok('DB',`Cache hit: "${taskTitle}" (${cached.wordCount} palavras)`);
      return res.json({text:cached.text,wordCount:cached.wordCount,fromCache:true});
    }
  }
  if(isDraft) log.info('ESSAY',`Rascunho "${taskTitle}" — gerando texto novo (cache ignorado)`);
  try {
    const text=await generateEssayText(taskData);
    const wordCount=text.split(/\s+/).filter(Boolean).length;
    if(taskId) EssaysDB.save(taskId, taskTitle, text, 'generated');
    res.json({text,wordCount,fromCache:false});
  } catch(e){
    log.error('ESSAY','generate-essay: '+e.message);
    res.status(500).json({error:e.message});
  }
});

/* ─── ROTA SUBMIT ────────────────────────────────────────────────────── */
app.post('/api/submit', async(req,res)=>{
  const {sessionId, taskId, answerId, payload: rawPayload, usedSlug} = req.body;
  const sess=sessions.get(sessionId);
  if(!sess) return res.status(401).json({error:'Sessão inválida'});
  if(!taskId||!rawPayload) return res.status(400).json({error:'taskId e payload obrigatórios'});
  if(!/^\d+$/.test(String(taskId))) return res.status(400).json({error:'taskId inválido'});
  if(answerId!=null && !/^\d+$/.test(String(answerId))) return res.status(400).json({error:'answerId inválido'});
  await proactiveRenewIfNeeded(sess);
  const pay = {
    status:       ['draft','submitted'].includes(rawPayload.status) ? rawPayload.status : 'draft',
    answers:      rawPayload.answers,
    accessed_on:  'room',
    executed_on:  usedSlug || rawPayload.executed_on || '',
    duration:     Number(rawPayload.duration) || 30,
  };
  if(rawPayload.token) pay.token = rawPayload.token;

  const doSubmit=async()=>{
    if(answerId){
      let r=await httpRetry(`${EDUSP}/tms/task/${taskId}/answer/${answerId}`,'PUT',buildEduspHeaders(sess.auth),pay,25000,2);
      if(r.status===404||r.status===422) r=await httpRetry(`${EDUSP}/tms/task/${taskId}/answer`,'POST',buildEduspHeaders(sess.auth),pay,25000,2);
      return r;
    }
    return httpRetry(`${EDUSP}/tms/task/${taskId}/answer`,'POST',buildEduspHeaders(sess.auth),pay,25000,2);
  };

  try {
    let r=await doSubmit();
    if(r.status===400&&typeof r.raw==='string'&&r.raw.includes('"executed_on"')){
      pay.executed_on=''; r=await doSubmit();
    }
    if(r.status===403){const ok=await renewAuth(sess);if(ok){await sleep(400);r=await doSubmit();}}
    const httpOk=r.status===200||r.status===201||r.status===204;
    const ok=httpOk&&(r.status===204||!!(r.body?.id||r.body?.answer_id||r.body?.status||r.body?.success===true||r.body?.ok===true));
    const msg=ok?'Entregue':(r.body?.message||r.raw?.slice(0,120)||`HTTP ${r.status}`);
    if(ok) EssaysDB.markDelivered(taskId);
    log[ok?'ok':'error']('SUBMIT', `${taskId}: ${msg} (HTTP ${r.status})`);
    res.json({ok,httpStatus:r.status,msg});
  } catch(e){
    log.error('SUBMIT','submit: '+e.message);
    res.status(500).json({ok:false,error:e.message});
  }
});

/* ─── ROTA RUN ───────────────────────────────────────────────────────── */
app.post('/api/run', async(req,res)=>{
  const {sessionId,taskIds,waitSeconds,mode}=req.body;
  const sess=sessions.get(sessionId);
  if(!sess) return res.status(401).json({error:'Sessão inválida'});
  if(!taskIds?.length) return res.status(400).json({error:'Nenhuma redação selecionada'});

  const ws = Math.max(0, Number(waitSeconds)||0);
  const maxTotalMs = (ws + 120) * taskIds.length * 1000 + 60000;
  const HARD_CAP   = 25 * 60 * 1000;
  const timeoutMs  = Math.min(maxTotalMs, HARD_CAP);
  let   _timedOut  = false;
  const _deadline  = setTimeout(()=>{ _timedOut=true; }, timeoutMs);

  log.info('ESSAY',`=== ${taskIds.length} redação(ões) | modo=${mode} | delay=${ws}s | timeout=${Math.round(timeoutMs/1000)}s ===`);
  const results=[];
  for(const tid of taskIds){
    if(_timedOut){ results.push({taskId:tid,ok:false,msg:'Timeout total da operação'}); continue; }
    const r=await processOneEssay(sess,tid,ws,mode);
    results.push(r);
    if(results.length<taskIds.length && !_timedOut) await sleep(800);
  }
  clearTimeout(_deadline);
  const ok=results.filter(r=>r.ok).length;
  log.ok('ESSAY',`=== Fim: ${ok}/${results.length} entregue(s) ===`);
  if(!res.headersSent) res.json({results,summary:{ok,err:results.length-ok,total:results.length}});
});

/* ─── ROTAS DB ───────────────────────────────────────────────────────── */
app.post('/api/db', (req,res)=>{
  const sid=(req.body||{}).sessionId;
  if(!sid||!sessions.has(sid)) return res.status(401).json({error:'Sessão inválida'});
  res.json({essays:EssaysDB.list(),stats:EssaysDB.stats()});
});
app.delete('/api/db/:taskId', (req,res)=>{
  if(!req.body?.sessionId||!sessions.has(req.body.sessionId)) return res.status(401).json({error:'Sessão inválida'});
  EssaysDB.delete(req.params.taskId);
  res.json({ok:true});
});

/* ═══════════════════════════════════════════════════════════════════════════
   GRACEFUL SHUTDOWN
═══════════════════════════════════════════════════════════════════════════ */
function shutdown(sig) {
  log.warn('SYS',`${sig} — encerrando...`);
  clearInterval(_backupInterval);
  clearInterval(_healthInterval);
  flushSync();
  if (_logStream) try{_logStream.end();}catch(_){}
  process.exit(0);
}
process.on('SIGTERM',()=>shutdown('SIGTERM'));
process.on('SIGINT', ()=>shutdown('SIGINT'));

/* ═══════════════════════════════════════════════════════════════════════════
   START
═══════════════════════════════════════════════════════════════════════════ */
app.listen(PORT, ()=>{
  console.log('');
  console.log(`\x1b[36m  ██████╗ ███████╗██████╗  █████╗ ███████╗██████╗ \x1b[0m`);
  console.log(`\x1b[36m  ██╔══██╗██╔════╝██╔══██╗██╔══██╗██╔════╝██╔══██╗\x1b[0m`);
  console.log(`\x1b[36m  ██████╔╝█████╗  ██║  ██║███████║███████╗██████╔╝\x1b[0m`);
  console.log(`\x1b[36m  ██╔══██╗██╔══╝  ██║  ██║██╔══██║╚════██║██╔═══╝ \x1b[0m`);
  console.log(`\x1b[36m  ██║  ██║███████╗██████╔╝██║  ██║███████║██║     \x1b[0m`);
  console.log(`\x1b[36m  ╚═╝  ╚═╝╚══════╝╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝     \x1b[0m`);
  console.log('');
  log.ok('SYS', `RedasP v3.1 → http://localhost:${PORT}`);
  log.info('SYS', `AI1=${AI1_URL}`);
  log.info('SYS', `AI2=${AI2_URL}`);
  const s=EssaysDB.stats();
  log.info('DB', `Cache: ${s.total} total | ${s.delivered} entregues | ${s.generated} geradas`);
  console.log('');
});