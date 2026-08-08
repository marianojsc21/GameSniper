# 📦 Ficha Chrome Web Store — GameSniper v4.1.0

Todo listo para subir en https://chrome.google.com/webstore/devconsole (requiere cuenta de desarrollador, **USD 5** de registro único).

---

## 1. 📄 Archivos a subir (ya preparados en esta carpeta)

| Archivo | Uso | Requisito CWS |
|---|---|---|
| `GameSniper-4.1.0-cws.zip` | Paquete de la extensión (21 archivos, `manifest.json` en la raíz, separadores `/`, sin código de más) | El ZIP del paquete |
| `screenshot-offers-1280x800.png` | Captura principal: página de ofertas (dashboard + grid) | Screenshot **1280×800** (o 640×400) — **obligatorio, mínimo 1** |
| `screenshot-popup-640x400.png` | Captura del popup (branding + botón + footer) | Screenshot **640×400** |
| `promo-440x280.png` | Small promo tile (recorte del header + dashboard) | Tile promocional 440×280 (opcional, recomendado) |

> El ZIP se generó **solo con los archivos que la extensión necesita** (manifest, background, content, offers/popup, shared/, icons/) — sin README, tests, `.github` ni archivos de debug. Verificado: 21 entradas, todos los paths con `/`.

---

## 2. ✏️ Datos básicos del listing

- **Idioma de la ficha**: Español (`es`)
- **Título (nombre)**: `GameSniper — Cazador de oportunidades de juegos`
  *(coincide con el `name` del manifest; 44 caracteres, dentro del límite)*
- **Resumen** (máx. 132 caracteres):
  `Compara precios de Steam, Epic y Microsoft Store y detecta price bugs y ofertas ocultas antes de que desaparezcan.`
  *(119 caracteres)*
- **Categoría sugerida**: **Compras** (Shopping) — es un comparador de precios. Alternativa: *Herramientas* (Tools).
- **Página principal del desarrollador** (opcional): `https://github.com/marianojsc21/GameSniper`

---

## 3. 📝 Descripción completa (pegar tal cual)

**GameSniper** encuentra el precio más barato de cualquier juego en segundos comparando **Microsoft Store, Steam y Epic Games**. No es solo un comparador: es una herramienta que detecta **errores de precio (price bugs)**, **regionalización mal configurada** y **ofertas ocultas** antes de que desaparezcan.

### 🚨 Detecta oportunidades que nadie ve
- **Posibles errores de precio**: marca juegos que en Microsoft Store salen mucho más baratos que en Steam/Epic (umbral configurable 40–70%).
- **Regionalización mal configurada**: detecta precios "argentinizados" o mal regionalizados.
- **Opportunity Score (0–100)**: cada juego recibe un score que pondera ahorro, tipo de anomalía y riesgo de corrección.
- **Probabilidad de corrección**: estima si la oferta está por desaparecer (alta / media / baja).

### 🎮 Compara de verdad
- **3 tiendas en una sola vista**: Steam, Epic Games y Microsoft Store, con precios convertidos a tu moneda.
- **16 regiones**: precios según el país (ARS, USD, MXN, BRL, CLP, COP, PEN, EUR, GBP, CAD, AUD, JPY, KRW…).
- **Gratis semanales de Epic**: sección dedicada con countdown en vivo y botón de reclamo.
- **Filtro de gratis reales**: muestra juegos realmente gratuitos (Epic, free-to-play de Steam, MS) — **Xbox Game Pass no cuenta como gratis**: se distingue claramente entre "Incluido con Game Pass", "Gratis" y "De pago".
- **Mínimo histórico**: en cualquier tienda, con sparkline y badge cuando el precio actual iguala el mínimo de la semana.
- **TOP Price Bugs del Día** y alertas "🔥 COMPRA YA" en casos extremos.

### 🔔 No te pierdas nada (sin spam)
- **Notificación diaria** con el TOP Price Bugs del Día (una al día, solo cuando hay oportunidades reales).
- **Alerta de nuevos gratis de Epic** cada jueves cuando rotan.
- **Lista de deseados inteligente**: avisa solo cuando baja de precio, hay mínimo histórico, error de precio, MS pasa a ser la más barata o Epic lo regala.

### 🖱️ Experiencia cuidada
- **Popup** con stats rápidas y la mejor oportunidad del último scan.
- **Vistas múltiples**: cuadrícula visual o lista compacta (con encabezados ordenables), la elección se recuerda.
- **Tema claro y oscuro** con transición suave.
- **Content script**: mientras navegás un juego en Steam o Epic, se inyecta el precio de Microsoft Store directamente en la página.
- **Dashboard**: price bugs, grandes ofertas, mínimos históricos, juegos y bug en Microsoft, todo junto.
- **Badge en el ícono** con la cantidad de precios bugueados del último scan.

### 🔒 Privacidad y datos
- **No recolecta ni envía ningún dato personal.** Todo se procesa localmente en tu navegador.
- Las consultas van a las **APIs públicas** de Steam, Epic Games, Microsoft Store y el servicio público del dólar.
- **Sin código remoto**: toda la lógica está en el paquete.
- Código abierto: [github.com/marianojsc21/GameSniper](https://github.com/marianojsc21/GameSniper) (licencia MIT).

### 📥 Instalación
1. Instalá la extensión desde esta página.
2. Tocá el ícono de GameSniper en la barra del navegador.
3. Presioná **VER OPORTUNIDADES** para abrir el comparador y escanear precios.

---

## 4. 🔐 Justificación de permisos (texto para el formulario)

- **`storage`**: guarda la caché de precios, las preferencias (tema, región, umbral, vista) y la lista de deseados localmente.
- **`notifications`**: muestra la notificación diaria del TOP Price Bugs del Día y los avisos de nuevos gratis de Epic.
- **`alarms`**: ejecuta chequeos periódicos en segundo plano (deseados cada 30 min, gratis de Epic al rotar).
- **Host permissions**: solo las APIs públicas de `store.steampowered.com`, `store.epicgames.com`, `storeedgefd.dsx.mp.microsoft.com`, `dolarapi.com` y `open.er-api.com` — para consultar precios. No se lee ni modifica ningún otro sitio.

---

## 5. ✅ Checklist antes de publicar

- [ ] ZIP subido como paquete (sin `test-logic.html`, sin `.github`, sin README).
- [ ] Nombre del listing = nombre del manifest (cumple la regla de CWS).
- [ ] Mínimo 1 screenshot 1280×800 o 640×400 → subidos **2**.
- [ ] Idioma: Español.
- [ ] **Objetivo único**: comparar precios y detectar oportunidades → cumple la política de "single purpose".
- [ ] **Sin código remoto**: toda la lógica está empaquetada.
- [ ] **Privacidad**: sin recolección de datos → responder "No" a todas las preguntas de datos del formulario.
- [ ] Descripción sin mayúsculas sostenidas ni claims exagerados.

---

## 6. 🚀 Pasos para publicar

1. Crear cuenta de desarrollador en https://chrome.google.com/webstore/devconsole (USD 5).
2. *New item* → subir `GameSniper-4.1.0-cws.zip`.
3. Completar la ficha con los textos de arriba.
4. Subir los screenshots y el tile.
5. *Submit for review* → la revisión típica tarda 1–3 días hábiles.
