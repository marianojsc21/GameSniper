// stores.js — arquitectura modular de tiendas.
// Cada tienda es un módulo independiente: { id, label, color, batch, fetch(term|appids) }.
// Para sumar una tienda nueva (GOG, Ubisoft, EA App, Battle.net, GreenManGaming,
// Fanatical, Humble Bundle…) solo hay que agregar un módulo al registro STORES y
// su host_permission en manifest.json — el resto del código lo consume dinámicamente.
'use strict';

const STEAM_APPDETAILS = 'https://store.steampowered.com/api/appdetails';
const STEAM_SEARCH = 'https://store.steampowered.com/api/storesearch';
const EPIC_GRAPHQL = 'https://store.epicgames.com/graphql';
const MS_SEARCH = 'https://storeedgefd.dsx.mp.microsoft.com/v9.0/search';
const DOLAR_API = 'https://dolarapi.com/v1/dolares';

// ---------- registro de tiendas (escalable) ----------
const STORES = {
  steam: {
    id: 'steam',
    label: 'Steam',
    color: '#66c0f4',
    batch: true, // consulta muchos juegos en una sola llamada
    termOf: (g) => null,
    fetch: fetchSteamPrices,
  },
  epic: {
    id: 'epic',
    label: 'Epic Games',
    color: '#c4a3ff',
    batch: false,
    termOf: (g) => g.epicTerm || g.name,
    fetch: fetchEpicPrice,
  },
  ms: {
    id: 'ms',
    label: 'Microsoft',
    color: '#00c6ff',
    batch: false,
    termOf: (g) => g.msTerm || g.name,
    fetch: fetchMsPrice,
    currency: 'ARS', // única tienda con precios directos en pesos
  },
};

// Consulta una tienda para todo el catálogo. Devuelve mapa (batch) o array (1:1 con games).
// onProgress(partial) se invoca a medida que llegan resultados (scan progresivo): para
// batch se llama una vez al terminar, para el resto por cada lote de pool completado.
async function fetchStore(storeId, games, onProgress) {
  const s = STORES[storeId];
  if (!s) return {};
  if (s.batch) {
    const r = await s.fetch(games.map((g) => g.steamId));
    if (onProgress) onProgress(r);
    return r;
  }
  return pool(games, 5, (g) => s.fetch(s.termOf(g)), onProgress);
}

// Nota: NO se pueden setear headers prohibidos (User-Agent, Origin) desde fetch() en Chrome;
// la página de extensión ya envía el UA real del navegador.

// ---------- STEAM ----------
// Devuelve { appid: { price, original, discount, currency, url } }.
// Steam SIEMPRE devuelve centavos (÷100) en la moneda de la región (cc=).
// El catálogo ahora tiene cientos de juegos: se consulta en chunks de ~120 porque
// Steam devuelve HTTP 400 (null) si el lote es demasiado grande (verificado en vivo).
async function fetchSteamPrices(appids) {
  const r = activeRegion();
  const list = Array.isArray(appids) ? appids : [appids];
  const out = {};
  for (const chunk of chunkIds(list, 120)) {
    const url = `${STEAM_APPDETAILS}?appids=${chunk.join(',')}&cc=${r.steamCc}&l=${r.steamLang}&filters=price_overview`;
    const res = await fetch(url);
    const json = await res.json();
    for (const id of chunk) {
      const entry = json && json[String(id)];
      const po = entry && entry.success && entry.data && entry.data.price_overview;
      if (po) {
        out[id] = {
          price: po.final / 100,       // centavos → unidades
          original: po.initial / 100,
          discount: po.discount_percent || 0,
          currency: po.currency,
          url: `https://store.steampowered.com/app/${id}/?cc=${r.steamCc}&l=${r.steamLang}`,
          free: po.final === 0, // F2P / gratuito real (precio 0)
        };
      }
    }
  }
  return out;
}

// Resuelve el appid de Steam de un título usando el search público de la tienda
// (storesearch). Devuelve { appid, name, price, currency } del mejor match, o null.
// Se usa en el buscador universal: al agregar un juego de MS Store, se intenta
// encontrar su versión de Steam para que la comparación funcione desde el día 1.
async function searchSteamAppId(title) {
  const r = activeRegion();
  const url = `${STEAM_SEARCH}/?term=${encodeURIComponent(title)}&cc=${r.steamCc}&l=${r.steamLang}`;
  const res = await fetch(url);
  const json = await res.json();
  const items = (json && json.items) || [];
  const candidates = items
    .filter((i) => i && i.type === 'app' && i.id)
    .map((i) => ({
      title: i.name,
      price: (i.price && i.price.final) || 0,
      original: (i.price && i.price.initial) || 0,
      currency: (i.price && i.price.currency) || 'USD',
      appid: i.id,
    }));
  const best = pickBest(title, candidates, 0.55);
  if (!best) return null;
  return { appid: best.appid, name: best.title, price: best.price, currency: best.currency };
}

