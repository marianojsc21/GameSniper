// util.js — utilidades compartidas: normalización, matching, formato, storage
'use strict';

// --- Normalización para comparar títulos ---
const normStr = (s) =>
  (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quita acentos
    .replace(/[^a-z0-9]+/g, ' ');

const tokenize = (s) => normStr(s).split(/\s+/).filter(Boolean);

const EDITION_PENALTY = /deluxe|premium|ultimate|definitiv|gold edition|game of the year|goty|season pass|bundle|pack|dlc|soundtrack|aniversary edition|anniversary edition/;
const STANDARD_BONUS = /standard|est.ndar|base game/;

// Score 0..1 de similitud entre una query y un título de tienda.
function scoreMatch(query, title) {
  const q = tokenize(query);
  const t = tokenize(title);
  if (!q.length || !t.length) return 0;
  const qs = new Set(q);
  const overlap = q.filter((w) => t.includes(w)).length;
  let score = (2 * overlap) / (q.length + t.length);
  const nt = normStr(title);
  if (nt.includes(normStr(query))) score += 0.25; // contiene la query exacta
  if (EDITION_PENALTY.test(nt)) score -= 0.2;
  if (STANDARD_BONUS.test(nt)) score += 0.15;
  return score;
}

// Elige el mejor candidato de una lista de {title, ...} para la query. Retorna null si ninguno alcanza el umbral.
// Desempate: si dos candidatos empatan en score (mismo título), se prefiere el que
// tiene un precio de compra real o Game Pass por sobre la variante F2P/gratis. La API
// de MS Store devuelve a menudo DOS resultados con el MISMO título (ej. "Halo Infinite"
// gratis-multijugador vs el juego completo incluido con Game Pass) y pickBest elegía
// siempre el primero: el juego completo aparecía como "Gratis" cuando en realidad
// requiere suscripción. Verificado en vivo contra la API.
function pickBest(query, candidates, threshold = 0.5) {
  let best = null;
  let bestScore = threshold;
  // Un candidato "gratis real" (free sin precio ni Game Pass) pierde el empate contra
  // uno con precio de compra o Game Pass: muestra el juego completo, no la variante F2P.
  const weaker = (c) => !!c && c.free === true && !(c.price > 0) && !c.gamePass;
  for (const c of candidates || []) {
    const s = scoreMatch(query, c.title || '');
    if (s > bestScore) {
      bestScore = s;
      best = c;
    } else if (s === bestScore && best && weaker(best) && !weaker(c)) {
      // mismo score: reemplazar la variante gratis por la versión con precio/Game Pass
      best = c;
    }
  }
  return best;
}

// Filtra rows de juegos ({bug, savings}) que son bug y superan el umbral de ahorro %.
const bugRowsOver = (rows, threshold) =>
  (rows || []).filter((r) => r && r.bug && r.savings != null && r.savings >= threshold);

// --- Detección de "precio bug" en Microsoft Store ---
// MS ≤ ratio del mejor precio USD (Steam/Epic) → más barato → bug.
// El umbral es configurable: bugThreshold % de ahorro (default 40% → ratio 0.6).
const MS_BUG_RATIO = 0.6;
const MS_REGIONAL_RATIO = 0.35; // ≥65% más barato: huele a regionalización mal configurada

const bugRatioFor = (thresholdPct) => {
  const t = Number(thresholdPct);
  if (!isFinite(t) || t <= 0 || t >= 100) return MS_BUG_RATIO;
  return (100 - t) / 100;
};

// Dado el precio MS en ARS y el mejor precio Steam/Epic convertido a ARS,
// devuelve { bug: boolean, savings: % ahorro o null }. ratio = umbral de bug.
const compareForBug = ({ msArs, bestUsdArs }, ratio = MS_BUG_RATIO) => {
  if (msArs == null || msArs <= 0 || bestUsdArs == null || bestUsdArs <= 0) {
    return { bug: false, savings: null };
  }
  const rel = msArs / bestUsdArs;
  return { bug: rel <= ratio, savings: Math.round((1 - rel) * 100) };
};

// Clasifica la anomalía: 'bug' (error de precio) o 'regional' (precio regional
// extremadamente bajo, "argentinizado"). Devuelve { type, savings }.
const detectType = ({ msArs, bestUsdArs }, thresholdPct = 40) => {
  if (msArs == null || msArs <= 0 || bestUsdArs == null || bestUsdArs <= 0) {
    return { type: 'none', savings: null };
  }
  const rel = msArs / bestUsdArs;
  const savings = Math.round((1 - rel) * 100);
  if (rel <= MS_REGIONAL_RATIO) return { type: 'regional', savings };
  if (rel <= bugRatioFor(thresholdPct)) return { type: 'bug', savings };
  return { type: 'none', savings };
};

// ---------- probabilidad de corrección ----------
// Estima (0..1) cuán probable es que el precio se corrija/desaparezca pronto.
// Factores: magnitud del ahorro, tipo (regional), qué tan fresco es, tendencia subiendo.
const correctionRisk = ({ type, savings, ageHours = 24, trend = 0 }) => {
  if (!savings || savings <= 0) return { risk: 0, level: 'baja', label: 'Precio estable' };
  let r = 0.2;
  if (savings >= 60) r += 0.3;
  if (savings >= 80) r += 0.25;
  if (type === 'regional') r += 0.2;
  if (ageHours < 24) r += 0.15; // recién aparecido: más probable que lo detecten
  if (trend > 0) r += 0.1;
  r = Math.min(0.95, r);
  const level = r >= 0.7 ? 'alta' : r >= 0.45 ? 'media' : 'baja';
  const label =
    level === 'alta' ? '⚠️ Alta probabilidad de corrección' :
    level === 'media' ? '⏳ Es probable que el precio aumente pronto' :
    '✅ Precio estable';
  return { risk: r, level, label };
};

// ---------- score de oportunidad (0..100) ----------
// Factores: ahorro, tipo de anomalía, riesgo de corrección, popularidad,
// tiempo que lleva la oferta, tendencia y descuento oficial.
const opportunityScore = ({ type, savings, risk = 0, popularity = 0.5, ageHours = 24, trend = 0, discount = 0 }) => {
  if (!savings || savings <= 0) return 0;
  let s = 0;
  s += Math.min(50, savings * 0.5);            // diferencia de precio (domina)
  if (type === 'regional') s += 12;            // posible error regional
  s += Math.min(12, risk * 14);                // riesgo de corrección → urgencia
  s += Math.min(10, popularity * 10);          // popularidad del juego
  if (ageHours >= 6 && ageHours <= 168) s += 8; // ni recién salido ni eterno
  else if (ageHours < 6) s += 5;
  if (trend < 0) s += 6;                       // precio bajando = mejor momento
  s += Math.min(6, discount * 0.06);           // descuento histórico oficial
  return Math.max(0, Math.min(100, Math.round(s)));
};

// Popularidad aproximada (0..1) por nombre: hits masivos vs. el resto.
const POPULAR = new Set([
  'Cyberpunk 2077', 'ELDEN RING', "Baldur's Gate 3", 'Red Dead Redemption 2',
  'Grand Theft Auto V', 'The Witcher 3: Wild Hunt', 'Hogwarts Legacy', 'God of War',
  'God of War Ragnarök', "Marvel's Spider-Man Remastered", "Marvel's Spider-Man: Miles Morales",
  'The Last of Us Part I', 'Ghost of Tsushima', 'Horizon Zero Dawn', 'Horizon Forbidden West',
  'Starfield', 'Fallout 4', 'The Elder Scrolls V: Skyrim Special Edition', 'DOOM', 'DOOM Eternal',
  'Stardew Valley', 'Terraria', 'Minecraft Dungeons', 'Forza Horizon 5',
  'Halo: The Master Chief Collection', 'Sea of Thieves', 'Left 4 Dead 2', 'Portal 2', 'Half-Life 2',
  "No Man's Sky", 'Rust', 'ARK: Survival Evolved', 'Resident Evil 2', 'Resident Evil 4', 'Sekiro',
  'Street Fighter 6', 'TEKKEN 8', 'Mortal Kombat 1', 'Diablo IV', 'Apex Legends', 'Overwatch 2',
]);
const popularityOf = (name) => (POPULAR.has(name) ? 0.95 : 0.55);

// ---------- historial de precios ----------
// Cada entrada: { ts, msArs, bestUsdArs, savings }. Lista por nombre de juego.
const HISTORY_MAX = 90;

// Agrega una captura; no duplica si el precio MS Y el mejor precio (cualquier tienda,
// ARS) no cambiaron en los últimos 30 min. Devuelve la MISMA referencia si no hubo
// cambios (para detectar dirty sin reescribir storage).
const captureHistory = (hist, entry) => {
  const list = Array.isArray(hist) ? hist : [];
  const last = list[list.length - 1];
  const sameMs = last && Math.abs(last.msArs - entry.msArs) < 0.5;
  const sameBest = last && Math.abs((last.bestArs ?? -1) - (entry.bestArs ?? -1)) < 0.5;
  if (last && sameMs && sameBest && Math.abs(entry.ts - last.ts) < 30 * 60 * 1000) {
    return list;
  }
  return [...list, entry].slice(-HISTORY_MAX);
};

// Precio registrado hace `ageMs` (o el más reciente anterior a ese corte).
const priceAt = (hist, ageMs, now = Date.now()) => {
  const list = (hist || []).filter((h) => h && h.msArs != null && h.ts <= now - ageMs);
  const latest = list[list.length - 1];
  return latest ? latest.msArs : null;
};

// Tendencia del precio MS: >0 bajando, <0 subiendo, 0 estable. Rango aproximado [-1, 1].
const priceTrend = (hist) => {
  const list = (hist || []).filter((h) => h && h.msArs != null);
  if (list.length < 2) return 0;
  const first = list[0].msArs;
  const last = list[list.length - 1].msArs;
  if (!first) return 0;
  return (first - last) / first;
};

// Cuántas horas hace que el precio actual está vigente (última captura).
const dealAgeHours = (hist) => {
  const list = (hist || []).filter((h) => h && h.ts != null);
  if (!list.length) return 0;
  return Math.max(0, (Date.now() - list[list.length - 1].ts) / 3600000);
};

// Mini sparkline SVG (path) a partir de valores de precio. Vacío si hay < 2 puntos.
const sparklinePath = (values, w = 96, h = 28) => {
  const v = (values || []).filter((n) => n != null && n > 0);
  if (v.length < 2) return '';
  const min = Math.min(...v);
  const max = Math.max(...v);
  const span = max - min || 1;
  const step = w / (v.length - 1);
  return v
    .map((n, i) => {
      const x = (i * step).toFixed(1);
      const y = (h - 2 - ((n - min) / span) * (h - 4)).toFixed(1);
      return `${i === 0 ? 'M' : 'L'}${x},${y}`;
    })
    .join(' ');
};

// ---------- clasificación por sets (filtros inteligentes) ----------
const AAA_TITLES = new Set([
  'God of War', 'God of War Ragnarök', "Marvel's Spider-Man Remastered", "Marvel's Spider-Man: Miles Morales",
  'Horizon Zero Dawn', 'Horizon Forbidden West', 'The Last of Us Part I', 'Ghost of Tsushima',
  'Days Gone', 'Detroit: Become Human', 'Returnal', 'Ratchet & Clank: Rift Apart',
  'Cyberpunk 2077', 'ELDEN RING', 'Hogwarts Legacy', "Baldur's Gate 3", 'Red Dead Redemption 2',
  'Grand Theft Auto V', 'The Witcher 3: Wild Hunt', 'Sekiro: Shadows Die Twice',
  'Star Wars Jedi: Survivor', 'Star Wars Jedi: Fallen Order', 'Resident Evil 4', 'Resident Evil Village',
  'Resident Evil 2', 'Resident Evil 3', 'Resident Evil 7: Biohazard', 'Devil May Cry 5',
  'Monster Hunter: World', 'Monster Hunter: Rise', 'Monster Hunter Wilds', 'Street Fighter 6',
  'Mortal Kombat 1', 'TEKKEN 8', 'Diablo IV', 'Final Fantasy VII Remake', 'FINAL FANTASY XV',
  'FINAL FANTASY XVI', "Dragon's Dogma 2", 'Lies of P', 'Atomic Heart',
  'Warhammer 40,000: Space Marine 2', 'Kingdom Come: Deliverance II', 'Indiana Jones and the Great Circle',
  'Call of Duty: Black Ops 6', 'Immortals Fenyx Rising', "Assassin's Creed Mirage",
  "Assassin's Creed Valhalla", "Assassin's Creed Odyssey", "Assassin's Creed Origins",
  'Death Stranding Director\'s Cut', 'Death Stranding', 'Starfield', 'The Elder Scrolls V: Skyrim Special Edition',
  'DOOM', 'DOOM Eternal', 'Fallout 4', 'Fallout 76', 'Batman: Arkham Knight', 'Batman: Arkham Asylum',
  'Batman: Arkham City', 'Middle-earth: Shadow of War', 'Middle-earth: Shadow of Mordor',
  'Mortal Kombat 11', 'Injustice 2', 'Shadow of the Tomb Raider', 'Rise of the Tomb Raider', 'Tomb Raider',
  'HITMAN World of Assassination', 'Far Cry 6', 'Far Cry 5', 'Watch Dogs 2',
  "Tom Clancy's Rainbow Six Siege", 'Dying Light 2 Stay Human', 'Dying Light', 'Borderlands 3',
  'Metro Exodus', 'Titanfall 2', 'Battlefield 2042', 'STAR WARS Battlefront II', 'STAR WARS: Squadrons',
  'Overwatch 2', 'Apex Legends', "No Man's Sky", 'Rust', 'ARK: Survival Evolved', '7 Days to Die',
  'Dark Souls III', 'Dark Souls: Remastered', 'Dark Souls II: Scholar of the First Sin', 'Nioh 2',
  'Wo Long: Fallen Dynasty', 'Tales of Arise', 'CODE VEIN', 'DRAGON BALL Z: KAKAROT', 'GUILTY GEAR -STRIVE-',
  'Persona 5 Strikers', 'Fallout: New Vegas', 'Fallout 3: Game of the Year Edition',
]);
const isAaa = (name) => AAA_TITLES.has(name);

const COOP_TITLES = new Set([
  'Sea of Thieves', 'Gears 5', 'Gears Tactics', 'Grounded', 'Minecraft Dungeons', 'Deep Rock Galactic',
  'Valheim', 'Sons of the Forest', 'Palworld', 'Enshrouded', 'A Way Out', 'It Takes Two',
  'Left 4 Dead 2', 'Borderlands 3', 'Dying Light', 'Dying Light 2 Stay Human', "Don't Starve Together",
  'Terraria', 'Stardew Valley', 'Satisfactory', 'ARK: Survival Evolved', 'Rust', '7 Days to Die',
  'Project Zomboid', 'Halo: The Master Chief Collection', 'Halo Infinite', 'Portal 2', 'Overwatch 2',
  "Tom Clancy's Rainbow Six Siege", 'Apex Legends', 'Cuphead', 'Monster Hunter: World',
  'Monster Hunter: Rise', 'Monster Hunter Wilds', 'Warhammer 40,000: Space Marine 2', 'Cult of the Lamb',
]);
const isCoop = (name) => COOP_TITLES.has(name);

const TOP_RATED_TITLES = new Set([
  'The Witcher 3: Wild Hunt', 'ELDEN RING', 'Portal 2', 'Half-Life 2', "Baldur's Gate 3",
  'Red Dead Redemption 2', 'God of War', 'God of War Ragnarök', 'Cyberpunk 2077', 'Hollow Knight',
  'Celeste', 'Hades', 'Hades II', 'Stardew Valley', 'Slay the Spire', 'Cuphead', 'Sekiro: Shadows Die Twice',
  'Resident Evil 4', 'DOOM', 'DOOM Eternal', 'Left 4 Dead 2', 'Persona 5 Royal', 'Nier: Automata',
  'Ori and the Will of the Wisps', 'Ori and the Blind Forest', 'It Takes Two', 'Returnal',
  'Horizon Zero Dawn', 'The Last of Us Part I', "Marvel's Spider-Man Remastered", 'Ghost of Tsushima',
  'Devil May Cry 5', 'Psychonauts 2', 'Metro Exodus', 'Titanfall 2', 'Vampire Survivors', 'TUNIC',
  'DREDGE', 'Sea of Stars', 'Half-Life 2', 'Deep Rock Galactic', 'A Plague Tale: Innocence', 'Kena: Bridge of Spirits',
]);
const isTopRated = (name) => TOP_RATED_TITLES.has(name);

// ---------- estadísticas del historial ----------
// hist: [{ ts, msArs, bestUsdArs, savings }]. Devuelve métricas útiles.
const histStats = (hist, nowMsArs) => {
  const list = (hist || []).filter((h) => h && h.msArs != null);
  // mínimo histórico en cualquier tienda (ARS): se filtra por bestArs directamente
  // (no por msArs) porque puede haber entradas con msArs null pero bestArs válido
  const bests = (hist || []).filter((h) => h && h.bestArs != null && h.bestArs > 0).map((h) => h.bestArs);
  if (!list.length && !bests.length) return null;
  const prices = list.map((h) => h.msArs);
  const min = list.length ? Math.min(...prices) : null;
  const max = list.length ? Math.max(...prices) : null;
  const avg = list.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
  const cur = nowMsArs != null ? nowMsArs : (prices.length ? prices[prices.length - 1] : null);
  // % de veces que el historial registró un precio MAYOR que el actual.
  // Si la última captura ES el precio actual (el snapshot del scan), no se cuenta a
  // sí misma: así un mínimo histórico muestra "más barato que el 100% de las veces".
  const prior = prices[prices.length - 1] === cur ? prices.slice(0, -1) : prices;
  const cheaperPct = prior.length
    ? Math.round((prior.filter((p) => p > cur).length / prior.length) * 100)
    : 0;
  // última vez (antes de la captura actual) que tuvo exactamente este precio
  let lastAt = null;
  for (let i = list.length - 2; i >= 0; i--) {
    if (cur != null && list[i].msArs === cur) { lastAt = list[i].ts; break; }
  }
  return {
    min, max, avg: avg != null ? Math.round(avg) : null, cheaperPct, lastAt, count: list.length,
    bestMin: bests.length ? Math.min(...bests) : null,
  };
};

// ¿El precio actual es el mínimo de todo el historial (solo MS)?
// Variante MS-only (se mantiene por completitud y para tests); la página usa
// isHistoricLowAny (mínimo en cualquier tienda, ARS).
// Solo precios reales de compra: 0 (gratis) o null no cuentan como mínimo histórico.
const isHistoricLow = (hist, msArs) => {
  if (msArs == null || msArs <= 0) return false;
  const list = (hist || []).filter((h) => h && h.msArs != null && h.msArs > 0);
  if (!list.length) return false;
  return msArs <= Math.min(...list.map((h) => h.msArs));
};

// ¿El mejor precio actual en CUALQUIER tienda (convertido a ARS) es el mínimo del
// historial? Compara contra la serie 'bestArs' (precio de compra más barato en ARS
// entre Steam/Epic/MS). Precios reales: 0 (gratis) o null no cuentan.
const isHistoricLowAny = (hist, currBestArs) => {
  if (currBestArs == null || currBestArs <= 0) return false;
  const list = (hist || []).filter((h) => h && h.bestArs != null && h.bestArs > 0);
  if (!list.length) return false;
  return currBestArs <= Math.min(...list.map((h) => h.bestArs));
};

// ¿El precio MS actual iguala el mínimo de la última semana (7 días)?
// Solo precios reales de compra: 0 (gratis) o null no cuentan.
const isWeeklyLow = (hist, msArs, days = 7, now = Date.now()) => {
  if (msArs == null || msArs <= 0) return false;
  const cutoff = now - days * 86400e3;
  const list = (hist || []).filter(
    (h) => h && h.msArs != null && h.msArs > 0 && h.ts != null && h.ts >= cutoff
  );
  if (!list.length) return false;
  return msArs <= Math.min(...list.map((h) => h.msArs));
};

// ¿El precio subió respecto de hace 24 h?
const priceRoseToday = (hist) => {
  const list = (hist || []).filter((h) => h && h.msArs != null);
  if (list.length < 2) return false;
  const yesterday = priceAt(hist, 24 * 3600e3);
  const now = list[list.length - 1].msArs;
  return yesterday != null && now > yesterday;
};

// ---------- "se acabó la oportunidad" ----------
// Detecta que un price bug fue CORREGIDO: el juego estuvo bugueado en el historial
// (ahorro >= umbral) y ahora ya no es una anomalía (type 'none') porque el precio MS
// subió >= risePct sobre el último precio bugueado. Devuelve { prevMsArs, newMsArs,
// risePct } o null. Puro y testeable (no depende de DOM ni de chrome).
const opportunityGone = (hist, curr, { bugThreshold = 40, risePct = 20 } = {}) => {
  if (!curr || curr.msArs == null || curr.msArs <= 0) return null;
  if (curr.type && curr.type !== 'none') return null; // sigue siendo una oportunidad
  const bugs = (hist || []).filter(
    (h) => h && h.savings != null && h.savings >= bugThreshold && h.msArs != null && h.msArs > 0
  );
  if (!bugs.length) return null;
  const lastBug = bugs[bugs.length - 1];
  if (curr.msArs <= lastBug.msArs) return null; // el precio MS no subió
  const rise = ((curr.msArs - lastBug.msArs) / lastBug.msArs) * 100;
  if (rise < risePct) return null;
  return { prevMsArs: lastBug.msArs, newMsArs: curr.msArs, risePct: Math.round(rise) };
};

// ---------- valoración del score (0..100) ----------
const scoreRating = (score) => {
  if (score >= 80) return { label: '🔥 Excelente', cls: 'excellent' };
  if (score >= 60) return { label: '💚 Muy buena', cls: 'good' };
  if (score >= 40) return { label: '👍 Buena', cls: 'ok' };
  if (score >= 20) return { label: 'Regular', cls: 'meh' };
  return { label: 'Baja', cls: 'low' };
};

// ---------- alerta urgente (oportunidad excepcional) ----------
const isUrgent = ({ type, savings, risk }) => {
  if (savings == null || savings <= 0) return false;
  if (savings >= 75) return true;                        // diferencia extrema
  if (type === 'regional' && savings >= 65) return true;  // regionalización + mucho ahorro
  return false;
};

// ---------- ordenamiento (dato puro, sin DOM — reutilizable por cualquier vista) ----------
// Comparador de filas enriquecidas según una clave de orden.
// keys: bug (oportunidad), savings, score, price (menor precio), discount (descuento
// de la mejor tienda), recent (más recientes por historial), name, steamPrice,
// epicPrice, msPrice. Devuelve <0, 0 o >0 como Array.sort.
const compareBySort = (a, b, key) => {
  switch (key) {
    case 'bug':
      return (b.bug - a.bug) || ((b.savings ?? -1) - (a.savings ?? -1));
    case 'savings':
      return (b.savings ?? -1) - (a.savings ?? -1);
    case 'score':
      return (b.score ?? 0) - (a.score ?? 0);
    case 'price':
      return (a.bestVal ?? Infinity) - (b.bestVal ?? Infinity);
    case 'discount': {
      const da = a.bestStore && a.stores[a.bestStore] ? a.stores[a.bestStore].discount || 0 : 0;
      const db = b.bestStore && b.stores[b.bestStore] ? b.stores[b.bestStore].discount || 0 : 0;
      return db - da;
    }
    case 'recent': {
      const ta = a.hist && a.hist.length ? a.hist[a.hist.length - 1].ts : 0;
      const tb = b.hist && b.hist.length ? b.hist[b.hist.length - 1].ts : 0;
      return tb - ta;
    }
    case 'name':
      return a.g.name.localeCompare(b.g.name, 'es');
    case 'steamPrice':
      return (a.ars.steam ?? Infinity) - (b.ars.steam ?? Infinity);
    case 'epicPrice':
      return (a.ars.epic ?? Infinity) - (b.ars.epic ?? Infinity);
    case 'msPrice':
      return (a.msArs ?? Infinity) - (b.msArs ?? Infinity);
    default:
      return 0;
  }
};

// Dirección natural (nativa) de cada criterio de orden: para precios/nombre es
// ascendente (menor primero), para ahorro/score/descuento/recientes es descendente
// (mayor primero). Se usa para que los encabezados clicables toggleen la dirección
// real de forma consistente (▲ ascendente / ▼ descendente).
const NATURAL_DIR = {
  bug: 'desc', savings: 'desc', score: 'desc', price: 'asc', discount: 'desc',
  recent: 'desc', name: 'asc', steamPrice: 'asc', epicPrice: 'asc', msPrice: 'asc',
};

// Igual que compareBySort pero aplicando una dirección explícita:
//   dir 'asc'  → ascendente (menor primero) para precios, A→Z para nombres
//   dir 'desc' → descendente (mayor primero)
// Si dir coincide con la dirección natural del criterio, es idéntico a compareBySort;
// si difiere, invierte el resultado. Puro y testeable.
const compareBySortDir = (a, b, key, dir) => {
  const nat = NATURAL_DIR[key] || 'asc';
  const mult = nat === dir ? 1 : -1;
  return compareBySort(a, b, key) * mult;
};

// ---------- TOP diario de price bugs ----------
// Filtra/ordena/limita filas de bugs para el "TOP Price Bugs del Día". Puro y testeable:
// solo cuentan filas con tipo de anomalía real, ahorro > 0 y precio MS válido (> 0,
// nunca Game Pass-only ni gratis). Devuelve las N mejores por % de ahorro.
const topBugs = (rows, n = 5) =>
  (rows || [])
    .filter((r) => r && r.type && r.type !== 'none' && r.savings != null && r.savings > 0 && r.msArs != null && r.msArs > 0)
    .sort((a, b) => b.savings - a.savings)
    .slice(0, n);

// ---------- gratis semanales de Epic (detección de cambios) ----------
// Juegos gratis con oferta ACTIVA (endDate en el futuro). Puro y testeable:
// los freebies permanentes (sin endDate) y los vencidos quedan fuera.
const epicFreeActive = (games, now = Date.now()) =>
  (games || []).filter((g) => g && g.endDate && new Date(g.endDate).getTime() > now);

// Clave de semana de una lista de gratis: la fecha de inicio de la rotación actual
// (mínimo startDate, en UTC 'YYYY-MM-DD'). null si ningún juego tiene startDate.
// Se usa como dedupe: cuando cambia la clave, rotó la semana de Epic (jueves).
const epicFreeWeekKey = (games) => {
  const starts = (games || [])
    .map((g) => (g && g.startDate ? new Date(g.startDate).getTime() : null))
    .filter((t) => Number.isFinite(t)); // descarta null Y fechas inválidas (NaN)
  if (!starts.length) return null;
  return new Date(Math.min(...starts)).toISOString().slice(0, 10);
};

// Títulos que NO estaban en la lista previa (notificar solo lo que cambió).
const epicFreeNewTitles = (prevTitles, currTitles) => {
  const known = new Set(prevTitles || []);
  return (currTitles || []).filter((t) => !known.has(t));
};

// Mapa steamId → gratis semanal de Epic que coincide EXACTAMENTE con el catálogo
// (solo gratis ACTIVOS: endDate en el futuro). Puro y testeable.
// Se usa igualdad de títulos NORMALIZADA (sin acentos/mayúsculas/puntuación) en vez
// de similitud difusa: es preciso y evita falsos positivos por substring (p. ej. un
// gratis "Ghostrunner 2" nunca marca al "Ghostrunner" del catálogo). Inyectar un
// "GRATIS" falso sería peor que no inyectar, así que priorizamos precisión.
const epicFreeCatalogMap = (games, freeGames, now = Date.now()) => {
  const map = {};
  const active = (freeGames || []).filter((g) => g && g.endDate && new Date(g.endDate).getTime() > now);
  const byNorm = new Map();
  for (const g of games || []) byNorm.set(normStr(g.name), g);
  for (const fg of active) {
    const g = byNorm.get(normStr(fg.title));
    if (g && map[g.steamId] === undefined) map[g.steamId] = fg;
  }
  return map;
};


// ---------- disponibilidad por tienda (calidad de datos) ----------
// Clasifica la oferta de una tienda:
//  'purchase' → precio real de compra
//  'free'     → gratuito real (sin suscripción)
//  'gamepass' → incluido con Xbox Game Pass, sin precio de compra propio
//  'none'     → sin datos / no disponible
const storeOfferKind = (store) => {
  if (!store) return 'none';
  if (store.price > 0) return 'purchase';
  if (store.gamePass && !(store.price > 0)) return 'gamepass';
  if (store.free && !(store.price > 0)) return 'free';
  return 'none';
};

// Cuántas tiendas tienen una opción REAL de conseguir el juego (precio de compra
// o gratis de verdad). Game Pass-only NO cuenta: requiere suscripción activa y no
// es un precio comparable. Se usa para mostrar solo juegos con 2+ tiendas.
const availableStoreCount = (stores) =>
  ['steam', 'epic', 'ms'].filter((k) => {
    const kind = storeOfferKind(stores && stores[k]);
    return kind === 'purchase' || kind === 'free';
  }).length;

// ¿Alguna tienda ofrece el juego GRATIS de verdad (sin suscripción)?
// Game Pass-only NO cuenta: requiere suscripción activa, no es un regalo.
// Se usa para el filtro "🎁 Gratis" (juegos gratis en cualquiera de las 3 tiendas).
const anyFreeStore = (stores) =>
  ['steam', 'epic', 'ms'].some((k) => storeOfferKind(stores && stores[k]) === 'free');

// ---------- gratis sospechoso (regla cross-store) ----------
// Un juego con precio REAL de compra en Steam o Epic NO puede ser gratis de verdad en
// otra tienda: los F2P reales (Apex, Overwatch 2, Rocket League, Fall Guys…) son gratis
// en TODAS las tiendas. Por eso, si Microsoft dice "Gratis" pero Steam o Epic muestran
// un precio de compra, es Xbox Game Pass (o ruido mal matcheado) → se re-clasifica como
// Game Pass, NUNCA como "Gratis". Y si Epic dice "Gratis" (sin ser gratis semanal
// inyectado) pero Steam tiene precio real, es un producto sin precio/retirado → se deja
// sin datos. Verificado en vivo contra las APIs: la búsqueda de GTA V devuelve GTA
// III/Vice City Definitive a $0 (delisted) y varias cards de MS dicen "Gratis" para
// juegos que en realidad están en Game Pass.
// stores: { steam?, epic?, ms? } (candidatos crudos), ars: { steam?, epic?, ms? } (ARS).
// Devuelve { stores, ars } NUEVOS (no muta el input). Función pura → testeable sin red.
const reclassifySuspiciousFree = (stores, ars) => {
  const s = { ...stores };
  const a = { ...ars };
  const paidElsewhere = (ars.steam != null && ars.steam > 0) || (ars.epic != null && ars.epic > 0);
  const paidOnSteam = ars.steam != null && ars.steam > 0;
  // MS "Gratis" con precio real en Steam/Epic → Game Pass (requiere suscripción activa)
  if (s.ms && s.ms.free && !(s.ms.price > 0) && paidElsewhere) {
    s.ms = { ...s.ms, free: false, gamePass: true, passName: s.ms.passName || 'Xbox Game Pass' };
    a.ms = null;
  }
  // Epic "Gratis" (no semanal) con precio real en Steam → sin precio/delisted: no mostrar
  if (s.epic && s.epic.free && !(s.epic.price > 0) && !s.epic.weekly && paidOnSteam) {
    s.epic = null;
    a.epic = null;
  }
  return { stores: s, ars: a };
};

// ---------- eventos de la lista de deseados ----------
// Compara la snapshot previa con la row actual y devuelve qué eventos de notificación
// corresponden (baja de precio, mínimo histórico, bug, MS más barata, Epic gratis).
const WISH_EVENT_LABEL = {
  drop: '💸 Bajó de precio',
  histLow: '🏆 Nuevo mínimo histórico',
  bug: '🚨 Posible error de precio',
  msCheapest: '🛒 Microsoft es la más barata',
  epicFree: '🎁 ¡Epic lo regala!',
};

const wishEvents = (prev, curr, { dropPct = 15 } = {}) => {
  const ev = [];
  if (!curr) return ev;
  // Solo se notifican TRANSICIONES reales: sin snapshot previo (primer sync) no se
  // dispara nada — el primer sync establece la línea base, evita spam al desear un juego.
  if (prev && (curr.type === 'bug' || curr.type === 'regional') && (prev.type !== 'bug' && prev.type !== 'regional')) {
    ev.push('bug');
  }
  if (prev && prev.msArs != null && curr.msArs != null && prev.msArs > curr.msArs) {
    const pct = ((prev.msArs - curr.msArs) / prev.msArs) * 100;
    if (pct >= dropPct) ev.push('drop');
  }
  if (prev && curr.histLow && !prev.histLow) ev.push('histLow');
  if (curr.bestStore === 'ms' && prev && prev.bestStore !== 'ms') ev.push('msCheapest');
  if (prev && curr.epicArs === 0 && prev.epicArs !== 0) ev.push('epicFree');
  return ev;
};

// --- Formato de precios ---
const fmtARS = (n) =>
  new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    maximumFractionDigits: 0,
  }).format(n || 0);

