# GameSniper — Guía de desarrollo 🛠️

Documento para entender **cómo se armó** la extensión y **cómo funciona por dentro**, para retomarla en el futuro sin tener que leer todo el código de cero.

---

## 1. Resumen

Extensión Chromium (Manifest V3) para **Chrome / Edge / Brave** que compara precios de juegos entre **Microsoft Store, Steam y Epic Games**, detecta **price bugs** (precios argentinizados / mal configurados en MS Store), muestra **gratis semanales de Epic** y notifica oportunidades.

- **Idioma**: interfaz en español (es-AR como base).
- **Multipaís**: 16 regiones (AR, US, MX, BR, CL, CO, PE, ES, GB, DE, FR, IT, CA, AU, JP, KR) — precios y links según la región activa.
- **Versión actual**: v4.0 (`BUILD_STAMP = gamesniper-offers-2026-08-08-v4-const-free`).

## 2. Arquitectura (archivos)

```
ofertas-extension/
├── manifest.json          # MV3: service worker, host_permissions, content script, alarmas
├── popup.html/css/js      # Popup: stats rápidas del último scan, tema, footer de marca
├── offers.html/css/js     # Página principal del comparador (dashboard, filtros, vistas)
├── background.js          # Service worker: badge, notificaciones, alarmas, fetch puntual
├── content.js             # Inyecta el precio de MS Store en páginas de juegos de Steam/Epic
├── shared/
│   ├── util.js            # TODA la lógica pura (ver §4) + Store (storage con fallback) + REGIONS
│   ├── db.js              # Capa de datos: caché por tienda con TTL, historial, wishlist
│   ├── stores.js          # Registro modular STORES + fetch/parse por tienda + dólar
│   └── catalog.js         # Catálogo 500+ juegos { name, steamId, genre }
├── icons/                 # Íconos + lettering del nombre (2 variantes por tema)
└── test-logic.html        # Harness de tests de lógica (300+ aserciones, sin red)
```

**Flujo de datos:** `offers.js` corre el scan → pide a `stores.js` los precios por tienda (con caché de `db.js`) → procesa con las funciones puras de `util.js` → guarda en `chrome.storage.local` (`ofertasCache_<REGION>`) → renderiza. El popup y las notificaciones leen esa caché (no re-escanean).

## 3. Las 3 tiendas (stores.js)

Cada tienda es un módulo en el registro `STORES` (escalable para agregar GOG, Ubisoft, etc.):

| Tienda | API | Moneda | Forma | Concurrencia |
|---|---|---|---|---|
| Steam | `store.steampowered.com/api/appdetails` (`cc=REGION`) | USD (unidades) | batch (appids juntos) | — |
| Epic | `store.epicgames.com/graphql` (`searchStore`, `country=`) | USD (centavos) | pool | 5 |
| Microsoft | `storeedgefd.dsx.mp.microsoft.com/v9.0/search` (`market=REGION`) | ARS / moneda local | pool | 5 |

- **Dólar**: `dolarapi.com` (blue / oficial / tarjeta) solo para conversión USD→ARS.
- **Cache TTL**: Steam 60 min, Epic 45 min, MS 30 min (`DB.storeFresh`). El scan muestra la caché al instante y refresca en segundo plano.
- **CORS**: los fetch van por el service worker (host_permissions). En `file://` (headless/tests) Epic bloquea por CORS → usar `--disable-web-security` solo para testing local.

## 4. La lógica pura (shared/util.js) — lo más importante

Toda la inteligencia vive en funciones puras y testeables (sin DOM, sin chrome):

- `pickBest` — elige la mejor coincidencia de un juego entre candidatos de la API (score por título normalizado; empates → gana el juego completo con precio/Game Pass sobre la variante F2P; `isMsNoise` filtra guías/trailers/DLC/upgrades).
- `parseMsCard` — clasifica cada card de MS Store en **purchase / free / gamepass**:
  - `DisplayPrice: "Incluido"` + `PlaintextPassName` → **Game Pass** (nunca "Gratis").
  - `MSRP 0` sin condiciones + "Gratis" → **free real** (F2P).
  - MSRP 0 + condiciones `EntitlementId` → **gamepass-only** (no gratis).
  - Con precio real → **purchase** (con nota "🎮 en Game Pass" si aplica).
- `reclassifySuspiciousFree` — validación **cross-store**: si MS dice "Gratis" pero Steam/Epic venden el juego con precio → es Game Pass (los F2P reales son gratis en todas las tiendas). Si Epic dice gratis pero no es weekly y Steam cobra → se descarta (delisted). **El gratis semanal de Epic está exento** (dato autoritativo).
- `compareForBug` / `detectType` — anomalías: `bug` (MS ≥ umbral 40/50/60/70% más barato que el mejor USD convertido) y `regional` (≥ 65%).
- `correctionRisk`, `opportunityScore`, `isUrgent` — riesgo de que se corrija, score 0–100, alerta "🔥 COMPRA YA".
- `captureHistory` / `histStats` / `isHistoricLow` / `isHistoricLowAny` / `isWeeklyLow` / `priceRoseToday` / `opportunityGone` — historial de precios (90 días, snapshots sin duplicar en 30 min), mínimo histórico en **cualquier tienda** (`bestArs`), "⛔ se acabó la oportunidad".
- `epicFreeActive` / `epicFreeWeekKey` / `epicFreeNewTitles` / `epicFreeCatalogMap` — gratis semanales de Epic: activos, dedupe por semana, títulos nuevos, y el matching para inyectar "🎁 GRATIS en Epic" en las cards (matching por título normalizado, sin falsos positivos por substring).
- `compareBySort` / `compareBySortDir` / `NATURAL_DIR` — ordenamiento (9 criterios + direcciones ▲/▼).
- `wishEvents` — eventos de la lista de deseados (bug, drop, histLow, msCheapest, epicFree). El primer sync no dispara nada (línea base anti-spam).
- `REGIONS` + helpers de moneda (`fmtARS`, `fmtUSD` **centavos**, `fmtUsd` **unidades**, `arsFromUsdCents`).

