// background.js — badge en el ícono + notificaciones + consultas puntuales del content script.
// Recibe el resultado de cada scan desde offers.js y decide qué mostrar.
'use strict';

// reutiliza las libs compartidas (matching, catálogo, fetches de tiendas, datos)
importScripts('shared/util.js', 'shared/catalog.js', 'shared/stores.js', 'shared/db.js');

const BADGE_COLOR = '#ff5d73'; // rojo hot de la extensión
const NOTIFY_THRESHOLD_DEFAULT = 60; // % de ahorro mínimo para notificar
const NOTIF_URLS_KEY = 'ofertasNotifUrls'; // notificationId → url del juego
const WISH_NOTIFIED_KEY = 'ofertasWishNotified'; // deseados ya notificados hoy (dedupe)
const LAST_BUGS_KEY = 'ofertaLastBugs'; // bugs del último scan (para el TOP diario)
const DAILY_TOP_KEY = 'ofertaDailyTopDate'; // fecha del último TOP enviado (dedupe diario)
const DAILY_TOP_N = 5; // cuántos bugs muestra la notificación diaria
const SETTINGS_KEY = 'ofertasNotifySettings';
const EPIC_FREE_ALARM = 'ofertaEpicFreeCheck'; // alarma one-shot diaria (detección de rotación)
const EPIC_FREE_CHECK_KEY = 'ofertaEpicFreeWeek'; // { weekKey, titles } — dedupe semanal

// Catálogo activo = GAMES (estático) + juegos que el usuario agregó desde el
// buscador de Microsoft Store (ofertasUserGames). Debe coincidir con el orden de
// catalog() de offers.js para que las cachés por tienda queden alineadas.
async function activeGames() {
  const user = (await Store.get('ofertasUserGames')) || [];
  return mergeCatalog(GAMES, user);
}

// ---------- settings ----------
async function getSettings() {
  const s = await chrome.storage.local.get(SETTINGS_KEY);
  const cfg = s[SETTINGS_KEY] || {};
  return {
    enabled: cfg.enabled !== false, // por defecto activo
    threshold: Number(cfg.threshold) || NOTIFY_THRESHOLD_DEFAULT,
  };
}

// ---------- badge ----------
async function setBadge(count) {
  try {
    if (count > 0) {
      await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
      await chrome.action.setBadgeText({ text: String(count > 999 ? '999+' : count) });
    } else {
      await chrome.action.setBadgeText({ text: '' });
    }
  } catch (e) { /* action no disponible en headless/tests */ }
}

// ---------- notificaciones ----------
// Recibe [{ name, savings, msArs, msUrl, type }] del scan y:
// 1) actualiza el badge con la cantidad TOTAL de bugs (no depende del umbral);
// 2) persiste los bugs del último scan para la NOTIFICACIÓN DIARIA del TOP.
// (Las notificaciones individuales por scan fueron reemplazadas por el TOP diario.)
async function handleScan(bugs) {
  const totalBugs = (bugs || []).length;
  await setBadge(totalBugs);
  await chrome.storage.local.set({ [LAST_BUGS_KEY]: bugs || [] });
}

// ---------- TOP Price Bugs del Día (notificación diaria) ----------
// Próximo horario local (default 10:00) para programar la alarma diaria.
function nextDailyTime(hour = 10) {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// Programa la alarma one-shot del TOP diario. Se crea en onInstalled/onStartup y se
// reprograma dentro del onAlarm al dispararse (NUNCA a nivel top-level: re-crearla en
// cada wake del SW podría reemplazar la alarma pendiente del día por la de mañana).
function scheduleDailyTop() {
  chrome.alarms.create('ofertaDailyTop', { when: nextDailyTime(10) });
}

// Envía UNA notificación diaria con el TOP de bugs del último scan (topBugs puro),
// solo si hay ≥ 1 oportunidad real. Dedupe: una vez por día calendario.
async function sendDailyTop() {
  const { enabled } = await getSettings();
  if (!enabled) return;

  const day = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD en hora local (coincide con la alarma 10:00)
  const stored = await chrome.storage.local.get(DAILY_TOP_KEY);
  if (stored[DAILY_TOP_KEY] === day) return; // ya notificamos hoy

  const last = await chrome.storage.local.get(LAST_BUGS_KEY);
  const top = topBugs(last[LAST_BUGS_KEY] || [], DAILY_TOP_N);
  if (!top.length) return; // sin oportunidades → nada

  // marcar ANTES de notificar para no duplicar si se cae la SW
  await chrome.storage.local.set({ [DAILY_TOP_KEY]: day });

  const nid = `oferta-top-${day}`;
  const lines = top.map((b, i) => `${i + 1}. ${b.name} — -${b.savings}%`).join('\n');
  try {
    await chrome.notifications.create(nid, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: '🔥 TOP Price Bugs del Día',
      message: `${top.length} oportunidad${top.length > 1 ? 'es' : ''} detectada${top.length > 1 ? 's' : ''}:\n${lines}\n\nTocá para abrir el comparador.`,
      priority: 1,
    });
    // clic → abrir el comparador (ahí está el TOP completo)
    const urlStore = await chrome.storage.local.get(NOTIF_URLS_KEY);
    const urls = urlStore[NOTIF_URLS_KEY] || {};
    urls[nid] = chrome.runtime.getURL('offers.html');
    await chrome.storage.local.set({ [NOTIF_URLS_KEY]: urls });
  } catch (e) { /* notifications no disponible */ }
}