// ---------- EPIC GAMES ----------
const EPIC_QUERY = `query searchStoreQuery($count: Int, $country: String!, $locale: String, $keywords: String) {
  Catalog {
    searchStore(count: $count, country: $country, locale: $locale, keywords: $keywords) {
      elements {
        title
        productSlug
        price(country: $country) {
          totalPrice { discountPrice originalPrice discount currencyCode }
        }
      }
    }
  }
}`;

// Juegos F2P reales (gratis permanente en TODAS las tiendas). La API de Epic devuelve
// discountPrice=0 Y originalPrice=0 tanto para los F2P reales como para los juegos
// retirados de venta / sin precio (ej. "GTA III – The Definitive Edition" delisted a
// $0). Solo la intersección de ambos (0/0) no distingue, así que se usa una lista corta
// de F2P conocidos: un candidato 0/0 fuera de esta lista es un juego SIN PRECIO (no
// gratis) y NUNCA debe mostrarse como "Gratis". Función pura → testeable sin red.
const EPIC_F2P = new Set([
  'apex legends', 'overwatch 2', 'fall guys', 'rocket league', 'fortnite',
  'warframe', 'destiny 2', 'valorant', 'genshin impact', 'team fortress 2',
  'counter-strike 2', 'path of exile', 'paladins', 'smite', 'brawlhalla',
]);
const isEpicF2P = (title) => EPIC_F2P.has(normStr(title));

// ¿El candidato de Epic es gratis de verdad? discountPrice 0 + (precio original real
// = descuento 100% temporario / gratis semanal) o F2P conocido. Un (0,0) fuera de la
// lista es un juego retirado/sin precio → NO es gratis. Función pura → testeable.
const epicFreeAt = (discountPrice, originalPrice, title) =>
  discountPrice === 0 && (originalPrice > 0 || isEpicF2P(title));

// Busca un juego en Epic por término y devuelve el mejor match con precio.
async function fetchEpicPrice(term) {
  const r = activeRegion();
  const body = JSON.stringify({
    query: EPIC_QUERY,
    variables: { count: 10, country: r.epicCountry, locale: r.epicLocale, keywords: term },
  });
  // credentials: 'include' intenta usar cookies del usuario en Epic (puede ayudar a pasar Cloudflare)
  const res = await fetch(EPIC_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body,
  });
  const json = await res.json();
  const elements = (json && json.data && json.data.Catalog && json.data.Catalog.searchStore && json.data.Catalog.searchStore.elements) || [];
  const candidates = elements
    .filter((e) => e && e.title && e.price && e.price.totalPrice)
    .map((e) => {
      const p = e.price.totalPrice;
      const slug = e.productSlug;
      return {
        title: e.title,
        price: priceToUnits(p.discountPrice, p.currencyCode),
        original: priceToUnits(p.originalPrice || p.discountPrice, p.currencyCode),
        discount: p.discount || 0,
        currency: p.currencyCode,
        // muchos juegos reales vienen con productSlug null (ej. "Grand Theft Auto V
        // Enhanced"): en vez de descartarlos, se arma una URL de búsqueda como fallback
        // para que el match no se pierda y quede el juego sin datos.
        url: slug
          ? `https://store.epicgames.com/p/${slug}`
          : `https://store.epicgames.com/${activeRegion().epicLocale}/browse?q=${encodeURIComponent(e.title)}`,
        // un candidato SOLO es gratis si es un F2P conocido o tiene un precio original
        // real (descuento 100% temporario / gratis semanal). Un (0,0) fuera de la lista
        // es un juego retirado o sin precio → NUNCA "Gratis". Verificado en vivo: la
        // búsqueda de GTA V devuelve GTA III/Vice City Definitive a $0 (delisted).
        free: epicFreeAt(p.discountPrice, p.originalPrice, e.title),
      };
    });
  return pickBest(term, candidates);
}

// ---------- EPIC: juegos gratis semanales ----------
const EPIC_FREE_QUERY = `query searchStoreQuery($count: Int, $country: String!, $locale: String, $category: String) {
  Catalog {
    searchStore(count: $count, country: $country, locale: $locale, category: $category) {
      elements {
        title
        productSlug
        offerMappings { pageSlug }
        catalogNs { mappings { pageSlug } }
        keyImages { type url }
        price(country: $country) {
          totalPrice { discountPrice originalPrice currencyCode }
        }
        promotions {
          promotionalOffers {
            promotionalOffers {
              startDate
              endDate
            }
          }
        }
      }
    }
  }
}`;

