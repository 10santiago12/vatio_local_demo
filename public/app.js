/* Vatio local demo - frontend (vanilla JS, no build step).
   Deep link helper for screenshots/demos: /?view=Alertas&theme=light (&more=1 opens the mobile "Más" sheet) */

const navItems = [
  "Inicio","Operaciones","Alertas","Recomendaciones","Control",
  "Ahorro y retorno","Reportes","Módulos","Datos crudos","Multisede","Configuración"
];
const DEMO_VIEW = "Panel de Demo";

const viewIcons = {
  "Inicio":"house","Operaciones":"activity","Alertas":"bell","Recomendaciones":"lightbulb",
  "Control":"sliders-horizontal","Ahorro y retorno":"piggy-bank","Reportes":"file-text",
  "Módulos":"cpu","Datos crudos":"database","Multisede":"building-2","Configuración":"settings",
  "Panel de Demo":"presentation"
};
// Short labels for the mobile bottom bar.
const primaryMobile = [
  {view:"Inicio", label:"Inicio"},
  {view:"Operaciones", label:"Operación"},
  {view:"Alertas", label:"Alertas"},
  {view:"Ahorro y retorno", label:"Ahorro"}
];

function initialView(){
  try{
    const v = new URLSearchParams(location.search).get("view");
    if(v && (navItems.includes(v) || v === DEMO_VIEW)) return v;
  }catch(e){}
  return "Inicio";
}

const state = {
  view: initialView(),
  theme: document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark",
  telemetry: null,
  info: null,
  tariff: Number(localStorage.getItem("vatio_tariff") || 950),
  investment: Number(localStorage.getItem("vatio_investment") || 1800000),
  role: "",
  csrf: "",
  permissions: [],
  apiViews: {},
  moreOpen: new URLSearchParams(location.search).get("more") === "1",
  animate: true,
  // Rolling buffer of real readings received by the browser (about 4 minutes).
  history: []
};

const baselineKwh = {
  freezer:14.5, fridge:16.2, pos:1.65, oven:64.0,
  coffee:32.5, ac:22.1, sign:4.0, tv:1.1
};

const criticality = {
  freezer:"Crítica", fridge:"Crítica", pos:"Crítica",
  oven:"Esencial", coffee:"Esencial", ac:"No esencial", sign:"No esencial", tv:"No esencial"
};

/* ---------- formatting helpers ---------- */
function money(value){
  return "$ " + Math.round(value).toLocaleString("es-CO");
}
function num(value, digits=1){
  return Number(value || 0).toLocaleString("es-CO",{minimumFractionDigits:digits,maximumFractionDigits:digits});
}
function escapeHtml(s){
  return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
}
function axisNum(v){ return Number(v).toLocaleString("es-CO",{maximumFractionDigits:1}); }
function icon(name, cls=""){
  return `<svg class="icon ${cls}" aria-hidden="true" focusable="false"><use href="/vendor/lucide-sprite.svg#${name}"></use></svg>`;
}
function pill(text, tone="neutral", iconName=""){
  return `<span class="pill ${tone}">${iconName ? icon(iconName,"sm") : ""}${escapeHtml(text)}</span>`;
}

