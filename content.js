// content.js — inyecta el precio de Microsoft Store en la página de un juego de Steam/Epic.
// Pide la comparación al service worker (background.js) para evitar CORS y reutilizar
// el mismo matching/format que el comparador. Incluye shared/util.js (esc, fmtMoney).
'use strict';

(() => {
  if (window.__OFERTAS_INJECTED__) return; // no duplicar si se reinyecta
  window.__OFERTAS_INJECTED__ = true;

  const HOST = 'oferta-ms-card';
  let shadowHost = null;
  let root = null;
  let lastUrl = '';
  let busy = false;

  // ---------- detección del juego ----------
  function isGamePage() {
    const h = location.hostname;
    if (h === 'store.steampowered.com') return /^\/app\/\d+/.test(location.pathname);
    if (h === 'store.epicgames.com') return /\/p\/[^/]+/.test(location.pathname);
    return false;
  }

  function detectGame() {
    const h = location.hostname;
    const p = location.pathname;
    if (h === 'store.steampowered.com') {
      const m = /^\/app\/(\d+)/.exec(p);
      const titleEl = document.querySelector('#appHubAppName');
      const title =
        (titleEl && titleEl.textContent.trim()) ||
        document.title.replace(/\s+on Steam$/i, '').trim();
      return { steamId: m ? Number(m[1]) : null, title };
    }
    if (h === 'store.epicgames.com') {
      const og = document.querySelector('meta[property="og:title"]');
      let title = (og && og.content) || '';
      if (!title) {
        const h1 = document.querySelector('h1');
        if (h1) title = h1.textContent.trim();
      }
      title = title.replace(/\s*[|–-]\s*Epic Games Store.*$/i, '').trim();
      return { steamId: null, title };
    }
    return null;
  }

  // ---------- región activa (multipaís) ----------
  // La card inyectada formatea precios con fmtMoney (moneda de la región activa).
  // content.js solo carga util.js, así que lee la región guardada por la página
  // (ofertasRegion) ANTES de renderizar; si no, mostraría todo como ARS.
  async function loadRegion() {
    try {
      const s = await Store.get('ofertasRegion');
      setActiveRegion(s || 'AR');
    } catch (e) { /* default AR */ }
  }

  // ---------- consulta al background ----------
  async function query(game) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'oferMsCheck', steamId: game.steamId, title: game.title }, (r) =>
          resolve(r || { ok: false })
        );
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  // ---------- UI (shadow DOM para no chocar con los estilos de la página) ----------
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: "Segoe UI", system-ui, Roboto, sans-serif; }
    .card {
      position: fixed; right: 18px; bottom: 18px; z-index: 2147483000;
      width: 300px; border-radius: 14px; overflow: hidden;
      background: #0b0e17; color: #e8ecf6;
      border: 1px solid #25304d;
      box-shadow: 0 14px 40px rgba(0,0,0,.55);
      font-size: 13px;
      animation: pop .18s ease-out;
    }
    @keyframes pop { from { transform: translateY(10px); opacity: 0; } to { transform: none; opacity: 1; } }
    .head {
      display: flex; align-items: center; gap: 9px;
      padding: 10px 12px; background: linear-gradient(135deg, #16223f, #131a2b);
      border-bottom: 1px solid #25304d;
    }
    .logo {
      width: 26px; height: 26px; flex-shrink: 0;
      object-fit: contain; display: block;
    }
    .head .t { min-width: 0; }
    .head .t .kicker { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #8b96b5; }
    .head .t .gname { font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .close { margin-left: auto; background: none; border: none; color: #8b96b5; cursor: pointer; font-size: 15px; padding: 2px 6px; border-radius: 6px; }
    .close:hover { background: rgba(255,255,255,.08); color: #fff; }
    .body { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    .bug-banner {
      border-radius: 10px; padding: 9px 11px; font-weight: 800; font-size: 13px;
      color: #fff; background: linear-gradient(135deg, #ff5d73, #ff9a3c);
      box-shadow: 0 6px 16px rgba(255,93,115,.35);
    }
    .prices { display: flex; flex-direction: column; gap: 5px; }
    .price-row { display: flex; justify-content: space-between; align-items: center; }
    .price-row .store { color: #8b96b5; }
    .price-row .val { font-weight: 700; }
    .price-row .val.best { color: #38e08b; }
    .price-row .val.na { color: #8b96b5; font-weight: 400; }
    .price-row .val .gp { color: #ffc857; font-size: 11.5px; font-weight: 800; text-align: right; }
    .gp-buy { display: block; color: #e8ecf6; font-size: 11px; font-weight: 600; margin-top: 3px; }
    .gp-buy b { color: #38e08b; font-weight: 800; }
    .price-row .val .free { color: #38e08b; }
    .hint { font-size: 11px; color: #8b96b5; }
    .actions { display: flex; gap: 8px; }
    .btn {
      flex: 1; text-align: center; text-decoration: none; cursor: pointer;
      border-radius: 10px; padding: 9px 10px; font-weight: 700; font-size: 12.5px;
      border: 1px solid #25304d; color: #e8ecf6; background: #131a2b;
      transition: filter .15s, transform .15s;
    }
    .btn:hover { filter: brightness(1.25); transform: translateY(-1px); }
    .btn.primary { background: linear-gradient(135deg, #38e08b, #14b8a6); color: #06281a; border: none; }
    .btn.primary:hover { filter: brightness(1.1); }
    .foot { text-align: center; font-size: 10.5px; color: #5b6480; padding: 8px; border-top: 1px solid #1b2233; }
    .score {
      display: flex; align-items: center; gap: 6px;
      font-size: 11.5px; font-weight: 800; color: #ffc857;
    }
    .score .num {
      width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center;
      color: #06281a; background: conic-gradient(#ff9a3c calc(var(--sc,0)*1%), rgba(255,255,255,.1) 0);
      position: relative; font-size: 10.5px;
    }
    .score .num::after { content: ""; position: absolute; inset: 3px; border-radius: 50%; background: #131a2b; }
    .score .num span { position: relative; z-index: 1; }
    .type-bug, .type-regional {
      border-radius: 8px; padding: 6px 9px; font-weight: 800; font-size: 11px; color: #fff;
    }
    .type-bug { background: linear-gradient(135deg, #ff5d73, #ff9a3c); }
    .type-regional { background: linear-gradient(135deg, #ff9a3c, #ff5d73); }
    .loading { display: flex; align-items: center; gap: 8px; color: #8b96b5; font-size: 12.5px; }
    .spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid #25304d; border-top-color: #38e08b; animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  `;

  function buildUI(inner) {
    const host = document.createElement('div');
    host.id = HOST;
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = inner;
    shadow.appendChild(card);
    document.body.appendChild(host);
    return { host, shadow, card };
  }

  function render({ state, game, data }) {
    removeCard();
    const escName = esc(game && game.title ? game.title : '');
    const head = `
      <div class="head">
        <img class="logo" src="${chrome.runtime.getURL('icons/icon128.png')}" alt="GameSniper" />
        <div class="t"><div class="kicker">GameSniper · Microsoft Store</div><div class="gname" title="${escName}">${escName}</div></div>
        <button class="close" title="Cerrar">✕</button>
      </div>`;

    let body;
    if (state === 'loading') {
      body = `<div class="body"><div class="loading"><span class="spinner"></span>Consultando precios…</div></div>`;
    } else if (state === 'error' || !data || data.ok === false) {
      body = `<div class="body"><div class="hint">No se pudo consultar Microsoft Store.</div></div>`;
    } else if (!data.ms) {
      body = `<div class="body"><div class="hint">No se encontró este juego en Microsoft Store (${esc((data.currency || 'ARS'))}) o no tiene precio.</div></div>`;
    } else {
      const ms = data.ms;
      const best = data.bestUsdArs;
      const bestPrice = best != null ? fmtMoney(best) : null;
      const bug = data.bug;
      const type = data.type;
      const score = data.score != null ? data.score : 0;
      const msKind = data.msKind || 'purchase';
      // Game Pass-only y gratis real nunca se muestran como precio. Si el juego está
      // en Game Pass Y además tiene precio de compra, se muestran las DOS opciones:
      // el badge 🎮 y, debajo, el precio de compra en ARS.
      const msPrice = ms.gamePass
        ? `<span class="gp">🎮 Incluido con<br/>${esc(ms.passName || 'Xbox Game Pass')}${data.msArs > 0 ? `<span class="gp-buy">o compralo por <b>${fmtMoney(data.msArs)}</b></span>` : ''}</span>`
        : msKind === 'free'
          ? '<span class="free">🎁 Gratis</span>'
          : fmtMoney(data.msArs);
      const anomaly = bug
        ? type === 'regional'
          ? `<div class="type-regional">🚨 Posible precio regional incorrecto</div>`
          : `<div class="type-bug">🚨 Posible error de precio</div>`
        : '';
      const banner = bug
        ? `<div class="bug-banner">🔥 ${data.savings}% más barato que Steam/Epic</div>`
        : ms.gamePass
          ? `<div class="hint">🎮 Incluido con ${esc(ms.passName || 'Xbox Game Pass')} — requiere suscripción activa${data.msArs > 0 ? `, o compralo por ${fmtMoney(data.msArs)}` : ''}.</div>`
          : msKind === 'free'
            ? `<div class="hint">🎁 Gratis en Microsoft Store, sin suscripción.</div>`
            : bestPrice != null
              ? `<div class="hint">MS ≈ igual o más caro que Steam/Epic (${fmtMoney(best)}).</div>`
              : `<div class="hint">Sin datos de Steam/Epic para comparar.</div>`;
      body = `<div class="body">${anomaly}${banner}
        <div class="score">🔥 Oportunidad <span class="num" style="--sc:${score}"><span>${score}</span></span> / 100</div>
        <div class="prices">
          <div class="price-row"><span class="store">Microsoft Store</span><span class="val ${bug ? 'best' : ''}">${msPrice}</span></div>
          <div class="price-row"><span class="store">Mejor Steam/Epic</span><span class="val">${bestPrice || '<span class="na">—</span>'}</span></div>
        </div>
        <div class="actions">
          <a class="btn primary" href="${esc(ms.url)}" target="_blank" rel="noopener">Ver en MS →</a>
          <a class="btn" id="oferOpen" href="#">Comparador</a>
        </div>
        <div class="foot">${data.rateLabel || `USD→${data.currency || 'ARS'}`} ≈ ${data.rate != null ? Math.round(data.rate) : '—'} · datos en vivo</div>
      </div>`;
    }

    const { host, shadow } = buildUI(head + body);
    shadowHost = host;
    root = shadow;

    // eventos (sin handlers inline → CSP ok)
    const close = root.querySelector('.close');
    if (close) close.addEventListener('click', removeCard);
    const open = root.querySelector('#oferOpen');
    if (open) {
      open.addEventListener('click', (e) => {
        e.preventDefault();
        try { chrome.runtime.sendMessage({ type: 'oferOpenOffers' }); } catch (err) { /* noop */ }
      });
    }
  }

  function removeCard() {
    if (shadowHost && shadowHost.parentNode) shadowHost.parentNode.removeChild(shadowHost);
    shadowHost = null;
    root = null;
  }

  // ---------- flujo principal ----------
  async function check() {
    if (busy) return;
    if (!isGamePage()) { removeCard(); return; }
    const game = detectGame();
    if (!game || (!game.steamId && !game.title)) return;
    busy = true;
    try {
      await loadRegion(); // región activa ANTES de formatear precios (multipaís)
      render({ state: 'loading', game });
      const data = await query(game);
      render({ state: 'done', game, data });
    } catch (e) {
      render({ state: 'error', game });
    } finally {
      busy = false;
    }
  }

  function schedule() {
    // corre si cambió la URL (SPA de Epic / navegación dentro de Steam)
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      check();
    }
  }

  // navegación SPA (Epic usa React Router; Steam a veces también)
  setInterval(schedule, 1200);
  window.addEventListener('popstate', schedule);
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', check);
  } else {
    check();
  }
})();