// ---------- gratis semanales de Epic: detección de rotación ----------
// Reutiliza la caché de la página (ofertasEpicFree, TTL 12 h) si sigue fresca;
// si no, consulta a la API y actualiza la misma caché (consistencia con offers/popup).
async function fetchEpicFreeWithCache() {
  const cached = await Store.get('ofertasEpicFree');
  if (cached && cached.ts && Date.now() - cached.ts < 12 * 60 * 60 * 1000 && Array.isArray(cached.list)) {
    return cached.list;
  }
  const list = await fetchEpicFreeGames().catch(() => null) || [];
  if (list.length) await Store.set('ofertasEpicFree', { ts: Date.now(), list });
  return list;
}

// Detecta si rotaron los juegos gratis de Epic (cada jueves) y notifica SOLO los
// nuevos. Dedupe por semana: semanaKey = min startDate de la rotación activa.
// Primer chequeo = línea base (sin notificar, evita spam al instalar).
async function checkEpicFreeChange() {
  const { enabled } = await getSettings();
  if (!enabled) return;

  let games = [];
  try {
    games = await fetchEpicFreeWithCache();
  } catch (e) {
    return;
  }
  const active = epicFreeActive(games);
  if (!active.length) return; // sin gratis activos → nada que reportar
  const weekKey = epicFreeWeekKey(active);
  if (!weekKey) return; // sin fecha de inicio → no es una rotación semanal
  const titles = active.map((g) => g.title);

  const stored = await chrome.storage.local.get(EPIC_FREE_CHECK_KEY);
  const prev = stored[EPIC_FREE_CHECK_KEY] || null;

  // primer chequeo: establecer línea base sin notificar (misma filosofía que la wishlist)
  if (!prev) {
    await chrome.storage.local.set({ [EPIC_FREE_CHECK_KEY]: { weekKey, titles } });
    return;
  }

  const sameWeek = prev.weekKey === weekKey;
  const fresh = epicFreeNewTitles(prev.titles, titles);
  if (sameWeek && !fresh.length) return; // misma semana y mismos títulos → nada cambió

  await chrome.storage.local.set({ [EPIC_FREE_CHECK_KEY]: { weekKey, titles } });
  // mitad de semana → solo los nuevos; semana nueva → todo el lote de la rotación
  await notifyEpicFree(sameWeek ? fresh : titles);
}

// Programa la alarma one-shot diaria del chequeo de gratis (default 13:00 local;
// la rotación de Epic es a las 15:00 UTC = 12:00 en Argentina, así el chequeo corre
// después del cambio en ese huso y, en otros husos, la redetección diaria lo cubre
// en ≤ 24 h porque la alarma se reprograma todos los días). Se reprograma dentro del
// onAlarm (nunca a nivel top-level).
function scheduleEpicFreeCheck() {
  chrome.alarms.create(EPIC_FREE_ALARM, { when: nextDailyTime(13) });
}

async function notifyEpicFree(titles) {
  if (!titles || !titles.length) return;
  const nid = `oferta-epic-free-${Date.now()}`;
  const lines = titles.slice(0, 5).map((t, i) => `${i + 1}. ${t}`).join('\n');
  try {
    await chrome.notifications.create(nid, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: '🎁 ¡Nuevos gratis en Epic!',
      message: `${titles.length} juego${titles.length > 1 ? 's' : ''} gratis esta semana:\n${lines}${titles.length > 5 ? `\n+${titles.length - 5} más` : ''}\n\nTocá para verlos en el comparador.`,
      priority: 1,
    });
    // clic → abrir el comparador (ahí está la sección 🎁 con los links de reclamo)
    const urlStore = await chrome.storage.local.get(NOTIF_URLS_KEY);
    const urls = urlStore[NOTIF_URLS_KEY] || {};
    urls[nid] = chrome.runtime.getURL('offers.html');
    await chrome.storage.local.set({ [NOTIF_URLS_KEY]: urls });
  } catch (e) { /* notifications no disponible */ }
}

