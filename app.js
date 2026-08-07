/* =========================================================
   TrackCare - Track Maintenance System
   Lógica de la PWA: offline-first (IndexedDB), cámara,
   checklist de inspección visual y predictiva, WhatsApp/email,
   sincronización al recuperar conexión, acceso por contraseña
   y captura obligatoria de inspector/celular con memoria de
   números previos.
   ========================================================= */

// ---------- Service Worker ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(console.error);
  });
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data && e.data.type === "TRY_SYNC") syncAll();
  });
}

// ---------- IndexedDB helper ----------
const DB_NAME = "trackcare_db";
const DB_VERSION = 2; // v2: agrega store "phonebook" para recordar celulares de inspectores
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const _db = e.target.result;
      if (!_db.objectStoreNames.contains("reports")) {
        const store = _db.createObjectStore("reports", { keyPath: "id" });
        store.createIndex("synced", "synced");
      }
      if (!_db.objectStoreNames.contains("settings")) {
        _db.createObjectStore("settings", { keyPath: "key" });
      }
      if (!_db.objectStoreNames.contains("phonebook")) {
        _db.createObjectStore("phonebook", { keyPath: "phone" });
      }
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(db); };
    req.onerror = (e) => reject(e);
  });
}

function tx(store, mode = "readonly") {
  return db.transaction(store, mode).objectStore(store);
}

function dbGetAll(store) {
  return new Promise((resolve, reject) => {
    const req = tx(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = reject;
  });
}
function dbPut(store, value) {
  return new Promise((resolve, reject) => {
    const req = tx(store, "readwrite").put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = reject;
  });
}
function dbDelete(store, key) {
  return new Promise((resolve, reject) => {
    const req = tx(store, "readwrite").delete(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = reject;
  });
}
function dbGet(store, key) {
  return new Promise((resolve, reject) => {
    const req = tx(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = reject;
  });
}

// ---------- Checklist definition (rutina de inspección visual y predictiva) ----------
// Puntos críticos considerando equipo rodante pesado (altas cargas por eje).
const CHECKLIST = [
  {
    key: "durmientes",
    title: "🪵 Estado de Durmientes",
    items: [
      "Sin grietas, fracturas o astillado visible",
      "Sujeción correcta de clips/anclas al riel",
      "Sin podredumbre, deterioro por humedad o plagas",
      "Separación y escuadría uniforme entre durmientes",
      "Sin durmientes faltantes en el tramo"
    ]
  },
  {
    key: "balasto",
    title: "🪨 Nivelación y Estado del Balasto",
    items: [
      "Nivel uniforme, sin hundimientos ni bolsas de asentamiento",
      "Volumen suficiente de balasto bajo y entre durmientes",
      "Sin vegetación excesiva que afecte drenaje",
      "Drenaje adecuado, sin encharcamientos",
      "Sin contaminación/mezcla de finos que reduzca capacidad de carga"
    ]
  },
  {
    key: "cambiavias",
    title: "🔧 Lubricación y Mecanismo de Cambiavías",
    items: [
      "Lubricación visible y vigente en placas de deslizamiento",
      "Movimiento libre de agujas, sin resistencia ni juego excesivo",
      "Varillaje, contrapesas y candado en buen estado",
      "Ajuste correcto de agujas contra riel (sin luz/holgura)",
      "Punta de aguja sin desgaste ni deformación"
    ]
  },
  {
    key: "geometria_riel",
    title: "📏 Desgaste Geométrico de Rieles",
    items: [
      "Sin desgaste ondulatorio (corrugación) en superficie de rodadura",
      "Ancho de vía (trocha) dentro de tolerancia especificada",
      "Sin deformación vertical/lateral por carga de equipo pesado",
      "Sin fisuras, exfoliación o descascarillado superficial",
      "Uniones y placas de unión firmes, sin pernos faltantes"
    ]
  },
  {
    key: "sapos_cruces",
    title: "⚙️ Sapos y Cruces de Vía",
    items: [
      "Punta de sapo sin desgaste/deformación crítica",
      "Fijación firme al durmiente",
      "Sin acumulación de material que impida rodadura"
    ]
  },
  {
    key: "descarriladores",
    title: "🛑 Descarriladores",
    items: [
      "Posicionamiento correcto (activado/desactivado según operación)",
      "Sin daño estructural ni corrosión avanzada",
      "Señalización/marca visual (amarillo) en buen estado"
    ]
  },
  {
    key: "senalizacion_entorno",
    title: "🚦 Señalización y Entorno",
    items: [
      "Señalamientos visibles, legibles y en posición correcta",
      "Área despejada de obstrucciones y materiales sueltos",
      "Iluminación y visibilidad adecuada en cruces"
    ]
  }
];

const ESTADOS_CAT = ["Bueno", "Regular", "Malo", "Requiere cambio"];

// ---------- App State ----------
let currentPhotos = { foto1: null, foto2: null, foto3: null };
let editingId = null;

// ---------- Init ----------
document.addEventListener("DOMContentLoaded", async () => {
  await openDB();
  buildPhotoGrid();
  buildChecklist();
  initWorkOrderHeader();
  bindTabs();
  bindActions();
  loadSettingsIntoForm();
  refreshConnectionStatus();
  renderHistory();
  await initAuth();          // pantalla de acceso por contraseña
  await loadPhoneSuggestions(); // datalist de celulares recordados
  bindValidation();
  window.addEventListener("online", () => { refreshConnectionStatus(); syncAll(); });
  window.addEventListener("offline", refreshConnectionStatus);
});

// ---------- Tabs ----------
function bindTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(btn.dataset.tab).classList.add("active");
      if (btn.dataset.tab === "tab-history") renderHistory();
      if (btn.dataset.tab === "tab-settings") renderAdminPanel();
    });
  });
}

