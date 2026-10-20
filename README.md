# Gasvalpo – pago en línea (demo con PayZen)

Proyecto separado en **backend** (Node/Express) y **frontend** (HTML/Bootstrap estático). Usa el **formulario embebido (Krypton V4)** de PayZen/Lyra, con soporte para Webpay (Transbank) y dos tiendas: Tarjetas (Mall) y Webpay Plus.

## Estructura

    backend/    API Express: consulta de deuda, creación del pago, retorno e IPN
    frontend/   Sitio estático (index.html + app.js)

## Flujo

1. El usuario ingresa su N° de cliente y el backend devuelve la deuda.
2. Al elegir el medio de pago, el backend llama a `Charge/CreatePayment` con las credenciales de esa tienda y devuelve un `formToken`.
3. El frontend carga `kr-payment-form.min.js` y renderiza el formulario con `KR.setFormConfig`. Con Webpay Plus, el botón de Webpay se presiona automáticamente.
4. Al terminar (o al volver de Webpay), PayZen hace POST al **backend** en `/retorno-pago` con `kr-answer` y `kr-hash`; el backend valida el hash con HMAC-SHA256.

## Ejecutar en local

Backend:

    cd backend
    npm install
    cp .env.example .env    # y completa las credenciales
    npm start               # http://localhost:3000

Frontend (otra terminal):

    npx serve frontend -l 5500    # http://localhost:5500

En local, `frontend/app.js` apunta solo a `http://localhost:3000`.

## Variables del backend (`backend/.env`)

- `FRONTEND_URL`: URL del frontend permitida por CORS (sin "/" final).
- `PAYZEN_ENDPOINT` y `PAYZEN_STATIC`: endpoints de PayZen.
- `PAYZEN_MALL_*` y `PAYZEN_PLUS_*`: `USERNAME`, `PASSWORD`, `PUBLIC_KEY` y `SHA256` de cada tienda (Back Office > Configuración > Tienda > Claves de la API REST).

## Subir a GitHub

    git init
    git add .
    git status        # verifica que NO aparezca backend/.env
    git commit -m "Proyecto separado en frontend y backend"
    git branch -M main
    git remote add origin https://github.com/TU-USUARIO/TU-REPO.git
    git push -u origin main

## Desplegar en Render

**1. Backend** (New > Web Service, conecta el repo)

- Root Directory: `backend`
- Build Command: `npm install`
- Start Command: `npm start`
- Health Check Path: `/health`
- Environment: todas las variables de `backend/.env.example` (por ahora deja `FRONTEND_URL` con un valor temporal)

**2. Frontend** (New > Static Site, mismo repo)

- Root Directory: `frontend`
- Build Command: (vacío)
- Publish Directory: `.`

**3. Conectar ambos**

- En `frontend/app.js`, reemplaza `https://TU-BACKEND.onrender.com` por la URL real del backend y haz push.
- En el backend, pon `FRONTEND_URL` con la URL del Static Site (sin "/" final).
- En el Back Office de PayZen, configura el IPN de ambas tiendas como `https://TU-BACKEND.onrender.com/webhook-payzen`.

## Antes de producción

- Marca la deuda como pagada en el IPN (`/webhook-payzen`), no en el retorno del navegador.
- Confirma que Webpay esté activo como medio de pago en tus tiendas.
- Reemplaza el objeto `DEUDAS` por tu consulta real.
- En el plan gratuito de Render el backend se "duerme" tras un rato sin uso, y la primera petición puede tardar. Para pagos reales conviene un plan que no se suspenda.