let toastTimer = null;
function toast(message){
  const root = document.getElementById("toast-root");
  root.innerHTML = `<div class="toast">${icon("circle-check")}<span>${escapeHtml(message)}</span></div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => root.innerHTML = "", 2800);
}

/* ---------- data helpers ---------- */
function readings(){
  return state.telemetry?.readings || [];
}
function totalPower(){
  return readings().reduce((a,r)=>a+Number(r.power_w||0),0);
}
function dailyEstimateKwh(){
  return totalPower()*12/1000;
}
function currentCost(){
  const energy = readings().reduce((a,r)=>a+Number(r.energy_kwh||0),0);
  return energy * state.tariff;
}
function sourcePill(){
  const source = state.telemetry?.source;
  if(source === "esp32" && readings().length && readings().every(r=>r.effective_status === "inactive")) return `<span class="pill warn">Pérdida de comunicación</span>`;
  if(source === "esp32") return `<span class="pill good"><span class="live-dot"></span>ESP32 en vivo</span>`;
  return `<span class="pill info">${icon("cpu","sm")}Datos simulados</span>`;
}
function ageLabel(r){
  const s = Number(r.age_seconds || 0);
  if(s < 10) return "ahora";
  if(s < 60) return `hace ${s} s`;
  return `hace ${Math.floor(s/60)} min`;
}
function sortedDevices(){
  return [...readings()].sort((a,b)=>Number(b.power_w)-Number(a.power_w));
}
function pushHistory(){
  const rs = readings();
  if(!rs.length) return;
  const loads = {};
  const names = {};
  rs.forEach(r => { loads[r.load_id] = Number(r.power_w||0); names[r.load_id] = r.load_name; });
  const t = state.telemetry.server_time ? new Date(state.telemetry.server_time) : new Date();
  state.history.push({
    label: t.toLocaleTimeString("es-CO",{hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}),
    totalKw: totalPower()/1000, loads, names
  });
  if(state.history.length > 120) state.history.shift();
}

/* ---------- gauge ---------- */
function gauge(pct, {size="", text, sub="", label, cls=""}={}){
  const p = Math.max(0, Math.min(100, Number(pct)||0));
  const over = Number(pct) > 100;
  return `<div class="gauge-wrap ${cls}" ${size ? `style="--size:${size}"` : ""} role="img" aria-label="${escapeHtml(label || text)}">
    <div class="gauge ${over?"over":""}" style="--p:${p}"></div>
    <div class="gauge-center"><strong>${escapeHtml(text)}</strong>${sub ? `<span>${escapeHtml(sub)}</span>` : ""}</div>
  </div>`;
}

/* ---------- charts (uPlot, colors read from the active theme) ---------- */
let pendingCharts = [];
let liveCharts = [];
let chartSeq = 0;

function chartBlock(cfg, height=240){
  const id = `chart-${++chartSeq}`;
  cfg.height = height;
  pendingCharts.push({id, cfg});
  const legend = cfg.series.length > 1 ? `<div class="chart-legend">${cfg.series.map(s =>
    `<span style="color:var(--muted)"><i class="${s.dash?"dash":""}" style="background:var(${s.color});color:var(${s.color})"></i>${escapeHtml(s.name)}</span>`).join("")}</div>` : "";
  const rows = cfg.labels.map((l,i)=>({l, i})).slice(-12);
  const fmt = cfg.fmt || (v => num(v,1));
  const table = `<details class="chart-table"><summary>Ver como tabla</summary><div class="table-wrap"><table>
    <thead><tr><th>${escapeHtml(cfg.xName || "Periodo")}</th>${cfg.series.map(s=>`<th>${escapeHtml(s.name)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map(r=>`<tr><td>${escapeHtml(cfg.tipLabel ? cfg.tipLabel(r.i) : r.l)}</td>${cfg.series.map(s=>`<td>${s.data[r.i]==null?"-":escapeHtml(fmt(s.data[r.i]))}</td>`).join("")}</tr>`).join("")}</tbody>
  </table></div></details>`;
  return `${legend}<div class="chart-box" id="${id}" style="height:${height}px" role="img" aria-label="${escapeHtml(cfg.aria || "Gráfico")}"></div>${table}`;
}

function cssVar(name){
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function withAlpha(hex, a){
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if(!m) return hex;
  const n = parseInt(m[1],16);
  return `rgba(${n>>16&255},${n>>8&255},${n&255},${a})`;
}

function destroyCharts(){
  liveCharts.forEach(u => { try{ u.destroy(); }catch(e){} });
  liveCharts = [];
}

function mountChart({id, cfg}){
  const el = document.getElementById(id);
  if(!el || typeof uPlot === "undefined") return;
  const n = cfg.labels.length;
  if(n < (cfg.bars ? 1 : 2)){
    el.style.height = "96px";
    el.innerHTML = `<div class="chart-empty">Reuniendo lecturas…</div>`;
    return;
  }
  const axisColor = cssVar("--chart-axis");
  const gridColor = cssVar("--chart-grid");
  const surface = cssVar("--chart-surface");
  const colors = cfg.series.map(s => cssVar(s.color));
  const xs = cfg.labels.map((_,i)=>i);
  const fmt = cfg.fmt || (v => num(v,1));
  const axisFmt = cfg.axisFmt || axisNum;
  const tipLabel = cfg.tipLabel || (i => cfg.labels[i]);
  const font = "13px Manrope, 'Segoe UI', system-ui, sans-serif";

  const series = [{}].concat(cfg.series.map((s,i)=>{
    const color = colors[i];
    if(cfg.bars){
      return {label:s.name, stroke:color, fill:color, width:0,
        paths:uPlot.paths.bars({size:[0.5,56], radius:0.2}), points:{show:false}};
    }
    return {
      label:s.name, stroke:color, width:2.5, dash:s.dash?[7,6]:undefined,
      paths:uPlot.paths.spline(), points:{show:false},
      fill: s.area ? (u => {
        const g = u.ctx.createLinearGradient(0, u.bbox.top, 0, u.bbox.top + u.bbox.height);
        g.addColorStop(0, withAlpha(color,.32));
        g.addColorStop(1, withAlpha(color,0));
        return g;
      }) : undefined
    };
  }));

  const opts = {
    width: Math.max(240, el.clientWidth),
    height: cfg.height,
    legend:{show:false},
    padding:[10,30,0,0],
    select:{show:false},
    cursor:{
      drag:{x:false,y:false},
      y:false,
      points:{show:!cfg.bars, size:10, width:2, fill:surface, stroke:(u,i)=>colors[i-1]}
    },
    scales:{
      x:{time:false, range:(u,min,max)=> cfg.bars ? [-0.6,n-0.4] : (n<2 ? [-0.5,0.5] : [min,max])},
      y:{range:(u,min,max)=>[cfg.yMin ?? 0, Math.max(cfg.yMax ?? 0, max*1.18, 1e-6)]}
    },
    axes:[
      {
        stroke:axisColor, font, size:34, gap:6,
        grid:{show:false}, ticks:{show:false}, border:{show:false},
        splits:(u)=>{
          if(cfg.bars) return xs;
          const k = Math.min(cfg.maxTicks || 4, n);
          const out = [];
          for(let j=0;j<k;j++) out.push(Math.round(j*(n-1)/Math.max(1,k-1)));
          return [...new Set(out)];
        },
        values:(u,vals)=>vals.map(i=>cfg.labels[i] ?? "")
      },
      {
        stroke:axisColor, font, size:cfg.ySize || 52, gap:6,
        grid:{stroke:gridColor,width:1}, ticks:{show:false}, border:{show:false},
        ...(cfg.incrs ? {incrs:cfg.incrs} : {}), values:(u,vals)=>vals.map(axisFmt)
      }
    ],
    series,
    hooks:{
      ready:[u => {
        const tip = document.createElement("div");
        tip.className = "chart-tip";
        u.over.appendChild(tip);
        u._tip = tip;
      }],
      setCursor:[u => {
        const tip = u._tip;
        if(!tip) return;
        const idx = u.cursor.idx;
        if(idx == null || u.cursor.left < 0){ tip.style.display = "none"; return; }
        tip.innerHTML = `<b>${escapeHtml(tipLabel(idx))}</b>` + cfg.series.map((s,i)=>{
          const v = s.data[idx];
          return `<div><span><i style="background:${colors[i]}"></i>${escapeHtml(s.name)}</span><strong>${v==null?"-":escapeHtml(fmt(v))}</strong></div>`;
        }).join("");
        tip.style.display = "block";
        const w = tip.offsetWidth;
        const x = u.valToPos(idx,"x");
        tip.style.left = (x + 14 + w > u.over.clientWidth ? Math.max(0, x - 14 - w) : x + 14) + "px";
      }]
    }
  };
  try{
    liveCharts.push(new uPlot(opts, [xs, ...cfg.series.map(s=>s.data)], el));
  }catch(e){
    console.error("chart error", e);
  }
}

function mountAllCharts(){
  destroyCharts();
  pendingCharts.forEach(mountChart);
}

/* ---------- reusable view blocks ---------- */
function statCard({label, value, sub="", iconName, tone=""}){
  return `<div class="stat ${tone}">
    <div class="stat-top"><span class="stat-label">${escapeHtml(label)}</span>
      ${iconName ? `<span class="chip ${tone==="warn"?"warn":""}">${icon(iconName)}</span>` : ""}</div>
    <div class="stat-value">${value}</div>
    <div class="stat-sub">${escapeHtml(sub)}</div>
  </div>`;
}
function cardHead(iconName, title, sub="", tone=""){
  return `<div class="card-head"><span class="chip ${tone}">${icon(iconName)}</span><div><h2>${escapeHtml(title)}</h2>${sub ? `<div class="small muted">${escapeHtml(sub)}</div>` : ""}</div></div>`;
}
function bannerBlock(title, sub, endpointText, iconName){
  return `<div class="source-banner">
    <div class="lead"><span class="chip info">${icon(iconName)}</span>
      <div><strong>${escapeHtml(title)}</strong><div class="small muted">${escapeHtml(sub)}</div></div></div>
    <div class="endpoint">${escapeHtml(endpointText)}</div>
  </div>`;
}
function layout(content, title=state.view){
  return {title, content};
}

/* ---------- shell ---------- */
const privacyLinks = `<a href="/politica-de-tratamiento.html" target="_blank" rel="noopener noreferrer">Política de Tratamiento</a>
  <a href="/aviso-de-privacidad.html" target="_blank" rel="noopener noreferrer">Aviso de Privacidad</a>
  <a href="/terminos-y-condiciones.html" target="_blank" rel="noopener noreferrer">Términos y Condiciones</a>`;
let contact = {};

function feedbackControl(){
  const label = "Sugerencias / Reportar un problema";
  return contact.feedbackUrl
    ? `<a class="feedback-link" href="${escapeHtml(contact.feedbackUrl)}" target="_blank" rel="noopener noreferrer">${label}<span class="sr-only"> (abre otra pestaña)</span></a>`
    : `<button type="button" class="feedback-link" data-action="feedback-unavailable">${label}</button><small>Canal no configurado</small>`;
}

function contactFooter(signedIn = false){
  const pqr = contact.pqrEmail ? `<a href="mailto:${escapeHtml(contact.pqrEmail)}">Correo de PQR</a>` : "<small>Correo de PQR por confirmar</small>";
  const personalData = signedIn ? '<a href="/api/me/personal-data" target="_blank" rel="noopener noreferrer">Consultar mis datos (JSON)</a>' : "";
  return `<footer class="contact-footer"><nav aria-label="Privacidad y contacto">${privacyLinks}${pqr}${personalData}</nav>
    <div class="feedback-slot">${feedbackControl()}</div></footer>`;
}

function closeMore(){
  state.moreOpen = false;
  render({force:true});
  document.querySelector('[data-action="open-more"]')?.focus();
}
function navButtons(){
  return navItems.map(n=>`<button class="nav-btn" data-view="${escapeHtml(n)}" ${state.view===n?'aria-current="page"':""}>${icon(viewIcons[n])}<span>${escapeHtml(n)}</span></button>`).join("");
}
function sidebarHtml(){
  return `
    <div class="brand"><span class="logo">${icon("zap","lg")}</span><span class="brand-name">Vatio</span></div>
    <p class="site-name">Panadería La Espiga · Chía</p>
    <nav class="nav" aria-label="Secciones">${navButtons()}</nav>
    <div class="sidebar-foot">
      <div class="feedback-slot">${feedbackControl()}</div>
      <button class="demo-nav" data-view="${DEMO_VIEW}" ${state.view===DEMO_VIEW?'aria-current="page"':""}>${icon("presentation")}<span>Panel de Demo</span></button>
    </div>`;
}
function bottomNavHtml(){
  const inPrimary = primaryMobile.some(p=>p.view===state.view);
  return primaryMobile.map(p=>`<button class="bn-btn" data-view="${escapeHtml(p.view)}" ${state.view===p.view?'aria-current="page"':""}>${icon(viewIcons[p.view])}<span>${escapeHtml(p.label)}</span></button>`).join("") +
    `<button class="bn-btn" data-action="open-more" aria-haspopup="dialog" ${!inPrimary?'aria-current="page"':""}>${icon("sliders-horizontal")}<span>Más</span></button>`;
}
function sheetHtml(){
  if(!state.moreOpen) return "";
  const rest = navItems.filter(n=>!primaryMobile.some(p=>p.view===n)).concat(DEMO_VIEW);
  return `<div class="sheet-backdrop" data-action="close-more"></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="Más secciones">
      <div class="sheet-heading"><h2>Más secciones</h2><button type="button" class="btn" data-action="close-more">Cerrar</button></div>
      <div class="feedback-slot">${feedbackControl()}</div>
      <nav class="nav">${rest.map(n=>`<button class="nav-btn" data-view="${escapeHtml(n)}" ${state.view===n?'aria-current="page"':""}>${icon(viewIcons[n])}<span>${escapeHtml(n)}</span></button>`).join("")}</nav>
    </div>`;
}
function headerHtml(title){
  const time = new Date().toLocaleString("es-CO",{dateStyle:"medium",timeStyle:"short"});
  const toLight = state.theme === "dark";
  return `
    <div>
      <h1>${escapeHtml(title)}</h1>
      <div class="header-sub">${escapeHtml(time)}</div>
    </div>
    <div class="header-actions">
      ${sourcePill()}
      ${pill(state.role,"good")}
      <button class="icon-btn" data-action="toggle-theme" aria-label="${toLight?"Cambiar a tema claro":"Cambiar a tema oscuro"}" title="${toLight?"Tema claro":"Tema oscuro"}">${icon(toLight?"sun":"moon")}</button>
      <button class="icon-btn" data-action="logout" aria-label="Cerrar sesión" title="Cerrar sesión">${icon("log-out")}</button>
    </div>`;
}
function mountShell(){
  document.getElementById("app").innerHTML = `
    <div class="app-shell">
      <aside class="sidebar" id="sidebar"></aside>
      <main class="main">
        <div class="card tint-warn" role="status">Prototipo en desarrollo: algunas vistas incluyen ejemplos. El control es simulado y no ejecuta órdenes físicas.</div>
        <div class="mobile-brand"><span class="logo">${icon("zap")}</span><span class="brand-name">Vatio</span><span class="site-name muted">Panadería La Espiga · Chía</span></div>
        <header class="header" id="header"></header>
        <div class="content" id="content"></div>
        ${contactFooter(true)}
      </main>
      <nav class="bottom-nav" id="bottom-nav" aria-label="Navegación principal"></nav>
      <div id="more-root"></div>
    </div>`;
}

const cache = {};
function setIfChanged(id, html){
  if(cache[id] === html) return false;
  cache[id] = html;
  document.getElementById(id).innerHTML = html;
  return true;
}

/* ---------- views ---------- */
function viewInicio(){
  if(!state.permissions.includes('view_simple')) return layout('<div class="card">Selecciona una sección disponible para tu perfil.</div>');
  const v=apiView('Inicio'); if(v.html) return v.html; const d=v.data;
  return layout(`<section class="grid4">${statCard({label:'Gasto de hoy',value:money(d.todaySpendCop),sub:escapeHtml(d.comparison?.text || ''),iconName:'trending-down'})}${statCard({label:'Alertas activas',value:String((d.alerts || []).length),iconName:'bell'})}</section><div class="two-col"><section class="card"><h2>Equipos por costo de hoy</h2>${(d.ranking || []).map(x=>`<div class="rank-row"><div class="rank-top"><span>${escapeHtml(x.name)}</span><strong>${money(x.costCop)}</strong></div></div>`).join('') || '<p>No hay lecturas disponibles.</p>'}</section><section class="card"><h2>Recomendaciones</h2>${(d.recommendations || []).map(x=>`<p>${escapeHtml(x.title)} · ${money(x.monthlySavingsCop)}/mes estimado</p>`).join('') || '<p>No hay recomendaciones disponibles.</p>'}<h2>Alertas</h2>${(d.alerts || []).map(x=>`<p>${escapeHtml(x.message)}</p>`).join('') || '<p>No hay alertas activas.</p>'}</section></div>`);
}

function viewOperaciones(){
  const v=apiView('Operaciones'); if(v.html) return v.html;
  return layout(`<section class="card"><h2>Equipos y consumo</h2>${tableData([['Equipo','name'],['Potencia W','currentPowerW'],['kWh de hoy','todayKwh'],['Costo de hoy COP','todayCostCop'],['Criticidad','criticalityLabel'],['Estado del módulo','moduleStatusText']],v.data.loads || [])}</section>`);
}

function deviceTable(devs){
  return `<div class="table-wrap"><table>
    <thead><tr><th>Equipo</th><th>Potencia</th><th>kWh acum.</th><th>Costo</th><th>Criticidad</th><th>Módulo</th><th>Estado</th></tr></thead>
    <tbody>${devs.map(d=>{
      const inactive = d.effective_status==="inactive";
      return `<tr>
      <td>${escapeHtml(d.load_name)}</td><td>${num(d.power_w,0)} W</td><td>${num(d.energy_kwh,3)}</td>
      <td>${money(Number(d.energy_kwh||0)*state.tariff)}</td><td>${escapeHtml(criticality[d.load_id]||"Esencial")}</td>
      <td>${escapeHtml(d.module_id)}</td><td><span class="status-dot ${inactive?"inactive":""}"></span>${inactive?"Inactivo":"Activo"}</td>
    </tr>`;}).join("")}</tbody>
  </table></div>`;
}

function buildAlerts(){
  const alerts = [];
  for(const r of readings()){
    if(r.effective_status==="inactive"){
      alerts.push({id:`inactive-${r.module_id}`, kind:"critical", type:"Pérdida de comunicación", load:r.load_name, detail:`Sin datos ${ageLabel(r)}`});
    }
    if(r.load_id==="freezer" && Number(r.power_w)>390){
      alerts.push({id:"freezer-maint",kind:"maintenance",type:"Mantenimiento",load:r.load_name,detail:"Potencia instantánea compatible con el escenario de deterioro +18 %."});
    }
    if(r.load_id==="sign" && Number(r.power_w)>100){
      const hour = new Date().getHours();
      if(hour>=20 || hour<6) alerts.push({id:"sign-offhours",kind:"critical",type:"Fuera de horario",load:r.load_name,detail:"Carga no esencial energizada con el local cerrado."});
    }
  }
  return alerts;
}

function viewAlertas(){
  const data = state.apiViews.Alertas;
  if(!data) return layout('<div class="card">Cargando alertas…</div>');
  if(data.error) return layout(`<div class="card" role="alert">${escapeHtml(data.error)}</div>`);
  return layout(`
    <div class="toolbar">${pill(`Activas · ${data.alerts.length}`,"info","bell")}</div>
    <div class="alert-grid">
      ${data.alerts.map(a=>`<article class="card alert-card">
        ${pill(a.type,"warn")}<h3>${escapeHtml(a.loadName || "Equipo")}</h3>
        <p class="small muted">${escapeHtml(a.message)}</p>
        ${state.permissions.includes("review_alert") ? `<button class="btn" data-review-alert="${a.id}">Marcar como revisada</button>` : ""}
      </article>`).join("") || '<div class="card empty">No hay alertas activas.</div>'}
    </div>
  `);
}

function viewRecomendaciones(){
  const data = state.apiViews.Recomendaciones;
  if(!data) return layout('<div class="card">Cargando recomendaciones…</div>');
  if(data.error) return layout(`<div class="card" role="alert">${escapeHtml(data.error)}</div>`);
  return layout(`<section class="stack">
    ${data.laya?.length ? `<section class="card"><h2>Laya · Demanda por equipo</h2>
      ${data.laya.map(l=>`<p><strong>${escapeHtml(l.name)}</strong> · ${l.lastReadingAt ? `Último envío del ESP32: ${Math.round(l.watts)} W (${escapeHtml(new Date(l.lastReadingAt).toLocaleString('es-CO'))})` : 'Esperando lecturas del ESP32'}<br>
      ${!l.ready ? `Aprendiendo el patrón de consumo: ${l.dayCount} de ${l.requiredDays} días completos.` : l.suggestion ? `Sugerencia para esta hora: ${l.suggestion === 'on' ? 'encender' : 'apagar'}.` : 'Sin sugerencia para esta hora.'}</p>`).join('')}</section>` : ''}
    ${data.recommendations.map(r=>`<article class="card recommendation">
      ${gauge(r.score,{cls:"score",text:String(r.score),label:`Puntaje ${r.score} de 100`})}
      <div class="rec-body"><h3>${escapeHtml(r.title)}</h3>
        <p>${escapeHtml(r.description || r.assumption || "")}</p>
        <div class="rec-saving">${money(r.monthlySavingsCop)}<span class="small muted"> /mes estimado</span></div>
      </div>
      ${state.permissions.includes("decide_recommendation") ? `<div class="actions">
        <button class="btn primary" data-recommendation="${r.id}" data-decision="accept">Aceptar</button>
        <button class="btn" data-recommendation="${r.id}" data-decision="postpone">Posponer</button>
        <button class="btn" data-recommendation="${r.id}" data-decision="discard">Descartar</button>
      </div>` : ""}
    </article>`).join("") || '<div class="card empty">No hay recomendaciones pendientes.</div>'}
  </section>`);
}

function viewControl(){
  const data = state.apiViews.Control;
  if(!data) return layout('<div class="card">Cargando control…</div>');
  if(data.error) return layout(`<div class="card" role="alert">${escapeHtml(data.error)}</div>`);
  const approvals = data.approvals || [];
  const closing = data.closing;
  return layout(`
    <section class="card tint-info">${cardHead("shield-check","Control simulado",
      "Las acciones se evalúan y registran en el servidor. No se controlan equipos físicos.")}</section>
    ${state.permissions.includes("approve_action") ? `
      <h2 class="section-title">Acciones pendientes de aprobación</h2>
      <div class="table-wrap"><table><thead><tr><th>Acción</th><th>Equipo</th><th>Motivo</th><th>Decisión</th></tr></thead>
      <tbody>${approvals.map(a=>`<tr><td>${a.action === "off" ? "Apagar" : "Encender"}</td>
        <td>${escapeHtml(a.loadName)}</td><td>${escapeHtml(a.reason || "")}</td>
        <td><button class="btn primary" data-control-id="${a.id}" data-control-action="approve">Aprobar</button>
        <button class="btn" data-control-id="${a.id}" data-control-action="reject">Rechazar</button></td></tr>`).join("") ||
          '<tr><td colspan="4">No hay acciones pendientes.</td></tr>'}
      </tbody></table></div>` : ""}
    ${data.executed ? `<section class="card"><h2>Decisiones simuladas de Laya</h2>${data.executed.filter(a=>a.rawOrigin === 'autonomous' && a.reason?.startsWith('Laya:')).map(a=>`<p>${escapeHtml(a.reason)} · ${escapeHtml(new Date(a.decidedAt).toLocaleString('es-CO'))}</p>`).join('') || '<p>Todavía no hay decisiones ejecutadas.</p>'}</section>` : ''}
    ${closing ? `<div class="gap"></div><section class="card"><h2>Modo cierre simulado</h2>
      <p>${escapeHtml(closing.estimatedNightlySavings.text)}</p>
      <h3>Equipos que se apagarían</h3>
      <ul>${closing.willSwitchOff.map(x=>`<li>${escapeHtml(x.name || x.loadName || x.loadId)}</li>`).join("") || "<li>Ninguno</li>"}</ul>
      <h3>Equipos que permanecen encendidos</h3>
      <ul>${closing.staysOn.map(x=>`<li>${escapeHtml(x.name || x.loadName || x.loadId)} · ${escapeHtml(x.reason || "")}</li>`).join("") || "<li>Ninguno</li>"}</ul>
      <button class="btn primary" data-action="confirm-closing">Confirmar modo cierre simulado</button>
    </section>` : ""}
    ${!closing && !state.permissions.includes("approve_action") ? '<div class="card">Tu perfil no tiene acciones de control disponibles.</div>' : ""}
  `);
}

function apiView(view){
  const data = state.apiViews[view];
  if(!data) return {html: layout('<div class="card">Cargando información…</div>')};
  if(data.error) return {html: layout(`<div class="card" role="alert">${escapeHtml(data.error)}</div>`)};
  return {data};
}
function tableData(columns, rows){
  return `<div class="table-wrap"><table><thead><tr>${columns.map(c=>`<th>${escapeHtml(c[0])}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${columns.map(c=>`<td>${escapeHtml(row[c[1]] ?? '—')}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${columns.length}">No hay datos disponibles.</td></tr>`}</tbody></table></div>`;
}
function viewAhorro(){
  const v=apiView('Ahorro y retorno'); if(v.html) return v.html;
  const d=v.data;
  return layout(`<section class="grid4">${statCard({label:'Ahorro acumulado estimado',value:money(d.cumulativeSavingsCop),sub:`${num(d.cumulativeSavingsKwh,2)} kWh`,iconName:'piggy-bank'})}${statCard({label:'Inversión',value:money(d.investmentCop),iconName:'database'})}${statCard({label:'Retorno',value:escapeHtml(d.payback?.label || 'No estimable'),sub:escapeHtml(d.payback?.message || ''),iconName:'clock'})}${statCard({label:'Equipos con línea base',value:String(d.loadsWithBaseline),iconName:'activity'})}</section><section class="card"><p>${escapeHtml(d.note || '')}</p><h2>Consumo por semana</h2>${tableData([['Desde','weekStart'],['Hasta','weekEnd'],['Línea base kWh','baselineKwh'],['Consumo kWh','actualKwh']],d.weekly || [])}</section>`,'Ahorro y retorno');
}
function viewReportes(){
  const v=apiView('Reportes'); if(v.html) return v.html; const d=v.data;
  if(!d.summary) return layout(`<section class="card"><h2>Impacto ODS 7</h2><p>Energía evitada: ${num(d.avoidedKwh,2)} kWh · Emisiones evitadas: ${num(d.avoidedKgCo2e,2)} kg CO₂e</p><p>${escapeHtml(d.methodology || '')}</p>${state.permissions.includes('download_impact_report')?'<a class="btn" href="/api/reports/impact/download?format=pdf">Descargar impacto ODS 7</a>':''}</section>`);
  return layout(`<section class="card"><h2>Reporte mensual · ${escapeHtml(d.month)}</h2><p>${escapeHtml(d.note || '')}</p>${tableData([['Equipo','name'],['Consumo kWh','consumptionKwh'],['Costo COP','consumptionCostCop'],['Ahorro COP','savingsCop']],d.loads || [])}<div class="actions">${state.permissions.includes('download_report')?'<a class="btn primary" href="/api/reports/monthly/download?format=csv">Descargar CSV</a><a class="btn" href="/api/reports/monthly/download?format=pdf">Descargar PDF</a>':''}${state.permissions.includes('download_impact_report')?'<a class="btn" href="/api/reports/impact/download?format=pdf">Descargar impacto ODS 7</a>':''}</div></section>`);
}
function viewModulos(){
  const v=apiView('Módulos'); if(v.html) return v.html;
  return layout(`<section class="card"><h2>Estado de módulos</h2>${tableData([['Módulo','id'],['Fabricante','manufacturer'],['Equipo','loadName'],['Estado','statusText'],['Última señal','lastHeartbeat']],v.data.modules || [])}</section>`,'Estado de módulos');
}
function viewDatos(){
  const v=apiView('Datos crudos'); if(v.html) return v.html;
  const cols=(v.data.columns || []).map(c=>[c,c]);
  return layout(`<section class="card"><h2>Lecturas guardadas</h2><p>Se muestran hasta ${escapeHtml(v.data.limit)} registros.</p>${state.permissions.includes('export_raw_data')?'<a class="btn" href="/api/data/export?format=csv">Exportar CSV</a> <a class="btn" href="/api/data/export?format=json">Exportar JSON</a>':''}${tableData(cols,v.data.rows || [])}</section>`,'Datos crudos');
}
function viewMultisede(){
  const v=apiView('Multisede'); if(v.html) return v.html;
  return layout(`<section class="card"><h2>Comparación por sede</h2>${tableData([['Sede','name'],['Días de operación','operatingDays'],['kWh/día','kwhPerOperatingDay'],['COP/día','copPerOperatingDay'],['Ahorro COP/día','savingsCopPerOperatingDay'],['Reducción %','reductionPct']],v.data.rows || [])}</section>`,'Comparación multisede');
}
function viewConfiguracion(){
  const v=apiView('Configuración'); if(v.html) return v.html; const d=v.data;
  return layout(`${d.settings?`<section class="card"><h2>Configuración</h2><div class="form-grid"><div class="field"><label for="investment">Inversión COP</label><input id="investment" type="number" min="0" value="${escapeHtml(d.settings.investmentCop)}"></div><div class="field"><label for="threshold">Umbral de alerta %</label><input id="threshold" type="number" min="1" max="500" value="${escapeHtml(d.settings.alertThresholdPct)}"></div><div class="field"><label for="window">Ventana en minutos</label><input id="window" type="number" min="1" max="120" value="${escapeHtml(d.settings.alertWindowMinutes)}"></div></div><button class="btn primary" data-action="save-settings">Guardar cambios</button></section>`:''}${state.permissions.includes('view_ops')?`<section class="card"><h2>Correo electrónico</h2><p>${d.email?.configured?'Correo configurado.':'Correo no configurado.'}</p><button class="btn" data-action="test-email">Enviar correo de prueba</button></section>`:''}${state.permissions.includes('manage_backups')?`<section class="card"><h2>Copias de seguridad</h2><p>Las copias locales deben descargarse fuera del servidor. El disco del plan gratuito de Render es temporal.</p><button class="btn" data-action="create-backup">Crear respaldo</button><ul>${(d.backups?.backups || []).map(b=>`<li><a href="/api/ops/backups/${encodeURIComponent(b.name)}/download">${escapeHtml(b.name)}</a> · ${num(b.size_bytes,0)} bytes</li>`).join('') || '<li>No hay copias disponibles.</li>'}</ul></section>`:''}`);
}

function viewDemo(){
  const endpoint = state.info?.telemetry_urls?.[0] || "http://IP_DEL_PC:3000/api/telemetry";
  return layout(`
    <section class="card tint-good">
      ${cardHead("presentation","Herramientas del presentador","La demo local puede funcionar sin hardware o recibir el ESP32 real.")}
    </section>
    <div class="gap"></div>
    <div class="demo-grid">
      <section class="card demo-tool">${cardHead("plug","Conectar ESP32","Usa esta URL en el firmware:","info")}<div class="endpoint">${escapeHtml(endpoint)}</div><button class="btn" data-action="copy-endpoint">${icon("copy","sm")}Copiar endpoint</button></section>
      <section class="card demo-tool tint-warn">${cardHead("cpu","Simulador","Si aún no llegó hardware, la página genera cargas virtuales automáticamente.","warn")}</section>
      <section class="card demo-tool tint-bad">${cardHead("shield-check","Seguridad","Demuestra que una carga crítica no puede apagarse.","bad")}<button class="btn danger" data-action="critical-off">${icon("power","sm")}Intentar apagar congelador</button></section>
      <section class="card demo-tool">${cardHead("code-xml","API","Salud del servidor y direcciones de red local.","info")}<div class="codebox" tabindex="0" aria-label="Información del servidor en JSON">${escapeHtml(JSON.stringify(state.info,null,2))}</div></section>
    </div>
  `,"Panel de Demo");
}

const renderers = {
  "Inicio":viewInicio,
  "Operaciones":viewOperaciones,
  "Alertas":viewAlertas,
  "Recomendaciones":viewRecomendaciones,
  "Control":viewControl,
  "Ahorro y retorno":viewAhorro,
  "Reportes":viewReportes,
  "Módulos":viewModulos,
  "Datos crudos":viewDatos,
  "Multisede":viewMultisede,
  "Configuración":viewConfiguracion,
  "Panel de Demo":viewDemo
};

/* ---------- render ---------- */
function isEditing(){
  const a = document.activeElement;
  return !!a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName);
}
function chartHovered(){
  return !!document.querySelector(".chart-box:hover");
}

function render(opts={}){
  // Polling must not wipe a field being edited or a tooltip being read.
  if(opts.poll && (isEditing() || chartHovered())) return;
  if(!document.getElementById("content")) mountShell();
  pendingCharts = [];
  chartSeq = 0;
  const v = (renderers[state.view] || viewInicio)();
  setIfChanged("header", headerHtml(v.title));
  setIfChanged("sidebar", sidebarHtml());
  setIfChanged("bottom-nav", bottomNavHtml());
  setIfChanged("more-root", sheetHtml());
  const contentEl = document.getElementById("content");
  const contentHtml = v.content;
  if(opts.force || cache.content !== contentHtml){
    cache.content = contentHtml;
    contentEl.className = "content" + (state.animate ? " enter" : "");
    contentEl.innerHTML = contentHtml;
    mountAllCharts();
  }
  state.animate = false;
}

async function loadOperationalView(view){
  const routes = { Inicio: "/api/simple", Operaciones: "/api/loads", Alertas: "/api/alerts?view=active", Recomendaciones: "/api/recommendations", "Ahorro y retorno":"/api/savings", Reportes:"/api/reports/monthly", "Módulos":"/api/modules", "Datos crudos":"/api/data/readings", Multisede:"/api/multisite" };
  if(view === "Configuración"){
    try {
      const endpoints=[];
      if(state.permissions.includes('configure')) endpoints.push(['settings','/api/settings']);
      if(state.permissions.includes('view_ops')) endpoints.push(['email','/api/ops/email']);
      if(state.permissions.includes('manage_backups')) endpoints.push(['backups','/api/ops/backups']);
      const results=await Promise.all(endpoints.map(async ([key,url])=>{ const r=await fetch(url,{cache:'no-store'}); if(r.status===401){endSession();throw Error('Sesión finalizada.');} const d=await r.json(); if(!r.ok) throw Error(d.error || 'No se pudo cargar la configuración.'); return [key,d]; }));
      state.apiViews[view]=Object.fromEntries(results);
    } catch(e){ state.apiViews[view]={error:e.message || 'No se pudo conectar con el servidor.'}; }
    if(state.view===view) render({force:true}); return;
  }
  if(view === "Control"){
    try {
      const endpoints = [];
      if(state.permissions.includes("approve_action")) endpoints.push(["approvals", "/api/control/approvals"], ["executed", "/api/control/approvals?status=executed"]);
      if(state.permissions.includes("activate_closing_mode")) endpoints.push(["closing", "/api/control/closing-mode"]);
      const results = await Promise.all(endpoints.map(async ([key, url]) => {
        const response = await fetch(url, {cache:"no-store"});
        if(response.status === 401){ endSession(); throw new Error("session"); }
        const body = await response.json();
        if(!response.ok) throw new Error(body.error || "No fue posible cargar el control.");
        return [key, key === "closing" ? body : body.approvals];
      }));
      state.apiViews.Control = Object.fromEntries(results);
    } catch(error) {
      state.apiViews.Control = {error:error.message === "session" ? "Sesión finalizada." : error.message || "No se pudo conectar con el servidor."};
    }
    if(state.view === view) render({force:true});
    return;
  }
  if(view === 'Inicio' && !state.permissions.includes('view_simple')) return;
  if(view === 'Reportes' && !state.permissions.includes('view_reports') && state.permissions.includes('view_impact_report')) routes.Reportes='/api/reports/impact';
  if(!routes[view]) return;
  try {
    const response = await fetch(routes[view], {cache:"no-store"});
    const body = await response.json();
    if(response.status === 401){ endSession(); return; }
    state.apiViews[view] = response.ok ? body : {error: body.error || "No fue posible cargar esta vista."};
  } catch {
    state.apiViews[view] = {error:"No se pudo conectar con el servidor."};
  }
  if(state.view === view) render({force:true});
}

async function submitOperationalAction(url, body, view){
  try {
    const response = await fetch(url, {
      method:"POST", headers:{"content-type":"application/json","x-csrf-token":state.csrf},
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if(response.status === 401){ endSession(); return; }
    if(!response.ok){ toast(result.error || "No fue posible guardar el cambio."); return; }
    toast("Cambio guardado.");
    await loadOperationalView(view);
  } catch {
    toast("No se pudo conectar con el servidor.");
  }
}

function setView(view){
  state.view = view;
  state.moreOpen = false;
  state.animate = true;
  render({force:true});
  window.scrollTo(0,0);
  loadOperationalView(view);
}

function applyTheme(theme){
  state.theme = theme;
  document.documentElement.setAttribute("data-theme", theme);
  try{ localStorage.setItem("vatio_theme", theme); }catch(e){}
  const meta = document.querySelector('meta[name="theme-color"]');
  if(meta) meta.setAttribute("content", theme==="light" ? "#dff3e8" : "#0a1218");
  render({force:true});
}

/* ---------- exports ---------- */
function csvEscape(v){
  const s = String(v ?? "");
  return `"${s.replaceAll('"','""')}"`;
}
function download(filename, content, type){
  const blob = new Blob([content],{type});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),500);
}
function exportCsv(){
  const headers=["module_id","load_id","load_name","manufacturer","voltage_v","current_a","power_w","energy_kwh","status","timestamp","received_at"];
  const lines=[headers.join(","),...readings().map(r=>headers.map(h=>csvEscape(r[h])).join(","))];
  download("vatio_telemetria.csv",lines.join("\n"),"text/csv;charset=utf-8");
}
function exportJson(){
  download("vatio_telemetria.json",JSON.stringify(state.telemetry,null,2),"application/json");
}

/* ---------- data loading ---------- */
async function fetchInfo(){
  try{ state.info = await fetch("/api/info",{cache:"no-store"}).then(r=>r.json()); }catch(e){}
}
async function fetchTelemetry(){
  try{
    const response = await fetch("/api/telemetry/latest",{cache:"no-store"});
    if(response.status===401){ endSession(); return; }
    const next = await response.json();
    const changedSource = state.telemetry && state.telemetry.source !== next.source;
    const first = !state.telemetry;
    state.telemetry = next;
    if(changedSource) toast(next.source==="esp32" ? "ESP32 conectado: telemetría en vivo." : "Volviste al simulador.");
    pushHistory();
    render({poll:!first && !changedSource});
  }catch(e){
    console.error(e);
  }
}
// The session lives only in an HttpOnly cookie (unreadable from JS) and the CSRF token is kept in memory
// only; nothing sensitive is written to localStorage. Logging out clears both and reloads a clean page.
function endSession(){
  state.csrf = "";
  state.role = "";
  state.telemetry = null;
  location.replace("/");
}
async function logout(){
  try{ await fetch("/api/auth/logout",{method:"POST",headers:{"x-csrf-token":state.csrf}}); }catch(e){}
  endSession();
}
async function resetSource(){
  await fetch("/api/reset",{method:"POST",headers:{"x-csrf-token":state.csrf}});
  await fetchTelemetry();
}
function cycleRole(){
  const roles=["Administrador","Gerente de operaciones","Empleado de cierre","Responsable financiero","Analista de datos"];
  const i=roles.indexOf(state.role);
  state.role=roles[(i+1)%roles.length]; render({force:true});
}

/* ---------- events ---------- */
document.addEventListener("click", async (event)=>{
  const viewBtn = event.target.closest("[data-view]");
  if(viewBtn){ setView(viewBtn.dataset.view); return; }

  const controlAction = event.target.closest("[data-control-id]");
  if(controlAction){
    controlAction.disabled = true;
    const id = encodeURIComponent(controlAction.dataset.controlId);
    const action = controlAction.dataset.controlAction;
    await submitOperationalAction(`/api/control/approvals/${id}/${action}`, {}, "Control");
    controlAction.disabled = false;
    return;
  }

  const decision = event.target.closest("[data-recommendation]");
  if(decision){
    decision.disabled = true;
    await submitOperationalAction(`/api/recommendations/${encodeURIComponent(decision.dataset.recommendation)}/decision`,
      {action:decision.dataset.decision}, "Recomendaciones");
    decision.disabled = false;
    return;
  }

  const review = event.target.closest("[data-review-alert]");
  if(review){
    review.disabled = true;
    await submitOperationalAction(`/api/alerts/${encodeURIComponent(review.dataset.reviewAlert)}/review`, {}, "Alertas");
    review.disabled = false;
    return;
  }

  const action = event.target.closest("[data-action]")?.dataset.action;
  if(!action) return;

  if(action==="cycle-role") cycleRole();
  if(action==="toggle-theme") applyTheme(state.theme==="dark" ? "light" : "dark");
  if(action==="logout") logout();
  if(action==="feedback-unavailable") toast("Canal no configurado");
  if(action==="open-more"){
    state.moreOpen = true;
    render({force:true});
    document.querySelector('.sheet [data-action="close-more"]').focus();
  }
  if(action==="close-more") closeMore();
  if(action==="download-csv") exportCsv();
  if(action==="download-json") exportJson();
  if(action==="reset-source") await resetSource();
  if(action==="critical-off") {
    const r=await fetch('/api/control/requests',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':state.csrf},body:JSON.stringify({site_id:'la-espiga-chia',load_id:'freezer',action:'off'})});
    const result=await r.json(); toast(result.error || 'Solicitud procesada.');
  }
  if(action==="confirm-closing"){
    const button = event.target.closest("[data-action]");
    button.disabled = true;
    await submitOperationalAction("/api/control/closing-mode", {confirm:true}, "Control");
    button.disabled = false;
  }
  if(action==="test-email"){
    const button = event.target.closest("[data-action]");
    button.disabled = true;
    try {
      const response = await fetch("/api/ops/email/test", {method:"POST",headers:{"x-csrf-token":state.csrf}});
      const result = await response.json();
      if(response.status === 401){ endSession(); return; }
      toast(response.ok ? "Correo de prueba aceptado por el servidor de correo." : (result.error || "No se pudo enviar el correo de prueba."));
    } catch {
      toast("No se pudo conectar con el servidor.");
    } finally {
      button.disabled = false;
    }
  }
  if(action==="create-backup"){
    const button=event.target.closest('[data-action]'); button.disabled=true;
    try {const r=await fetch('/api/ops/backups',{method:'POST',headers:{'x-csrf-token':state.csrf}}); const d=await r.json(); if(!r.ok) toast(d.error || 'No se pudo crear el respaldo.'); else {toast('Respaldo creado.'); await loadOperationalView('Configuración');}} catch {toast('No se pudo conectar con el servidor.');} finally {button.disabled=false;}
  }
  if(action==="copy-endpoint"){
    const text=state.info?.telemetry_urls?.[0] || "";
    try{ await navigator.clipboard?.writeText(text); }catch(e){}
    toast("Endpoint copiado.");
  }
  if(action==="save-settings"){
    const payload={investmentCop:Number(document.getElementById('investment').value),alertThresholdPct:Number(document.getElementById('threshold').value),alertWindowMinutes:Number(document.getElementById('window').value)};
    try { const r=await fetch('/api/settings',{method:'PUT',headers:{'content-type':'application/json','x-csrf-token':state.csrf},body:JSON.stringify(payload)}); const d=await r.json(); if(!r.ok){toast(d.error || 'No se pudo guardar.');return;} toast('Configuración guardada.'); await loadOperationalView('Configuración'); } catch {toast('No se pudo conectar con el servidor.');}
  }
});

document.addEventListener("keydown", (event)=>{
  if(!state.moreOpen) return;
  if(event.key==="Escape") closeMore();
  if(event.key==="Tab"){
    const controls = [...document.querySelectorAll(".sheet button, .sheet a")];
    const first = controls[0];
    const last = controls.at(-1);
    if(event.shiftKey && document.activeElement === first){ event.preventDefault(); last.focus(); }
    else if(!event.shiftKey && document.activeElement === last){ event.preventDefault(); first.focus(); }
  }
});

let resizeTimer = null;
window.addEventListener("resize", ()=>{
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(mountAllCharts, 150);
});

(async function init(){
  try {
    const response = await fetch("/api/public/contact");
    if(response.ok) contact = await response.json();
  } catch { /* Contact configuration is optional for sign-in. */ }

  async function authenticate(){
    let response = await fetch('/api/auth/me');
    if (!response.ok) {
      const root=document.getElementById('app');
      root.innerHTML=`<main class="card login-card"><h1>Ingresar a VATIO</h1><p>Usa el usuario configurado para esta instalación.</p>
        <form id="login-form">
          <div class="field"><label for="username">Usuario</label><input id="username" autocomplete="username" required></div>
          <div class="field"><label for="password">Contraseña</label><input id="password" type="password" autocomplete="current-password" required></div>
          <fieldset id="activation-consent" hidden disabled>
            <legend>Activación de la cuenta</legend>
            <label><input id="habeas-data-accepted" type="checkbox" required> Autorizo el tratamiento de mis datos según la Política de Tratamiento.</label>
            <label><input id="terms-accepted" type="checkbox" required> Acepto los Términos y Condiciones.</label>
          </fieldset>
          <p id="login-error" role="alert"></p><button class="btn primary" type="submit">Ingresar</button>
        </form>${contactFooter()}</main>`;
      const form = document.getElementById("login-form");
      const consent = document.getElementById("activation-consent");
      const habeas = document.getElementById("habeas-data-accepted");
      const terms = document.getElementById("terms-accepted");
      const error = document.getElementById("login-error");
      const submit = form.querySelector("button[type=submit]");
      let versions = null;
      let submitting = false;
      const updateSubmit = () => { submit.disabled = submitting || (versions && !(habeas.checked && terms.checked)); };
      consent.addEventListener("change", updateSubmit);
      response = await new Promise(resolve => {
        form.addEventListener("submit", async event => {
          event.preventDefault();
          if(submit.disabled) return;
          submitting = true;
          updateSubmit();
          error.textContent = "";
          try {
            const r = await fetch("/api/auth/login", {
              method:"POST", headers:{"content-type":"application/json"},
              body:JSON.stringify({
                username:document.getElementById("username").value, password:document.getElementById("password").value,
                ...(versions && { ...versions, habeasDataAccepted:habeas.checked, termsAccepted:terms.checked }),
              }),
            });
            if(r.ok) return resolve(r);
            if(r.status === 428){
              const { policyVersion, termsVersion, error:message } = await r.json();
              versions = { policyVersion, termsVersion };
              consent.hidden = consent.disabled = habeas.checked = terms.checked = false;
              submit.textContent = "Activar e ingresar";
              error.textContent = message;
              habeas.focus();
            } else {
              error.textContent = r.status === 429 ? "Demasiados intentos. Intenta nuevamente en un minuto." : "No fue posible iniciar sesión.";
            }
          } catch {
            error.textContent = "No se pudo conectar con el servidor.";
          } finally {
            submitting = false;
            updateSubmit();
          }
        });
      });
    }
    const user=await response.json(); state.role=user.role; state.csrf=user.csrf; state.permissions=user.permissions || [];
  }
  await authenticate();
  render({force:true});
  await fetchInfo();
  await loadOperationalView(state.view);
  await fetchTelemetry();
  setInterval(fetchTelemetry, 2000);
  let refreshPending = false;
  setInterval(async () => {
    if (refreshPending || document.hidden || isEditing()) return;
    if (!['Inicio', 'Operaciones', 'Alertas', 'Módulos', 'Datos crudos', 'Recomendaciones', 'Control'].includes(state.view)) return;
    refreshPending = true;
    try { await loadOperationalView(state.view); } finally { refreshPending = false; }
  }, 5000);
})();