// ---------- wishlist inteligente ----------
// Recibe rows de los deseados desde offers.js y notifica SOLO cuando ocurre un
// evento relevante (baja de precio, mínimo histórico, bug, MS más barata, Epic gratis).
// Dedupe: cada juego+evento se notifica una sola vez por día.
async function checkWishlist(rows) {
  if (!rows || !rows.length) return;
  const enabled = (await getSettings()).enabled;
  const day = new Date().toISOString().slice(0, 10);
  const stored = await chrome.storage.local.get(WISH_NOTIFIED_KEY);
  const notified = stored[WISH_NOTIFIED_KEY] || {};
  const snapsStore = await DB.getSnaps();
  const snaps = { ...snapsStore };
  const freshEvents = [];

  for (const r of rows) {
    const prev = snaps[r.name] || null;
    const curr = {
      msArs: r.msArs,
      bestUsdArs: r.bestUsdArs,
      epicArs: r.epicArs,
      type: r.type,
      bestStore: r.bestStore,
      histLow: r.histLow,
    };
    const evs = wishEvents(prev, curr, { dropPct: 15 });
    snaps[r.name] = curr;
    for (const ev of evs) {
      const key = `${r.name}|${ev}|${day}`;
      if (!notified[key] && enabled) {
        notified[key] = true;
        freshEvents.push({ name: r.name, event: ev, savings: r.savings, msArs: r.msArs, msUrl: r.msUrl });
      }
    }
  }

  await DB.setSnaps(snaps);
  await chrome.storage.local.set({ [WISH_NOTIFIED_KEY]: notified });

  // notificación (máx 3 por sync para no spamear)
  const urlStore = await chrome.storage.local.get(NOTIF_URLS_KEY);
  const urls = urlStore[NOTIF_URLS_KEY] || {};
  for (const ev of freshEvents.slice(0, 3)) {
    const label = WISH_EVENT_LABEL[ev.event] || 'Oportunidad';
    const extra = ev.msArs != null ? ` · MS: $${Math.round(ev.msArs)}` : '';
    const nid = `wish-${ev.name}-${ev.event}-${Date.now()}`;
    try {
      await chrome.notifications.create(nid, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: `${label} — ${ev.name}`,
        message: `${label}${ev.savings != null ? ` · ahorro ${ev.savings}%` : ''}${extra}`,
        priority: 1,
      });
      if (ev.msUrl) urls[nid] = ev.msUrl;
    } catch (e) { /* notifications no disponible */ }
  }
  await chrome.storage.local.set({ [NOTIF_URLS_KEY]: urls });
}