// Convierte los elementos de la respuesta de "freegames" en { title, url, endDate,
// startDate, original, currency, art }. Filtra solo los GRATIS reales
// (discountPrice === 0). En este endpoint el productSlug suele venir null: se usa
// offerMappings[0].pageSlug (o catalogNs.mappings[0].pageSlug) como fallback para
// armar la URL. La portada (art) sale de keyImages: se prefiere 'Thumbnail' (cuadrada,
// ideal para la miniatura de la card), luego 'DieselGameBox' y como último recurso
// cualquier imagen. Función pura → testeable sin red en test-logic.html.
const parseEpicFreeElements = (elements) =>
  (elements || [])
    .filter((e) => e && e.title && e.price && e.price.totalPrice && e.price.totalPrice.discountPrice === 0)
    .map((e) => {
      const p = e.price.totalPrice;
      const slug = e.productSlug
        || ((e.offerMappings || [])[0] || {}).pageSlug
        || (((e.catalogNs || {}).mappings || [])[0] || {}).pageSlug;
      const promo = ((e.promotions || {}).promotionalOffers || [])[0];
      const offer = (promo && promo.promotionalOffers && promo.promotionalOffers[0]) || null;
      const imgs = e.keyImages || [];
      const artImg = imgs.find((i) => i && i.type === 'Thumbnail')
        || imgs.find((i) => i && i.type === 'DieselGameBox')
        || imgs.find((i) => i && i.url);
      return {
        title: e.title,
        url: slug ? `https://store.epicgames.com/p/${slug}` : `https://store.epicgames.com/${activeRegion().epicLocale}/browse?q=${encodeURIComponent(e.title)}`,
        endDate: offer ? offer.endDate : null,
        startDate: offer ? offer.startDate : null,
        original: p.originalPrice || p.discountPrice,
        currency: p.currencyCode || 'USD',
        art: artImg ? artImg.url : null,
      };
    });

// Busca los juegos gratis semanales de Epic (se renuevan cada jueves).
// locale en-US para que el endpoint devuelva los pageSlug (con es-AR vienen null).
async function fetchEpicFreeGames() {
  const r = activeRegion();
  // locale en-US para que el endpoint devuelva los pageSlug (con es-AR vienen null);
  // el país SIEMPRE es la región activa para que el precio original sea local.
  const body = JSON.stringify({
    query: EPIC_FREE_QUERY,
    variables: { count: 20, country: r.epicCountry, locale: 'en-US', category: 'freegames' },
  });
  const res = await fetch(EPIC_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body,
  });
  const json = await res.json();
  const elements = (json && json.data && json.data.Catalog && json.data.Catalog.searchStore && json.data.Catalog.searchStore.elements) || [];
  return parseEpicFreeElements(elements);
}

// ---------- MICROSOFT STORE ----------
// Convierte una card cruda de la API de MS Store en un candidato normalizado
// { title, price, original, discount, currency, url, art, gamePass, free, passName }.
// currency: moneda de la región activa (MS devuelve SIEMPRE precio directo, no
// centavos — DisplayPrice "$X"/"Gratis"/"Incluido" con MSRP/SalePrices directos).
// Shape real de la API a nivel card:
//   DisplayPrice: "Incluido" (Game Pass) | "Gratis" | "$X"
//   PlaintextPassName / GlyphTextPassName: "Xbox Game Pass" (suscripción)
//   SkusSummary[].MSRP y SalePrices[] (los que tienen Conditions.EntitlementId
//   son descuentos de Game Pass, no el precio de compra).
// Función pura → testeable sin red en test-logic.html.
// URL del detalle de un juego en Microsoft Store con la REGIÓN ACTIVA: sin
// ?hl/gl, apps.microsoft.com redirige por geo-detección del navegador (p. ej. a
// microsoft.mx) y manda al usuario al store equivocado. Con hl (idioma) + gl
// (país) del selector de región se fuerza el store correcto en el enlace.
const msDetailUrl = (productId) => {
  const r = activeRegion();
  return `https://apps.microsoft.com/detail/${productId}?hl=${r.msLocale}&gl=${r.msMarket}`;
};

