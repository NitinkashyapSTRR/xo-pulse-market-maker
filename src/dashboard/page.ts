// The dashboard page. Plain HTML + canvas, no build step, no CDN.
// __TOKEN__ and __RANGES__ are filled in by server.ts.
export const PAGE = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>XO Pulse MM</title>
<style>
:root{--pink:#FF87A6;--bg:#0d0b10;--card:#17141c;--line:#241f2b;--muted:#9a93a6;--up:#3ddc97;--down:#ff6b7a;--warn:#ffcc66;--blue:#7aa7ff}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto;background:var(--bg);color:#f4f1f7}
header{position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:14px 24px;border-bottom:1px solid var(--line);background:rgba(13,11,16,.92);backdrop-filter:blur(6px)}
header b{color:var(--pink);font-size:18px;margin-right:4px}
.pill{padding:3px 10px;border-radius:99px;background:var(--line);color:var(--muted);font-size:12px}
.pill.live{background:#3a1220;color:var(--pink)}.pill.ok{background:#11301f;color:var(--up)}.pill.bad{background:#3a1220;color:var(--down)}.pill.wait{background:#33280f;color:var(--warn)}
.spacer{flex:1}
button{font:inherit;border:1px solid var(--line);background:#221d29;color:#f4f1f7;border-radius:10px;padding:7px 14px;cursor:pointer}
button:hover{border-color:#3a3344}button.primary{background:var(--pink);border-color:var(--pink);color:#1a0f14;font-weight:600}
button.danger{background:#3a1220;border-color:#5a1a30;color:#ffb3c2;font-weight:600}button:disabled{opacity:.45;cursor:not-allowed}
.progress{height:3px;background:var(--line);position:relative}.progress i{position:absolute;left:0;top:0;bottom:0;background:var(--pink);transition:width 1s linear}
main{display:grid;grid-template-columns:repeat(12,1fr);gap:14px;padding:18px 24px}
.card{grid-column:span 3;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;min-width:0}
.c6{grid-column:span 6}.c4{grid-column:span 4}.c8{grid-column:span 8}.c12{grid-column:1/-1}
@media(max-width:1100px){.card,.c6,.c4,.c8{grid-column:span 6}}@media(max-width:700px){.card,.c6,.c4,.c8{grid-column:1/-1}}
.card h3{margin:0 0 10px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);display:flex;justify-content:space-between;align-items:center;gap:8px}
.big{font-size:30px;font-weight:700;font-variant-numeric:tabular-nums}.row{display:flex;justify-content:space-between;padding:3px 0;gap:10px}.muted{color:var(--muted)}
.bar{height:10px;border-radius:6px;background:linear-gradient(90deg,var(--down),#444 50%,var(--up));position:relative;margin:12px 0}
.bar i{position:absolute;top:-5px;width:3px;height:20px;background:#fff;border-radius:2px;transition:left .6s}
canvas{width:100%;height:220px;display:block}
.legend{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin-top:6px}.legend span:before{content:"";display:inline-block;width:10px;height:3px;margin-right:5px;vertical-align:middle;background:var(--c)}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:5px 6px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}
.up{color:var(--up)}.down{color:var(--down)}.warn{color:var(--warn)}
.sl{display:grid;grid-template-columns:1fr auto;gap:2px 10px;margin:8px 0}.sl label{font-size:13px}.sl output{font-variant-numeric:tabular-nums;color:var(--pink)}
.sl input[type=range]{grid-column:1/-1;width:100%;accent-color:var(--pink)}.sl small{grid-column:1/-1;color:var(--muted);font-size:11.5px}
.chips{display:flex;gap:6px;flex-wrap:wrap}.chip{padding:3px 10px;border-radius:99px;border:1px solid var(--line);background:none;font-size:12px;color:var(--muted)}.chip.on{background:var(--line);color:#fff}
#log{font:12px ui-monospace,Menlo,Consolas,monospace;max-height:300px;overflow:auto;white-space:pre-wrap;color:#cfc8da}
#log div.fill{color:var(--up)}#log div.err{color:var(--down)}#log div.halt{color:var(--warn)}
.toasts{position:fixed;right:18px;bottom:18px;display:flex;flex-direction:column;gap:8px;z-index:20}
.toast{background:#221d29;border:1px solid #3a3344;border-left:4px solid var(--pink);padding:10px 14px;border-radius:10px;min-width:240px;box-shadow:0 8px 30px rgba(0,0,0,.4);animation:in .25s ease}
.toast.good{border-left-color:var(--up)}.toast.bad{border-left-color:var(--down)}
@keyframes in{from{transform:translateY(10px);opacity:0}to{transform:none;opacity:1}}
.kbd{font:11px ui-monospace,monospace;border:1px solid #3a3344;border-radius:4px;padding:0 4px;color:var(--muted)}
.switch{display:flex;align-items:center;gap:8px;font-size:13px;margin:8px 0}
</style></head><body>
<header>
  <b>XO Pulse MM</b><span id="mode" class="pill">…</span><span id="round" class="pill">–</span><span id="clock" class="pill">–</span><span id="status" class="pill">–</span>
  <span class="spacer"></span>
  <label class="switch" title="Beep on fills"><input type="checkbox" id="sound"> sound</label>
  <button id="pauseBtn">Pause <span class="kbd">P</span></button>
  <button id="killBtn" class="danger">Kill switch <span class="kbd">K</span></button>
</header>
<div class="progress"><i id="prog"></i></div>
<main>
  <div class="card"><h3>Fair P(UP)</h3><div class="big" id="fair">–</div><div class="bar"><i id="fairMark"></i></div>
    <div class="row"><span class="muted">Book bid / ask</span><span id="book">–</span></div>
    <div class="row"><span class="muted">Edge vs book mid</span><span id="edge">–</span></div></div>
  <div class="card"><h3>BTC</h3><div class="big" id="btc">–</div>
    <div class="row"><span class="muted">Price to beat</span><span id="k">–</span></div>
    <div class="row"><span class="muted">Distance</span><span id="dist">–</span></div>
    <div class="row"><span class="muted">Vol (5-min σ)</span><span id="vol">–</span></div></div>
  <div class="card"><h3>Rewards</h3><div class="big" id="score">–</div><div class="muted">est. score today (local estimate)</div>
    <div class="row"><span class="muted">Daily pools</span><span id="pools">–</span></div>
    <div class="row"><span class="muted">Band / min size</span><span id="rules">–</span></div></div>
  <div class="card"><h3>P&amp;L</h3><div class="big" id="pnl">–</div><div class="muted">realised, settled rounds</div>
    <div class="row"><span class="muted">Fills</span><span id="fills">0</span></div>
    <div class="row"><span class="muted">Round inventory</span><span id="inv">–</span></div>
    <div id="halt" class="warn"></div></div>

  <div class="card c6"><h3>BTC vs price to beat <span class="muted" id="c1note"></span></h3><canvas id="c1"></canvas>
    <div class="legend"><span style="--c:#f4f1f7">BTC</span><span style="--c:var(--pink)">Price to beat</span></div></div>
  <div class="card c6"><h3>Fair value vs book <span class="muted" id="c2note"></span></h3><canvas id="c2"></canvas>
    <div class="legend"><span style="--c:var(--blue)">Fair P(UP)</span><span style="--c:#6b6377">Book bid/ask</span><span style="--c:var(--up)">Our bid</span><span style="--c:var(--down)">Our ask</span></div></div>

  <div class="card c4"><h3>Strategy <span class="chips" id="presets"></span></h3>
    <div id="sliders"></div>
    <label class="switch"><input type="checkbox" id="rewardAware"> keep quotes inside reward band</label>
    <div class="row" style="margin-top:10px"><button id="resetBtn">Reset</button><button id="applyBtn" class="primary" disabled>Apply changes</button></div>
    <div class="muted" id="liveNote" style="font-size:12px;margin-top:8px"></div></div>
  <div class="card c8"><h3>Resting quotes <span class="muted" id="reason"></span></h3>
    <table><thead><tr><th>Leg</th><th>Buy</th><th>Price</th><th>UP-axis</th><th>Shares</th><th>Resting</th></tr></thead><tbody id="orders"></tbody></table>
    <h3 style="margin-top:18px">Rounds</h3>
    <table><thead><tr><th>Round</th><th>UP</th><th>DOWN</th><th>Cost</th><th>Result</th><th>P&amp;L</th></tr></thead><tbody id="rounds"></tbody></table></div>

  <div class="card c12"><h3>Log <span class="chips" id="logf"></span></h3><div id="log"></div></div>
</main>
<div class="toasts" id="toasts"></div>
<script>
const TOKEN="__TOKEN__", RANGES=__RANGES__;
const $=id=>document.getElementById(id);
const f3=x=>x==null?'–':Number(x).toFixed(3);
const usd=x=>'$'+Number(x).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
let S=null, dirty={}, logFilter='all', seenLog=0, lastPaused=null;

const SLIDERS=[
 ['halfSpread','Half-spread','¢',100,0.001,'How far from fair you quote. Wider = fewer fills, less adverse selection.'],
 ['minEdge','Min edge','¢',100,0.001,'Never quote closer than this to fair.'],
 ['shares','Shares per quote','',1,1,'Reward minimum is 4.'],
 ['maxNetShares','Inventory cap','sh',1,1,'Max UP minus DOWN held in one round.'],
 ['skewPerShare','Inventory skew','¢/sh',100,0.0001,'Shift quotes against inventory.'],
 ['pullBeforeExpirySec','Pull before expiry','s',1,1,'Stop quoting this long before the round ends.'],
 ['fairFloor','Fair floor','%',100,0.01,'No quotes when fair is below this or above 1 minus this.'],
 ['maxRoundSpendUsdc','Spend cap / round','USDC',1,1,'Max USDC committed per 5-minute round.'],
 ['maxDailyLossUsdc','Daily loss halt','USDC',1,1,'Cancel everything and stop past this loss.'],
];
const PRESETS={
 Safe:{halfSpread:0.03,minEdge:0.012,shares:5,maxNetShares:15,skewPerShare:0.001,pullBeforeExpirySec:60,fairFloor:0.12},
 Balanced:{halfSpread:0.02,minEdge:0.008,shares:8,maxNetShares:25,skewPerShare:0.0007,pullBeforeExpirySec:40,fairFloor:0.08},
 Tight:{halfSpread:0.012,minEdge:0.005,shares:10,maxNetShares:40,skewPerShare:0.0005,pullBeforeExpirySec:25,fairFloor:0.06},
};

function buildSliders(){
  const box=$('sliders');
  for(const [k,label,unit,mul,step,help] of SLIDERS){
    const r=RANGES[k];const max=k==='maxRoundSpendUsdc'||k==='maxDailyLossUsdc'?200:k==='maxNetShares'?200:k==='shares'?100:r.max;
    const d=document.createElement('div');d.className='sl';
    d.innerHTML='<label for="s_'+k+'">'+label+'</label><output id="o_'+k+'"></output><input type="range" id="s_'+k+'" min="'+r.min+'" max="'+max+'" step="'+step+'"><small>'+help+'</small>';
    box.appendChild(d);
    const inp=d.querySelector('input');
    inp.addEventListener('input',()=>{dirty[k]=Number(inp.value);showVal(k,inp.value,unit,mul);$('applyBtn').disabled=false;});
    inp.dataset.unit=unit;inp.dataset.mul=mul;
  }
  for(const name of Object.keys(PRESETS)){const b=document.createElement('button');b.className='chip';b.textContent=name;
    b.onclick=()=>{Object.assign(dirty,PRESETS[name]);for(const [k,v] of Object.entries(PRESETS[name]))setSlider(k,v);$('applyBtn').disabled=false;};$('presets').appendChild(b);}
  $('rewardAware').onchange=e=>{dirty.rewardAware=e.target.checked;$('applyBtn').disabled=false;};
  for(const f of ['all','fills','orders','errors']){const b=document.createElement('button');b.className='chip'+(f==='all'?' on':'');b.textContent=f;
    b.onclick=()=>{logFilter=f;[...$('logf').children].forEach(c=>c.classList.toggle('on',c===b));renderLog();};$('logf').appendChild(b);}
}
function showVal(k,v,unit,mul){const n=Number(v)*Number(mul);$('o_'+k).textContent=(Number.isInteger(n)?n:n.toFixed(unit==='¢/sh'?2:1))+(unit?' '+unit:'');}
function setSlider(k,v){const i=$('s_'+k);if(!i)return;i.value=v;showVal(k,v,i.dataset.unit,i.dataset.mul);}
function syncSliders(p){for(const [k] of SLIDERS) if(!(k in dirty)) setSlider(k,p[k]); if(!('rewardAware' in dirty)) $('rewardAware').checked=!!p.rewardAware;}

async function ctl(body){
  try{const r=await fetch('/control',{method:'POST',headers:{'content-type':'application/json','x-control-token':TOKEN},body:JSON.stringify(body)});
    const j=await r.json();if(!j.ok)throw new Error(j.error);return j.msg;}
  catch(e){toast(e.message,'bad');throw e;}
}
$('applyBtn').onclick=async()=>{try{await ctl({action:'set',params:dirty});toast('Settings applied','good');dirty={};$('applyBtn').disabled=true;}catch{}};
$('resetBtn').onclick=()=>{dirty={};$('applyBtn').disabled=true;if(S)syncSliders(S.params);};
async function togglePause(){if(!S)return;try{await ctl({action:S.paused?'resume':'pause'});}catch{}}
async function kill(){if(confirm('Cancel every order and halt the bot?'))try{await ctl({action:'kill'});toast('Kill switch: everything cancelled','bad');}catch{}}
$('pauseBtn').onclick=togglePause;$('killBtn').onclick=kill;
document.addEventListener('keydown',e=>{if(e.target.tagName==='INPUT')return;if(e.key==='p'||e.key==='P')togglePause();if(e.key==='k'||e.key==='K')kill();});

function toast(msg,kind){const t=document.createElement('div');t.className='toast '+(kind||'');t.textContent=msg;$('toasts').appendChild(t);setTimeout(()=>t.remove(),4500);}
let ac;function beep(f){if(!$('sound').checked)return;ac=ac||new AudioContext();const o=ac.createOscillator(),g=ac.createGain();o.frequency.value=f;g.gain.value=.06;o.connect(g);g.connect(ac.destination);o.start();o.stop(ac.currentTime+.12);}

function renderLog(){if(!S)return;const box=$('log');box.textContent='';
  for(const l of S.log){const m=l.msg;const kind=m.startsWith('FILL')?'fill':/error|fail/i.test(m)?'err':/HALT|KILL|PAUSE/.test(m)?'halt':'';
    if(logFilter==='fills'&&!/FILL|settled/.test(m))continue;if(logFilter==='orders'&&!/place|cancel|FILL/.test(m))continue;if(logFilter==='errors'&&kind!=='err'&&kind!=='halt')continue;
    const d=document.createElement('div');d.className=kind;d.textContent=new Date(l.t).toLocaleTimeString()+'  '+m;box.appendChild(d);}
  box.scrollTop=1e9;}

function chart(cv,series,opts){
  const dpr=devicePixelRatio||1,w=cv.clientWidth,h=cv.clientHeight;cv.width=w*dpr;cv.height=h*dpr;const c=cv.getContext('2d');c.scale(dpr,dpr);c.clearRect(0,0,w,h);
  const pts=series.flatMap(s=>s.data.filter(p=>p.y!=null));if(pts.length<2){c.fillStyle='#9a93a6';c.fillText('collecting data…',12,20);return;}
  let x0=opts.x0??Math.min(...pts.map(p=>p.x)),x1=opts.x1??Math.max(...pts.map(p=>p.x)),y0=opts.y0??Math.min(...pts.map(p=>p.y)),y1=opts.y1??Math.max(...pts.map(p=>p.y));
  if(y1-y0<1e-9){y0-=1;y1+=1}const pad=(y1-y0)*.08;if(opts.y0==null)y0-=pad;if(opts.y1==null)y1+=pad;
  const L=54,R=8,T=8,B=20,X=x=>L+(x-x0)/(x1-x0)*(w-L-R),Y=y=>T+(1-(y-y0)/(y1-y0))*(h-T-B);
  c.strokeStyle='#241f2b';c.fillStyle='#9a93a6';c.font='11px ui-sans-serif,system-ui';c.lineWidth=1;
  for(let i=0;i<=4;i++){const y=y0+(y1-y0)*i/4;c.beginPath();c.moveTo(L,Y(y));c.lineTo(w-R,Y(y));c.stroke();c.fillText(opts.fmt(y),4,Y(y)+4);}
  if(opts.band){c.fillStyle='rgba(107,99,119,.18)';c.beginPath();let first=true;const d=opts.band;
    for(const p of d)if(p.hi!=null){first?c.moveTo(X(p.x),Y(p.hi)):c.lineTo(X(p.x),Y(p.hi));first=false}
    for(const p of d.slice().reverse())if(p.lo!=null)c.lineTo(X(p.x),Y(p.lo));c.fill();}
  for(const s of series){c.strokeStyle=s.color;c.lineWidth=s.w||1.6;c.setLineDash(s.dash||[]);c.beginPath();let pen=false;
    for(const p of s.data){if(p.y==null){pen=false;continue}pen?c.lineTo(X(p.x),Y(p.y)):c.moveTo(X(p.x),Y(p.y));pen=true}c.stroke();}
  c.setLineDash([]);c.fillStyle='#9a93a6';const sec=Math.round((x1-x0)/1000);c.fillText('last '+Math.floor(sec/60)+':'+String(sec%60).padStart(2,'0'),w-70,h-5);
}

function render(){
  const s=S;if(!s)return;
  $('mode').textContent=s.mode.toUpperCase();$('mode').className='pill'+(s.mode==='live'?' live':'');
  const st=s.halted?['HALTED','bad']:s.paused?['PAUSED','wait']:s.working.length?['QUOTING','ok']:['WATCHING',''];
  $('status').textContent=st[0];$('status').className='pill '+st[1];
  $('pauseBtn').innerHTML=(s.paused?'Resume':'Pause')+' <span class="kbd">P</span>';$('pauseBtn').disabled=!!s.halted;
  if(lastPaused!==null&&lastPaused!==s.paused)toast(s.paused?'Paused: quotes pulled':'Resumed',s.paused?'':'good');lastPaused=s.paused;
  if(s.round){const left=Math.max(0,(s.round.expiresAt-s.now)/1000),tot=(s.round.expiresAt-s.round.startsAt)/1000;
    $('round').textContent='Round #'+s.round.cycle;$('clock').textContent=Math.floor(left/60)+':'+String(Math.floor(left%60)).padStart(2,'0')+' left';
    $('prog').style.width=(100*(1-left/tot))+'%';}
  $('fair').textContent=s.fairUp==null?'–':(s.fairUp*100).toFixed(1)+'%';$('fairMark').style.left=((s.fairUp??.5)*100)+'%';
  $('book').textContent=f3(s.book?.bid)+' / '+f3(s.book?.ask);
  const mid=s.book?.bid!=null&&s.book?.ask!=null?(s.book.bid+s.book.ask)/2:null;
  $('edge').textContent=mid!=null&&s.fairUp!=null?((s.fairUp-mid)*100>=0?'+':'')+((s.fairUp-mid)*100).toFixed(1)+'¢':'–';
  $('btc').textContent=s.btc?usd(s.btc):'–';const K=s.round?.priceToBeat;$('k').textContent=K?usd(K):'–';
  if(s.btc&&K){const d=s.btc-K;$('dist').textContent=(d>=0?'+':'−')+usd(Math.abs(d)).slice(1)+(d>=0?' ▲':' ▼');$('dist').className=d>=0?'up':'down';}
  $('vol').textContent=s.volPerSqrtSec?(s.volPerSqrtSec*Math.sqrt(300)*100).toFixed(3)+'%':'–';
  $('score').textContent=Number(s.scoreToday||0).toFixed(0);
  if(s.rewards){$('pools').textContent=Number(s.rewards.usdcDailyPool).toFixed(0)+' USDC + '+s.rewards.cpDailyPool+' CP';$('rules').textContent='±'+(s.rewards.maxDistance*100).toFixed(0)+'¢ / '+s.rewards.minShares+' sh';}
  $('pnl').textContent=(s.realisedPnl>=0?'+':'')+Number(s.realisedPnl).toFixed(3)+' USDC';$('pnl').className='big '+(s.realisedPnl>=0?'up':'down');
  $('halt').textContent=s.halted?'Halted: '+s.halted:'';$('fills').textContent=s.fills;
  const cur=s.positions.find(p=>!p.settled);$('inv').textContent=cur?cur.upShares+' UP / '+cur.downShares+' DOWN':'–';
  const ob=$('orders');ob.textContent='';
  if(!s.working.length){const tr=ob.insertRow();const td=tr.insertCell();td.colSpan=6;td.className='muted';td.textContent='none';}
  for(const o of s.working){const tr=ob.insertRow();[o.leg,o.token,f3(o.price),f3(o.upAxisPrice),o.shares-o.filled,((s.now-o.placedAt)/1000).toFixed(0)+'s'].forEach((v,i)=>{const td=tr.insertCell();td.textContent=v;if(i===1)td.className=o.token==='UP'?'up':'down';});}
  $('reason').textContent=s.decision?s.decision.reason:'';
  const rb=$('rounds');rb.textContent='';
  for(const p of s.positions.slice().reverse()){const tr=rb.insertRow();[p.roundId,p.upShares,p.downShares,p.cost.toFixed(3),p.settled?p.settled.winner:'open',p.settled?(p.settled.pnl>=0?'+':'')+p.settled.pnl.toFixed(3):'–'].forEach((v,i)=>{const td=tr.insertCell();td.textContent=v;if(i===5&&p.settled)td.className=p.settled.pnl>=0?'up':'down';});}
  syncSliders(s.params);
  $('liveNote').textContent=s.mode==='live'?'Live mode: risk limits can only be lowered from where the bot started.':'Paper mode: change anything, nothing real is at stake.';
  // toasts for new fills / settlements
  const newest=s.log.length?s.log[s.log.length-1].t:0;
  for(const l of s.log) if(l.t>seenLog&&seenLog){ if(l.msg.startsWith('FILL')){toast(l.msg,'good');beep(880);} else if(/settled/.test(l.msg)){toast(l.msg,/pnl -/.test(l.msg)?'bad':'good');beep(520);} else if(/HALT/.test(l.msg)){toast(l.msg,'bad');} }
  seenLog=Math.max(seenLog,newest)||newest;
  renderLog();
  const h=s.history.filter(p=>s.round&&p.round===s.round.cycle);const src=h.length>1?h:s.history.slice(-150);
  const x0=s.round?s.round.startsAt:undefined,x1=s.round?s.round.expiresAt:undefined;
  chart($('c1'),[{color:'#f4f1f7',data:src.map(p=>({x:p.t,y:p.btc}))},{color:'#FF87A6',dash:[5,4],data:src.map(p=>({x:p.t,y:p.k}))}],{x0,x1,fmt:v=>Math.round(v).toLocaleString()});
  chart($('c2'),[{color:'#7aa7ff',w:2,data:src.map(p=>({x:p.t,y:p.fair}))},{color:'#3ddc97',data:src.map(p=>({x:p.t,y:p.qBid??null}))},{color:'#ff6b7a',data:src.map(p=>({x:p.t,y:p.qAsk??null}))}],
    {x0,x1,y0:0,y1:1,fmt:v=>(v*100).toFixed(0)+'%',band:src.map(p=>({x:p.t,lo:p.bid,hi:p.ask}))});
  $('c1note').textContent=$('c2note').textContent=h.length>1?'this round':'';
}
async function poll(){try{S=await (await fetch('/state')).json();render();}catch(e){$('status').textContent='OFFLINE';$('status').className='pill bad';}}
buildSliders();setInterval(poll,1000);poll();addEventListener('resize',render);
</script></body></html>`;