// Sync periódico en background: revisa los deseados con caché inteligente (TTL por tienda)
// y prioridad (favoritos primero). Se ejecuta cada 30 min mientras el navegador está abierto.
chrome.alarms.create('ofertaWishSync', { periodInMinutes: 30 });
chrome.alarms.onAlarm.addListener(async (al) => {
  if (al.name === 'ofertaDailyTop') {
    try {
      await sendDailyTop();
    } catch (e) {
      console.error('sendDailyTop', e);
    }
    // reprogramar para mañana (la alarma es one-shot)
    scheduleDailyTop();
    return;
  }
  if (al.name === EPIC_FREE_ALARM) {
    try {
      await checkEpicFreeChange();
    } catch (e) {
      console.error('epicFreeCheck', e);
    }
    // reprogramar para mañana (la alarma es one-shot)
    scheduleEpicFreeCheck();
    return;
  }
  if (al.name !== 'ofertaWishSync') return;
  try {
    await loadRegion(); // región activa antes de cualquier fetch
    const wishlist = await DB.getWishlist();
    if (!wishlist.length) return;
    // prioridad: juegos deseados (los únicos que interesan en background)
    const games = await activeGames();
    const rows = [];
    for (const steamId of wishlist) {
      const g = games.find((x) => x.steamId === Number(steamId));
      if (!g) continue;
      // consulta directa por juego (la wishlist es chica): MS siempre fresco para
      // detectar cambios en el precio bugueado; Steam/Epic igual (sin caché cruzada
      // con arrays alineados al catálogo, que se desalinearían con los userGames).
      const rate = (await fetchDolarRates().catch(() => null) || {}).blue || 1;
      const [ms, steamMap, epic] = await Promise.all([
        fetchMsPrice(g.msTerm || g.name).catch(() => null),
        (async () => {
          const v = await fetchSteamPrices([steamId]).catch(() => null);
          return v ? v[steamId] : null;
        })(),
        fetchEpicPrice(g.epicTerm || g.name).catch(() => null),
      ]);
      const steamArs = steamMap ? storeToLocal(steamMap, activeRegion(), rate) : null;
      const epicArs = epic ? storeToLocal(epic, activeRegion(), rate) : null;
      const usdCandidates = [steamArs, epicArs].filter((v) => v != null && v > 0);
      const bestUsdArs = usdCandidates.length ? Math.min(...usdCandidates) : null;
      // regla cross-store (idéntica a la página): MS "Gratis" con precio real en
      // Steam/Epic = Xbox Game Pass, no gratis → no compite como precio más barato.
      const re = reclassifySuspiciousFree(
        { ms, steam: steamMap, epic },
        { steam: steamArs, epic: epicArs, ms: ms ? ms.price : null }
      );
      const msFinal = re.stores.ms;
      const msArs = re.ars.ms;
      const { type, savings } = detectType({ msArs, bestUsdArs });
      // misma lógica que la página: compite precio real de compra o gratis real;
      // Game Pass-only (0 sin flags de compra) no cuenta como "más barata".
      let bestStore = null, bestVal = Infinity;
      const storeObjs = { ms: msFinal, steam: steamMap, epic: re.stores.epic };
      for (const k of ['ms', 'steam', 'epic']) {
        const kind = storeOfferKind(storeObjs[k]);
        if (kind !== 'purchase' && kind !== 'free') continue;
        const v = k === 'ms' ? msArs : k === 'steam' ? steamArs : epicArs;
        if (v != null && v < bestVal) { bestVal = v; bestStore = k; }
      }
      const hist = (await DB.getHistory())[g.name] || [];
      // mínimo histórico en CUALQUIER tienda (mejor precio de compra en ARS), igual que la página
      const anyArs = Number.isFinite(bestVal) && bestVal > 0 ? bestVal : null;
      rows.push({
        name: g.name,
        msArs,
        bestUsdArs,
        epicArs,
        type,
        bestStore,
        histLow: isHistoricLowAny(hist, anyArs),
        savings,
        msUrl: msFinal ? msFinal.url : null,
      });
    }
    await checkWishlist(rows);
  } catch (e) {
    console.error('wishSync', e);
  }
});

// clic en la notificación → abrir la página del juego en Microsoft Store
chrome.notifications.onClicked.addListener(async (id) => {
  chrome.notifications.clear(id);
  const stored = await chrome.storage.local.get(NOTIF_URLS_KEY);
  const urls = stored[NOTIF_URLS_KEY] || {};
  // fallback con la región activa (igual que msDetailUrl): sin hl/gl, apps.microsoft.com
  // redirige por geo y manda a un store equivocado (p. ej. microsoft.mx).
  const r = activeRegion();
  const url = urls[id] || `https://apps.microsoft.com/search?query=&hl=${r.msLocale}&gl=${r.msMarket}`;
  chrome.tabs.create({ url });
  delete urls[id];
  await chrome.storage.local.set({ [NOTIF_URLS_KEY]: urls });
});