## 5. ⚠️ Trampas conocidas (leer antes de tocar)

1. **Centavos vs unidades**: Steam devuelve USD **en unidades** (7 → $7.00), pero `fmtUSD` divide por 100 (espera centavos). Para Steam usar **`fmtUsd`** (sin dividir). Los `original` de Epic Free vienen en centavos → `fmtUSD` está bien ahí. Mezclar esto produce precios como `$0.07`.
2. **`Assignment to constant variable` fantasma**: la línea 115 del reporte de errores puede apuntar a `runScan` por un error viejo capturado (async boundary de Chrome). Verificar con el badge `v4.0` en el header y el `BUILD_STAMP` del panel rojo antes de perseguir el error en el código.
3. **`--virtual-time-budget` no dispara `setTimeout`** en headless: la barra de progreso "no se oculta" en dumps con budget virtual — es artefacto de la prueba, no un bug.
4. **GDI+ no puede guardar sobre un archivo abierto** (PowerShell/System.Drawing): para regenerar PNGs, leer los píxeles a memoria, liberar, y guardar a temp + mover.
5. **Game Pass-only ≠ gratis**: cualquier ruta que muestre "Gratis" debe pasar por `storeOfferKind` (`purchase`/`free`/`gamepass`) y `reclassifySuspiciousFree`.
6. **Región en URLs**: MS detail → `?hl=<locale>&gl=<country>`; Steam → `?cc=&l=`; Epic fallback → locale por región. Nunca hardcodear `es-AR`.
7. **Nunca romper el patrón** `({ stores, ars } = reclassifySuspiciousFree(...))` en `buildRow`: `ars` y `stores` deben ser `let` (el harness tiene un smoke test para esto).

## 6. Versiones de caché y "blanqueos"

- `CACHE_VERSION` (historial) y `STORE_CACHE_VERSION` (caché por tienda) están en **7**.
- Cuando un fix cambia el **formato** de lo que se guarda (ej. la clasificación Game Pass), **subir la versión**: `db.js` descarta automáticamente la caché vieja (sin versión o con versión menor) aunque el TTL no haya vencido.
- El harness asevera `STORE_CACHE_VERSION === 7` — al cambiarla, actualizar `test-logic.html`.

## 7. Cómo testear

**Harness de lógica** (300+ aserciones, corre sin red — usa `Store` con fallback a memoria):
```bash
"chrome.exe" --headless=new --disable-gpu --allow-file-access-from-files --dump-dom file:///…/test-logic.html
# debe mostrar <title>ALL PASS</title>
```

**CI**: `.github/workflows/test.yml` corre lo mismo en cada push (Chrome de ubuntu-latest, `--no-sandbox`), y falla si hay cualquier FAIL.

**Página real (headless)**:
```bash
"chrome.exe" --headless=new --disable-gpu --disable-web-security --allow-file-access-from-files --virtual-time-budget=90000 --dump-dom file:///…/offers.html
# sin --disable-web-security los fetch a Epic fallan por CORS (file://)
```

**Medición de layout** (popup/offers): página temporal que carga el CSS real y escribe en `document.title` si entra en un renglón (`scrollWidth <= clientWidth`).

## 8. Historia del desarrollo (resumen de decisiones)

1. **Comparador simple** (popup + página) → se convirtió en **cazador de oportunidades**: el valor real es encontrar bugs de precio, no comparar precios.
2. **Catálogo 200 → 500+ juegos**: appids de Steam verificados contra `appdetails` (los erróneos fueron corregidos o descartados).
3. **Game Pass ≠ Gratis** (fix grande): la API de MS expone "Incluido" + `PlaintextPassName`; antes los juegos de Game Pass aparecían como "Gratis" → `parseMsCard` + `reclassifySuspiciousFree` + `storeOfferKind`.
4. **Delisted a $0** (GTA V): Epic devuelve variantes retiradas a $0 con `productSlug` null → no descartar por slug null, y un `(0,0)` que no es F2P jamás es gratis (`isEpicF2P` / `epicFreeAt`).
5. **Multipaís**: se agregó `REGIONS` (16 países) con precios/links/notificaciones por región. El usuario pidió que "la puedan usar de distintas partes del mundo".
6. **UX**: barra de progreso 0→100 (reemplazó el render progresivo que "pestañeaba"), vistas Cuadrícula/Lista con orden recordable, tema claro/oscuro con crossfade, logos SVG + precios clicables.
7. **Ghost del error const**: auditoría completa del scan + cachés blanqueadas a v7 + badge `v4.0` en el header + `BUILD_STAMP` en el panel de errores. El error era de builds viejas capturadas, no del código actual.
8. **Branding**: GameSniper (logo circular + lettering pixelado). El lettering se regeneró con **fondo uniforme** por tema: blanco en modo oscuro (texto negro), negro en modo claro (texto blanco) — antes era "mitad y mitad" (GAME blanco / SNIPER negro).

## 9. Publicación

- Repo: `github.com/marianojsc21/GameSniper` (público, MIT, CI verde).
- Release: `v1.0.0` con `GameSniper-v1.0.0.zip` (manifest.json en la raíz).
- Para Chrome Web Store: subir el ZIP (requiere cuenta de desarrollador, USD 5, y `content_security_policy`/host_permissions a revisar en la revisión).
