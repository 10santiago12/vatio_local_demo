'use strict';
/**
 * Generates the ER diagram from the real schema (migrations applied to an in-memory database).
 * Outputs, with no network access and no dependencies:
 *   docs/der.svg  - rendered diagram
 *   docs/der.mmd  - Mermaid erDiagram source
 *   docs/der.md   - the block between <!-- der:start --> and <!-- der:end --> is refreshed
 * The PNG (docs/der.png) is rasterized from the SVG with headless Edge/Chrome; see docs/der.md.
 */
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('../backend/db/connection');
const { migrate } = require('../backend/db/migrate');

const DOCS = path.join(__dirname, '..', 'docs');

// Column positions of each group, left to right. Entities not listed fall into the legacy row.
const LAYOUT = [
  ['roles', 'users', 'user_sites', 'consents', 'audit', 'events', 'error_log'],
  ['sites', 'site_schedules', 'tariffs', 'settings'],
  ['loads', 'modules', 'readings', 'readings_hourly'],
  ['baselines', 'alerts', 'recommendations', 'control_actions']
];
const LEGACY = ['telemetry', 'control_requests', 'schema_migrations'];
// Foreign keys to users that only record who did something are drawn dashed and light.
const ACCOUNTABILITY = new Set(['created_by', 'updated_by', 'reviewed_by', 'decided_by', 'requested_by', 'registered_by']);

function readSchema() {
  const db = openDatabase(':memory:');
  migrate(db);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  const tables = new Map();
  for (const name of names) {
    const columns = db.prepare(`PRAGMA table_info(${name})`).all().map((c) => ({ name: c.name, type: c.type || 'TEXT', pk: c.pk > 0, notNull: c.notnull === 1 }));
    const fks = db.prepare(`PRAGMA foreign_key_list(${name})`).all().map((f) => ({ from: f.from, table: f.table }));
    const unique = new Set();
    for (const idx of db.prepare(`PRAGMA index_list(${name})`).all()) {
      if (idx.unique && !idx.partial) {
        const cols = db.prepare(`PRAGMA index_info(${idx.name})`).all().map((c) => c.name);
        if (cols.length === 1) unique.add(cols[0]);
      }
    }
    for (const c of columns) {
      c.fk = fks.some((f) => f.from === c.name);
      c.unique = unique.has(c.name);
    }
    tables.set(name, { name, columns, fks });
  }
  db.close();
  return tables;
}

function mermaidType(type) {
  const t = type.toUpperCase();
  return t.includes('INT') ? 'int' : t.includes('REAL') ? 'float' : 'string';
}

function relationships(tables) {
  const rels = [];
  for (const t of tables.values()) {
    for (const fk of t.fks) {
      if (fk.table === t.name) continue;
      const col = t.columns.find((c) => c.name === fk.from);
      const parentMandatory = col.notNull;
      const oneToOne = col.unique || (col.pk && t.columns.filter((c) => c.pk).length === 1);
      rels.push({ child: t.name, parent: fk.table, column: fk.from, parentMandatory, oneToOne, soft: ACCOUNTABILITY.has(fk.from) });
    }
  }
  return rels;
}

function toMermaid(tables, rels) {
  const lines = ['erDiagram'];
  for (const r of rels) {
    const left = r.parentMandatory ? '||' : '|o';
    const right = r.oneToOne ? 'o|' : 'o{';
    lines.push(`  ${r.parent} ${left}--${right} ${r.child} : "${r.column}"`);
  }
  for (const t of tables.values()) {
    lines.push(`  ${t.name} {`);
    for (const c of t.columns) {
      const keys = [c.pk ? 'PK' : null, c.fk ? 'FK' : null, !c.pk && c.unique ? 'UK' : null].filter(Boolean).join(',');
      lines.push(`    ${mermaidType(c.type)} ${c.name}${keys ? ` ${keys}` : ''}`);
    }
    lines.push('  }');
  }
  return lines.join('\n');
}

const ROW = 17, HEAD = 26, WIDTH = 280, GAP_X = 130, GAP_Y = 36, MARGIN = 40;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function layout(tables) {
  const boxes = new Map();
  let maxY = 0;
  LAYOUT.forEach((group, ci) => {
    let y = MARGIN + 30;
    for (const name of group) {
      const t = tables.get(name);
      const h = HEAD + t.columns.length * ROW + 8;
      boxes.set(name, { t, x: MARGIN + ci * (WIDTH + GAP_X), y, w: WIDTH, h });
      y += h + GAP_Y;
    }
    maxY = Math.max(maxY, y);
  });
  let x = MARGIN;
  for (const name of LEGACY) {
    const t = tables.get(name);
    const h = HEAD + t.columns.length * ROW + 8;
    boxes.set(name, { t, x, y: maxY + 40, w: WIDTH, h, legacy: true });
    x += WIDTH + 40;
  }
  const bottom = Math.max(...[...boxes.values()].map((b) => b.y + b.h));
  const width = MARGIN * 2 + LAYOUT.length * WIDTH + (LAYOUT.length - 1) * GAP_X;
  return { boxes, width, height: bottom + MARGIN, legacyY: maxY + 40 };
}

/** Point where the segment from the box center towards (tx, ty) leaves the box border. */
function edgePoint(box, tx, ty) {
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const dx = tx - cx, dy = ty - cy;
  const scale = Math.min(dx ? (box.w / 2) / Math.abs(dx) : Infinity, dy ? (box.h / 2) / Math.abs(dy) : Infinity);
  return { x: cx + dx * scale, y: cy + dy * scale };
}

