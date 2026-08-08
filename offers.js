// offers.js — lógica de la página de comparación
'use strict';

(() => {
  const CACHE_VERSION = 7; // v7: invalida TODAS las cachés/historial persistidos de versiones anteriores (el único dato que podría interactuar con código viejo)
  const CACHE_TTL = 30 * 60 * 1000; // 30 min
  const REGION_KEY = 'ofertasRegion'; // región activa (multipaís)
  const cacheKey = () => `ofertasCache_${activeRegion().code}`; // caché de la página POR región
  const TOP_N = 5; // cuántos entran en el TOP Price Bugs del Día
  const EPIC_FREE_KEY = 'ofertasEpicFree';
  const EPIC_FREE_TTL = 12 * 60 * 60 * 1000; // 12 h — los gratis de Epic cambian cada jueves

  const $ = (id) => document.getElementById(id);

  // stamp de build: se loguea en cada init para confirmar que el navegador corre
  // el código actualizado (un usuario con build vieja puede ver errores que ya
  // fueron corregidos en disco).
  const BUILD_STAMP = 'gamesniper-offers-2026-08-08-v4-1-lettering'; // v4.1: branding (letterings por tema) + popup rediseñado
  const BUILD_LABEL = 'v4.1'; // etiqueta visible en el header (confirma la build sin consola)

  // ---------- reporte de errores (diagnóstico) ----------
  // Cualquier error que escape (o que se capture en los catches del scan) queda
  // visible en un panel flotante con el STACK COMPLETO: así, si algo vuelve a
  // fallar, se ve la línea exacta sin tener que abrir la consola.
  function reportErr(tag, e) {
    try {
      console.error(tag, e, e && e.stack);
      let box = document.getElementById('errReport');
      if (!box) {
        box = document.createElement('div');
        box.id = 'errReport';
        box.className = 'err-report';
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'err-report-close';
        close.textContent = '✕';
        close.setAttribute('aria-label', 'Cerrar reporte de errores');
        close.onclick = () => box.remove();
        box.appendChild(close);
        document.body.appendChild(box);
      }
      // el panel muestra QUÉ build lo generó: si aparece un error viejo, el stamp
      // confirma si corrió el código nuevo o una página/instancia cacheada.
      const line = document.createElement('div');
      line.className = 'err-report-line';
      const stamp = typeof BUILD_STAMP !== 'undefined' ? BUILD_STAMP : 'n/a';
      line.textContent = `[build ${stamp}] [${tag}] ${e && e.message ? e.message : String(e)}${e && e.stack ? '\n' + e.stack : ''}`;
      box.appendChild(line);
      // no dejar crecer el panel indefinidamente entre rescans: máx 8 entradas
      while (box.children.length > 9) box.removeChild(box.children[1]);
    } catch (_) { /* el reporte no debe romper nada */ }
  }

  // errores no capturados (los más difíciles de ver) también van al panel
  window.addEventListener('error', (ev) => reportErr('uncaught', ev.error || ev.message));
  window.addEventListener('unhandledrejection', (ev) => reportErr('promise', ev.reason));

  const state = {
    games: [],        // rows enriquecidas
    userGames: [],    // juegos agregados por el usuario desde el buscador de MS Store
    rate: null,       // { blue, oficial, tarjeta }
    rateType: 'blue',
    customRate: null,
    status: {},       // store → 'ok' | 'err' | 'loading'
    onlyBug: false,
    onlyWish: false,
    showExclusives: false, // mostrar también juegos con precio en 1 sola tienda
    view: 'grid',          // 'grid' | 'list' — persistido entre sesiones
    sort: 'bug',
    sortDir: 'asc',        // 'asc' | 'desc' — dirección del orden (encabezados clicables)
    theme: 'dark',         // 'dark' | 'light' — persistido entre sesiones
    query: '',
    genre: '',
    bugThreshold: 40,     // % de ahorro para marcar bug (configurable)
    scanning: false,
    notifyEnabled: true,   // notificaciones del navegador
    notifyThreshold: 60,   // % de ahorro mínimo para notificar
    history: {},           // name → [{ ts, msArs, bestUsdArs, savings }]
    wishlist: [],          // steamIds de la lista de deseados
    epicFree: [],          // juegos gratis semanales de Epic (sección 🎁)
    epicFreeMap: {},       // steamId → gratis activo que coincide con el catálogo (inyección en cards)
    epicFreeLoaded: false, // true cuando el mapa ya se construyó (evita borrar gratis por carrera)
    forceRefresh: false,   // el botón ↻ ignora la caché y refetchea todo
    filters: {             // filtros inteligentes
      aaa: false, coop: false, topRated: false, histLow: false, free: false,
      maxPrice: null, minSavings: null,
    },
  };

  // ---------- helpers ----------
  function currentRate() {
    if (state.customRate != null && state.rateType === 'custom') return state.customRate;
    const r = state.rate && state.rate[state.rateType];
    if (r) return r;
    if (state.customRate != null) return state.customRate;
    // fallback conservador según la región: AR mantiene el 1560 histórico si falla
    // dolarapi (Steam/Epic devuelven USD en AR); el resto usa la tasa oficial del
    // último fetch o 1 (USD→USD no convierte).
    return state.rate && state.rate.oficial
      ? state.rate.oficial
      : (activeRegion().code === 'AR' ? 1560 : 1);
  }

  // Precio de una tienda en la MONEDA LOCAL de la región activa. Las tiendas ya
  // devuelven moneda local (Steam cc=, Epic country=, MS market=); si alguna
  // devuelve USD (caso Steam en AR), se convierte con la tasa activa.
  function localOf(storePrice) {
    if (!storePrice) return null;
    return storeToLocal(storePrice, activeRegion(), currentRate());
  }

  // Catálogo activo = GAMES (estático, 500+ juegos) + los que el usuario agregó
  // desde el buscador de Microsoft Store (persistidos en ofertasUserGames).
  function catalog() {
    return mergeCatalog(GAMES, state.userGames);
  }

  // ---------- fetch de todo (usa el registry de tiendas de stores.js) ----------
  // Progresivo: las rows se pintan a medida que llegan datos de cada tienda, así un
  // catálogo de 500+ juegos no se siente congelado en el primer scan.
  async function runScan() {
    if (state.scanning) return;
    state.scanning = true;
    $('refreshBtn').classList.add('loading');
    const loading = { dolar: 'loading' };
    for (const s of Object.values(STORES)) loading[s.id] = 'loading';
    try { renderStatus(loading); } catch (e) { reportErr('status', e); }
    if (!state.games.length) {
      try { renderGrid(); } catch (e) { reportErr('skeleton', e); } // skeletons durante el primer scan
    }
    const games = catalog();

    // 1) dólar
    try {
      state.rate = await fetchDolarRates();
      renderStatus({ dolar: state.rate ? 'ok' : 'err' });
    } catch (e) { renderStatus({ dolar: 'err' }); }

    // 2..n) tiendas del registry — en paralelo, con caché por tienda (TTL) y
    // render progresivo vía onProgress de pool/fetchStore.
    const results = {};
    // ---- barra de progreso 0→100% ----
    // Nada de pintar cards a medias (eso causaba el pestañeo): la barra muestra el
    // avance real de cada tienda y los juegos se pintan UNA sola vez al completar.
    const PROGRESS_STORES = Object.values(STORES).map((s) => s.id);
    const prog = {};
    for (const pid of PROGRESS_STORES) prog[pid] = 0;
    const setProgress = (id, v) => {
      if (id != null && prog[id] !== undefined) prog[id] = Math.min(1, Math.max(0, v));
      const box = $('scanProgress');
      if (!box) return;
      let acc = 0;
      for (const pid of PROGRESS_STORES) acc += prog[pid] || 0;
      const pct = Math.round((acc / PROGRESS_STORES.length) * 100);
      const fill = $('scanProgressFill');
      if (fill) fill.style.width = pct + '%';
      const lbl = $('scanProgressPct');
      if (lbl) lbl.textContent = pct + '%';
      const boxA = $('scanProgress');
      if (boxA) boxA.setAttribute('aria-valuenow', String(pct));
    };
    const finishProgress = () => {
      const box = $('scanProgress');
      if (!box) return;
      const fill = $('scanProgressFill');
      if (fill) fill.style.width = '100%';
      const lbl = $('scanProgressPct');
      if (lbl) lbl.textContent = '100%';
      if (box) box.setAttribute('aria-valuenow', '100');
      setTimeout(() => {
        // si ya arrancó OTRO scan, no ocultar la barra nueva (carrera de timers)
        if (state.scanning) return;
        box.hidden = true;
        if (fill) fill.style.width = '0%';
      }, 400);
    };
    { const box = $('scanProgress'); if (box) box.hidden = false; }
    setProgress(null, 0);
    try {
      await Promise.all(Object.values(STORES).map(async (s) => {
        try {
          if (!state.forceRefresh && (await DB.storeFresh(s.id))) {
            const cached = await DB.getStoreCache(s.id);
            const data = cached ? cached.data : null;
            // validar la forma del dato cacheado: batch → objeto; resto → array alineado
            const valid = s.batch
              ? data && typeof data === 'object' && !Array.isArray(data)
              : Array.isArray(data);
            results[s.id] = valid ? data : (s.batch ? {} : games.map(() => null));
            renderStatus({ [s.id]: 'ok' });
          } else {
            results[s.id] = await fetchStore(s.id, games, (partial) => {
              if (partial) {
                results[s.id] = partial;
                // avance real de esta tienda: ítems con dato / total (sin pintar cards)
                if (!s.batch && Array.isArray(partial) && games.length) {
                  setProgress(s.id, partial.filter((x) => x != null).length / games.length);
                }
              }
            });
            await DB.setStoreCache(s.id, results[s.id]);
            const ok = s.batch ? Object.keys(results[s.id] || {}).length > 0
              : (results[s.id] || []).some((x) => x);
            renderStatus({ [s.id]: ok ? 'ok' : 'err' });
          }
        } catch (e) {
          console.error(s.id, e);
          results[s.id] = s.batch ? {} : games.map(() => null);
          renderStatus({ [s.id]: 'err' });
        }
        setProgress(s.id, 1); // tienda terminada (fetch, caché o error)
      }));
    } catch (e) {
      // una tienda que rechaza NO debe tumbar el scan: se loguea y se sigue.
      reportErr('stores', e);
      finishProgress(); // la barra nunca debe quedar clavada aunque falle todo
    }
    state.forceRefresh = false;

    // armar rows finales y commitear
    try {
      const steamMap = results.steam || {};
      const epic = results.epic || [];
      const ms = results.ms || [];
      // resiliencia: si un juego puntual tiene datos que rompen buildRow/decorate
      // (p. ej. una caché vieja con forma rara), se salta SOLO ese juego y el scan
      // completo no muere. El log deja ver cuál fue para poder diagnosticarlo.
      let skipped = 0;
      const fresh = [];
      for (let i = 0; i < games.length; i++) {
        const g = games[i];
        try {
          fresh.push(buildRow(g, steamMap[g.steamId], epic[i], ms[i]));
        } catch (e) {
          skipped++;
          console.error('buildRow skip', g && g.name, e, e && e.stack);
        }
      }
      if (skipped > 0) console.warn('buildRow: ' + skipped + ' juegos omitidos por datos inválidos (ver logs de skip)');
      // conservar las cards previas (o caché) si el scan nuevo no trajo precios
      if (fresh.some((r) => r.stores.steam || r.stores.epic || r.stores.ms)) {
        state.games = fresh;
        await saveCache();
        await captureHistoryAll(fresh); // historial de precios por juego
      } else if (!state.games.length) {
        state.games = fresh; // filas todo-null → dispara el estado de error con reintento
      }
    } catch (e) {
      reportErr('build', e); // loguea + panel (evita duplicar el console.error)
    } finally {
      state.scanning = false;
      $('refreshBtn').classList.remove('loading');
    }
    finishProgress(); // barra al 100% → se oculta sola; recién acá se pintan los juegos
    try { render(); } catch (e) { reportErr('render', e); }
    try { notifyScan(); } catch (e) { reportErr('notifyScan', e); }
    try { notifyWishlist(); } catch (e) { reportErr('notifyWishlist', e); }
    // IMPORTANTE: loadEpicFree es async — un try/catch NO atrapa su rechazo. Sin
    // .catch(), un error ahí es un unhandled rejection que Chrome atribuye al
    // boundary de runScan (el "build TypeError" que veía el usuario).
    loadEpicFree().catch((e) => reportErr('epicFree', e));
  }

  // ---------- buscador universal de Microsoft Store ----------
  // Busca CUALQUIER juego del catálogo de MS Store y permite agregarlo al comparador
  // (si tiene versión en Steam/Epic se compara también desde el día 1). Así el usuario
  // tiene acceso a TODOS los juegos de Microsoft Store, no solo a los del catálogo.
  async function doMsSearch() {
    const input = $('msSearchInput');
    const term = input && input.value ? input.value.trim() : '';
    const box = $('msSearchResults');
    if (!box) return;
    if (!term) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="msr-loading">🔎 Buscando en Microsoft Store…</div>';
    let hits = [];
    try {
      hits = await searchMsStore(term);
    } catch (e) {
      box.innerHTML = '<div class="msr-empty">No se pudo consultar Microsoft Store. Revisá tu conexión e intentá de nuevo.</div>';
      return;
    }
    if (!hits.length) {
      box.innerHTML = `<div class="msr-empty">No encontramos "<b>${esc(term)}</b>" en Microsoft Store (región AR).<br/>Probá con el título en inglés o un término más corto.</div>`;
      return;
    }
    box.innerHTML = hits.map(msResultHTML).join('');
  }

  function msResultHTML(c) {
    const now = catalog();
    const exists = now.some((g) => normStr(g.name) === normStr(c.title));
    const isUser = state.userGames.some((g) => normStr(g.name) === normStr(c.title));
    const kind = storeOfferKind(c);
    let badge;
    if (kind === 'gamepass') badge = '<span class="msr-badge gp">🎮 Incluido con Xbox Game Pass</span>';
    else if (kind === 'free') badge = '<span class="msr-badge free">Gratis</span>';
    else badge = `<span class="msr-badge price">${fmtMoney(c.price)}</span>`;
    const art = c.art
      ? `<img src="${esc(c.art)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
      : '<span class="msr-art-ph">🎮</span>';
    const btn = exists
      ? (isUser
          ? `<button class="msr-btn remove" data-remove="${esc(c.title)}">✕ Quitar</button>`
          : `<button class="msr-btn added" disabled>✔ Ya está en el comparador</button>`)
      : `<button class="msr-btn add" data-add="${esc(c.title)}" data-price="${c.price || 0}">➕ Agregar al comparador</button>`;
    return `<div class="msr-card">
      <span class="msr-art">${art}</span>
      <div class="msr-info">
        <div class="msr-name">${esc(c.title)}</div>
        <div class="msr-badges">${badge}</div>
      </div>
      <a class="msr-open" href="${esc(c.url)}" target="_blank" rel="noopener" title="Abrir en Microsoft Store">↗</a>
      ${btn}
    </div>`;
  }

  async function addGameFromMs(candidate) {
    const entry = {
      name: candidate.title,
      genre: null,
      msTerm: candidate.title,
      epicTerm: candidate.title,
      user: true,
    };
    // mejor esfuerzo: resolver el appid de Steam para que la comparación funcione
    try {
      const st = await searchSteamAppId(candidate.title);
      if (st) entry.steamId = st.appid;
    } catch (e) { /* sin Steam → queda como juego de MS/Epic */ }
    state.userGames.push(entry);
    await Store.set('ofertasUserGames', state.userGames);
    populateGenres();
    await scanOne(entry);
    const input = $('msSearchInput');
    if (input && input.value.trim()) doMsSearch(); // refrescar (ahora dirá ✔)
  }

  // Escanea y agrega un ÚNICO juego (el que acaba de agregar el usuario) sin
  // refetchear las otras 500+ cards.
  async function scanOne(g) {
    try {
      const rate = await fetchDolarRates().catch(() => null);
      if (rate) state.rate = rate;
      const [steamMap, epic, ms] = await Promise.all([
        g.steamId ? fetchSteamPrices([g.steamId]).catch(() => ({})) : Promise.resolve({}),
        fetchEpicPrice(g.epicTerm || g.name).catch(() => null),
        fetchMsPrice(g.msTerm || g.name).catch(() => null),
      ]);
      const row = buildRow(g, steamMap[g.steamId], epic, ms);
      const i = state.games.findIndex((r) => r.g && normStr(r.g.name) === normStr(g.name));
      if (i >= 0) state.games[i] = row; else state.games.push(row);
      await captureHistoryAll([row]);
      await saveCache();
      render();
      refreshBadge();
    } catch (e) {
      console.error('scanOne', e);
    }
  }

  async function removeUserGame(name) {
    state.userGames = state.userGames.filter((g) => normStr(g.name) !== normStr(name));
    await Store.set('ofertasUserGames', state.userGames);
    state.games = state.games.filter((r) => r.g && normStr(r.g.name) !== normStr(name));
    await saveCache();
    populateGenres();
    render();
    refreshBadge();
  }

  // ---------- juegos gratis semanales de Epic ----------
  // Carga los gratis de Epic con caché (TTL 12 h) y renderiza la sección 🎁.
  // Los gratis cambian cada jueves, así que 12 h alcanzan de sobra.
  async function loadEpicFree() {
    try {
      let list = null;
      const cached = await Store.get(EPIC_FREE_KEY);
      if (cached && cached.ts && Date.now() - cached.ts < EPIC_FREE_TTL) {
        list = cached.list || null;
      } else {
        list = await fetchEpicFreeGames().catch(() => null);
        if (list && list.length) await Store.set(EPIC_FREE_KEY, { ts: Date.now(), list });
      }
      if (list && list.length) state.epicFree = list;
      // si el fetch falló (null/vacío) y ya teníamos juegos, conservar los previos
      // (degradación elegante, igual que las cards del scan)
    } catch (e) {
      console.error('epicFree', e);
    }
    // mapa steamId → gratis ACTIVO que coincide con el catálogo (inyección en cards)
    try {
      state.epicFreeMap = epicFreeCatalogMap(catalog(), state.epicFree);
      state.epicFreeLoaded = true;
      // re-decorar las rows ya construidas para que la inyección 🎁 aparezca en las
      // cards existentes (el scan construye rows antes de que se resuelva este fetch).
      // silent=true: el runScan ya notificó; el badge se refresca igual (refreshBadge).
      if (state.games.length) recomputeRows(true);
      renderEpicFree();
    } catch (e) {
      // nunca dejar que la inyección de gratis tumbe el runScan (rechazo async)
      reportErr('epicFree.post', e);
    }
  }

  function fmtEpicEnds(endMs) {
    const ms = endMs - Date.now();
    if (ms <= 0) return '¡Termina hoy!';
    const d = Math.floor(ms / 86400e3);
    const h = Math.floor((ms % 86400e3) / 3600e3);
    const m = Math.floor((ms % 3600e3) / 60e3);
    if (d > 0) return `Quedan ${d}d ${h}h`;
    if (h > 0) return `Quedan ${h}h ${m}m`;
    return `Quedan ${m}min`;
  }

  function epicFreeCardHTML(g) {
    const endMs = g.endDate ? new Date(g.endDate).getTime() : null;
    // solo mostrar el tachado si hubo un precio real (evita "<s>$0.00</s> → Gratis")
    const orig = g.original > 0 ? fmtUSD(g.original) : '';
    const ends = endMs
      ? `<span class="efc-ends ${endMs - Date.now() < 86400e3 ? 'urgent' : ''}" data-end="${endMs}">⏳ ${fmtEpicEnds(endMs)}</span>`
      : '';
    // portada del juego (keyImages del GraphQL de Epic): miniatura redondeada a la
    // izquierda del tag; si la caché vieja no trae art, un 🎮 placeholder mantiene el tamaño
    const art = `<span class="efc-art">${g.art ? `<img src="${esc(g.art)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : '🎮'}</span>`;
    // tiempo restante + botón Reclamar van SIEMPRE juntos (.efc-action): el botón
    // queda al lado del countdown y no se separan aunque la card haga wrap
    const action = `<span class="efc-action">${ends}<span class="efc-btn">Reclamar →</span></span>`;
    return `<a class="epic-free-card" href="${esc(g.url || '#')}" target="_blank" rel="noopener">
      ${art}
      <span class="efc-tag">🎁 GRATIS</span>
      <span class="efc-name">${esc(g.title)}</span>
      ${orig ? `<span class="efc-orig"><s>${orig}</s> → Gratis</span>` : '<span class="efc-orig">Gratis por tiempo limitado</span>'}
      ${action}
    </a>`;
  }

  function renderEpicFree() {
    const section = $('epicFreeSection');
    if (!section) return;
    const now = Date.now();
    // filtrar vencidos (igual que el popup) y ordenar por urgencia (vence antes primero)
    const list = state.epicFree
      .filter((g) => g && g.title && (!g.endDate || new Date(g.endDate).getTime() > now))
      .sort((a, b) => (a.endDate ? new Date(a.endDate).getTime() : Infinity) - (b.endDate ? new Date(b.endDate).getTime() : Infinity));
    // limpiar el timer previo SIEMPRE (aunque la lista quedó vacía) para no fugarlo
    clearInterval(renderEpicFree._iv);
    renderEpicFree._iv = null;
    section.classList.toggle('hidden', !list.length);
    if (!list.length) return;
    $('epicFreeList').innerHTML = list.map(epicFreeCardHTML).join('');
    // countdown en vivo: actualiza los .efc-ends cada 60 s mientras la página esté abierta
    renderEpicFree._iv = setInterval(() => {
      document.querySelectorAll('.efc-ends[data-end]').forEach((el) => {
        const end = Number(el.dataset.end);
        if (!end) return;
        el.textContent = `⏳ ${fmtEpicEnds(end)}`;
        el.classList.toggle('urgent', end - Date.now() < 86400e3);
        if (end - Date.now() <= 0) el.closest('.epic-free-card')?.remove();
      });
      // si todas las cards vencieron, ocultar la sección entera y frenar el timer
      if (!section.querySelector('.epic-free-card')) {
        section.classList.add('hidden');
        clearInterval(renderEpicFree._iv);
        renderEpicFree._iv = null;
      }
    }, 60e3);
  }

  // ---------- notificaciones / badge ----------
  // Envía el resultado del scan al service worker (badge + notificación del navegador).
  function notifyScan() {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
    const bugs = state.games
      .filter((r) => r.bug && r.savings != null)
      .map((r) => ({ name: r.g.name, savings: r.savings, msArs: r.msArs, msUrl: r.stores.ms ? r.stores.ms.url : null, type: r.type }));
    try {
      chrome.runtime.sendMessage({ type: 'ofertaScan', bugs }).catch(() => {});
    } catch (e) { /* sin background en contextos no-extensión */ }
  }

  // Badge directo (por si el usuario cambia el toggle sin rescanear).
  // Refleja la cantidad TOTAL de bugs del último scan.
  function refreshBadge() {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
    const n = state.games.filter((r) => r.bug).length;
    try {
      chrome.runtime.sendMessage({ type: 'ofertaBadge', count: n }).catch(() => {});
    } catch (e) { /* noop */ }
  }

  // Decora una row base {g, stores, ars, msArs} con todas las métricas
  // (anomalía, mejor tienda, riesgo, score). Se reusa al cambiar el umbral sin refetchear.
  function decorate(r) {
    // guard defensivo: una row malformada (caché vieja, dato raro) no puede romper
    // el scan; se normaliza a objetos vacíos y se sigue con las demás.
    if (!r || !r.g || !r.g.name) return r;
    const g = r.g;
    const stores = r.stores && typeof r.stores === 'object' ? r.stores : {};
    const ars = r.ars && typeof r.ars === 'object' ? r.ars : {};
    // write-back: si la row venía con stores/ars malformados, el resto del render
    // (cardHTML, notifyScan…) lee r.stores.r/ars y no debe volver a chocar.
    r.stores = stores;
    r.ars = ars;
    const msArs = r.msArs != null ? r.msArs : (ars.ms != null ? ars.ms : null);
    // 🎁 gratis semanal de Epic: si el juego del catálogo coincide con un gratis ACTIVO
    // de esta semana, la columna Epic muestra el gratis (precio 0 + URL de reclamo de
    // Epic) y compite como MEJOR PRECIO (vale 0). Si la semana terminó y la card traía
    // un gratis inyectado, se vuelve a sin-datos hasta el próximo scan.
    const fg = state.epicFreeMap && state.epicFreeMap[g.steamId];
    const epicFree = !!fg;
    if (fg) {
      stores.epic = { price: 0, original: fg.original || 0, free: true, currency: 'USD', url: fg.url, weekly: true };
      ars.epic = 0;
    } else if (stores.epic && stores.epic.weekly && state.epicFreeLoaded) {
      stores.epic = null; // la semana terminó → sin-datos hasta el próximo scan
      ars.epic = null;
    }
    // recomputar el mejor precio PAGO (Steam/Epic): un gratis (0) no compite como precio
    const usdCandidates = [ars.steam, ars.epic].filter((v) => v != null && v > 0);
    const bestUsdArs = usdCandidates.length ? Math.min(...usdCandidates) : null;
    const { type: rawType, savings: rawSavings } = detectType({ msArs, bestUsdArs }, state.bugThreshold);
    // si el juego es gratis en Epic, la oportunidad es el regalo (no un bug de MS)
    const type = epicFree ? 'none' : rawType;
    const savings = epicFree ? null : rawSavings;
    const bug = type !== 'none';

    // mejor tienda = precio real de compra más barato, o gratis real (vale 0).
    // Game Pass-only NO compite: requiere suscripción, no es un precio de compra.
    let bestStore = null, bestVal = Infinity;
    for (const k of ['ms', 'steam', 'epic']) {
      const kind = storeOfferKind(stores[k]);
      if (kind !== 'purchase' && kind !== 'free') continue;
      const v = ars[k];
      if (v != null && v < bestVal) { bestVal = v; bestStore = k; }
    }

    const hist = state.history[g.name] || [];
    const ageHours = dealAgeHours(hist);
    const trend = priceTrend(hist);
    const discount = bestStore && stores[bestStore] ? stores[bestStore].discount || 0 : 0;
    const risk = correctionRisk({ type, savings, ageHours, trend });
    let score = opportunityScore({
      type, savings, risk: risk.risk, popularity: popularityOf(g.name),
      ageHours, trend, discount,
    });
    // un gratis semanal es una oportunidad real (100% de ahorro): no debe quedar en 0
    if (epicFree && score < 70) score = 70;
    const avail = availableStoreCount(stores);
    // "se acabó la oportunidad": el price bug fue corregido (el precio MS subió)
    const gone = opportunityGone(hist, { msArs, type }, { bugThreshold: state.bugThreshold });
    // mínimo histórico en CUALQUIER tienda (mejor precio de compra en ARS) + min semanal (MS)
    const anyArs = Number.isFinite(bestVal) && bestVal > 0 ? bestVal : null;
    return Object.assign(r, {
      msArs, bestUsdArs, savings, bug, type, risk, score, hist, bestStore, bestVal,
      gone, epicFree,
      histLow: isHistoricLowAny(hist, anyArs),
      weekLow: isWeeklyLow(hist, msArs),
      histStats: histStats(hist, msArs),
      rating: scoreRating(score),
      urgent: isUrgent({ type, savings, risk: risk.risk }),
      aaa: isAaa(g.name),
      coop: isCoop(g.name),
      topRated: isTopRated(g.name),
      wished: state.wishlist.includes(g.steamId),
      avail,
      msKind: storeOfferKind(stores.ms),
    });
  }

  function buildRow(g, steam, epic, ms) {
    let stores = { steam, epic, ms };
    let ars = {};
    for (const k of ['steam', 'epic', 'ms']) ars[k] = localOf(stores[k]);
    // regla cross-store: un juego con precio real en Steam/Epic no puede ser gratis de
    // verdad en MS (los F2P son gratis en todas las tiendas) → si MS dice "Gratis" pero
    // Steam/Epic tienen precio, es Xbox Game Pass, no gratis. Se aplica ANTES de decorate
    // para que msArs, kind, best y la detección de bugs se computen con el dato correcto.
    ({ stores, ars } = reclassifySuspiciousFree(stores, ars));
    const usdCandidates = [ars.steam, ars.epic].filter((v) => v != null && v > 0);
    const bestUsdArs = usdCandidates.length ? Math.min(...usdCandidates) : null;
    return decorate({ g, stores, ars, msArs: ars.ms, bestUsdArs });
  }

  // Recomputa las métricas de las rows actuales (sin consultar tiendas) tras
  // cambiar el umbral de bug o al inyectar los gratis semanales de Epic.
  // silent=true omite re-notificar al SW: loadEpicFree() ya fue precedida por
  // notifyScan() del runScan, y handleScan() es idempotente (badge + persistir
  // bugs), así que re-enviarlo solo duplicaría mensajes sin efecto.
  function recomputeRows(silent = false) {
    state.games = state.games.map((r) => decorate(r));
    render();
    refreshBadge();
    if (!silent) notifyScan();
  }

  // ---------- historial de precios ----------
  async function captureHistoryAll(rows) {
    const now = Date.now();
    let dirty = false;
    for (const r of rows) {
      if (!r || !r.g || !r.g.name) continue;
      // mejor precio real de compra en ARS en cualquier tienda (para el mínimo histórico)
      const bestArs = Number.isFinite(r.bestVal) && r.bestVal > 0 ? Math.round(r.bestVal) : null;
      // sin precio MS pero con precio en otra tienda: registrar igual para el min any-store
      if ((r.msArs == null || r.msArs <= 0) && bestArs == null) continue;
      const prev = state.history[r.g.name] || [];
      const next = captureHistory(prev, {
        ts: now,
        msArs: r.msArs != null && r.msArs > 0 ? Math.round(r.msArs) : null,
        bestUsdArs: r.bestUsdArs != null ? Math.round(r.bestUsdArs) : null,
        bestArs,
        savings: r.savings,
      });
      if (next !== prev) { state.history[r.g.name] = next; dirty = true; }
    }
    if (dirty) await DB.setHistory(state.history);
  }

  // ---------- render ----------
  function render() {
    renderDashboard();
    renderTop();
    renderGrid();
  }

  // ---------- Dashboard (todas las stats juntas) ----------
  function renderDashboard() {
    const set = (id, n) => { const el = $(id); if (el) el.textContent = n || '–'; };
    set('dashBugs', state.games.filter((r) => r.bug).length);
    set('dashBig', state.games.filter((r) => r.score >= 70).length);
    set('dashLows', state.games.filter((r) => r.histLow).length);
    // calidad de datos: "juegos" refleja solo comparaciones reales (2+ tiendas),
    // salvo que el usuario active "Mostrar exclusivos".
    const total = state.showExclusives
      ? state.games.length
      : state.games.filter((r) => r.avail >= 2).length;
    set('statGames', total);
    set('statBugs', state.games.filter((r) => r.bug).length);
  }

  // ---------- TOP Price Bugs del Día ----------
  function renderTop() {
    const section = $('topSection');
    if (!section) return;
    const top = state.games
      .filter((r) => r.bug && r.savings != null)
      .sort((a, b) => b.savings - a.savings)
      .slice(0, TOP_N);
    if (!top.length) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');
    section.querySelector('.top-sub').textContent =
      `${top.length} oportunidades detectadas hoy — ordenadas por ahorro.`;
    section.querySelector('.top-list').innerHTML = top.map((r, i) => `
      <a class="top-card ${r.type === 'regional' ? 'regional' : ''}" href="${esc(bestUrl(r))}" target="_blank" rel="noopener">
        <span class="top-rank">#${i + 1}</span>
        <span class="top-name">${esc(r.g.name)}</span>
        <span class="top-save">-${r.savings}%</span>
        <span class="top-score" style="--sc:${r.score}">${r.score}</span>
      </a>`).join('');
  }

  function bestUrl(r) {
    return r.bestStore && r.stores[r.bestStore] ? r.stores[r.bestStore].url : '#';
  }

  function filteredSorted() {
    let list = state.games.slice();
    // calidad de datos: por defecto solo juegos con precio comparable en 2+ tiendas.
    // "Mostrar exclusivos" revela los que tienen precio en una sola tienda. El filtro
    // 🎁 Gratis se comporta como exclusivos implícitos: un juego gratis en UNA sola
    // tienda (F2P solo en Steam, gratis semanal de Epic como única tienda) es
    // exactamente lo que el usuario busca y no debe descartarse por la regla de 2+.
    if (!state.showExclusives && !state.filters.free) list = list.filter((r) => r.avail >= 2);
    if (state.onlyBug) list = list.filter((r) => r.bug);
    if (state.onlyWish) list = list.filter((r) => r.wished);
    if (state.genre) list = list.filter((r) => r.g.genre === state.genre);
    const f = state.filters;
    if (f.aaa) list = list.filter((r) => r.aaa);
    if (f.coop) list = list.filter((r) => r.coop);
    if (f.topRated) list = list.filter((r) => r.topRated);
    if (f.histLow) list = list.filter((r) => r.histLow);
    if (f.free) list = list.filter((r) => anyFreeStore(r.stores));
    if (f.maxPrice != null) list = list.filter((r) => r.msArs != null && r.msArs <= f.maxPrice);
    if (f.minSavings != null) list = list.filter((r) => r.savings != null && r.savings >= f.minSavings);
    const q = normStr(state.query);
    if (q) list = list.filter((r) => normStr(r.g.name).includes(q));

    list.sort((a, b) => compareBySortDir(a, b, state.sort, state.sortDir));
    return list;
  }

  function renderGrid() {
    const grid = $('grid');
    const count = $('gridCount');
    // la clase de vista se mantiene consistente incluso en skeletons/error/empty
    grid.classList.toggle('list-view', state.view === 'list');
    if (!state.games.length) {
      // durante el escaneo inicial mostramos skeletons
      if (count) count.textContent = '';
      grid.innerHTML = Array.from({ length: 6 }, () => '<div class="skeleton"></div>').join('');
      return;
    }
    // estado de error real: el scan terminó pero ninguna tienda devolvió precios
    if (!state.scanning && state.games.every((r) => !r.stores.steam && !r.stores.epic && !r.stores.ms)) {
      if (count) count.textContent = '';
      grid.innerHTML = `<div class="empty">No se pudo consultar ninguna tienda.<br/>
        <button class="btn-refresh" id="retryBtn">↻ Reintentar</button></div>`;
      const retry = document.getElementById('retryBtn');
      if (retry) retry.addEventListener('click', () => runScan().catch((e) => reportErr('runScan', e)));
      return;
    }
    const list = filteredSorted();
    if (!list.length) {
      const hasAny = state.games.some((r) => r.avail >= 1);
      // con el filtro Gratis activo el vacío es "no hay gratis", no "faltan 2 tiendas"
      grid.innerHTML = state.filters.free
        ? '<div class="empty">No se encontraron juegos gratis en ninguna tienda 🎁</div>'
        : hasAny && !state.showExclusives
          ? `<div class="empty">Sin comparaciones: cada juego necesita precio en al menos 2 tiendas.<br/>
               <button class="btn-refresh" id="showExclBtn">👀 Mostrar exclusivos</button></div>`
          : '<div class="empty">No se encontraron juegos con esos filtros 🎮</div>';
      const b = document.getElementById('showExclBtn');
      if (b) b.addEventListener('click', () => { state.showExclusives = true; $('fExclusives').checked = true; render(); });
      return;
    }
    // presentación: la MISMA lista filtrada/ordenada se renderiza con el componente
    // de la vista activa (grid o list). Sin refetch: solo cambia el render.
    grid.innerHTML = state.view === 'list'
      ? listHeadHTML() + list.map(listRowHTML).join('')
      : list.map(cardHTML).join('');
    if (count) count.textContent = `${list.length} juegos en ${state.view === 'list' ? 'lista' : 'cuadrícula'}`;
  }

  // ---------- logos de tiendas (SVG inline, escalables y sin assets externos) ----------
  const STORE_LOGOS = {
    steam: '<svg viewBox="0 0 512 512" aria-hidden="true" focusable="false"><path fill="currentColor" d="M496 256c0 137-111.2 248-248.4 248-113.8 0-209.6-76.3-239-180.4l95.2 39.3c6.4 2.5 13.5 1.8 19.4-.9 25.4-11.6 53.9-13.8 81-5.9 43.7 12.6 89.9 3.8 126.1-23.7 36.3-27.5 57.1-69.6 57.1-114.9 0-79.4-64.6-143.8-144-143.8-79.4 0-144 64.4-144 143.8 0 35.3 12.7 67.8 35.8 92.9L4.5 300.6C1.7 176.5 97.8 47.8 248 16c105.4-22.4 211.3 34.8 238.4 135.7C491.7 177.5 496 216.1 496 256zM240.8 319.6l-78.9-32.6c7.9 5.3 16.9 8.9 26.5 10.5 28.6 4.8 55.7-3.2 76.6-22.4 20.8-19.2 31.7-45.3 30.6-73.2-.7-17.9-7.3-34.7-18.6-47.8-11.3-13.1-27-21.7-44.1-24.2-2.4-.4-4.8-.6-7.2-.6-17.2 0-33.6 6.4-46.2 18.1-12.6 11.7-20 27.5-20.7 44.4-.5 12.1 3.6 23.9 11.4 33.1l72.3 34.6c2.9 1.4 6.1 2.1 9.3 2.1 4.1 0 8.1-1.3 11.5-3.7 6.3-4.6 8-13.2 3.8-19.6-4.2-6.4-12.8-8.2-19.2-4.1-2.2 1.5-4.8 2.2-7.4 2.2-3.4 0-6.7-1.1-9.4-3.2l-52.4-25.1c4.5-.7 9-1 13.5-1 9.8 0 19.4 2.6 27.7 7.5 23.8 14 32 44.7 18.1 68.6-13.9 23.9-44.6 32.1-68.5 18.2z"/></svg>',
    epic: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="1.75" y="1.75" width="20.5" height="20.5" rx="5.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path fill="currentColor" d="M6.6 6.6h10.8v2.3H9.1v2.1h7.2v2.3H9.1v2.3h7.4v2.3H6.6z"/></svg>',
    ms: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 8h13l1.15 10.6a2.2 2.2 0 0 1-2.2 2.4H6.55a2.2 2.2 0 0 1-2.2-2.4z"/><path d="M9 10V6.2a3 3 0 0 1 6 0V10"/></svg>',
  };
  const storeName = (k) => (k === 'ms' ? 'Microsoft Store' : k === 'steam' ? 'Steam' : 'Epic Games');
  const miniLogo = (k) => `<span class="mini-logo ${k}">${STORE_LOGOS[k] || ''}</span>`;
  const rowGo = '<span class="row-go" aria-hidden="true">↗</span>';

  // ---------- vista Lista (comparar muchas filas rápido) ----------
  // Encabezados clicables: cada columna ordenable tiene un data-sort (key de
  // compareBySortDir) y un indicador ▲/▼ en la columna activa.
  const SORT_COLUMNS = [
    { key: 'steamPrice', label: 'Steam' },
    { key: 'epicPrice', label: 'Epic' },
    { key: 'msPrice', label: 'Microsoft' },
    { key: 'price', label: 'Mejor' },
    { key: 'savings', label: 'Ahorro' },
    { key: 'score', label: 'Score' },
  ];
  function listHeadHTML() {
    const sortable = SORT_COLUMNS.map(({ key, label }) => {
      const active = state.sort === key;
      const arrow = active ? (state.sortDir === 'asc' ? '▲' : '▼') : '';
      return `<span class="lh-sort ${active ? 'active' : ''}" data-sort="${key}" tabindex="0" role="button" aria-pressed="${active}" title="Ordenar por ${label}">${label}${active ? ` <em class="arrow">${arrow}</em>` : ''}</span>`;
    }).join('');
    return `
    <div class="list-head">
      <span></span>
      <span class="lh-name">Juego</span>
      ${sortable}
      <span></span>
    </div>`;
  }
  function listRowHTML(row) {
    const { g, stores, ars, bug, savings, bestStore, score, histLow, weekLow, gone } = row;
    const art = stores.ms && stores.ms.art ? esc(stores.ms.art) : null;
    const indicators = [
      bug ? '<span class="ind" title="Price Bug">🔥</span>' : '',
      bestStore ? '<span class="ind best" title="Mejor precio">💚</span>' : '',
      histLow ? '<span class="ind low" title="Mínimo histórico">📉</span>' : '',
      weekLow ? '<span class="ind week" title="Mínimo de la semana">📅</span>' : '',
      score >= 70 ? '<span class="ind star" title="Oferta destacada">⭐</span>' : '',
      gone ? '<span class="ind gone" title="Se acabó la oportunidad">⛔</span>' : '',
    ].join('');
    // cada celda de precio es un link directo a la página del juego en esa tienda
    const cell = (k) => {
      const store = stores[k];
      if (!store) return '<span class="na">—</span>';
      const kind = storeOfferKind(store);
      // Game Pass y Gratis también son links (misma URL de la tienda): la lista
      // queda consistente con las cards — cada celda abre la página correspondiente.
      if (kind === 'gamepass') {
        return `<a class="gp cell-link" href="${esc(store.url)}" target="_blank" rel="noopener" title="Abrir en ${storeName(k)}">🎮 Game Pass</a>`;
      }
      if (kind === 'free') {
        const txt = store.weekly ? '🎁 GRATIS en Epic' : 'Gratis';
        const ttl = store.weekly ? `Reclamar en ${storeName(k)}` : `Abrir en ${storeName(k)}`;
        return `<a class="free${store.weekly ? ' weekly' : ''} cell-link" href="${esc(store.url)}" target="_blank" rel="noopener" title="${ttl}">${txt}</a>`;
      }
      const priceTxt = store.currency === activeRegion().currency
        ? fmtMoney(store.price)
        : `${fmtUsd(store.price)}<small>≈${fmtMoney(ars[k])}</small>`;
      return `<a class="cell-link" href="${esc(store.url)}" target="_blank" rel="noopener" title="Abrir en ${storeName(k)}" aria-label="Abrir en ${storeName(k)}">${miniLogo(k)}${priceTxt}</a>`;
    };
    const bestKind = bestStore ? storeOfferKind(stores[bestStore]) : 'none';
    // identificar QUÉ tienda es la más barata (logo + precio link; gratis real → Gratis link)
    const best = bestStore && stores[bestStore]
      ? bestKind === 'free'
        ? `<a class="free cell-link best-link" href="${esc(stores[bestStore].url)}" target="_blank" rel="noopener" title="Obtener gratis en ${storeName(bestStore)}">Gratis</a>`
        : `<a class="cell-link best-link" href="${esc(stores[bestStore].url)}" target="_blank" rel="noopener" title="Abrir en ${storeName(bestStore)}" aria-label="Abrir en ${storeName(bestStore)}">${miniLogo(bestStore)}${stores[bestStore].currency === activeRegion().currency ? fmtMoney(stores[bestStore].price) : fmtUsd(stores[bestStore].price)}</a>`
      : '—';
    const buy = bestStore && stores[bestStore]
      ? bestKind === 'free'
        ? `<a class="buy-btn free" href="${esc(stores[bestStore].url)}" target="_blank" rel="noopener" title="Obtener gratis">🎁</a>`
        : `<a class="buy-btn" href="${esc(stores[bestStore].url)}" target="_blank" rel="noopener" title="Comprar en ${esc(bestStore)}">🛒</a>`
      : '';
    return `<div class="list-row ${bug ? 'bugged' : ''}" data-id="${g.steamId}">
      ${art ? `<img class="list-art" src="${art}" alt="" loading="lazy" />` : `<div class="list-art"></div>`}
      <div class="list-name"><h3>${esc(g.name)}</h3><span class="list-ind">${indicators}</span></div>
      <div class="list-price">${cell('steam')}</div>
      <div class="list-price">${cell('epic')}</div>
      <div class="list-price ms">${cell('ms')}</div>
      <div class="list-best">${best}</div>
      <div class="list-save">${savings != null ? `-${savings}%` : ''}</div>
      <div class="list-score" style="--sc:${score}"><span>${score}</span></div>
      <div class="list-buy">${buy}</div>
    </div>`;
  }

  function storeRow(key, label, logoClass, store, ars, isBest) {
    const sname = key === 'ms' ? 'Microsoft' : key[0].toUpperCase() + key.slice(1);
    const openIn = `Abrir en ${storeName(key)}`;
    const logoHTML = STORE_LOGOS[key] || label;
    if (!store) {
      return `<div class="store-row">
        <span class="logo ${logoClass}">${logoHTML}</span>
        <span class="sname">${sname}</span>
        <span class="sprice na">no disponible</span>
      </div>`;
    }
    const kind = storeOfferKind(store);
    // Incluido con Xbox Game Pass SIN precio de compra: nunca mostrar como "Gratis"
    if (kind === 'gamepass') {
      return `<a class="store-row" href="${esc(store.url)}" target="_blank" rel="noopener" title="${openIn}" aria-label="${openIn}">
        <span class="logo ${logoClass}">${logoHTML}</span>
        <span class="sname">${sname}</span>
        <span class="sprice gp">🎮 Incluido con<br/>${esc(store.passName || 'Xbox Game Pass')}${rowGo}</span>
      </a>`;
    }
    // Gratuito real (sin suscripción). Si es el gratis semanal de Epic inyectado en
    // el catálogo, se muestra "🎁 GRATIS en Epic" con la URL de reclamo de Epic.
    if (kind === 'free') {
      const freeTxt = store.weekly ? '🎁 GRATIS en Epic' : 'Gratis';
      return `<a class="store-row ${isBest ? 'best' : ''}" href="${esc(store.url)}" target="_blank" rel="noopener" title="${openIn}" aria-label="${openIn}">
        <span class="logo ${logoClass}">${logoHTML}</span>
        <span class="sname">${sname}</span>
        <span class="sprice free${store.weekly ? ' weekly' : ''}">${freeTxt}${rowGo}</span>
      </a>`;
    }
    // Precio real de compra (puede tener además Game Pass)
    const priceFmt = store.currency === activeRegion().currency ? fmtMoney(store.price) : fmtUsd(store.price);
    const sub = store.currency === activeRegion().currency ? activeRegion().currency : `≈ ${fmtMoney(ars)}`;
    const disc = store.discount > 0 ? `<span class="discount">-${store.discount}%</span>` : '';
    const gpNote = store.gamePass ? `<span class="gp-note">🎮 en ${store.passName || 'Xbox Game Pass'}</span>` : '';
    const bestCls = isBest ? 'best' : '';
    return `<a class="store-row ${bestCls}" href="${esc(store.url)}" target="_blank" rel="noopener" title="${openIn}" aria-label="${openIn}">
      <span class="logo ${logoClass}">${logoHTML}</span>
      <span class="sname">${sname}${disc}</span>
      <span class="sprice">${priceFmt}${gpNote}<small>${sub}</small>${rowGo}</span>
    </a>`;
  }

  function scoreRing(score) {
    const r = 15.9; // radio
    const c = 2 * Math.PI * r; // circunferencia
    const off = c * (1 - (score || 0) / 100);
    const cls = score >= 70 ? 'hot' : score >= 40 ? 'good' : 'low';
    return `<svg class="score-ring" viewBox="0 0 40 40" aria-label="Oportunidad ${score}/100">
      <circle class="ring-bg" cx="20" cy="20" r="${r}" />
      <circle class="ring-val ${cls}" cx="20" cy="20" r="${r}" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" />
      <text class="ring-num" x="20" y="24" text-anchor="middle">${score}</text>
    </svg>`;
  }

  function historyBlock(row) {
    const hist = row.hist || [];
    const path = sparklinePath(hist.map((h) => h.msArs));
    const d1 = priceAt(hist, 24 * 3600e3);
    const d7 = priceAt(hist, 7 * 24 * 3600e3);
    const d30 = priceAt(hist, 30 * 24 * 3600e3);
    const lines = [
      ['24 h', d1], ['1 semana', d7], ['1 mes', d30],
    ].filter(([, v]) => v != null);
    const txt = lines.map(([l, v]) => `<span class="hist-item"><b>${l}</b> ${fmtMoney(v)}</span>`).join('');

    // estadísticas inteligentes del historial
    const st = row.histStats;
    let statsHtml = '';
    if (st) {
      const lastAt = st.lastAt != null ? ` · última vez: <b>${timeAgo(st.lastAt)}</b>` : '';
      const anyMin = st.bestMin != null ? `<span>Mín en cualquier tienda: <b>${fmtMoney(st.bestMin)}</b></span>` : '';
      statsHtml = `<div class="hist-stats">
        <span>Más barato que el <b>${st.cheaperPct}%</b> de las veces</span>
        <span>Prom <b>${fmtMoney(st.avg)}</b> · Mín <b>${fmtMoney(st.min)}</b> · Máx <b>${fmtMoney(st.max)}</b>${lastAt}</span>
        ${anyMin}
      </div>`;
    }

    if (!lines.length && !statsHtml) return '';
    return `<div class="hist-block">
      <div class="hist-head">📈 Historial de precios (MS + mejor tienda)</div>
      ${path ? `<svg class="spark" viewBox="0 0 96 28" preserveAspectRatio="none"><path d="${path}"/></svg>` : ''}
      ${statsHtml}
      ${txt ? `<div class="hist-items">${txt}</div>` : ''}
    </div>`;
  }

  function cardHTML(row) {
    const { g, stores, ars, bug, savings, bestStore, type, risk, score, rating, urgent, wished } = row;
    const art = stores.ms && stores.ms.art ? esc(stores.ms.art) : null;
    const artTag = art
      ? `<img class="card-art" src="${art}" alt="" loading="lazy" />`
      : `<div class="card-art"></div>`;
    const anomaly = bug
      ? type === 'regional'
        ? `<div class="type-tag regional">🚨 Posible precio regional incorrecto</div>`
        : `<div class="type-tag bug">🚨 Posible error de precio</div>`
      : '';
    // El banner gone-banner comunica "se acabó la oportunidad" (evita duplicar tag + banner)
    const tag = row.epicFree
      ? `<div class="free-tag epic">🎁 GRATIS esta semana en Epic</div>`
      : bug
        ? `<div class="cheap-tag">🔥 MS es ~${savings}% más barato</div>`
      : row.msKind === 'gamepass'
        ? `<div class="gp-tag">🎮 Incluido con Xbox Game Pass</div>`
        : row.msKind === 'free'
          ? `<div class="free-tag">🎁 Gratis en Microsoft Store</div>`
          : row.bestUsdArs != null && row.msArs != null
            ? `<div class="norm-tag">MS ≈ igual o más caro que Steam/Epic</div>`
            : `<div class="norm-tag">&nbsp;</div>`;
    // indicadores por card: bug / mejor precio / mínimo histórico / oferta destacada
    const chips = [
      bug ? '<span class="card-chip bug-chip">🔥 Price Bug</span>' : '',
      row.epicFree ? '<span class="card-chip free-chip">🎁 Gratis en Epic</span>' : '',
      bestStore && !bug ? `<span class="card-chip best-chip">💚 Mejor en ${esc(bestStore.toUpperCase())}</span>` : '',
      row.histLow ? '<span class="card-chip low">📉 Mínimo histórico</span>' : '',
      row.weekLow ? '<span class="card-chip week-chip">📅 Min. de la semana</span>' : '',
      score >= 70 ? '<span class="card-chip star-chip">⭐ Oferta destacada</span>' : '',
      row.gone ? '<span class="card-chip gone-chip">⛔ Oportunidad agotada</span>' : '',
      row.aaa ? '<span class="card-chip aaa">AAA</span>' : '',
      row.coop ? '<span class="card-chip coop">👥 Coop</span>' : '',
      row.topRated ? '<span class="card-chip rated">⭐ Top</span>' : '',
    ].join('');

    const rows = [
      storeRow('steam', 'S', 'steam', stores.steam, ars.steam, bestStore === 'steam'),
      storeRow('epic', 'E', 'epic', stores.epic, ars.epic, bestStore === 'epic'),
      storeRow('ms', 'M', 'ms', stores.ms, ars.ms, bestStore === 'ms'),
    ].join('');

    const bestKind = bestStore ? storeOfferKind(stores[bestStore]) : 'none';
    const buy = bestStore && stores[bestStore]
      ? bestKind === 'free'
        ? `<a class="buy-btn free" href="${esc(stores[bestStore].url)}" target="_blank" rel="noopener">
            🎁 Obtener gratis en la tienda más barata
          </a>`
        : `<a class="buy-btn" href="${esc(stores[bestStore].url)}" target="_blank" rel="noopener">
            🛒 Comprar en la tienda más barata (${stores[bestStore].currency === 'ARS' ? 'MS' : stores[bestStore].currency})
          </a>`
      : '';

    const riskLine = bug
      ? `<div class="risk-line ${risk.level}">${esc(risk.label)}</div>`
      : '';

    const urgentBanner = urgent
      ? `<div class="urgent-banner">🔥 COMPRA YA<br/><small>Precio ${savings}% inferior al habitual · ${esc(risk.label)}</small></div>`
      : '';

    const scoreRow = `
      <div class="score-row">
        <div class="score-bar"><span style="width:${score}%"></span></div>
        <span class="score-rating ${rating.cls}">${esc(rating.label)}</span>
      </div>`;

    const wishBtn = `<button class="wish-btn ${wished ? 'on' : ''}" data-wish="${g.steamId}" title="${wished ? 'Quitar de deseados' : 'Agregar a deseados'}">${wished ? '★' : '☆'}</button>`;

    const goneBanner = row.gone
      ? `<div class="gone-banner">⛔ SE ACABÓ LA OPORTUNIDAD<br/><small>El precio MS subió de ${fmtMoney(row.gone.prevMsArs)} a ${fmtMoney(row.gone.newMsArs)} (+${row.gone.risePct}%)</small></div>`
      : '';

    return `<article class="card ${bug ? 'bugged' : ''} ${row.gone ? 'gone' : ''}" data-id="${g.steamId}">
      <div class="score-wrap">${scoreRing(score)}<div class="score-label">Oportunidad</div></div>
      <div class="card-head">
        ${wishBtn}
        ${artTag}
        <div class="card-title"><h3>${esc(g.name)}</h3>${anomaly}${tag}</div>
      </div>
      ${scoreRow}
      ${urgentBanner}
      ${goneBanner}
      ${chips ? `<div class="card-chips">${chips}</div>` : ''}
      ${rows}
      ${buy}
      ${riskLine}
      ${historyBlock(row)}
    </article>`;
  }

  function populateGenres() {
    const genres = [...new Set(catalog().map((g) => g.genre).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
    const sel = $('genreSelect');
    sel.innerHTML = '<option value="">Todos los géneros</option>' +
      genres.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join('');
  }

  // ---------- statusbar (labels derivadas del registry de tiendas) ----------
  function renderStatus(st) {
    Object.assign(state.status, st);
    const labels = { dolar: 'Dólar' };
    for (const s of Object.values(STORES)) labels[s.id] = s.label;
    const bar = $('statusbar');
    bar.innerHTML = Object.keys(labels).map((k) => {
      const s = state.status[k];
      const cls = s === 'ok' ? 'ok' : s === 'err' ? 'err' : '';
      const text = s === 'ok' ? '✓' : s === 'err' ? '✕' : '…';
      return `<span class="chip ${cls}"><span class="dot"></span>${labels[k]} ${text}</span>`;
    }).join('');
  }

  // ---------- cache ----------
  async function saveCache() {
    // guardar sin `hist` (vive aparte en el historial por región) para no duplicar storage
    const games = state.games.map(({ hist, ...r }) => {
      if (!r || !r.g) return null;
      // el gratis semanal inyectado (stores.epic.weekly) es dato DERIVADO que se
      // re-inyecta en cada loadEpicFree; no persistirlo para que la caché nunca
      // muestre un "🎁 GRATIS" vencido al reabrir antes de la re-inyección.
      if (r.stores && r.stores.epic && r.stores.epic.weekly) r.stores.epic = null;
      return r;
    }).filter(Boolean);
    await Store.set(cacheKey(), { ts: Date.now(), v: CACHE_VERSION, rate: state.rate, games });
  }
  async function loadCache() {
    const c = await Store.get(cacheKey());
    // v: descartar cachés viejas con clasificación desactualizada (free:true para Game Pass)
    if (c && Array.isArray(c.games) && c.v === CACHE_VERSION && Date.now() - c.ts < CACHE_TTL) {
      // re-decorar con el umbral/historial actuales; se descartan las rows malformadas
      state.games = c.games.map((r) => {
        try { return decorate(r); } catch (e) { console.error('cache row skip', e); return null; }
      }).filter((r) => r && r.g && r.g.name);
      state.rate = c.rate || state.rate;
      if (state.games.length) render();
    }
  }

  // ---------- wishlist ----------
  async function loadWishlist() {
    state.wishlist = await DB.getWishlist();
    state.games.forEach((r) => { r.wished = state.wishlist.includes(r.g.steamId); });
  }

  // Envía las rows de los deseados al service worker para que detecte eventos
  // (baja de precio, mínimo histórico, bug, MS más barata, Epic gratis) y notifique.
  async function notifyWishlist() {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
    if (!state.wishlist.length) return;
    const rows = state.games
      .filter((r) => state.wishlist.includes(r.g.steamId))
      .map((r) => ({
        name: r.g.name,
        msArs: r.msArs,
        bestUsdArs: r.bestUsdArs,
        epicArs: r.ars && r.ars.epic,
        type: r.type,
        bestStore: r.bestStore,
        histLow: r.histLow,
        savings: r.savings,
        msUrl: r.stores.ms ? r.stores.ms.url : null,
      }));
    if (!rows.length) return;
    try {
      chrome.runtime.sendMessage({ type: 'oferWishCheck', rows }).catch(() => {});
    } catch (e) { /* noop */ }
  }

  // ---------- UI events ----------
  // ---------- tema claro/oscuro ----------
  // animate=true solo lo usa el toggle del usuario: agrega la clase theme-transition
  // (transiciones CSS activas ~450ms) SIN tocar el primer paint de init() ni los
  // overrides de prefers-reduced-motion. Se fuerza un reflow para que la clase se
  // registre antes del cambio de data-theme y la transición realmente ocurra.
  function applyTheme(theme, animate = false) {
    state.theme = theme === 'light' ? 'light' : 'dark';
    const root = document.documentElement;
    if (animate) {
      root.classList.add('theme-transition');
      void root.offsetWidth; // reflow: aplicar la clase antes del cambio de tema
      clearTimeout(applyTheme._anim);
      applyTheme._anim = setTimeout(() => root.classList.remove('theme-transition'), 500);
    }
    root.dataset.theme = state.theme;
    const btn = $('themeToggle');
    if (btn) {
      btn.textContent = state.theme === 'light' ? '☀️' : '🌙';
      btn.title = state.theme === 'light' ? 'Cambiar a tema oscuro' : 'Cambiar a tema claro';
    }
    // logo con fondo transparente: en tema claro se usa la variante con el anillo en
    // navy (#131d3a) porque el anillo blanco del logo sería invisible sobre el fondo
    // claro; en oscuro, la variante con anillo blanco. El nombre pixelado también
    // tiene variante por tema ("Game" blanco en oscuro / navy en claro).
    const light = state.theme === 'light';
    const logo = document.querySelector('.brand-logo img');
    if (logo) logo.src = light ? 'icons/gamesniper-light.png' : 'icons/gamesniper.png';
    const name = document.querySelector('.brand .gs-name');
    if (name) name.src = light ? 'icons/gamesniper-name-light.png' : 'icons/gamesniper-name.png';
  }

  // ---------- buscador unificado (toolbar + MS Store en vivo) ----------
  // El input del toolbar filtra el catálogo Y busca en vivo en Microsoft Store:
  // si el juego no está en el catálogo (aunque esté en MS Store), aparece acá con
  // botón ➕ para agregarlo al comparador. Debounced para no spamear la API.
  let liveSearchTimer = null;
  let liveSearchSeq = 0; // token anti-race: ignora respuestas fuera de orden
  function scheduleLiveSearch() {
    clearTimeout(liveSearchTimer);
    liveSearchTimer = setTimeout(runLiveSearch, 400);
  }
  async function runLiveSearch() {
    const box = $('searchLive');
    const input = $('searchInput');
    const term = input && input.value ? input.value.trim() : '';
    if (!box) return;
    const seq = ++liveSearchSeq;
    if (term.length < 3) { box.hidden = true; box.innerHTML = ''; if (input) input.setAttribute('aria-expanded', 'false'); return; }
    box.hidden = false;
    if (input) input.setAttribute('aria-expanded', 'true');
    box.innerHTML = '<div class="sl-loading">🔎 Buscando en Microsoft Store…</div>';
    let hits = [];
    try { hits = await searchMsStore(term, 20); } catch (e) {
      if (seq !== liveSearchSeq) return; // respuesta vieja: la ignora la más nueva
      box.innerHTML = '<div class="sl-empty">No se pudo consultar Microsoft Store ahora. Probá de nuevo en unos segundos.</div>';
      return;
    }
    if (seq !== liveSearchSeq) return; // respuesta vieja: la ignora la más nueva
    try {
      const names = new Set(catalog().map((g) => normStr(g.name)));
      const news = hits.filter((c) => !names.has(normStr(c.title))).slice(0, 8);
      if (!hits.length) {
        box.innerHTML = `<div class="sl-empty">No encontramos "<b>${esc(term)}</b>" en Microsoft Store (región AR).<br/>Probá con el título en inglés o un término más corto.</div>`;
        return;
      }
      if (!news.length) {
        box.innerHTML = '<div class="sl-empty">Todo lo que devuelve Microsoft Store para este término ya está en el catálogo — fijate en la grilla de abajo. 👇</div>';
        return;
      }
      box.innerHTML = '<div class="sl-head">En Microsoft Store (no está en el catálogo) — agregalo 👇</div>' +
        news.map(slRowHTML).join('');
    } catch (e2) { reportErr('liveSearch.render', e2); }
  }
  function slRowHTML(c) {
    const kind = storeOfferKind(c);
    const badge = kind === 'gamepass'
      ? '<span class="sl-badge gp">🎮 Game Pass</span>'
      : kind === 'free'
        ? '<span class="sl-badge free">Gratis</span>'
        : `<span class="sl-badge price">${fmtMoney(c.price)}</span>`;
    const art = c.art
      ? `<img src="${esc(c.art)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
      : '🎮';
    return `<div class="sl-row">
      <span class="sl-art">${art}</span>
      <span class="sl-name" title="${esc(c.title)}">${esc(c.title)}</span>
      ${badge}
      <button class="sl-add" data-live-add="${esc(c.title)}" data-live-price="${c.price || 0}">➕ Agregar</button>
    </div>`;
  }
  async function addFromLiveSearch(btn) {
    const title = btn.dataset.liveAdd;
    btn.disabled = true;
    btn.textContent = '⏳ Agregando…';
    await addGameFromMs({ title, price: Number(btn.dataset.livePrice) || 0 });
    // ya está en el catálogo: quitarlo del dropdown (solo faltaría re-buscar)
    const row = btn.closest('.sl-row');
    if (row) row.remove();
    const box = $('searchLive');
    if (box && !box.querySelector('.sl-row')) { box.hidden = true; box.innerHTML = ''; }
    // refrescar el filtro local (el juego nuevo ahora matchea con el término)
    renderGrid();
  }
  function closeLiveSearch(e) {
    const box = $('searchLive');
    const input = $('searchInput');
    if (box && !box.hidden) {
      if (e && e.target && e.target.closest && e.target.closest('.search-wrap')) return;
      box.hidden = true;
    }
    if (input) input.setAttribute('aria-expanded', 'false');
  }

  function bind() {
    $('refreshBtn').addEventListener('click', () => { state.forceRefresh = true; runScan().catch((e) => reportErr('runScan', e)); });
    $('searchInput').addEventListener('input', (e) => { state.query = e.target.value; renderGrid(); scheduleLiveSearch(); });
    $('searchInput').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeLiveSearch(); e.target.blur(); }
      if (e.key === 'Enter') { state.query = e.target.value; renderGrid(); }
    });
    if ($('searchLive')) $('searchLive').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-live-add]');
      if (btn) addFromLiveSearch(btn).catch((err) => reportErr('liveAdd', err));
    });
    document.addEventListener('click', closeLiveSearch);
    // accesibilidad: cerrar el dropdown si el foco sale del wrapper (sin matar el clic en Agregar)
    document.querySelector('.search-wrap')?.addEventListener('focusout', (e) => {
      if (!e.relatedTarget || !e.relatedTarget.closest || !e.relatedTarget.closest('.search-wrap')) closeLiveSearch();
    });
    $('genreSelect').addEventListener('change', (e) => { state.genre = e.target.value; renderGrid(); });
    $('sortSelect').addEventListener('change', async (e) => {
      state.sort = e.target.value;
      // al cambiar criterio desde el select, la dirección vuelve a la natural del criterio
      state.sortDir = NATURAL_DIR[state.sort] || 'asc';
      await persistSort();
      renderGrid();
    });
    $('viewToggle').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-view]');
      if (!btn) return;
      state.view = btn.dataset.view;
      await Store.set('ofertasView', state.view);
      [...document.querySelectorAll('#viewToggle button')].forEach((b) =>
        b.classList.toggle('active', b.dataset.view === state.view));
      renderGrid();
    });
    $('themeToggle').addEventListener('click', async () => {
      applyTheme(state.theme === 'dark' ? 'light' : 'dark', true);
      await Store.set('ofertasTheme', state.theme);
    });
    $('onlyBugToggle').addEventListener('change', (e) => { state.onlyBug = e.target.checked; renderGrid(); });
    $('onlyWishToggle').addEventListener('change', (e) => { state.onlyWish = e.target.checked; renderGrid(); });
    $('fExclusives').addEventListener('change', (e) => { state.showExclusives = e.target.checked; render(); });
    $('rateType').addEventListener('change', async (e) => {
      state.rateType = e.target.value;
      await Store.set('rateType', state.rateType);
      render();
    });
    $('customRate').addEventListener('change', async (e) => {
      const v = parseFloat(e.target.value);
      state.customRate = isNaN(v) || v <= 0 ? null : v;
      await Store.set('customRate', state.customRate);
      render();
    });
    $('notifyToggle').addEventListener('change', async (e) => {
      state.notifyEnabled = e.target.checked;
      await saveNotifySettings();
      refreshBadge();
    });
    $('notifyThreshold').addEventListener('change', async (e) => {
      const v = parseFloat(e.target.value);
      state.notifyThreshold = isNaN(v) ? 60 : Math.min(95, Math.max(10, Math.round(v)));
      $('notifyThreshold').value = state.notifyThreshold;
      await saveNotifySettings();
      refreshBadge();
    });
    $('bugThreshold').addEventListener('change', async (e) => {
      try {
        const v = Number(e.target.value);
        state.bugThreshold = [40, 50, 60, 70].includes(v) ? v : 40;
        await Store.set('ofertasBugThreshold', state.bugThreshold);
        recomputeRows();
      } catch (err) { reportErr('bugThreshold', err); }
    });
    // el input está anidado en un <label> con checkbox: evitar que el click lo togglee
    $('notifyThreshold').addEventListener('mousedown', (e) => e.stopPropagation());
    $('notifyThreshold').addEventListener('click', (e) => e.stopPropagation());

    // selector de región (multipaís): cambia la moneda de las 3 tiendas
    $('regionSelect').addEventListener('change', async (e) => {
      const code = e.target.value;
      setActiveRegion(code);
      await Store.set(REGION_KEY, code);
      updateRegionUI();
      // los precios/la moneda cambiaron: invalidar la caché de la página y re-escanear
      state.games = [];
      state.history = {};
      state.rate = null;
      runScan().catch((e) => reportErr('runScan', e));
    });
    // filtros inteligentes
    $('fAaa').addEventListener('change', (e) => { state.filters.aaa = e.target.checked; renderGrid(); });
    $('fCoop').addEventListener('change', (e) => { state.filters.coop = e.target.checked; renderGrid(); });
    $('fTopRated').addEventListener('change', (e) => { state.filters.topRated = e.target.checked; renderGrid(); });
    $('fHistLow').addEventListener('change', (e) => { state.filters.histLow = e.target.checked; renderGrid(); });
    $('fFree').addEventListener('change', (e) => { state.filters.free = e.target.checked; renderGrid(); });
    $('fMaxPrice').addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      state.filters.maxPrice = isNaN(v) || v <= 0 ? null : v;
      renderGrid();
    });
    $('fMinSavings').addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      state.filters.minSavings = isNaN(v) || v <= 0 ? null : v;
      renderGrid();
    });

    // buscador universal de Microsoft Store
    if ($('msSearchBtn')) $('msSearchBtn').addEventListener('click', () => doMsSearch().catch((err) => reportErr('msSearch', err)));
    if ($('msSearchInput')) $('msSearchInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doMsSearch().catch((err) => reportErr('msSearch', err)); }
    });
    if ($('msSearchResults')) $('msSearchResults').addEventListener('click', async (e) => {
      try {
        const add = e.target.closest('[data-add]');
        if (add) {
          add.disabled = true;
          add.textContent = '⏳ Agregando…';
          await addGameFromMs({ title: add.dataset.add, price: Number(add.dataset.price) || 0 });
          return;
        }
        const rm = e.target.closest('[data-remove]');
        if (rm) await removeUserGame(rm.dataset.remove);
      } catch (err) { reportErr('msSearch', err); }
    });

    // encabezados de columna clicables (vista Lista) — 1er clic ▲ asc, 2do ▼ desc
    const sortByHeader = async (th) => {
      const key = th.dataset.sort;
      if (state.sort === key) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sort = key;
        state.sortDir = 'asc';
      }
      $('sortSelect').value = state.sort;
      await persistSort();
      renderGrid();
    };
    $('grid').addEventListener('click', (e) => {
      const th = e.target.closest('.lh-sort');
      if (th) sortByHeader(th);
    });
    // accesibilidad: Enter/Espacio sobre el header ordena igual que el clic
    $('grid').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const th = e.target.closest('.lh-sort');
      if (th) {
        e.preventDefault();
        sortByHeader(th);
      }
    });
    // wishlist (delegación en el grid)
    $('grid').addEventListener('click', async (e) => {
      const btn = e.target.closest('.wish-btn');
      if (!btn) return;
      const sid = Number(btn.dataset.wish);
      if (!sid) return;
      state.wishlist = await DB.toggleWish(sid);
      state.games.forEach((r) => { if (r.g.steamId === sid) r.wished = state.wishlist.includes(sid); });
      renderGrid();
      notifyWishlist();
    });
  }

  // Actualiza textos que dependen de la región: subtítulo del brand, label del
  // tipo de cambio y opciones del select (Argentina usa Blue/Oficial/Tarjeta;
  // el resto usa una sola tasa oficial USD→moneda local).
  function updateRegionUI() {
    const r = activeRegion();
    const sub = $('brandSub');
    if (sub) sub.innerHTML = `Steam · Epic · Microsoft Store — precios en <b>${esc(r.currency)}</b>`;
    const rateLabel = $('rateLabel');
    if (rateLabel) {
      rateLabel.textContent = r.code === 'AR'
        ? 'Dólar:'
        : `USD→${r.currency}:`;
    }
    const rt = $('rateType');
    if (rt && r.code !== 'AR') {
      // fuera de Argentina solo hay una tasa oficial: ocultar Blue/Tarjeta
      [...rt.options].forEach((o) => {
        o.hidden = o.value === 'blue' || o.value === 'tarjeta';
      });
      if (state.rateType === 'blue' || state.rateType === 'tarjeta') {
        state.rateType = 'oficial';
        rt.value = 'oficial';
        Store.set('rateType', 'oficial');
      }
    } else if (rt) {
      [...rt.options].forEach((o) => { o.hidden = false; });
    }
  }

  async function persistSort() {
    await Promise.all([
      Store.set('ofertasSort', state.sort),
      Store.set('ofertasSortDir', state.sortDir),
    ]);
  }

  async function saveNotifySettings() {
    await Store.set('ofertasNotifySettings', {
      enabled: state.notifyEnabled,
      threshold: state.notifyThreshold,
    });
  }

  async function init() {
    console.log(BUILD_STAMP); // confirma versión del código cargado
    const buildTagEl = $('buildTag');
    if (buildTagEl) { buildTagEl.textContent = BUILD_LABEL; buildTagEl.title = 'Build ' + BUILD_STAMP; }
    bind();
    populateGenres();
    const [rt, cr, ns, bt, vw, st, sd, th, ug, reg] = await Promise.all([
      Store.get('rateType'), Store.get('customRate'), Store.get('ofertasNotifySettings'),
      Store.get('ofertasBugThreshold'),
      Store.get('ofertasView'), Store.get('ofertasSort'), Store.get('ofertasSortDir'), Store.get('ofertasTheme'),
      Store.get('ofertasUserGames'), Store.get(REGION_KEY),
    ]);
    // región activa (multipaís) ANTES de cargar caché/historial (las claves son por región)
    setActiveRegion(REGIONS[reg] ? reg : 'AR');
    const regSel = $('regionSelect');
    if (regSel) regSel.value = activeRegion().code;
    updateRegionUI();
    state.userGames = Array.isArray(ug) ? ug : [];
    state.rateType = rt || 'blue';
    state.customRate = cr || null;
    state.notifyEnabled = ns ? ns.enabled !== false : true;
    state.notifyThreshold = ns && ns.threshold ? Number(ns.threshold) : 60;
    state.bugThreshold = [40, 50, 60, 70].includes(Number(bt)) ? Number(bt) : 40;
    // el historial vive POR REGIÓN (la moneda cambia): se lee con DB.getHistory()
    state.history = (await DB.getHistory()) || {};
    state.view = vw === 'list' ? 'list' : 'grid';
    state.sort = ['bug', 'savings', 'score', 'price', 'discount', 'recent', 'name', 'steamPrice', 'epicPrice', 'msPrice'].includes(st) ? st : 'bug';
    // restaurar dirección recordada (default: la natural del criterio para no cambiar comportamiento)
    state.sortDir = sd === 'asc' || sd === 'desc' ? sd : (NATURAL_DIR[state.sort] || 'asc');
    applyTheme(th === 'light' ? 'light' : 'dark'); // tema antes de pintar (evita flash)
    await loadWishlist();
    $('rateType').value = state.rateType;
    if (state.customRate) $('customRate').value = state.customRate;
    $('notifyToggle').checked = state.notifyEnabled;
    $('notifyThreshold').value = state.notifyThreshold;
    $('bugThreshold').value = state.bugThreshold;
    $('sortSelect').value = state.sort;
    [...document.querySelectorAll('#viewToggle button')].forEach((b) =>
      b.classList.toggle('active', b.dataset.view === state.view));
    await loadCache();
    refreshBadge();
    runScan().catch((e) => reportErr('runScan', e)); // siempre refresca; la caché pinta rápido y después se actualiza
  }

  init();
})();