// Formatea un precio en la moneda de la REGIÓN ACTIVA (multipaís): sin decimales
// para ARS/CLP/COP/KRW/JPY, con 2 para el resto (USD, MXN, EUR…).
const fmtMoney = (n) => {
  const r = activeRegion();
  return new Intl.NumberFormat(r.intl, {
    style: 'currency',
    currency: r.currency,
    maximumFractionDigits: NO_DECIMAL.has(r.currency) ? 0 : 2,
  }).format(n || 0);
};

const fmtUSD = (n) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format((n || 0) / 100); // cents → dollars

// Formatea un precio que YA viene en UNIDADES de USD (sin dividir por 100):
// Steam devuelve dólares (po.final/100) con currency 'USD' en regiones como AR,
// mientras que fmtUSD espera centavos. Usar fmtUSD con unidades mostraba
// "$0.07" en vez de "$7.00".
const fmtUsd = (n) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(n || 0);

const fmtPct = (n) => `${Math.round(n || 0)}%`;

function arsFromUsdCents(usdCents, usdArsRate) {
  if (usdCents == null || !usdArsRate) return null;
  return (usdCents / 100) * usdArsRate;
}

// --- Storage (chrome.storage.local con fallback a memoria) ---
const Store = (() => {
  let mem = {};
  const hasChrome = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  return {
    async get(key) {
      try {
        if (hasChrome) {
          const r = await chrome.storage.local.get(key);
          return r[key];
        }
      } catch (e) { /* noop */ }
      return mem[key];
    },
    async set(key, value) {
      try {
        if (hasChrome) await chrome.storage.local.set({ [key]: value });
      } catch (e) { /* noop */ }
      mem[key] = value;
    },
  };
})();