// ---------- consulta puntual (content script en Steam/Epic) ----------
// Dado un juego (steamId y/o título), consulta MS Store + Steam + Epic y devuelve
// el resultado compacto para que content.js lo muestre sin hacer fetches.
// Usa la REGIÓN ACTIVA guardada (multipaís): precios en la moneda local.
async function msCheckFor({ steamId, title }) {
  const reg = await loadRegion();
  const rateData = await fetchDolarRates().catch(() => null);
  const rate = (rateData && rateData.blue) || 1;

  // encontrar el juego en el catálogo (por appid o por matching de título)
  const games = await activeGames();
  let entry = null;
  if (steamId) entry = games.find((g) => g.steamId === Number(steamId));
  if (!entry && title) {
    const hit = pickBest(title, games.map((g) => ({ title: g.name, g })), 0.5);
    if (hit) entry = hit.g;
  }

  const msTerm = (entry && entry.msTerm) || title;
  const epicTerm = (entry && entry.epicTerm) || title;
  const idUsed = Number(steamId) || (entry && entry.steamId) || null;

  const [ms, steamMap, epic] = await Promise.all([
    msTerm ? fetchMsPrice(msTerm).catch(() => null) : Promise.resolve(null),
    idUsed ? fetchSteamPrices([idUsed]).catch(() => null) : Promise.resolve(null),
    epicTerm ? fetchEpicPrice(epicTerm).catch(() => null) : Promise.resolve(null),
  ]);
  const steamRes = idUsed && steamMap ? steamMap[idUsed] : null;

  const steamArs = steamRes ? storeToLocal(steamRes, reg, rate) : null;
  const epicArs = epic ? storeToLocal(epic, reg, rate) : null;
  const usdCandidates = [steamArs, epicArs].filter((v) => v != null && v > 0);
  const bestUsdArs = usdCandidates.length ? Math.min(...usdCandidates) : null;
  // regla cross-store (idéntica a offers.js): MS "Gratis" con precio real en Steam/Epic
  // = Xbox Game Pass, nunca "Gratis" en la card inyectada. Un "Gratis" falso de Epic
  // (delisted/sin precio) con precio real en Steam se descarta.
  const re = reclassifySuspiciousFree(
    { ms, steam: steamRes, epic },
    { steam: steamArs, epic: epicArs, ms: ms ? ms.price : null }
  );
  const msFinal = re.stores.ms;
  const msArs = re.ars.ms;
  // usar el umbral que el usuario configuró en la página (ofertasBugThreshold)
  const savedTh = await chrome.storage.local.get('ofertasBugThreshold');
  const threshold = [40, 50, 60, 70].includes(Number(savedTh.ofertasBugThreshold))
    ? Number(savedTh.ofertasBugThreshold)
    : 40;
  const { type, savings } = detectType({ msArs, bestUsdArs }, threshold);
  const bug = type !== 'none';
  const discount = msFinal && msFinal.discount ? msFinal.discount : 0;
  const risk = correctionRisk({ type, savings, ageHours: 0, trend: 0 });
  const score = opportunityScore({
    type, savings, risk: risk.risk, popularity: popularityOf((entry && entry.name) || title),
    ageHours: 0, trend: 0, discount,
  });
  // tipo de oferta MS: purchase / free / gamepass — nunca mostrar Game Pass como "Gratis"
  const msKind = storeOfferKind(msFinal);

  return {
    ok: true,
    name: (entry && entry.name) || title || 'Juego',
    ms: msFinal ? { price: msFinal.price, url: msFinal.url, currency: msFinal.currency, gamePass: msFinal.gamePass, free: msFinal.free, passName: msFinal.passName || null } : null,
    msKind,
    msArs: msFinal && msFinal.price > 0 ? msArs : null,
    bestUsdArs,
    bug,
    type,
    savings,
    score,
    rate,
    currency: reg.currency,
    rateLabel: reg.code === 'AR' ? 'Dólar blue' : `USD→${reg.currency}`,
  };
}

// ---------- región activa (multipaís) ----------
// Lee la región guardada por la página (ofertasRegion) y la deja activa para
// todos los fetches del service worker (msCheckFor, wishSync, gratis de Epic).
// Se relee SIEMPRE (sin caché): el usuario puede cambiar de región y la página
// guarda el nuevo código en storage; el SW debe ver el cambio sin reiniciar.
async function loadRegion() {
  const s = await chrome.storage.local.get('ofertasRegion');
  setActiveRegion(s.ofertasRegion || 'AR');
  return activeRegion();
}

// ---------- mensajes desde offers.js / content.js ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'ofertaScan') {
    handleScan(msg.bugs).catch((e) => console.error('ofertaScan', e));
    sendResponse({ ok: true });
    return true;
  }
  if (msg && msg.type === 'ofertaBadge') {
    setBadge(msg.count || 0);
    sendResponse({ ok: true });
    return true;
  }
  if (msg && msg.type === 'oferWishCheck') {
    checkWishlist(msg.rows).catch((e) => console.error('oferWishCheck', e));
    sendResponse({ ok: true });
    return true;
  }
  if (msg && msg.type === 'oferMsCheck') {
    msCheckFor(msg).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg && msg.type === 'oferOpenOffers') {
    chrome.tabs.create({ url: chrome.runtime.getURL('offers.html') });
    sendResponse({ ok: true });
    return true;
  }
});

// al iniciar el navegador/worker, restaurar el badge desde lo último guardado
// y garantizar que las alarmas diarias (TOP y gratis de Epic) existan siempre
// (instalación/update y arranque).
chrome.runtime.onInstalled.addListener(() => { setBadge(0); scheduleDailyTop(); scheduleEpicFreeCheck(); });
chrome.runtime.onStartup.addListener(() => { scheduleDailyTop(); scheduleEpicFreeCheck(); });