// ---------- Work Order header ----------
function initWorkOrderHeader() {
  document.getElementById("woNumber").value = generateWONumber();
  document.getElementById("woDateTime").value = new Date().toLocaleString();
}
function generateWONumber() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const rand = Math.floor(Math.random() * 900 + 100);
  return `WO-${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${rand}`;
}

// ---------- Photo grid ----------
function buildPhotoGrid() {
  const grid = document.getElementById("photoGrid");
  const labels = [
    { key: "foto1", label: "Foto 1 - Vista frontal" },
    { key: "foto2", label: "Foto 2 - Vista lateral" },
    { key: "foto3", label: "Foto 3 - Vista plano" }
  ];
  grid.innerHTML = labels.map(l => `
    <div class="photo-slot" data-key="${l.key}">
      <h4>${l.label}</h4>
      <img class="photo-preview" id="prev-${l.key}" src="" style="display:none;">
      <div class="photo-buttons">
        <button type="button" class="icon-btn" onclick="capturePhoto('${l.key}', true)">📷 Tomar foto</button>
        <button type="button" class="icon-btn" onclick="capturePhoto('${l.key}', false)">🖼️ Galería</button>
      </div>
      <input type="file" accept="image/*" capture="environment" style="display:none" id="cam-${l.key}">
      <input type="file" accept="image/*" style="display:none" id="gal-${l.key}">
      <textarea placeholder="Comentario de la foto…" id="comment-${l.key}"></textarea>
    </div>
  `).join("");

  labels.forEach(l => {
    document.getElementById(`cam-${l.key}`).addEventListener("change", (e) => handlePhotoInput(e, l.key));
    document.getElementById(`gal-${l.key}`).addEventListener("change", (e) => handlePhotoInput(e, l.key));
  });
}

function capturePhoto(key, useCamera) {
  const input = document.getElementById(useCamera ? `cam-${key}` : `gal-${key}`);
  input.click();
}

function handlePhotoInput(e, key) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    currentPhotos[key] = ev.target.result; // base64, saved locally
    const img = document.getElementById(`prev-${key}`);
    img.src = ev.target.result;
    img.style.display = "block";
  };
  reader.readAsDataURL(file);
}

// ---------- Checklist ----------
function buildChecklist() {
  const container = document.getElementById("checklistContainer");
  container.innerHTML = CHECKLIST.map((cat, idx) => `
    <div class="check-category" data-cat="${cat.key}">
      <div class="check-category-head" onclick="toggleCat('${cat.key}')">
        <span>${cat.title}</span>
        <span class="badge" id="count-${cat.key}">0/${cat.items.length}</span>
      </div>
      <div class="check-items" id="items-${cat.key}">
        ${cat.items.map((it, i) => `
          <label class="check-item">
            <input type="checkbox" data-cat="${cat.key}" onchange="updateCatCount('${cat.key}')">
            <span>${it}</span>
          </label>
        `).join("")}
      </div>
      <div class="cat-status">
        <select id="status-${cat.key}">
          <option value="">Estado de la categoría…</option>
          ${ESTADOS_CAT.map(s => `<option value="${s}">${s}</option>`).join("")}
        </select>
        <input type="text" id="note-${cat.key}" placeholder="Observación / medida específica…">
      </div>
    </div>
  `).join("");
}

function toggleCat(key) {
  document.getElementById(`items-${key}`).classList.toggle("collapsed");
}

function updateCatCount(key) {
  const total = document.querySelectorAll(`input[type=checkbox][data-cat="${key}"]`).length;
  const checked = document.querySelectorAll(`input[type=checkbox][data-cat="${key}"]:checked`).length;
  document.getElementById(`count-${key}`).textContent = `${checked}/${total}`;
}

