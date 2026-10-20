require('dotenv').config();
const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // PayZen devuelve kr-answer / kr-hash por POST (form)

// URL(s) del frontend, separadas por coma. Puede incluir ruta (ej. GitHub Pages:
// https://usuario.github.io/mi-repo/). Para CORS se usa solo el origen (esquema + dominio).
const URLS_FRONTEND = (process.env.FRONTEND_URL)
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean);
const ORIGENES_PERMITIDOS = URLS_FRONTEND.map((u) => {
  try { return new URL(u).origin; } catch { return u.replace(/\/$/, ''); }
});
const FRONTEND_PRINCIPAL = URLS_FRONTEND[0]; // a donde vuelve el usuario tras pagar

// CORS solo para la API que consume el navegador (el retorno y el IPN no lo necesitan)
app.use('/api', (req, res, next) => {
  const origen = req.headers.origin;
  if (origen && ORIGENES_PERMITIDOS.includes(origen)) {
    res.setHeader('Access-Control-Allow-Origin', origen);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const DEUDAS = {
  '12.572.407-8': {
    numeroCliente: '12.572.407-8',
    nombre: 'Fernando Luna',
    email: 'fernando.luna@lyra.com',
    direccion: 'Av Chile, San Isidro',
    periodo: 'Octubre 2026',
    vencimiento: '2026-10-31',
    monto: 35000 // CLP, sin decimales
  }
};

const {
  PAYZEN_ENDPOINT = 'https://api.payzen.lat',
  PAYZEN_STATIC = 'https://static.payzen.lat/static/js/krypton-client/V4.0'
} = process.env;

// Una entrada por tienda: cada una con sus propias credenciales
const TIENDAS = {
  mall: {
    nombre: 'Webpay Mall Completa',
    username: process.env.PAYZEN_MALL_USERNAME,
    password: process.env.PAYZEN_MALL_PASSWORD,
    publicKey: process.env.PAYZEN_MALL_PUBLIC_KEY,
    sha256: process.env.PAYZEN_MALL_SHA256
  },
  plus: {
    nombre: 'Webpay Plus',
    username: process.env.PAYZEN_PLUS_USERNAME,
    password: process.env.PAYZEN_PLUS_PASSWORD,
    publicKey: process.env.PAYZEN_PLUS_PUBLIC_KEY,
    sha256: process.env.PAYZEN_PLUS_SHA256
  }
};

// Health check para Render
app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/api/consulta-deuda', (req, res) => {
  const dni = String(req.body.dni || '').trim();
  const cuenta = DEUDAS[dni];
  if (!cuenta) return res.status(404).json({ error: 'No encontramos una deuda asociada a ese número de cliente.' });
  res.json(cuenta);
});

// Datos públicos que necesita el navegador para la tienda elegida
app.get('/api/config', (req, res) => {
  const tienda = TIENDAS[req.query.tienda];
  if (!tienda) return res.status(400).json({ error: 'Medio de pago no válido.' });
  if (!tienda.publicKey) return res.status(500).json({ error: `Falta la clave pública de ${tienda.nombre} en el .env` });
  res.json({
    publicKey: tienda.publicKey,
    jsUrl: `${PAYZEN_STATIC}/stable/kr-payment-form.min.js`,
    themeCss: `${PAYZEN_STATIC}/ext/classic-reset.css`,
    themeJs: `${PAYZEN_STATIC}/ext/classic.js`
  });
});

// Crea el pago en PayZen con las credenciales de la tienda elegida
app.post('/api/crear-pago', async (req, res) => {
  const dni = String(req.body.dni || '').trim();
  const cuenta = DEUDAS[dni];
  if (!cuenta) return res.status(404).json({ error: 'Cliente no encontrado.' });

  const tienda = TIENDAS[req.body.tienda];
  if (!tienda) return res.status(400).json({ error: 'Medio de pago no válido.' });
  if (!tienda.username || !tienda.password) {
    return res.status(500).json({ error: `Faltan las credenciales de ${tienda.nombre} en el .env` });
  }

  const auth = Buffer.from(`${tienda.username}:${tienda.password}`).toString('base64');

  try {
    const r = await fetch(`${PAYZEN_ENDPOINT}/api-payment/V4/Charge/CreatePayment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
      body: JSON.stringify({
        amount: cuenta.monto, // el monto SIEMPRE sale del backend
        currency: 'CLP',
        formAction: 'PAYMENT',
        orderId: `GV-${req.body.tienda.toUpperCase()}-${cuenta.numeroCliente}-${Date.now()}`,
        customer: { email: cuenta.email, reference: cuenta.numeroCliente }
      })
    });
    const data = await r.json();

    if (data.status !== 'SUCCESS' || !data.answer || !data.answer.formToken) {
      console.error(`Error PayZen CreatePayment (${tienda.nombre}):`, JSON.stringify(data));
      const msg = (data.answer && data.answer.errorMessage) || 'PayZen rechazó la creación del pago.';
      return res.status(502).json({ error: msg });
    }

    res.json({ formToken: data.answer.formToken });
  } catch (err) {
    console.error('Error llamando a PayZen:', err);
    res.status(502).json({ error: 'No se pudo conectar con PayZen.' });
  }
});

// Valida kr-hash = HMAC-SHA256(kr-answer). Como el retorno no dice de qué tienda viene,
// se prueba con las claves de cada tienda configurada.
function hashValido(body) {
  const respuesta = body['kr-answer'];
  const hash = body['kr-hash'];
  if (!respuesta || !hash) return false;

  const recibido = Buffer.from(String(hash));
  return Object.values(TIENDAS).some((t) => {
    const clave = body['kr-hash-key'] === 'password' ? t.password : t.sha256;
    if (!clave) return false;
    const esperado = Buffer.from(crypto.createHmac('sha256', clave).update(respuesta, 'utf8').digest('hex'));
    return esperado.length === recibido.length && crypto.timingSafeEqual(esperado, recibido);
  });
}

// Retorno del navegador (kr-post-url-success y kr-post-url-refused apuntan aquí)
app.post('/retorno-pago', (req, res) => {
  if (!hashValido(req.body)) {
    return res.status(400).send(paginaResultado(false, 'La firma no coincide: no se confirma el pago.'));
  }
  const respuesta = JSON.parse(req.body['kr-answer']);
  const exito = respuesta.orderStatus === 'PAID';
  res.send(paginaResultado(exito, `Orden ${escaparHtml(respuesta.orderDetails?.orderId || '')}: ${escaparHtml(respuesta.orderStatus)}`));
});

// Si alguien abre la URL de retorno directamente
app.get('/retorno-pago', (req, res) => res.redirect(FRONTEND_PRINCIPAL));

// IPN (notificación servidor a servidor). Configura esta URL en el Back Office de AMBAS tiendas.
// Aquí es donde debes marcar la deuda como pagada, no en el retorno del navegador.
app.post('/webhook-payzen', (req, res) => {
  if (!hashValido(req.body)) return res.status(400).send('Firma inválida');
  const respuesta = JSON.parse(req.body['kr-answer']);
  console.log('IPN:', respuesta.orderDetails?.orderId, respuesta.orderStatus);
  res.status(200).send('OK');
});

function escaparHtml(valor) {
  return String(valor).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function paginaResultado(exito, mensaje) {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<title>Resultado del pago</title>
<link href="https://cdnjs.cloudflare.com/ajax/libs/bootstrap/5.3.3/css/bootstrap.min.css" rel="stylesheet"></head>
<body class="d-flex align-items-center justify-content-center" style="height:100vh;background:#eef1f7;">
<div class="card p-4 text-center shadow-sm" style="max-width:420px;">
  <h1 class="h4 mb-3">${exito ? '✅ Pago autorizado' : '⚠️ Pago no autorizado'}</h1>
  <p class="text-muted">${mensaje}</p>
  <a href="${escaparHtml(FRONTEND_PRINCIPAL)}" class="btn" style="background:#0d1b4c;color:#fff;">Volver al inicio</a>
</div></body></html>`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor escuchando en puerto ${PORT}`));