// --- Concurrencia acotada ---
// onProgress(partial): se invoca con el array parcial cada vez que un ítem termina
// (para el scan progresivo de catálogos grandes sin esperar a que termine todo).
async function pool(items, limit, fn, onProgress) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (e) {
        results[idx] = null;
      }
      if (onProgress) onProgress(results.slice());
    }
  });
  await Promise.all(workers);
  return results;
}

const timeAgo = (ts) => {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `hace ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m}min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h}h`;
  return new Date(ts).toLocaleDateString('es-AR');
};

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- regiones / moneda (multipaís) ----------
// Cada tienda devuelve precios en la moneda local de la región que se le pase
// (Steam con cc=, Epic con country=, MS con market=). La extensión ahora es
// multipaís: se elige una región y TODAS las APIs + la moneda de visualización
// cambian. La tasa USD→local (open.er-api.com, gratis sin key) se usa solo para
// regiones sin precio local en alguna tienda o para el tipo de cambio oficial.
const REGIONS = {
  AR: { code: 'AR', flag: '🇦🇷', label: 'Argentina', currency: 'ARS', intl: 'es-AR', steamCc: 'AR', steamLang: 'spanish', epicCountry: 'AR', epicLocale: 'es-AR', msMarket: 'AR', msLocale: 'es-ar' },
  US: { code: 'US', flag: '🇺🇸', label: 'Estados Unidos', currency: 'USD', intl: 'en-US', steamCc: 'US', steamLang: 'english', epicCountry: 'US', epicLocale: 'en-US', msMarket: 'US', msLocale: 'en-us' },
  MX: { code: 'MX', flag: '🇲🇽', label: 'México', currency: 'MXN', intl: 'es-MX', steamCc: 'MX', steamLang: 'spanish', epicCountry: 'MX', epicLocale: 'es-MX', msMarket: 'MX', msLocale: 'es-mx' },
  BR: { code: 'BR', flag: '🇧🇷', label: 'Brasil', currency: 'BRL', intl: 'pt-BR', steamCc: 'BR', steamLang: 'brazilian', epicCountry: 'BR', epicLocale: 'pt-BR', msMarket: 'BR', msLocale: 'pt-br' },
  CL: { code: 'CL', flag: '🇨🇱', label: 'Chile', currency: 'CLP', intl: 'es-CL', steamCc: 'CL', steamLang: 'spanish', epicCountry: 'CL', epicLocale: 'es-CL', msMarket: 'CL', msLocale: 'es-cl' },
  CO: { code: 'CO', flag: '🇨🇴', label: 'Colombia', currency: 'COP', intl: 'es-CO', steamCc: 'CO', steamLang: 'spanish', epicCountry: 'CO', epicLocale: 'es-CO', msMarket: 'CO', msLocale: 'es-co' },
  PE: { code: 'PE', flag: '🇵🇪', label: 'Perú', currency: 'PEN', intl: 'es-PE', steamCc: 'PE', steamLang: 'spanish', epicCountry: 'PE', epicLocale: 'es-PE', msMarket: 'PE', msLocale: 'es-pe' },
  ES: { code: 'ES', flag: '🇪🇸', label: 'España', currency: 'EUR', intl: 'es-ES', steamCc: 'ES', steamLang: 'spanish', epicCountry: 'ES', epicLocale: 'es-ES', msMarket: 'ES', msLocale: 'es-es' },
  GB: { code: 'GB', flag: '🇬🇧', label: 'Reino Unido', currency: 'GBP', intl: 'en-GB', steamCc: 'GB', steamLang: 'english', epicCountry: 'GB', epicLocale: 'en-GB', msMarket: 'GB', msLocale: 'en-gb' },
  DE: { code: 'DE', flag: '🇩🇪', label: 'Alemania', currency: 'EUR', intl: 'de-DE', steamCc: 'DE', steamLang: 'german', epicCountry: 'DE', epicLocale: 'de-DE', msMarket: 'DE', msLocale: 'de-de' },
  FR: { code: 'FR', flag: '🇫🇷', label: 'Francia', currency: 'EUR', intl: 'fr-FR', steamCc: 'FR', steamLang: 'french', epicCountry: 'FR', epicLocale: 'fr-FR', msMarket: 'FR', msLocale: 'fr-fr' },
  IT: { code: 'IT', flag: '🇮🇹', label: 'Italia', currency: 'EUR', intl: 'it-IT', steamCc: 'IT', steamLang: 'italian', epicCountry: 'IT', epicLocale: 'it-IT', msMarket: 'IT', msLocale: 'it-it' },
  CA: { code: 'CA', flag: '🇨🇦', label: 'Canadá', currency: 'CAD', intl: 'en-CA', steamCc: 'CA', steamLang: 'english', epicCountry: 'CA', epicLocale: 'en-CA', msMarket: 'CA', msLocale: 'en-ca' },
  AU: { code: 'AU', flag: '🇦🇺', label: 'Australia', currency: 'AUD', intl: 'en-AU', steamCc: 'AU', steamLang: 'english', epicCountry: 'AU', epicLocale: 'en-AU', msMarket: 'AU', msLocale: 'en-au' },
  JP: { code: 'JP', flag: '🇯🇵', label: 'Japón', currency: 'JPY', intl: 'ja-JP', steamCc: 'JP', steamLang: 'japanese', epicCountry: 'JP', epicLocale: 'ja-JP', msMarket: 'JP', msLocale: 'ja-jp' },
  KR: { code: 'KR', flag: '🇰🇷', label: 'Corea del Sur', currency: 'KRW', intl: 'ko-KR', steamCc: 'KR', steamLang: 'koreana', epicCountry: 'KR', epicLocale: 'ko-KR', msMarket: 'KR', msLocale: 'ko-kr' },
};

