/* =====================================================================
   Dulce Panelita · Conexión con Firebase (Authentication + Firestore)
   Los datos de la app viven SOLO en Firestore. Este archivo:
   1) pide inicio de sesión (correo y contraseña),
   2) carga los datos desde Firestore y arranca la app (DP.start),
   3) envía a Firestore los cambios cada vez que app.js llama a save().
   ===================================================================== */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, setPersistence, browserLocalPersistence }
  from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, collection, getDocs, doc, getDoc, writeBatch }
  from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAFEfpmB-Sz9koDr_pdEK_-JjxAZman8EI",
  authDomain: "dulce-panelita-pwa-1.firebaseapp.com",
  projectId: "dulce-panelita-pwa-1",
  storageBucket: "dulce-panelita-pwa-1.firebasestorage.app",
  messagingSenderId: "194210860795",
  appId: "1:194210860795:web:e236fd0922fc1711162a5e",
  measurementId: "G-FCT124G1SR"
};

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);   // sin caché local: nada de datos queda guardado en el dispositivo

/* ---------- Estructura de datos ----------
   Un documento por registro, con el mismo id que usa la app:
   pets, svc, cit, caja, inv, compras, prec, pagos, diplomas  → colecciones
   ajustes/general → { meta, perfil (sin diplomas), cfg }
   Cada documento guarda _o (posición en la lista) para conservar el orden. */
const COLS = ['pets', 'svc', 'cit', 'caja', 'inv', 'compras', 'prec', 'pagos'];
const DIP = 'diplomas';
const SETTINGS = ['ajustes', 'general'];
const LOCAL_KEY = 'dulcePanelita.v1';   // solo se LEE una vez, para migrar datos antiguos; nunca se escribe ni se borra
const MAX_DOC_BYTES = 900000;           // Firestore admite 1 MiB por documento