const parseMsCard = (r, currency) => {
  const passName = r.PlaintextPassName || r.GlyphTextPassName || '';
  const gamePass = !!passName || r.DisplayPrice === 'Incluido';

  const skus = (r.SkusSummary || [])[0] || {};
  const sales = skus.SalePrices || [];
  const sale = sales.find((s) => !s.Conditions) || sales[0];
  const msrp = skus.MSRP || 0;
  let price = sale && sale.Price != null ? sale.Price : msrp;
  if (price === 0 && msrp > 0) price = msrp; // evitar "-100%" cuando solo hay precio Game Pass
  const original = msrp || price;
  // Si TODOS los precios de venta son condiciones de Game Pass (EntitlementId) y no
  // hay MSRP real, el juego es Game Pass-only aunque DisplayPrice diga "Gratis":
  // NUNCA clasificarlo como gratis real (requiere suscripción activa).
  const gpOnly = !gamePass
    && sales.length > 0
    && sales.every((s) => s && s.Conditions && s.Conditions.Type === 'EntitlementId')
    && !(msrp > 0);
  const free = !gamePass && !gpOnly && (r.DisplayPrice === 'Gratis' || r.DisplayPrice === 'Gratuito' || r.DisplayPrice === 'Free');
  const poster = (r.Images || []).find((i) => i.ImageType === 'Poster');
  return {
    title: r.Title,
    price: price ?? 0,
    original: original ?? 0,
    discount: original > price && original > 0 ? Math.round((1 - price / original) * 100) : 0,
    currency: (currency || activeRegion().currency) || 'ARS',
    url: msDetailUrl(r.ProductId),
    art: poster ? poster.Url : null,
    gamePass: gamePass || gpOnly,
    free,
    passName: passName || (gpOnly ? 'Xbox Game Pass' : null),
  };
};

// Títulos de Microsoft Store que NUNCA son el juego buscado: guías de estrategia
// ("Cult of the Lamb: The Ultimate Guide" a $35 ARS), trailers, demos/pruebas,
// DLC/add-ons/upgrades, packs de complementos y soundtracks. Se filtran ANTES de
// pickBest para que no matcheen al juego real. Verificado en vivo contra la API.
// Función pura → testeable sin red en test-logic.html.
const MS_NOISE = /gu[aá]a|guide|walkthrough|estrategia|\bstrategy\b|\btrucos?\b|\bcheats?\b|trailer|gameplay|accolades|\banuncio\b|announce|\blanch\b|teaser|\bdemo\b|prueba|\btrial\b|complementos|add-?on|\bdlc\b|upgrade|season pass|pase de temporada|contenido adicional|soundtrack|banda sonora|\bost\b/i;
const isMsNoise = (title) => MS_NOISE.test(title || '');

// Busca en el store de Microsoft y devuelve el mejor match con precios (ARS).
async function fetchMsPrice(term) {
  const candidates = await searchMsStore(term, 10);
  const best = pickBest(term, candidates);
  if (!best) return null;
  return best;
}

// Buscador universal de Microsoft Store: devuelve TODOS los candidatos (top N)
// parseados y sin ruido (guías, trailers, demos, DLC, packs…). Se usa en la página
// de ofertas para encontrar y agregar cualquier juego del catálogo de MS Store.
// limit: cuántos resultados pedir a la API (la API topa en 20 por query).
async function searchMsStore(term, limit = 20) {
  const r = activeRegion();
  const url = `${MS_SEARCH}?query=${encodeURIComponent(term)}&market=${r.msMarket}&locale=${r.msLocale}&limit=${limit}&deviceFamily=windows.desktop`;
  const res = await fetch(url);
  const json = await res.json();
  const results = (json && json.Payload && json.Payload.SearchResults) || [];
  const seen = new Set();
  const out = [];
  for (const r of results) {
    if (!r || !r.Title || !r.ProductId || isMsNoise(r.Title)) continue;
    if (seen.has(r.ProductId)) continue; // la API repite la misma card a veces
    seen.add(r.ProductId);
    out.push(parseMsCard(r));
  }
  return out;
}

// ---------- DÓLAR / TIPO DE CAMBIO (multipaís) ----------
// AR → dolarapi (blue/oficial/tarjeta, el mercado original de la extensión).
// Resto del mundo → open.er-api.com (gratis, sin key): tasa USD→moneda local
// oficial. Para simplificar la UI, en regiones no-AR las 3 casas valen lo mismo.
async function fetchDolarRates() {
  const r = activeRegion();
  if (r.code === 'AR') {
    const res = await fetch(DOLAR_API);
    const json = await res.json();
    const get = (casa) => {
      const d = (json || []).find((x) => x.casa === casa);
      return d ? d.venta : null;
    };
    return { blue: get('blue'), oficial: get('oficial'), tarjeta: get('tarjeta') };
  }
  // resto del mundo: open.er-api.com/v6/latest/USD → rates[<moneda local>]
  const res = await fetch('https://open.er-api.com/v6/latest/USD');
  const json = await res.json();
  const rate = (json && json.rates && json.rates[r.currency]) || null;
  return { blue: rate, oficial: rate, tarjeta: rate };
}