// Región activa (se setea al arrancar desde chrome.storage y se cambia con el
// selector de la página). Default Argentina (mercado original de la extensión).
let ACTIVE_REGION_CODE = 'AR';
const setActiveRegion = (code) => { ACTIVE_REGION_CODE = REGIONS[code] ? code : 'AR'; };
const activeRegion = () => REGIONS[ACTIVE_REGION_CODE];

// Monedas SIN decimales (Steam/Epic devuelven el precio directo, no en centavos).
// Las que no están acá (USD, MXN, BRL, EUR…) vienen en centavos (÷100).
const NO_DECIMAL = new Set(['ARS', 'CLP', 'COP', 'KRW', 'JPY', 'ISK', 'HUF', 'VND']);

// Normaliza el precio crudo de Steam/Epic a unidades de la moneda local:
// centavos (÷100) para monedas con decimales, directo para ARS/CLP/COP/KRW/JPY.
const priceToUnits = (price, currency) => {
  if (price == null) return null;
  return NO_DECIMAL.has((currency || '').toUpperCase()) ? price : price / 100;
};

// Convierte el precio de una tienda a la moneda local de la región. Reglas:
//  - si la tienda ya devolvió la moneda de la región → el precio ya es local
//  - si devolvió otra moneda (p. ej. Steam en AR devuelve USD) → se asume USD y
//    se convierte con la tasa usdRate (unidades USD, no centavos).
const storeToLocal = (storePrice, region, usdRate) => {
  if (!storePrice || storePrice.price == null) return null;
  const cur = (storePrice.currency || (region && region.currency) || 'USD').toUpperCase();
  if (region && cur === region.currency.toUpperCase()) return storePrice.price;
  const rate = usdRate || 1;
  return storePrice.price * rate;
};