const emptyData = () => ({ pets: [], svc: [], cit: [], caja: [], inv: [], compras: [], prec: [], pagos: [], meta: { m: 0 }, perfil: { diplomas: [] }, cfg: {} });
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const docId = id => { let s = String(id).replace(/\//g, '_'); if (s === '.' || s === '..' || /^__.*__$/.test(s)) s = 'id' + s; return s; };
const clean = o => JSON.parse(JSON.stringify(o));
const isObj = r => r && typeof r === 'object';
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

/* Estado de la app → mapa «ruta → documento» */
function toDocs(D) {
  const m = new Map();
  const add = (col, list) => {
    (Array.isArray(list) ? list : []).forEach((r, i) => {
      if (!isObj(r)) return;
      if (r.id == null || r.id === '') r.id = newId();
      let key = col + '/' + docId(r.id);
      while (m.has(key)) { r.id = newId(); key = col + '/' + docId(r.id); }
      m.set(key, { ...clean(r), _o: i });
    });
  };
  COLS.forEach(c => add(c, D[c]));
  add(DIP, D.perfil && D.perfil.diplomas);
  const perfil = { ...(D.perfil || {}) }; delete perfil.diplomas;
  m.set(SETTINGS.join('/'), clean({ meta: D.meta || { m: 0 }, perfil, cfg: D.cfg || {} }));
  return m;
}

const sortStrip = list => { list.sort((a, b) => (a._o ?? 1e9) - (b._o ?? 1e9)); list.forEach(r => { delete r._o; }); return list; };

async function loadAll() {
  const D = emptyData(); let any = false;
  const names = [...COLS, DIP];
  const snaps = await Promise.all(names.map(c => getDocs(collection(db, c))));
  names.forEach((c, i) => {
    const list = snaps[i].docs.map(d => d.data());
    if (list.length) any = true;
    sortStrip(list);
    if (c === DIP) D.perfil.diplomas = list; else D[c] = list;
  });
  const s = await getDoc(doc(db, SETTINGS[0], SETTINGS[1]));
  if (s.exists()) {
    any = true;
    const v = s.data();
    D.meta = v.meta || { m: 0 };
    D.perfil = { ...(v.perfil || {}), diplomas: D.perfil.diplomas };
    D.cfg = v.cfg || {};
  }
  return { D, any };
}

/* ---------- Envío de cambios ---------- */
let lastSynced = new Map();   // ruta → contenido ya confirmado en Firestore
const markSynced = D => { lastSynced = new Map(); toDocs(D).forEach((v, p) => lastSynced.set(p, stable(v))); };

async function runPush(D) {
  const cur = toDocs(D), curStr = new Map(), ops = [], enc = new TextEncoder();
  cur.forEach((v, p) => {
    const s = stable(v); curStr.set(p, s);
    if (lastSynced.get(p) !== s) {
      if (enc.encode(s).length > MAX_DOC_BYTES) throw new Error('Un registro (' + p + ') es demasiado grande para Firestore. Usa una foto más pequeña.');
      ops.push({ t: 'set', p, v, s });
    }
  });
  lastSynced.forEach((s, p) => { if (!curStr.has(p)) ops.push({ t: 'del', p }); });
  for (let i = 0; i < ops.length; i += 400) {
    const chunk = ops.slice(i, i + 400), b = writeBatch(db);
    chunk.forEach(o => { const [c, id] = o.p.split('/'); const ref = doc(db, c, id); if (o.t === 'set') b.set(ref, o.v); else b.delete(ref); });
    await b.commit();
    chunk.forEach(o => { if (o.t === 'set') lastSynced.set(o.p, o.s); else lastSynced.delete(o.p); });
  }
}

let running = false, again = false, waiters = [];
function push(cb) {
  if (cb) waiters.push(cb);
  api.pending = true;
  if (running) { again = true; return; }
  running = true;
  (async () => {
    let ok = true, err = null;
    do {
      again = false;
      try { await runPush(window.DP.getData()); } catch (e) { ok = false; err = e; console.error('Firestore:', e); break; }
    } while (again);
    running = false; api.pending = false;
    const w = waiters; waiters = [];
    w.forEach(f => { try { f(ok, err); } catch (x) { } });
  })();
}

/* ---------- Migración desde el localStorage antiguo (solo lectura) ---------- */
const count = l => (Array.isArray(l) ? l.filter(isObj).length : 0);
function readLocal() {
  try {
    const x = JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null');
    if (!x || typeof x !== 'object' || !Array.isArray(x.pets)) return null;
    const total = COLS.reduce((n, c) => n + count(x[c]), 0) + count(x.perfil && x.perfil.diplomas);
    return total > 0 ? x : null;
  } catch (e) { return null; }
}
async function uploadAndVerify(local) {
  const src = { ...emptyData(), ...clean(local) };
  src.perfil = { ...(src.perfil || {}), diplomas: (src.perfil && src.perfil.diplomas) || [] };
  lastSynced = new Map();
  await runPush(src);
  const { D: back } = await loadAll();
  const bad = [];
  COLS.forEach(c => { if (count(back[c]) !== count(src[c])) bad.push(c); });
  if (count(back.perfil.diplomas) !== count(src.perfil.diplomas)) bad.push(DIP);
  if (bad.length) throw new Error('La verificación falló en: ' + bad.join(', ') + '. Tus datos locales siguen intactos; no se borró nada.');
  return back;
}

/* ---------- Pantallas (inicio de sesión, carga, migración) ---------- */
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function overlay(html) {
  if (!document.getElementById('dpAuthCss')) {
    const st = document.createElement('style'); st.id = 'dpAuthCss';
    st.textContent = `#dpAuth{position:fixed;inset:0;z-index:99999;display:grid;place-items:center;padding:20px;background:var(--bg,#FAF6FF);color:var(--tx,#2B2233);font-family:'Nunito',system-ui,sans-serif}
#dpAuth .card{width:min(400px,100%);background:var(--card,#fff);border-radius:20px;padding:26px 22px;box-shadow:0 10px 40px rgba(90,60,130,.18);text-align:center}
#dpAuth h2{font-family:'Quicksand',sans-serif;font-size:21px;margin:6px 0 4px}
#dpAuth p{margin:6px 0;font-size:14px;opacity:.8}
#dpAuth label{display:block;text-align:left;font-size:13px;font-weight:700;margin:14px 0 5px}
#dpAuth input{width:100%;box-sizing:border-box;padding:12px 13px;font:inherit;font-size:16px;border:1.5px solid rgba(120,90,160,.3);border-radius:12px;background:transparent;color:inherit}
#dpAuth button{width:100%;margin-top:16px;padding:13px;font:inherit;font-weight:800;font-size:15px;border:0;border-radius:13px;cursor:pointer;color:#fff;background:var(--grad,linear-gradient(135deg,#B99BD5,#E8A9C4))}
#dpAuth button.sec{background:transparent;color:inherit;border:1.5px solid rgba(120,90,160,.35);margin-top:10px}
#dpAuth button:disabled{opacity:.6;cursor:wait}
#dpAuth .err{color:#C0392B;font-size:13.5px;font-weight:700;min-height:18px;margin-top:12px}
#dpAuth ul{text-align:left;margin:10px auto;padding-left:20px;font-size:14px}`;
    document.head.appendChild(st);
  }
  let el = document.getElementById('dpAuth');
  if (!el) { el = document.createElement('div'); el.id = 'dpAuth'; document.body.appendChild(el); }
  el.innerHTML = '<div class="card">' + html + '</div>';
  return el;
}
const removeOverlay = () => { const el = document.getElementById('dpAuth'); if (el) el.remove(); };
const head = '<div style="font-size:34px">🐾</div><h2>Dulce Panelita</h2>';

function authMsg(e) {
  const c = e && e.code || '';
  if (c === 'auth/invalid-credential' || c === 'auth/wrong-password' || c === 'auth/user-not-found') return 'Correo o contraseña incorrectos.';
  if (c === 'auth/invalid-email') return 'El correo no es válido.';
  if (c === 'auth/too-many-requests') return 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.';
  if (c === 'auth/network-request-failed') return 'Sin conexión a internet.';
  return 'No se pudo iniciar sesión (' + (c || (e && e.message) || 'error') + ').';
}
function showLogin() {
  const el = overlay(head + `<p>Inicia sesión para ver tus datos</p>
<form id="dpLogin" novalidate>
<label for="dpMail">Correo electrónico</label><input id="dpMail" type="email" autocomplete="username" inputmode="email" required>
<label for="dpPass">Contraseña</label><input id="dpPass" type="password" autocomplete="current-password" required>
<div class="err" id="dpErr" role="alert"></div>
<button type="submit" id="dpGo">Entrar</button></form>`);
  el.querySelector('#dpLogin').addEventListener('submit', async ev => {
    ev.preventDefault();
    const mail = el.querySelector('#dpMail').value.trim(), pass = el.querySelector('#dpPass').value;
    const err = el.querySelector('#dpErr'), btn = el.querySelector('#dpGo');
    if (!mail || !pass) { err.textContent = 'Escribe tu correo y tu contraseña.'; return; }
    btn.disabled = true; btn.textContent = 'Entrando…'; err.textContent = '';
    try { await signInWithEmailAndPassword(auth, mail, pass); }
    catch (e) { err.textContent = authMsg(e); btn.disabled = false; btn.textContent = 'Entrar'; }
  });
}
const showLoading = t => overlay(head + '<p>' + esc(t) + '</p>');
function showError(msg, retry) {
  const el = overlay(head + '<p class="err" style="text-align:center">' + esc(msg) + '</p><button id="dpRetry">Reintentar</button><button class="sec" id="dpOut">Cerrar sesión</button>');
  el.querySelector('#dpRetry').addEventListener('click', retry);
  el.querySelector('#dpOut').addEventListener('click', () => api.logout());
}
function showMigration(local) {
  const L = { pets: 'mascotas', svc: 'servicios en el historial', cit: 'citas', caja: 'movimientos de caja', inv: 'materiales de inventario', compras: 'compras', prec: 'servicios del catálogo', pagos: 'pagos' };
  const items = COLS.filter(c => count(local[c])).map(c => '<li>' + count(local[c]) + ' ' + L[c] + '</li>');
  const nd = count(local.perfil && local.perfil.diplomas); if (nd) items.push('<li>' + nd + ' diplomas</li>');
  return new Promise(res => {
    const el = overlay(head + `<p>Tu nube está vacía, pero encontré datos guardados en este navegador:</p><ul>${items.join('')}</ul>
<p>Se copiarán a Firestore y se verificará que llegaron completos. <b>No se borrará nada de este navegador.</b></p>
<button id="dpUp">Subir mis datos a la nube</button><button class="sec" id="dpNo">Empezar sin datos</button>`);
    el.querySelector('#dpUp').addEventListener('click', () => res('upload'));
    el.querySelector('#dpNo').addEventListener('click', () => res('empty'));
  });
}

/* ---------- Arranque ---------- */
let started = false;
async function boot() {
  showLoading('Cargando tus datos…');
  try {
    let { D, any } = await loadAll();
    if (!any) {
      const local = readLocal();
      if (local && await showMigration(local) === 'upload') { showLoading('Subiendo y verificando tus datos…'); D = await uploadAndVerify(local); }
    }
    markSynced(D);
    api.ready = true;
    removeOverlay();
    window.DP.start(D);
  } catch (e) {
    console.error('Arranque:', e);
    started = false;
    const perm = e && e.code === 'permission-denied';
    showError(perm ? 'Esta cuenta no tiene permiso para leer los datos (reglas de Firestore).' : 'No se pudieron cargar tus datos: ' + (e && e.message || e), () => { started = true; boot(); });
  }
}

const api = {
  ready: false, pending: false, push,
  async logout() { try { await signOut(auth); } finally { location.reload(); } },
  _core: { toDocs, stable, loadAll, runPush, markSynced, uploadAndVerify, getLast: () => lastSynced }
};
window.DPCloud = api;

(async () => { try { await setPersistence(auth, browserLocalPersistence); } catch (e) { } })();
showLoading('Conectando…');
onAuthStateChanged(auth, user => {
  if (!user) { started = false; api.ready = false; showLogin(); return; }
  if (started) return;
  started = true; boot();
});