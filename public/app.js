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
  role: localStorage.getItem("vatio_role") || "Administrador",
  accepted: new Set(),
  reviewedAlerts: new Set(),
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
function navButtons(){
  return navItems.map(n=>`<button class="nav-btn" data-view="${escapeHtml(n)}" ${state.view===n?'aria-current="page"':""}>${icon(viewIcons[n])}<span>${escapeHtml(n)}</span></button>`).join("");
}
function sidebarHtml(){
  return `
    <div class="brand"><span class="logo">${icon("zap","lg")}</span><span class="brand-name">Vatio</span></div>
    <p class="site-name">Panadería La Espiga · Chía</p>
    <nav class="nav" aria-label="Secciones">${navButtons()}</nav>
    <div class="sidebar-foot">
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
      <h2>Más secciones</h2>
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
      <button class="btn" data-action="cycle-role" aria-label="Cambiar rol">${icon("user-round","sm")}<span class="label">Cambiar rol</span></button>
      <button class="icon-btn" data-action="toggle-theme" aria-label="${toLight?"Cambiar a tema claro":"Cambiar a tema oscuro"}" title="${toLight?"Tema claro":"Tema oscuro"}">${icon(toLight?"sun":"moon")}</button>
    </div>`;
}
function mountShell(){
  document.getElementById("app").innerHTML = `
    <div class="app-shell">
      <aside class="sidebar" id="sidebar"></aside>
      <main class="main">
        <div class="mobile-brand"><span class="logo">${icon("zap")}</span><span class="brand-name">Vatio</span><span class="site-name muted">Panadería La Espiga · Chía</span></div>
        <header class="header" id="header"></header>
        <div class="content" id="content"></div>
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
  const devs = sortedDevices();
  const costs = devs.map(r=>({ ...r, estCost:Number(r.power_w)*8/1000*state.tariff }));
  const max = Math.max(...costs.map(x=>x.estCost), 1);
  const source = state.telemetry?.source === "esp32";
  const alerts = buildAlerts();
  const total = totalPower();
  const nonEssential = readings().filter(r=>criticality[r.load_id]==="No esencial").reduce((a,r)=>a+Number(r.power_w||0),0);
  const pct = total > 0 ? Math.round(nonEssential/total*100) : 0;
  const liveCfg = {
    aria:"Potencia total en las últimas lecturas", xName:"Hora",
    labels: state.history.map(h=>h.label),
    series:[{name:"Potencia total", data:state.history.map(h=>h.totalKw), color:"--chart-1", area:true}],
    fmt:v=>num(v,2)+" kW", axisFmt:v=>num(v,1), ySize:44
  };
  return layout(`
    ${bannerBlock(
      source ? "Telemetría recibida desde hardware" : "Modo demostración sin hardware",
      source ? `Gateway ${state.telemetry.gateway?.gateway_id || ""}` : "Conecta el ESP32 y el dashboard cambiará automáticamente.",
      state.info?.telemetry_urls?.[0] || "Cargando endpoint...",
      source ? "plug" : "cpu")}
    <section class="hero">
      <div class="card hero-gauge">
        <div><h2>Consumo no esencial</h2><div class="small muted">Parte del consumo actual que se puede programar</div></div>
        ${gauge(pct,{size:"188px", text:`${pct} %`, sub:"del total ahora", label:`Consumo no esencial: ${pct} % del total`})}
        <div class="small muted">${num(nonEssential/1000,2)} kW de ${num(total/1000,2)} kW en uso</div>
      </div>
      <div class="hero-stats">
        ${statCard({label:"Gasto de lecturas acumuladas", value:money(currentCost()), sub:source ? "Datos enviados por ESP32" : "Datos simulados", iconName:"trending-down", tone:"accent"})}
        ${statCard({label:"Potencia instantánea", value:`${num(totalPower()/1000,2)}<small>kW</small>`, sub:`${readings().length} cargas visibles`, iconName:"zap"})}
        ${statCard({label:"Ahorro acumulado", value:"$ 428.600", sub:"Valor demostrativo del prototipo", iconName:"piggy-bank"})}
        ${statCard({label:"Alertas activas", value:String(alerts.length), sub:`${alerts.filter(a=>a.kind==="critical").length} requiere revisión`, iconName:"bell", tone:alerts.length?"warn":""})}
      </div>
    </section>
    <div class="two-col">
      <section class="card">
        ${cardHead("trending-down","¿Qué está costando más ahora?","Ranking por potencia actual y costo estimado de 8 h")}
        ${costs.slice(0,7).map(x=>`
          <div class="rank-row">
            <div class="rank-top"><span>${escapeHtml(x.load_name)}</span><strong>${money(x.estCost)}</strong></div>
            <div class="track" role="img" aria-label="${escapeHtml(x.load_name)}: ${money(x.estCost)}"><span style="width:${Math.max(3,x.estCost/max*100)}%"></span></div>
          </div>`).join("") || `<div class="empty">Esperando lecturas...</div>`}
      </section>
      <section class="card">
        ${cardHead("activity","Potencia en vivo","Suma de todas las cargas, últimas lecturas","info")}
        ${chartBlock(liveCfg, 260)}
      </section>
    </div>
    <div class="two-col even">
      <section class="card tint-bad">
        ${cardHead("clock","El letrero puede quedar encendido después del cierre.","El ESP32 simula este comportamiento por la noche para disparar la demostración.","bad")}
        ${pill("Fuera de horario","bad","triangle-alert")}
      </section>
      <section class="card">
        ${cardHead("lightbulb","Top recomendaciones")}
        ${[
          "Programar apagado del letrero · $ 14.400/mes",
          "Reducir standby de cafetera · $ 11.800/mes",
          "Revisar congelador · consumo +18 %"
        ].map((x,i)=>`<div class="rec-line"><span class="rec-num">${i+1}</span><span>${escapeHtml(x)}</span></div>`).join("")}
      </section>
    </div>
  `);
}

function viewOperaciones(){
  const devs = sortedDevices();
  const total = totalPower() || 1;
  const top = devs.slice(0,3);
  const palette = ["--chart-1","--chart-2","--chart-3"];
  const liveCfg = {
    aria:"Potencia de las tres cargas con mayor consumo", xName:"Hora",
    labels: state.history.map(h=>h.label),
    series: top.map((d,i)=>({
      name:d.load_name, color:palette[i],
      data: state.history.map(h=>h.loads[d.load_id] ?? null)
    })),
    fmt:v=>num(v,0)+" W", axisFmt:v=>num(v,0), ySize:48
  };
  return layout(`
    <div class="toolbar">
      ${pill(`${devs.length} cargas`,"good","plug")}
      ${pill(`Críticas: ${devs.filter(d=>criticality[d.load_id]==="Crítica").length}`,"info","shield-check")}
      ${pill(`Inactivas: ${devs.filter(d=>d.effective_status==="inactive").length}`,"warn","pause")}
    </div>
    <section class="card">
      ${cardHead("activity","Las tres cargas que más consumen","Potencia en vatios, últimas lecturas","info")}
      ${chartBlock(liveCfg, 260)}
    </section>
    <div class="gap"></div>
    <section class="device-live-grid">
      ${devs.map(d=>{
        const share = Number(d.power_w||0)/total*100;
        const inactive = d.effective_status==="inactive";
        return `
        <article class="device-card ${inactive?"inactive":""}">
          <div class="device-top">
            <div class="device-name"><span class="status-dot ${inactive?"inactive":""}"></span><span>${escapeHtml(d.load_name)}</span></div>
            ${gauge(share,{cls:"mini", text:`${Math.round(share)} %`, label:`${d.load_name}: ${Math.round(share)} % del consumo total`})}
          </div>
          <div class="device-power">${num(d.power_w,0)} <small>W</small></div>
          <div class="device-meta">${escapeHtml(criticality[d.load_id] || "Esencial")} · ${escapeHtml(d.module_id)}<br>
          ${num(d.voltage_v,1)} V · ${num(d.current_a,2)} A<br>Actualizado ${escapeHtml(ageLabel(d))}</div>
        </article>`;}).join("") || `<div class="card empty">Esperando lecturas...</div>`}
    </section>
    <div class="gap"></div>
    ${deviceTable(devs)}
  `);
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
      alerts.push({id:`inactive-${r.module_id}`, kind:"critical", type:"Módulo inactivo", load:r.load_name, detail:`Sin datos ${ageLabel(r)}`});
    }
    if(r.load_id==="freezer" && Number(r.power_w)>390){
      alerts.push({id:"freezer-maint",kind:"maintenance",type:"Mantenimiento",load:r.load_name,detail:"Potencia instantánea compatible con el escenario de deterioro +18 %."});
    }
    if(r.load_id==="sign" && Number(r.power_w)>100){
      const hour = new Date().getHours();
      if(hour>=20 || hour<6) alerts.push({id:"sign-offhours",kind:"critical",type:"Fuera de horario",load:r.load_name,detail:"Carga no esencial energizada con el local cerrado."});
    }
  }
  return alerts.filter(a=>!state.reviewedAlerts.has(a.id));
}

function viewAlertas(){
  const alerts = buildAlerts();
  const trend = [42,46,45,51,54,58,61,67,70,72,78,80];
  const trendCfg = {
    aria:"Tendencia de mantenimiento del congelador en 12 semanas", xName:"Semana",
    labels: trend.map((_,i)=>String(i+1)), tipLabel:i=>`Semana ${i+1}`,
    series:[{name:"Índice de desgaste", data:trend, color:"--chart-3", area:true}],
    fmt:v=>num(v,0), axisFmt:v=>num(v,0), yMax:100, ySize:40, maxTicks:6
  };
  return layout(`
    <div class="toolbar">${pill(`Activas · ${alerts.length}`,"good","bell")}${pill("Actualización automática","neutral","refresh-cw")}</div>
    <div class="alert-grid">
      ${alerts.map(a=>{
        const maint = a.kind==="maintenance";
        return `<article class="card alert-card ${maint?"tint-info":"tint-bad"}">
        <span class="chip ${maint?"info":"bad"}">${icon(maint?"wrench":"triangle-alert")}</span>
        ${pill(a.type, maint?"info":"bad")}
        <h3>${escapeHtml(a.load)}</h3>
        <p class="small muted">${escapeHtml(a.detail)}</p>
        <button class="btn" data-review-alert="${escapeHtml(a.id)}">${icon("check","sm")}Marcar como revisada</button>
      </article>`;}).join("") || `<div class="card empty" style="grid-column:1/-1"><span class="chip">${icon("circle-check","lg")}</span><strong>Todo en orden</strong><span>No hay alertas activas con las lecturas actuales.</span></div>`}
    </div>
    <div class="gap"></div>
    <section class="card">
      ${cardHead("wrench","Tendencia de mantenimiento · Congelador","Representación visual del escenario del prototipo.","warn")}
      ${chartBlock(trendCfg, 240)}
    </section>
  `);
}

const recommendations = [
  {id:"sign",score:92,load:"Letrero luminoso",action:"Programar apagado automático al cierre",saving:14400,confidence:"Alta",icon:"lightbulb"},
  {id:"coffee",score:78,load:"Cafetera industrial",action:"Reducir standby fuera de horario",saving:11800,confidence:"Alta",icon:"zap"},
  {id:"freezer",score:64,load:"Congelador vertical",action:"Revisar equipo por aumento sostenido",saving:7800,confidence:"Media",icon:"snowflake"},
  {id:"ac",score:51,load:"Aire acondicionado",action:"Programar apagado a las 20:15",saving:6100,confidence:"Media",icon:"clock"}
];

function viewRecomendaciones(){
  return layout(`
    <section class="stack">
      ${recommendations.map(r=>{
        const done = state.accepted.has(r.id);
        return `
        <article class="card recommendation">
          ${gauge(r.score,{cls:"score", text:String(r.score), label:`Puntaje ${r.score} de 100`})}
          <div class="rec-body"><h3>${escapeHtml(r.load)} · ${escapeHtml(r.action)}</h3>
            <div class="rec-saving">${money(r.saving)}<span class="small muted" style="font-weight:600"> /mes</span></div>
            <div class="rec-meta">${pill(`Confianza ${r.confidence}`, r.confidence==="Alta"?"good":"info")}
              <span class="small muted">Puntaje = ahorro normalizado × criticidad × confianza</span></div>
          </div>
          <div class="actions">
            <button class="btn primary" data-accept="${r.id}" ${done?"disabled":""}>${icon(done?"check":"circle-check","sm")}${done?"Aceptada":"Aceptar"}</button>
            <button class="btn">${icon("hourglass","sm")}Posponer</button>
          </div>
        </article>`;}).join("")}
    </section>
  `);
}

function viewControl(){
  const pending = recommendations.filter(r=>state.accepted.has(r.id));
  return layout(`
    <section class="card tint-good">
      ${cardHead("shield-check","Control seguro por diseño","Las cargas críticas nunca se apagan. Toda acción de control requiere aprobación explícita.")}
    </section>
    <h2 class="section-title">Acciones pendientes de aprobación</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>Acción</th><th>Carga</th><th>Ahorro</th><th>Estado</th><th><span class="sr-only">Acciones</span></th></tr></thead>
      <tbody>
      ${pending.map(r=>`<tr><td>${escapeHtml(r.action)}</td><td>${escapeHtml(r.load)}</td><td>${money(r.saving)}/mes</td><td>${pill("Pendiente","warn","hourglass")}</td>
        <td><button class="btn primary" data-approve="${r.id}">${icon("check","sm")}Aprobar</button></td></tr>`).join("") ||
        `<tr><td colspan="5" class="muted">Acepta una recomendación para crear una acción pendiente.</td></tr>`}
      <tr><td>Apagar</td><td>Congelador vertical</td><td>—</td><td>${pill("Rechazada · crítica","bad","circle-x")}</td><td></td></tr>
      </tbody>
    </table></div>
    <div class="gap"></div>
    <section class="card">
      ${cardHead("file-text","Auditoría")}
      <div class="kpi-line"><span>Intentar apagar congelador</span><strong style="color:var(--bad)">Rechazada · carga crítica</strong></div>
      <div class="kpi-line"><span>Telemetría de módulos</span><strong>${state.telemetry?.source==="esp32"?"Hardware ESP32":"Simulador"}</strong></div>
    </section>
  `);
}

function viewAhorro(){
  const monthlySaving = 214000;
  const payback = state.investment / monthlySaving;
  const weeks = Array.from({length:12},(_,i)=>String(i+1));
  const real = [61,66,58,54,48,51,44,46,39,42,36,34];
  const cum = [8,14,20,28,35,43,52,61,70,79,88,97];
  const spendCfg = {
    aria:"Gasto real frente a la línea base en 12 semanas", xName:"Semana",
    labels:weeks, tipLabel:i=>`Semana ${i+1}`,
    series:[
      {name:"Gasto real", data:real, color:"--chart-1", area:true},
      {name:"Línea base", data:real.map(()=>70), color:"--chart-2", dash:true}
    ],
    fmt:v=>num(v,0), axisFmt:v=>num(v,0), ySize:40, maxTicks:6
  };
  const cumCfg = {
    aria:"Ahorro acumulado como porcentaje de la inversión", xName:"Semana",
    labels:weeks, tipLabel:i=>`Semana ${i+1}`,
    series:[
      {name:"Ahorro acumulado", data:cum, color:"--chart-1", area:true},
      {name:"Inversión recuperada", data:cum.map(()=>100), color:"--chart-2", dash:true}
    ],
    fmt:v=>num(v,0)+" %", axisFmt:v=>num(v,0)+" %", yMax:110, ySize:52, maxTicks:6
  };
  return layout(`
    <section class="grid4">
      ${statCard({label:"Ahorro acumulado", value:"$ 428.600", sub:"451,2 kWh evitados", iconName:"piggy-bank", tone:"accent"})}
      ${statCard({label:"Inversión", value:money(state.investment), sub:"Configurable", iconName:"database"})}
      ${statCard({label:"Retorno estimado", value:`${num(payback,1)}<small>meses</small>`, sub:"Rango demostrativo 7,1–10,2 meses", iconName:"clock"})}
      ${statCard({label:"Reducción", value:"9,8 %", sub:"vs. línea base", iconName:"trending-down"})}
    </section>
    <div class="two-col even">
      <section class="card">${cardHead("trending-down","Gasto real vs. línea base","Índice semanal, valores demostrativos")}${chartBlock(spendCfg,250)}</section>
      <section class="card">${cardHead("piggy-bank","Ahorro acumulado vs. inversión","Porcentaje de la inversión recuperada","info")}${chartBlock(cumCfg,250)}</section>
    </div>
    <div class="table-wrap"><table><thead><tr><th>Recomendación</th><th>Estado</th><th>Ventana</th><th>Ahorro atribuible</th></tr></thead>
    <tbody><tr><td>Apagado letrero</td><td>${pill("Concluyente","good","check")}</td><td>14 días</td><td>$ 13.920</td></tr>
    <tr><td>Standby cafetera</td><td>${pill("No concluyente","neutral")}</td><td>12 días</td><td>Dentro de incertidumbre</td></tr>
    <tr><td>Programa AC</td><td>${pill("En medición","info","clock")}</td><td>Día 4 de 7</td><td>—</td></tr></tbody></table></div>
  `,"Ahorro y retorno");
}

function viewReportes(){
  const weekly = [48,55,64,58,69,73,62,67,75,81,76,84];
  const cfg = {
    aria:"Consumo semanal de ejemplo", xName:"Semana",
    labels:weekly.map((_,i)=>String(i+1)), tipLabel:i=>`Semana ${i+1}`,
    series:[{name:"Consumo semanal", data:weekly, color:"--chart-1"}],
    bars:true, fmt:v=>num(v,0)+" kWh", axisFmt:v=>num(v,0), ySize:40
  };
  return layout(`
    <div class="two-col even">
      <section class="card tint-good">${cardHead("file-text","Reporte mensual financiero","Consumo, costo, ahorro, retorno, recomendaciones y alertas.")}<button class="btn primary" data-action="download-csv">${icon("download","sm")}Descargar CSV</button></section>
      <section class="card tint-info">${cardHead("leaf","Impacto ODS 7","kWh evitados, reducción y kgCO2e evitados.","info")}<button class="btn" data-action="download-json">${icon("download","sm")}Descargar JSON</button></section>
    </div>
    <section class="card">
      ${cardHead("activity","Vista previa · lecturas actuales","Consumo semanal de ejemplo (valores demostrativos)")}
      <div class="toolbar">
        ${pill(`Potencia total: ${num(totalPower()/1000,2)} kW`,"good","zap")}
        ${pill(`Costo acumulado: ${money(currentCost())}`,"info","trending-down")}
      </div>
      ${chartBlock(cfg,250)}
    </section>
  `);
}

function viewModulos(){
  const devs = sortedDevices();
  return layout(`
    ${bannerBlock("Endpoint del ESP32","Copia esta dirección en INGEST_URL dentro del .ino.", state.info?.telemetry_urls?.[0] || "Cargando...", "wifi")}
    <div class="toolbar">${pill(`${devs.filter(d=>d.effective_status!=="inactive").length} activos`,"good","circle-check")}
      ${pill(`${devs.filter(d=>d.effective_status==="inactive").length} inactivos`,"warn","pause")}
      ${pill(state.telemetry?.source==="esp32"?"Hardware":"Simulador","info","cpu")}</div>
    ${deviceTable(devs)}
    <div class="gap"></div>
    <section class="card tint-info">
      ${cardHead("refresh-cw","Buffer / reconexión","","info")}
      <div class="small muted">La API registra cada lote recibido en <code>data/telemetry.jsonl</code>. Si el módulo deja de enviar por más de 2 minutos se marca como inactivo.</div>
    </section>
  `,"Estado de módulos");
}

function viewDatos(){
  return layout(`
    <div class="toolbar"><button class="btn primary" data-action="download-csv">${icon("download","sm")}Exportar CSV</button><button class="btn" data-action="download-json">${icon("download","sm")}Exportar JSON</button></div>
    ${deviceTable(sortedDevices())}
    <div class="gap"></div>
    <section class="card">${cardHead("code-xml","Payload actual")}<div class="codebox" tabindex="0" aria-label="Payload actual en JSON">${escapeHtml(JSON.stringify(state.telemetry,null,2))}</div></section>
  `,"Datos crudos");
}

function viewMultisede(){
  const sedes = [
    {name:"Chía", red:9.8},
    {name:"Cajicá", red:7.2},
    {name:"Zipaquirá", red:11.3}
  ];
  const cfg = {
    aria:"Reducción de consumo frente a la línea base por sede", xName:"Sede",
    labels:sedes.map(s=>s.name), tipLabel:i=>`La Espiga · ${sedes[i].name}`,
    series:[{name:"Reducción", data:sedes.map(s=>s.red), color:"--chart-1"}],
    bars:true, fmt:v=>num(v,1)+" %", axisFmt:v=>axisNum(v)+" %", yMax:14, incrs:[2,5], ySize:48
  };
  return layout(`
    <div class="table-wrap"><table><thead><tr><th>Sede</th><th>kWh/día</th><th>Costo/día</th><th>Ahorro/día</th><th>Reducción</th></tr></thead>
    <tbody><tr><td>La Espiga · Chía</td><td>${num(dailyEstimateKwh(),1)}</td><td>${money(dailyEstimateKwh()*state.tariff)}</td><td>$ 14.290</td><td>9,8 %</td></tr>
    <tr><td>La Espiga · Cajicá</td><td>148,1</td><td>$ 140.695</td><td>$ 10.630</td><td>7,2 %</td></tr>
    <tr><td>La Espiga · Zipaquirá</td><td>171,0</td><td>$ 162.450</td><td>$ 18.310</td><td>${pill("11,3 % · mayor","good","trending-down")}</td></tr></tbody></table></div>
    <div class="gap"></div>
    <section class="card">${cardHead("building-2","Reducción frente a línea base","Porcentaje por sede")}${chartBlock(cfg,240)}</section>
  `,"Comparación multisede");
}

function viewConfiguracion(){
  return layout(`
    <div class="two-col even">
      <section class="card">
        ${cardHead("settings","Empresa y cálculo")}
        <div class="form-grid">
          <div class="field"><label for="tariff">Tarifa COP/kWh</label><input id="tariff" type="number" value="${state.tariff}"></div>
          <div class="field"><label for="investment">Inversión del sistema</label><input id="investment" type="number" value="${state.investment}"></div>
          <div class="field"><label for="threshold">Umbral de alerta</label><input id="threshold" value="30 %"></div>
          <div class="field"><label for="window">Ventana</label><input id="window" value="15 min"></div>
        </div>
        <div class="gap"></div><button class="btn primary" data-action="save-settings">${icon("check","sm")}Guardar cambios</button>
      </section>
      <section class="card">
        ${cardHead("wifi","Conectividad local","","info")}
        <div class="kpi-line"><span>Puerto</span><strong>${escapeHtml(state.info?.port || 3000)}</strong></div>
        <div class="kpi-line"><span>Device key</span><strong><code>${escapeHtml(state.info?.device_key || "")}</code></strong></div>
        <div class="kpi-line"><span>Fuente actual</span><strong>${state.telemetry?.source==="esp32"?"ESP32":"Simulador"}</strong></div>
      </section>
    </div>
  `);
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
      <section class="card demo-tool tint-warn">${cardHead("cpu","Simulador","Si aún no llegó hardware, la página genera cargas virtuales automáticamente.","warn")}<button class="btn" data-action="reset-source">${icon("refresh-cw","sm")}Volver al simulador</button></section>
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

function setView(view){
  state.view = view;
  state.moreOpen = false;
  state.animate = true;
  render({force:true});
  window.scrollTo(0,0);
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
    const next = await fetch("/api/telemetry/latest",{cache:"no-store"}).then(r=>r.json());
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
async function resetSource(){
  await fetch("/api/reset",{method:"POST"});
  await fetchTelemetry();
}
function cycleRole(){
  const roles=["Administrador","Gerente de operaciones","Empleado de cierre","Responsable financiero","Analista de datos"];
  const i=roles.indexOf(state.role);
  state.role=roles[(i+1)%roles.length]; localStorage.setItem("vatio_role",state.role); render({force:true});
}

/* ---------- events ---------- */
document.addEventListener("click", async (event)=>{
  const viewBtn = event.target.closest("[data-view]");
  if(viewBtn){ setView(viewBtn.dataset.view); return; }

  const accept = event.target.closest("[data-accept]");
  if(accept){ state.accepted.add(accept.dataset.accept); toast("Recomendación aceptada: acción pendiente creada."); render({force:true}); return; }

  const approve = event.target.closest("[data-approve]");
  if(approve){ toast("Acción aprobada para la demostración. No se controla hardware real."); return; }

  const review = event.target.closest("[data-review-alert]");
  if(review){ state.reviewedAlerts.add(review.dataset.reviewAlert); render({force:true}); return; }

  const action = event.target.closest("[data-action]")?.dataset.action;
  if(!action) return;

  if(action==="cycle-role") cycleRole();
  if(action==="toggle-theme") applyTheme(state.theme==="dark" ? "light" : "dark");
  if(action==="open-more"){ state.moreOpen = true; render({force:true}); }
  if(action==="close-more"){ state.moreOpen = false; render({force:true}); }
  if(action==="download-csv") exportCsv();
  if(action==="download-json") exportJson();
  if(action==="reset-source") await resetSource();
  if(action==="critical-off") toast("RECHAZADO: el congelador es una carga crítica y permanece energizado.");
  if(action==="copy-endpoint"){
    const text=state.info?.telemetry_urls?.[0] || "";
    try{ await navigator.clipboard?.writeText(text); }catch(e){}
    toast("Endpoint copiado.");
  }
  if(action==="save-settings"){
    state.tariff=Number(document.getElementById("tariff")?.value || state.tariff);
    state.investment=Number(document.getElementById("investment")?.value || state.investment);
    localStorage.setItem("vatio_tariff",state.tariff);
    localStorage.setItem("vatio_investment",state.investment);
    toast("Configuración guardada.");
    render({force:true});
  }
});

document.addEventListener("keydown", (event)=>{
  if(event.key==="Escape" && state.moreOpen){ state.moreOpen = false; render({force:true}); }
});

let resizeTimer = null;
window.addEventListener("resize", ()=>{
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(mountAllCharts, 150);
});

(async function init(){
  render({force:true});
  await fetchInfo();
  await fetchTelemetry();
  setInterval(fetchTelemetry, 2000);
})();