// ---------- GPS ----------
document.addEventListener("click", (e) => {
  if (e.target && e.target.id === "btnGPS") {
    if (!navigator.geolocation) { showToast("Geolocalización no disponible en este dispositivo"); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        document.getElementById("fGPS").value = `${pos.coords.latitude.toFixed(6)}, ${pos.coords.longitude.toFixed(6)}`;
      },
      () => showToast("No se pudo obtener la ubicación GPS"),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }
});

// ---------- Bind main actions ----------
function bindActions() {
  document.getElementById("btnAutoFill").addEventListener("click", autoFillSummary);
  document.getElementById("btnSaveReport").addEventListener("click", saveReport);
  document.getElementById("btnClearForm").addEventListener("click", () => { if(confirm("¿Limpiar el formulario actual?")) resetForm(); });

  document.getElementById("btnSaveSettings").addEventListener("click", saveSettings);
  document.getElementById("btnExportAll").addEventListener("click", exportBackup);
  document.getElementById("btnImportAll").addEventListener("click", () => document.getElementById("importFile").click());
  document.getElementById("importFile").addEventListener("change", importBackup);
  document.getElementById("btnWipe").addEventListener("click", wipeData);

  document.getElementById("btnSyncAll").addEventListener("click", syncAll);
  document.getElementById("historySearch").addEventListener("input", renderHistory);

  document.querySelector(".modal-close-overlay");
  document.getElementById("modalOverlay").addEventListener("click", (e) => {
    if (e.target.id === "modalOverlay") closeModal();
  });

  // ---- Seguridad: bloqueo de sesión de app ----
  document.getElementById("btnLock").addEventListener("click", lockApp);

  // ---- Panel de Administrador (contraseña + borrar datos) ----
  bindAdminPanel();
}

function autoFillSummary() {
  let riesgos = [];
  let recCorto = [];
  let resumen = [];
  CHECKLIST.forEach(cat => {
    const status = document.getElementById(`status-${cat.key}`).value;
    const note = document.getElementById(`note-${cat.key}`).value;
    const total = cat.items.length;
    const checked = document.querySelectorAll(`input[type=checkbox][data-cat="${cat.key}"]:checked`).length;
    if (status && status !== "Bueno") {
      riesgos.push(`${cat.title.replace(/^[^\s]+\s/, "")}: estado ${status}${note ? " — " + note : ""}`);
      recCorto.push(`Atender ${cat.title.replace(/^[^\s]+\s/, "")} (prioridad por estado ${status}).`);
    }
    if (checked < total) {
      riesgos.push(`${cat.title.replace(/^[^\s]+\s/, "")}: ${total-checked} punto(s) de revisión sin cumplir (${checked}/${total}).`);
    }
    resumen.push(`${cat.title.replace(/^[^\s]+\s/, "")}: ${checked}/${total} puntos conformes${status ? ", estado " + status : ""}.`);
  });
  document.getElementById("fResumen").value = resumen.join("\n");
  document.getElementById("fRiesgos").value = riesgos.length ? riesgos.join("\n") : "Sin riesgos relevantes identificados en la inspección visual.";
  document.getElementById("fCorto").value = recCorto.length ? recCorto.join("\n") : "Continuar con inspección rutinaria y lubricación preventiva.";
  document.getElementById("fMediano").value = "Validar alineación, ajuste y nivelación en próxima inspección programada.";
  document.getElementById("fLargo").value = "Evaluar mantenimiento predictivo basado en condición e inclusión en monitoreo digital (registro histórico).";
  showToast("Resumen generado automáticamente ✔");
}

// ---------- Validación de campos obligatorios (Inspector y Celular) ----------
function bindValidation() {
  const inspector = document.getElementById("woInspector");
  const celular = document.getElementById("woCelular");
  inspector.addEventListener("input", () => validateInspectorField());
  celular.addEventListener("input", () => {
    // Solo dígitos, +, espacios y guiones mientras escribe
    celular.value = celular.value.replace(/[^\d+\-\s]/g, "");
    validateCelularField();
  });
}

function validateInspectorField() {
  const inspector = document.getElementById("woInspector");
  const err = document.getElementById("errInspector");
  const ok = inspector.value.trim().length >= 3;
  inspector.classList.toggle("field-error", !ok);
  err.classList.toggle("show", !ok);
  return ok;
}

function normalizeDigits(v) {
  return (v || "").replace(/\D/g, "");
}

function validateCelularField() {
  const celular = document.getElementById("woCelular");
  const err = document.getElementById("errCelular");
  const digits = normalizeDigits(celular.value);
  const ok = digits.length >= 10;
  celular.classList.toggle("field-error", !ok);
  err.classList.toggle("show", !ok);
  return ok;
}

