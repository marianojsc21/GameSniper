// db.js — capa de datos local, desacoplada de la interfaz.
// Toda persistencia pasa por acá. En el futuro, un backend central puede reemplazar
// las implementaciones internas (fetch a un servidor) manteniendo la MISMA API,
// sin tocar offers.js / popup.js / background.js.
'use strict';

// TTL por tienda (configurable): cuánto tiempo consideramos válida su última respuesta.
const STORE_TTL_DEFAULT = {
  steam: 60 * 60 * 1000, // 1 h (batch, barato de re-consultar)
  epic: 45 * 60 * 1000,  // 45 min
  ms: 30 * 60 * 1000,    // 30 min (la que más cambia con los bugs)
};

// Versión del formato de la caché por tienda: las rows guardadas contienen la
// clasificación YA calculada (free/gamePass). Si cambia la lógica de parseMsCard o
// pickBest (p. ej. el fix de Game Pass-only), las cachés viejas seguirían mostrando
// "Gratis" hasta vencer el TTL. Subir esta constante descarta las cachés existentes
// y fuerza un re-fetch limpio con la clasificación nueva.
const STORE_CACHE_VERSION = 7; // v7: descarta cachés por tienda de versiones anteriores (blanqueo total tras la auditoría de consts)

// Las cachés/historial se guardan POR REGIÓN: los precios en ARS no son comparables
// con los de MXN/USD, así que cada región tiene su propio set de datos.
const regionKey = (key) => `${key}_${activeRegion().code}`;

const DB = {
  // ---------- caché por tienda ----------
  async getStoreCache(storeId) {
    const all = (await Store.get(regionKey('ofertasStoreCache'))) || {};
    return all[storeId] || null;
  },
  async setStoreCache(storeId, data) {
    const all = (await Store.get(regionKey('ofertasStoreCache'))) || {};
    all[storeId] = { ts: Date.now(), v: STORE_CACHE_VERSION, data };
    await Store.set(regionKey('ofertasStoreCache'), all);
  },
  // TTL efectivo de una tienda (default o configurado por el usuario)
  async getStoreTtl(storeId) {
    const t = (await Store.get('ofertasStoreTtl')) || {};
    return t[storeId] || STORE_TTL_DEFAULT[storeId] || 30 * 60 * 1000;
  },
  // ¿La caché de una tienda sigue siendo válida? (evita consultas innecesarias)
  async storeFresh(storeId) {
    const c = await DB.getStoreCache(storeId);
    // caché con formato viejo (sin versión o con versión anterior): descartar para que
    // el próximo scan re-consulte con la clasificación nueva (fix Game Pass-only)
    if (!c || !c.ts || c.v !== STORE_CACHE_VERSION) return false;
    const ttl = await DB.getStoreTtl(storeId);
    return Date.now() - c.ts < ttl;
  },

  // ---------- historial por juego (por región: la moneda cambia) ----------
  // Migración única: si el usuario venía de la versión solo-ARS (clave sin sufijo de
  // región), se copia su historial a la clave de AR y se borra la vieja.
  async getHistory() {
    const key = regionKey('ofertasHistory');
    const cur = await Store.get(key);
    if (cur) return cur || {};
    if (activeRegion().code === 'AR') {
      const legacy = await Store.get('ofertasHistory');
      if (legacy) {
        await Store.set(key, legacy);
        await Store.set('ofertasHistory', null);
        return legacy;
      }
    }
    return {};
  },
  async setHistory(hist) { await Store.set(regionKey('ofertasHistory'), hist); },

  // ---------- snapshots por juego (por región, para detectar eventos en deseados) ----------
  async getSnaps() { return (await Store.get(regionKey('ofertasSnaps'))) || {}; },
  async setSnaps(snaps) { await Store.set(regionKey('ofertasSnaps'), snaps); },

  // ---------- lista de deseados ----------
  async getWishlist() { return (await Store.get('ofertasWishlist')) || []; },
  async setWishlist(list) { await Store.set('ofertasWishlist', list); },
  async toggleWish(steamId) {
    const list = await DB.getWishlist();
    const i = list.indexOf(steamId);
    if (i >= 0) list.splice(i, 1); else list.push(steamId);
    await DB.setWishlist(list);
    return list;
  },
};