// ---------- helpers del catálogo ampliado (más juegos de Microsoft Store) ----------
// Parte una lista de ids en chunks de tamaño n (Steam devuelve HTTP 400 con lotes
// demasiado grandes: se consulta en chunks de ~120). Puro y testeable.
const chunkIds = (arr, n = 120) => {
  const out = [];
  for (let i = 0; i < (arr || []).length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

// Géneros válidos del catálogo (filtro de búsqueda + validación de integridad).
const VALID_GENRES = [
  'Acción', 'Aventura', 'Carreras', 'Deportes', 'Estrategia', 'JRPG', 'Lucha',
  'Plataformas', 'Puzzle', 'Roguelike', 'RPG', 'Shooter', 'Simulación',
  'Supervivencia', 'Terror',
];

// Merge del catálogo base + juegos agregados por el usuario: evita duplicados por
// steamId y por nombre normalizado. Puro y testeable (sin red ni DOM).
const mergeCatalog = (base, extra) => {
  const seen = new Set();
  const out = [];
  for (const g of [...(base || []), ...(extra || [])]) {
    if (!g || !g.name) continue;
    const idKey = g.steamId != null ? `id:${g.steamId}` : null;
    const nameKey = `n:${normStr(g.name)}`;
    if (seen.has(nameKey) || (idKey != null && seen.has(idKey))) continue;
    if (idKey != null) seen.add(idKey);
    seen.add(nameKey);
    out.push(g);
  }
  return out;
};