// ---------- Memoria de celulares (datalist para futuros reportes) ----------
async function loadPhoneSuggestions() {
  const all = await dbGetAll("phonebook");
  all.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
  const datalist = document.getElementById("celularSugerencias");
  datalist.innerHTML = all.map(p => `<option value="${p.phone}">${p.name ? "Insp: " + p.name : ""}</option>`).join("");
}

async function rememberPhone(phoneRaw, inspectorName) {
  const digits = normalizeDigits(phoneRaw);
  if (digits.length < 10) return;
  await dbPut("phonebook", { phone: phoneRaw.trim(), name: inspectorName || "", lastUsed: Date.now() });
  await loadPhoneSuggestions();
}

// ---------- Save report ----------
async function saveReport() {
  const ubicacion = document.getElementById("fUbicacion").value.trim();
  const tipoHerraje = document.getElementById("fTipoHerraje").value;
  const estado = document.getElementById("fEstado").value;
  const inspector = document.getElementById("woInspector").value.trim();
  const celular = document.getElementById("woCelular").value.trim();

  // Validación obligatoria: inspector y celular (con lista desplegable de recordados)
  const inspectorOk = validateInspectorField();
  const celularOk = validateCelularField();

  if (!inspectorOk || !celularOk) {
    showToast("⚠️ Capture el nombre del inspector y un celular válido (10 dígitos) antes de guardar");
    if (!inspectorOk) document.getElementById("woInspector").focus();
    else document.getElementById("woCelular").focus();
    return;
  }

  if (!ubicacion || !tipoHerraje || !estado) {
    showToast("⚠️ Complete Ubicación, Tipo de herraje y Estado antes de guardar");
    return;
  }

  const checklistData = {};
  CHECKLIST.forEach(cat => {
    const checks = Array.from(document.querySelectorAll(`input[type=checkbox][data-cat="${cat.key}"]`)).map(c => c.checked);
    checklistData[cat.key] = {
      items: checks,
      status: document.getElementById(`status-${cat.key}`).value,
      note: document.getElementById(`note-${cat.key}`).value
    };
  });

  const report = {
    id: editingId || `RPT-${Date.now()}`,
    woNumber: document.getElementById("woNumber").value,
    dateTime: document.getElementById("woDateTime").value,
    inspector,
    celular,
    shift: document.getElementById("woShift").value,
    ubicacion, area: document.getElementById("fArea").value,
    tipoHerraje, activoId: document.getElementById("fActivoId").value,
    gps: document.getElementById("fGPS").value,
    estado,
    infoEspecifica: document.getElementById("fInfoEspecifica").value,
    photos: {
      foto1: { data: currentPhotos.foto1, comment: document.getElementById("comment-foto1").value },
      foto2: { data: currentPhotos.foto2, comment: document.getElementById("comment-foto2").value },
      foto3: { data: currentPhotos.foto3, comment: document.getElementById("comment-foto3").value }
    },
    checklist: checklistData,
    resumen: document.getElementById("fResumen").value,
    riesgos: document.getElementById("fRiesgos").value,
    recCorto: document.getElementById("fCorto").value,
    recMediano: document.getElementById("fMediano").value,
    recLargo: document.getElementById("fLargo").value,
    synced: false,
    savedAt: new Date().toISOString()
  };

  await dbPut("reports", report);
  await rememberPhone(celular, inspector); // guarda el celular para sugerirlo en futuros reportes
  showToast("✅ Reporte guardado localmente" + (navigator.onLine ? "" : " (sin conexión)"));
  resetForm();
  renderHistory();

  // Try background sync registration
  if ("serviceWorker" in navigator && "SyncManager" in window) {
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.sync.register("trackcare-sync");
    } catch (e) { /* silent */ }
  }
}

function resetForm() {
  document.getElementById("woNumber").value = generateWONumber();
  document.getElementById("woDateTime").value = new Date().toLocaleString();
  ["fUbicacion","fArea","fTipoHerraje","fActivoId","fGPS","fEstado","fInfoEspecifica",
   "fResumen","fRiesgos","fCorto","fMediano","fLargo"].forEach(id => document.getElementById(id).value = "");
  currentPhotos = { foto1: null, foto2: null, foto3: null };
  ["foto1","foto2","foto3"].forEach(k => {
    document.getElementById(`prev-${k}`).style.display = "none";
    document.getElementById(`comment-${k}`).value = "";
  });
  CHECKLIST.forEach(cat => {
    document.querySelectorAll(`input[type=checkbox][data-cat="${cat.key}"]`).forEach(c => c.checked = false);
    document.getElementById(`status-${cat.key}`).value = "";
    document.getElementById(`note-${cat.key}`).value = "";
    updateCatCount(cat.key);
  });
  editingId = null;
  // El inspector y celular NO se limpian (se conservan para el siguiente reporte del mismo turno);
  // solo se re-validan visualmente.
  validateInspectorField();
  validateCelularField();
}