function toSvg(tables, rels) {
  const { boxes, width, height, legacyY } = layout(tables);
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Segoe UI, Arial, sans-serif">`);
  out.push('<title>Vatio - Diagrama entidad-relación</title>');
  out.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);
  const groupTitles = ['Acceso y trazabilidad', 'Sede y configuración', 'Cargas y mediciones', 'Análisis y control'];
  groupTitles.forEach((title, ci) => {
    out.push(`<text x="${MARGIN + ci * (WIDTH + GAP_X)}" y="${MARGIN}" font-size="15" font-weight="700" fill="#0e1612">${esc(title)}</text>`);
  });
  out.push(`<text x="${MARGIN}" y="${legacyY - 12}" font-size="15" font-weight="700" fill="#5b6b63">Tablas heredadas y de control de versiones (sin relaciones)</text>`);

  // Relationship lines first so boxes cover their ends.
  for (const r of rels) {
    const a = boxes.get(r.child), b = boxes.get(r.parent);
    const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const p1 = edgePoint(a, bc.x, bc.y), p2 = edgePoint(b, ac.x, ac.y);
    const style = r.soft ? 'stroke="#b6c2bb" stroke-dasharray="4 4" stroke-width="1"' : 'stroke="#148c4f" stroke-width="1.6"';
    out.push(`<line x1="${p1.x.toFixed(1)}" y1="${p1.y.toFixed(1)}" x2="${p2.x.toFixed(1)}" y2="${p2.y.toFixed(1)}" ${style}/>`);
    if (!r.soft) {
      const lx = (f, p, q) => (p.x + (q.x - p.x) * f).toFixed(1);
      const ly = (f, p, q) => (p.y + (q.y - p.y) * f - 4).toFixed(1);
      out.push(`<text x="${lx(0.1, p1, p2)}" y="${ly(0.1, p1, p2)}" font-size="11" font-weight="700" fill="#0e6b3b">${r.oneToOne ? '1' : 'N'}</text>`);
      out.push(`<text x="${lx(0.9, p1, p2)}" y="${ly(0.9, p1, p2)}" font-size="11" font-weight="700" fill="#0e6b3b">${r.parentMandatory ? '1' : '0..1'}</text>`);
    }
  }

  for (const box of boxes.values()) {
    const { t } = box;
    const head = box.legacy ? '#5b6b63' : '#0e1612';
    out.push(`<g><rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="6" fill="#f6f8f7" stroke="#0e1612" stroke-width="1.2"/>`);
    out.push(`<path d="M${box.x} ${box.y + HEAD} V${box.y + 6} a6 6 0 0 1 6 -6 H${box.x + box.w - 6} a6 6 0 0 1 6 6 V${box.y + HEAD} Z" fill="${head}"/>`);
    out.push(`<text x="${box.x + 10}" y="${box.y + 18}" font-size="13" font-weight="700" fill="#ffffff">${esc(t.name)}</text>`);
    t.columns.forEach((c, i) => {
      const y = box.y + HEAD + 14 + i * ROW;
      const tag = [c.pk ? 'PK' : null, c.fk ? 'FK' : null].filter(Boolean).join(' ');
      out.push(`<text x="${box.x + 10}" y="${y}" font-size="11.5" fill="#0e1612" font-weight="${c.pk ? 700 : 400}">${esc(c.name)}</text>`);
      out.push(`<text x="${box.x + 186}" y="${y}" font-size="10.5" fill="#5b6b63">${esc(c.type.toLowerCase())}</text>`);
      if (tag) out.push(`<text x="${box.x + box.w - 8}" y="${y}" font-size="10" text-anchor="end" font-weight="700" fill="#148c4f">${tag}</text>`);
    });
    out.push('</g>');
  }
  const ly = height - 14;
  out.push(`<line x1="${MARGIN + 600}" y1="${ly - 4}" x2="${MARGIN + 640}" y2="${ly - 4}" stroke="#148c4f" stroke-width="1.6"/><text x="${MARGIN + 648}" y="${ly}" font-size="11" fill="#0e1612">Relación estructural (N : 1)</text>`);
  out.push(`<line x1="${MARGIN + 860}" y1="${ly - 4}" x2="${MARGIN + 900}" y2="${ly - 4}" stroke="#b6c2bb" stroke-dasharray="4 4"/><text x="${MARGIN + 908}" y="${ly}" font-size="11" fill="#0e1612">Responsable de una acción (usuario)</text>`);
  out.push('</svg>');
  return out.join('\n');
}

function main() {
  const tables = readSchema();
  const rels = relationships(tables);
  const mermaid = toMermaid(tables, rels);
  fs.writeFileSync(path.join(DOCS, 'der.svg'), toSvg(tables, rels));
  fs.writeFileSync(path.join(DOCS, 'der.mmd'), mermaid + '\n');
  const mdPath = path.join(DOCS, 'der.md');
  if (fs.existsSync(mdPath)) {
    const md = fs.readFileSync(mdPath, 'utf8');
    const block = `<!-- der:start -->\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n<!-- der:end -->`;
    fs.writeFileSync(mdPath, md.replace(/<!-- der:start -->[\s\S]*?<!-- der:end -->/, () => block));
  }
  console.log(`DER generated: ${tables.size} tables, ${rels.length} relationships`);
}

main();
