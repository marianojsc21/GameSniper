// popup.js — abre la página de ofertas y muestra stats cacheadas
'use strict';

(() => {
  const CACHE_KEY = () => `ofertasCache_${activeRegion().code}`;
  const EPIC_FREE_KEY = 'ofertasEpicFree';
  const EPIC_FREE_TTL = 12 * 60 * 60 * 1000;

  document.getElementById('openBtn').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('offers.html') });
  });

  // ---------- tema claro/oscuro (compartido con offers.html) ----------
  const THEME_KEY = 'ofertasTheme';
  // animate=true solo lo usa el toggle del usuario: agrega la clase theme-transition
  // (transiciones CSS activas ~450ms) SIN tocar el primer paint. Se fuerza un reflow
  // para que la clase se registre antes del cambio de data-theme y el crossfade ocurra.
  function applyTheme(theme, animate = false) {
    const t = theme === 'light' ? 'light' : 'dark';
    const root = document.documentElement;
    if (animate) {
      root.classList.add('theme-transition');
      void root.offsetWidth; // reflow: aplicar la clase antes del cambio de tema
      clearTimeout(applyTheme._anim);
      applyTheme._anim = setTimeout(() => root.classList.remove('theme-transition'), 500);
    }
    root.dataset.theme = t;
    const btn = document.getElementById('themeToggle');
    if (btn) {
      btn.textContent = t === 'light' ? '☀️' : '🌙';
      btn.title = t === 'light' ? 'Cambiar a tema oscuro' : 'Cambiar a tema claro';
    }
    // logo con fondo transparente: variante con anillo navy en tema claro (el anillo
    // blanco sería invisible sobre fondo claro), anillo blanco en tema oscuro. El
    // nombre pixelado también tiene variante por tema ("Game" blanco/navy).
    const light = t === 'light';
    // logo del header y del footer (miniatura) comparten el swap por tema
    document.querySelectorAll('.logo').forEach((logo) => {
      logo.src = light ? 'icons/gamesniper-light.png' : 'icons/gamesniper.png';
    });
    const name = document.querySelector('.head img.gs-name');
    if (name) name.src = light ? 'icons/gamesniper-name-light.png' : 'icons/gamesniper-name.png';
  }
  document.getElementById('themeToggle').addEventListener('click', async () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    applyTheme(next, true);
    await Store.set(THEME_KEY, next);
  });
  Store.get(THEME_KEY).then((t) => applyTheme(t));

  async function showStats() {
    // región activa (multipaís): la caché y la moneda dependen de ella
    const reg = await Store.get('ofertasRegion');
    setActiveRegion(reg || 'AR');
    const c = await Store.get(CACHE_KEY());
    const qLast = document.getElementById('qLast');
    const qChips = document.getElementById('qChips');
    if (!c || !c.games) {
      qLast.textContent = `Todavía no hay datos. Tocá el botón para escanear precios en ${activeRegion().currency}.`;
      return;
    }
    const bugs = c.games.filter((g) => g.bug).length;
    const total = c.games.length;

    qLast.innerHTML = bugs > 0
      ? `Hay <b>${bugs}</b> juego${bugs === 1 ? '' : 's'} con precio bug en Microsoft Store 🤑`
      : `Sin bugs detectados por ahora. Abrí el comparador para ver precios en ${activeRegion().currency}.`;
    // gratis semanales de Epic (caché propia, independiente del scan de precios)
    let epicFree = 0;
    try {
      const fc = await Store.get(EPIC_FREE_KEY);
      if (fc && fc.ts && Date.now() - fc.ts < EPIC_FREE_TTL && Array.isArray(fc.list)) {
        epicFree = fc.list.filter((g) => g && g.endDate && new Date(g.endDate).getTime() > Date.now()).length;
      }
    } catch (e) { /* noop */ }
    qChips.innerHTML = [
      `<span class="q-chip">${total} juegos</span>`,
      `<span class="q-chip warn">${bugs} oportunidades</span>`,
      epicFree > 0 ? `<span class="q-chip free">🎁 Epic regala ${epicFree}</span>` : '',
      `<span class="q-time">${timeAgo(c.ts)}</span>`,
    ].join('');

    // mejor oportunidad del último scan (score más alto)
    const best = c.games
      .filter((g) => g.bug && g.score != null)
      .sort((a, b) => b.score - a.score)[0];
    const el = document.getElementById('qBest');
    if (el && best) {
      el.classList.remove('hidden');
      el.innerHTML = `
        <div class="b-label">🔥 Mejor oportunidad</div>
        <div class="b-meta">
          <span class="b-score" style="--sc:${best.score}"><span>${best.score}</span></span>
          <span class="b-name">${esc(best.g.name)}</span>
          <span class="b-save">-${best.savings}%</span>
          <a class="b-open" href="${esc(bestUrl(best))}" target="_blank" rel="noopener">Ver →</a>
        </div>`;
    }
  }

  function bestUrl(r) {
    return r.bestStore && r.stores && r.stores[r.bestStore] ? r.stores[r.bestStore].url : null;
  }

  showStats();
})();