// ---------- History ----------
async function renderHistory() {
  const all = await dbGetAll("reports");
  all.sort((a,b) => new Date(b.savedAt) - new Date(a.savedAt));
  const search = (document.getElementById("historySearch").value || "").toLowerCase();
  const filtered = all.filter(r =>
    !search ||
    (r.ubicacion||"").toLowerCase().includes(search) ||
    (r.activoId||"").toLowerCase().includes(search) ||
    (r.inspector||"").toLowerCase().includes(search) ||
    (r.tipoHerraje||"").toLowerCase().includes(search)
  );

  const pending = all.filter(r => !r.synced).length;
  document.getElementById("syncSummary").textContent = `${pending} pendiente(s) de sincronizar`;

  const list = document.getElementById("historyList");
  if (!filtered.length) {
    list.innerHTML = `<p class="hint">No hay reportes guardados todavía.</p>`;
    return;
  }
  list.innerHTML = filtered.map(r => `
    <div class="history-item">
      <div class="hi-main">
        <h4>${r.activoId || r.tipoHerraje || "Elemento"} — ${r.ubicacion}</h4>
        <p>${r.woNumber} · ${r.dateTime} · Insp: ${r.inspector || "—"} · Cel: ${r.celular || "—"}</p>
        <span class="badge-status badge-${(r.estado||"").split(" ")[0]}">${r.estado}</span>
        <span class="badge-status ${r.synced ? "badge-sync-done" : "badge-sync-pending"}">${r.synced ? "Sincronizado" : "Pendiente"}</span>
      </div>
      <div class="hi-actions">
        <button class="icon-btn" onclick="viewReport('${r.id}')">👁️ Ver</button>
        <button class="icon-btn whatsapp" onclick="shareWhatsApp('${r.id}')">🟢 WhatsApp</button>
        <button class="icon-btn email" onclick="shareEmail('${r.id}')">✉️ Correo</button>
        <button class="icon-btn delete" onclick="deleteReport('${r.id}')">🗑️</button>
      </div>
    </div>
  `).join("");
}

async function deleteReport(id) {
  if (!confirm("¿Eliminar este reporte del dispositivo?")) return;
  await dbDelete("reports", id);
  renderHistory();
}

async function viewReport(id) {
  const r = await dbGet("reports", id);
  if (!r) return;
  const box = document.getElementById("modalBox");
  box.innerHTML = `
    <button class="modal-close" onclick="closeModal()">✕</button>
    <h3>${r.woNumber} — ${r.tipoHerraje}</h3>
    <p><b>Ubicación:</b> ${r.ubicacion} | <b>Área:</b> ${r.area || "—"}</p>
    <p><b>Activo:</b> ${r.activoId || "—"} | <b>GPS:</b> ${r.gps || "—"}</p>
    <p><b>Estado:</b> ${r.estado} | <b>Inspector:</b> ${r.inspector || "—"} (${r.shift || ""})</p>
    <p><b>Celular de quien reporta:</b> ${r.celular || "—"}</p>
    <p><b>Información específica:</b> ${r.infoEspecifica || "—"}</p>
    ${["foto1","foto2","foto3"].map(k => r.photos[k] && r.photos[k].data ? `<img src="${r.photos[k].data}"><p><i>${r.photos[k].comment||""}</i></p>` : "").join("")}
    <p><b>Resumen:</b><br>${(r.resumen||"").replace(/\n/g,"<br>")}</p>
    <p><b>Riesgos:</b><br>${(r.riesgos||"").replace(/\n/g,"<br>")}</p>
    <p><b>Corto plazo:</b> ${r.recCorto||"—"}</p>
    <p><b>Mediano plazo:</b> ${r.recMediano||"—"}</p>
    <p><b>Largo plazo:</b> ${r.recLargo||"—"}</p>
  `;
  document.getElementById("modalOverlay").classList.remove("hidden");
}
function closeModal() { document.getElementById("modalOverlay").classList.add("hidden"); }

// ---------- WhatsApp / Email sharing ----------
function buildReportText(r) {
  return `*TrackCare - Reporte de Inspección*\n` +
    `Orden: ${r.woNumber}\n` +
    `Fecha: ${r.dateTime}\n` +
    `Inspector: ${r.inspector || "—"} (${r.shift || ""})\n` +
    `Celular de quien reporta: ${r.celular || "—"}\n` +
    `Ubicación: ${r.ubicacion} | Área: ${r.area || "—"}\n` +
    `Elemento: ${r.tipoHerraje} (${r.activoId || "—"})\n` +
    `GPS: ${r.gps || "—"}\n` +
    `Estado: *${r.estado}*\n` +
    `Info específica: ${r.infoEspecifica || "—"}\n\n` +
    `Resumen:\n${r.resumen || "—"}\n\n` +
    `Riesgos:\n${r.riesgos || "—"}\n\n` +
    `Recomendaciones:\n- Corto: ${r.recCorto || "—"}\n- Mediano: ${r.recMediano || "—"}\n- Largo: ${r.recLargo || "—"}`;
}

async function shareWhatsApp(id) {
  const r = await dbGet("reports", id);
  const text = buildReportText(r);
  const photos = ["foto1","foto2","foto3"].map(k => r.photos[k]?.data).filter(Boolean);

  // Try Web Share API with files (best UX on mobile, includes photos)
  if (navigator.canShare && photos.length) {
    try {
      const files = await Promise.all(photos.map(async (dataUrl, i) => {
        const res = await fetch(dataUrl);
        const blob = await res.blob();
        return new File([blob], `foto${i+1}.jpg`, { type: blob.type || "image/jpeg" });
      }));
      if (navigator.canShare({ files })) {
        await navigator.share({ text, files, title: "Reporte TrackCare" });
        return;
      }
    } catch (e) { /* fallback below */ }
  }
  // Fallback: WhatsApp deep link con texto (photos deben adjuntarse manualmente)
  const settings = await dbGet("settings", "app");
  const phone = settings?.whatsapp ? settings.whatsapp.replace(/\D/g,"") : "";
  const url = `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
  window.open(url, "_blank");
}

async function shareEmail(id) {
  const r = await dbGet("reports", id);
  const text = buildReportText(r);
  const settings = await dbGet("settings", "app");
  const to = settings?.email || "";
  const subject = encodeURIComponent(`TrackCare - Reporte ${r.woNumber} - ${r.tipoHerraje}`);
  const body = encodeURIComponent(text + "\n\n(Adjunte manualmente las fotos exportadas desde 'Ver' si su cliente de correo no las incluye).");
  window.location.href = `mailto:${to}?subject=${subject}&body=${body}`;
}

// ---------- Settings ----------
async function loadSettingsIntoForm() {
  const s = await dbGet("settings", "app");
  if (s) {
    document.getElementById("cfgInspector").value = s.inspector || "";
    document.getElementById("cfgWhatsapp").value = s.whatsapp || "";
    document.getElementById("cfgEmail").value = s.email || "";
    document.getElementById("cfgEndpoint").value = s.endpoint || "";
    if (s.inspector) document.getElementById("woInspector").value = s.inspector;
  }
}
async function saveSettings() {
  const settings = {
    key: "app",
    inspector: document.getElementById("cfgInspector").value,
    whatsapp: document.getElementById("cfgWhatsapp").value,
    email: document.getElementById("cfgEmail").value,
    endpoint: document.getElementById("cfgEndpoint").value
  };
  await dbPut("settings", settings);
  document.getElementById("woInspector").value = settings.inspector;
  validateInspectorField();
  showToast("Configuración guardada ✔");
}

// ---------- Backup export/import ----------
async function exportBackup() {
  const reports = await dbGetAll("reports");
  const settings = await dbGetAll("settings");
  const blob = new Blob([JSON.stringify({ reports, settings }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `trackcare_backup_${Date.now()}.json`;
  a.click();
}
async function importBackup(e) {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  try {
    const data = JSON.parse(text);
    for (const r of data.reports || []) await dbPut("reports", r);
    for (const s of data.settings || []) await dbPut("settings", s);
    showToast("Respaldo importado ✔");
    renderHistory();
    loadSettingsIntoForm();
  } catch (err) {
    showToast("Archivo de respaldo inválido");
  }
}
async function wipeData() {
  if (!isAdminUnlocked()) { showToast("Solo un administrador puede borrar todos los datos. Desbloquee el panel primero."); return; }
  if (!confirm("Esto eliminará TODOS los reportes locales. ¿Continuar?")) return;
  const all = await dbGetAll("reports");
  for (const r of all) await dbDelete("reports", r.id);
  showToast("Datos eliminados");
  renderHistory();
}

// ---------- Sync (cuando hay conexión) ----------
async function syncAll() {
  if (!navigator.onLine) { showToast("Sin conexión. Se sincronizará automáticamente al reconectar."); return; }
  const settings = await dbGet("settings", "app");
  const endpoint = settings?.endpoint;
  const all = await dbGetAll("reports");
  const pending = all.filter(r => !r.synced);
  if (!pending.length) { showToast("No hay reportes pendientes de sincronizar"); return; }
  if (!endpoint) {
    showToast("Configure un endpoint de sincronización en Configuración para subir automáticamente");
    return;
  }
  let okCount = 0;
  for (const r of pending) {
    try {
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(r)
      });
      if (resp.ok) {
        r.synced = true;
        await dbPut("reports", r);
        okCount++;
      }
    } catch (e) { /* keep pending, try later */ }
  }
  showToast(`Sincronizados ${okCount}/${pending.length} reporte(s)`);
  renderHistory();
}

// ---------- Connection status ----------
function refreshConnectionStatus() {
  const pill = document.getElementById("connStatus");
  if (navigator.onLine) {
    pill.textContent = "🟢 En línea";
    pill.className = "status-pill online";
  } else {
    pill.textContent = "🔴 Sin conexión (modo offline)";
    pill.className = "status-pill offline";
  }
}

// ---------- Toast ----------
let toastTimer;
function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 3200);
}

/* =========================================================
   ============ ACCESO POR CONTRASEÑA (AUTENTICACIÓN) ========
   =========================================================
   Nota de seguridad: esta es una protección de acceso básica
   pensada para uso en campo (evitar que cualquier persona abra
   la app en el dispositivo compartido). La contraseña se guarda
   con hash SHA-256 en IndexedDB local; no sustituye un sistema
   de autenticación de servidor/Azure AD para datos críticos.
   ========================================================= */

async function sha256(text) {
  const enc = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function getAuthSettings() {
  return await dbGet("settings", "auth");
}

async function initAuth() {
  const overlay = document.getElementById("loginOverlay");
  const auth = await getAuthSettings();

  bindTogglePasswordButtons();
  document.getElementById("formLogin").addEventListener("submit", handleLoginSubmit);
  document.getElementById("formSetupPassword").addEventListener("submit", handleSetupSubmit);

  if (!auth || !auth.passwordHash) {
    // Primera vez: se debe crear una contraseña antes de usar la app
    document.getElementById("loginTitle").textContent = "Configurar acceso";
    document.getElementById("loginSubtitle").textContent = "Es la primera vez que se usa esta app en este dispositivo. Cree una contraseña de acceso.";
    document.getElementById("formLogin").style.display = "none";
    document.getElementById("formSetupPassword").style.display = "block";
    overlay.classList.remove("hidden");
    return;
  }

  if (sessionStorage.getItem("tc_unlocked") === "1") {
    overlay.classList.add("hidden");
  } else {
    document.getElementById("loginTitle").textContent = "Acceso protegido";
    document.getElementById("loginSubtitle").textContent = "Ingrese la contraseña de la aplicación para continuar.";
    document.getElementById("formLogin").style.display = "block";
    document.getElementById("formSetupPassword").style.display = "none";
    overlay.classList.remove("hidden");
  }
}

async function handleLoginSubmit(e) {
  e.preventDefault();
  const pass = document.getElementById("loginPassword").value;
  const err = document.getElementById("loginError");
  const auth = await getAuthSettings();
  const hash = await sha256(pass);
  if (auth && hash === auth.passwordHash) {
    err.classList.remove("show");
    sessionStorage.setItem("tc_unlocked", "1");
    document.getElementById("loginOverlay").classList.add("hidden");
    document.getElementById("loginPassword").value = "";
  } else {
    err.classList.add("show");
  }
}

async function handleSetupSubmit(e) {
  e.preventDefault();
  const p1 = document.getElementById("setupPassword1").value;
  const p2 = document.getElementById("setupPassword2").value;
  const err = document.getElementById("setupError");
  if (p1.length < 4 || p1 !== p2) {
    err.classList.add("show");
    return;
  }
  err.classList.remove("show");
  const hash = await sha256(p1);
  await dbPut("settings", { key: "auth", passwordHash: hash });
  sessionStorage.setItem("tc_unlocked", "1");
  document.getElementById("loginOverlay").classList.add("hidden");
  document.getElementById("setupPassword1").value = "";
  document.getElementById("setupPassword2").value = "";
  showToast("Contraseña creada correctamente ✔");
}

function lockApp() {
  sessionStorage.removeItem("tc_unlocked");
  document.getElementById("loginTitle").textContent = "Acceso protegido";
  document.getElementById("loginSubtitle").textContent = "Ingrese la contraseña de la aplicación para continuar.";
  document.getElementById("formLogin").style.display = "block";
  document.getElementById("formSetupPassword").style.display = "none";
  document.getElementById("loginOverlay").classList.remove("hidden");
}

function bindTogglePasswordButtons() {
  document.querySelectorAll(".toggle-pass").forEach(btn => {
    btn.addEventListener("click", () => {
      const input = document.getElementById(btn.dataset.target);
      input.type = input.type === "password" ? "text" : "password";
    });
  });
}

/* =========================================================
   ============ ROL DE ADMINISTRADOR (GATING) =================
   =========================================================
   Solo un usuario que verifique la contraseña de administrador
   puede: (a) restablecer/cambiar la contraseña de acceso de la
   app, (b) cambiar la propia contraseña de administrador, y
   (c) borrar todos los datos locales. El desbloqueo del panel
   dura únicamente la sesión actual del navegador (sessionStorage)
   y puede cerrarse manualmente con "Cerrar panel de administrador".
   ========================================================= */

function isAdminUnlocked() {
  return sessionStorage.getItem("tc_admin_unlocked") === "1";
}

function bindAdminPanel() {
  document.getElementById("btnAdminSetupCreate").addEventListener("click", handleAdminSetupCreate);
  document.getElementById("btnAdminUnlock").addEventListener("click", handleAdminUnlock);
  document.getElementById("btnAdminLock").addEventListener("click", handleAdminLock);
  document.getElementById("btnAdminResetAccess").addEventListener("click", handleAdminResetAccess);
  document.getElementById("btnAdminChangePassword").addEventListener("click", handleAdminChangePassword);
  // Enter key support en el campo de desbloqueo
  document.getElementById("adminUnlockPass").addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleAdminUnlock();
  });
  renderAdminPanel();
}

async function renderAdminPanel() {
  const auth = await getAuthSettings();
  const setupView = document.getElementById("adminSetupView");
  const lockedView = document.getElementById("adminLockedView");
  const unlockedView = document.getElementById("adminUnlockedView");

  setupView.style.display = "none";
  lockedView.style.display = "none";
  unlockedView.style.display = "none";

  if (!auth || !auth.adminPasswordHash) {
    // Nunca se ha configurado una contraseña de administrador: se debe crear primero
    setupView.style.display = "block";
    return;
  }

  if (isAdminUnlocked()) {
    unlockedView.style.display = "block";
  } else {
    lockedView.style.display = "block";
  }
}

async function handleAdminSetupCreate() {
  const p1 = document.getElementById("adminSetupPass1").value;
  const p2 = document.getElementById("adminSetupPass2").value;
  const err = document.getElementById("errAdminSetup");
  if (p1.length < 4 || p1 !== p2) {
    err.classList.add("show");
    return;
  }
  err.classList.remove("show");
  const auth = (await getAuthSettings()) || { key: "auth" };
  auth.adminPasswordHash = await sha256(p1);
  await dbPut("settings", auth);
  sessionStorage.setItem("tc_admin_unlocked", "1");
  document.getElementById("adminSetupPass1").value = "";
  document.getElementById("adminSetupPass2").value = "";
  showToast("Contraseña de administrador creada. Panel desbloqueado ✔");
  renderAdminPanel();
}

async function handleAdminUnlock() {
  const pass = document.getElementById("adminUnlockPass").value;
  const err = document.getElementById("errAdminUnlock");
  const auth = await getAuthSettings();
  const hash = await sha256(pass);
  if (!auth || hash !== auth.adminPasswordHash) {
    err.classList.add("show");
    return;
  }
  err.classList.remove("show");
  sessionStorage.setItem("tc_admin_unlocked", "1");
  document.getElementById("adminUnlockPass").value = "";
  showToast("Panel de administrador desbloqueado ✔");
  renderAdminPanel();
}

function handleAdminLock() {
  sessionStorage.removeItem("tc_admin_unlocked");
  showToast("Panel de administrador bloqueado");
  renderAdminPanel();
}

async function handleAdminResetAccess() {
  if (!isAdminUnlocked()) { showToast("Desbloquee el panel de administrador primero"); return; }
  const p1 = document.getElementById("adminNewAccessPass1").value;
  const p2 = document.getElementById("adminNewAccessPass2").value;
  const err = document.getElementById("errAdminResetAccess");
  if (p1.length < 4 || p1 !== p2) {
    err.classList.add("show");
    return;
  }
  err.classList.remove("show");
  const auth = (await getAuthSettings()) || { key: "auth" };
  auth.passwordHash = await sha256(p1);
  await dbPut("settings", auth);
  document.getElementById("adminNewAccessPass1").value = "";
  document.getElementById("adminNewAccessPass2").value = "";
  showToast("Contraseña de acceso restablecida correctamente ✔");
}

async function handleAdminChangePassword() {
  if (!isAdminUnlocked()) { showToast("Desbloquee el panel de administrador primero"); return; }
  const current = document.getElementById("adminChangeCurrent").value;
  const next1 = document.getElementById("adminChangeNew1").value;
  const next2 = document.getElementById("adminChangeNew2").value;
  const err = document.getElementById("errAdminChange");

  const auth = await getAuthSettings();
  const currentHash = await sha256(current);

  if (!auth || currentHash !== auth.adminPasswordHash || next1.length < 4 || next1 !== next2) {
    err.classList.add("show");
    return;
  }
  err.classList.remove("show");
  auth.adminPasswordHash = await sha256(next1);
  await dbPut("settings", auth);
  document.getElementById("adminChangeCurrent").value = "";
  document.getElementById("adminChangeNew1").value = "";
  document.getElementById("adminChangeNew2").value = "";
  showToast("Contraseña de administrador actualizada ✔");
}
