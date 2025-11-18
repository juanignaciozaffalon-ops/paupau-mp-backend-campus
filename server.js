// server.js — PauPau Backend (MP + Postgres + Admin + Emails) — MULTI HORARIOS + extra_info + modalidad/grupal

const express = require('express');
const bodyParser = require('body-parser');
const mercadopago = require('mercadopago');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
require('dotenv').config(); // NEW: dotenv
const { createClient } = require('@supabase/supabase-js'); // NEW: supabase

const app = express();

/* ====== ENV ====== */
const PORT       = process.env.PORT || 10000;
const MP_TOKEN   = process.env.MP_ACCESS_TOKEN;
const ADMIN_KEY  = process.env.ADMIN_KEY || 'cambia-esta-clave';
const ALLOWED    = (process.env.ALLOWED_ORIGIN || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// SMTP
const SMTP_HOST     = process.env.SMTP_HOST || '';
const SMTP_PORT     = Number(process.env.SMTP_PORT || 587);
const SMTP_USER     = process.env.SMTP_USER || '';
const SMTP_PASS     = process.env.SMTP_PASS || '';
const FROM_EMAIL    = process.env.FROM_EMAIL || SMTP_USER || 'no-reply@paupau.local';
const ACADEMY_EMAIL = process.env.ACADEMY_EMAIL || FROM_EMAIL;

// NEW: Campus (Supabase + MP)
const SUPABASE_URL          = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || '';
const FRONTEND_URL          = process.env.FRONTEND_URL || ''; // ej: https://tu-dominio.com/campus
const WEBHOOK_SECRET        = process.env.WEBHOOK_SECRET || 'cambia-este-webhook-secret';
const MONTHLY_FEE           = Number(process.env.MONTHLY_FEE || 50);

// NEW: moneda MP para el campus (por defecto ARS)
const MP_CURRENCY           = process.env.MP_CURRENCY || 'ARS';

/* ====== CORS ====== */
app.use((req, res, next) => {
  const reqOrigin = req.headers.origin || '';
  let ok = ALLOWED.includes(reqOrigin);

  // también permitimos el origin del FRONTEND_URL (campus) si está seteado
  if (!ok && FRONTEND_URL) {
    try {
      const campusOrigin = new URL(FRONTEND_URL).origin;
      if (campusOrigin === reqOrigin) ok = true;
    } catch (_) {}
  }

  if (ok) {
    res.header('Access-Control-Allow-Origin', reqOrigin);
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Key');
    res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,PATCH,OPTIONS');
    res.header('Access-Control-Allow-Credentials', 'true');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(ok ? 200 : 403);
  next();
});

app.use(bodyParser.json());

/* ====== DB ====== */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
pool.connect()
  .then(() => console.log('[DB] Conectado a Postgres ✅'))
  .catch(err => console.error('[DB] Error de conexión ❌', err));

/* ====== MP SDK v1.x ====== */
try {
  mercadopago.configure({ access_token: MP_TOKEN });
  console.log('[boot] Mercado Pago SDK configurado (v1.x)');
} catch (e) {
  console.error('[boot] Error configurando MP SDK:', e.message);
}

/* ====== MAIL ====== */
let transporter = null;
if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  transporter.verify()
    .then(() => console.log('[mail] Transporte SMTP listo ✅'))
    .catch(err => console.error('[mail] Error SMTP ❌', err?.message));
} else {
  console.warn('[mail] SMTP no configurado (faltan vars). Emails deshabilitados.');
}

/* ====== UTIL ====== */
const STATE_CASE = `
  CASE
    WHEN EXISTS (SELECT 1 FROM reservas r WHERE r.horario_id=h.id AND r.estado='pagado') THEN 'ocupado'
    WHEN EXISTS (SELECT 1 FROM reservas r WHERE r.horario_id=h.id AND r.estado='bloqueado') THEN 'bloqueado'
    WHEN EXISTS (
      SELECT 1 FROM reservas r
      WHERE r.horario_id=h.id
        AND r.estado='pendiente'
        AND r.reservado_hasta IS NOT NULL
        AND r.reservado_hasta > now()
    ) THEN 'pendiente'
    ELSE 'disponible'
  END
`;
const HAS_PAGADO = `EXISTS (SELECT 1 FROM reservas r WHERE r.horario_id=h.id AND r.estado='pagado') AS has_pagado`;
const HAS_BLOQ   = `EXISTS (SELECT 1 FROM reservas r WHERE r.horario_id=h.id AND r.estado='bloqueado') AS has_bloqueado`;
const HAS_PEND   = `EXISTS (SELECT 1 FROM reservas r WHERE r.horario_id=h.id AND r.estado='pendiente' AND r.reservado_hasta>now()) AS has_pendiente`;
const DAY_ORDER = `array_position(ARRAY['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo']::text[], h.dia_semana)`;

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g,c=>
    (c ^ crypto.randomBytes(1)[0] & 15 >> c / 4).toString(16));
}

// Mails de profes conocidos (fallback si la tabla profesores no tiene email)
const PROF_EMAILS = {
  'Lourdes':  'paupaulanguages2@gmail.com',
  'Santiago': 'paupaulanguages10@gmail.com',
  'Milena':   'paupaulanguages13@gmail.com',
  'Gissel':   'paupaulanguages3@gmail.com',
  'Heliana':  'paupaulanguages9@gmail.com'
};

/* ====== HEALTH ====== */
app.get('/health', (_req, res) => res.json({ ok: true }));

/* ============================================================
   CAMPUS (Supabase) — NUEVO
   Endpoints separados para no chocar con el flujo de inscripción existente
============================================================ */
const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE)
  : null;

function currentMonthYear() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

// Crear preferencia de pago mensual del campus (con cupones)
app.post('/campus/create-payment', async (req, res) => {
  try {
    if (!supabase) {
      console.error('[campus/create-payment] Supabase no configurado');
      return res.status(500).json({ error: 'supabase_not_configured' });
    }

    const { user_id, amount, coupon_code } = req.body || {};
    if (!user_id) return res.status(400).json({ error: 'user_id_requerido' });

    const fullAmount = Number(amount || MONTHLY_FEE || 50);
    if (!(fullAmount > 0)) {
      return res.status(400).json({ error: 'amount_invalido' });
    }

    let discountPercent = 0;
    let normalizedCoupon = null;

    // Buscar cupón solo si viene algo
    if (coupon_code && String(coupon_code).trim()) {
      normalizedCoupon = String(coupon_code).trim().toLowerCase();

      const { data: rows, error: cErr } = await supabase
        .from('coupons')
        .select('id, code, discount_percent, is_active, valid_from, valid_until, usage_limit, usage_count')
        .eq('code', normalizedCoupon)
        .limit(1);

      if (cErr) {
        console.error('[campus/create-payment] Error buscando cupón:', cErr);
        return res.status(500).json({ error: 'coupon_lookup_failed' });
      }

      const coupon = rows && rows[0];
      const now = new Date();

      if (!coupon || !coupon.is_active) {
        return res.status(400).json({ error: 'invalid_coupon' });
      }

      if (coupon.valid_from && new Date(coupon.valid_from) > now) {
        return res.status(400).json({ error: 'coupon_not_started' });
      }

      if (coupon.valid_until && new Date(coupon.valid_until) < now) {
        return res.status(400).json({ error: 'coupon_expired' });
      }

      if (coupon.usage_limit && coupon.usage_count >= coupon.usage_limit) {
        return res.status(400).json({ error: 'coupon_limit_reached' });
      }

      discountPercent = Number(coupon.discount_percent || 0);
      normalizedCoupon = coupon.code; // normalizado como está en la DB
    }

    // Calculamos el monto final con descuento
    let finalAmount = fullAmount;
    if (discountPercent > 0) {
      finalAmount = +(fullAmount * (1 - discountPercent / 100)).toFixed(2);
      if (finalAmount < 0.01) finalAmount = 0.01;
    }

    const pref = {
      items: [
        {
          title: `Cuota PauPau - ${currentMonthYear()}`,
          quantity: 1,
          currency_id: MP_CURRENCY,
          unit_price: finalAmount
        }
      ],
      back_urls: {
        success: FRONTEND_URL || '/',
        failure: FRONTEND_URL || '/',
        pending: FRONTEND_URL || '/'
      },
      auto_return: 'approved',
      notification_url: `${process.env.RENDER_EXTERNAL_URL || ''}/campus/webhook?secret=${WEBHOOK_SECRET}`,
      metadata: {
        user_id,
        context: 'campus',
        coupon_code: normalizedCoupon,
        discount_percent: discountPercent,
        full_amount: fullAmount,
        final_amount: finalAmount
      }
    };

    const result = await mercadopago.preferences.create(pref);
    const prefId = result.body.id;

    // Insertamos/actualizamos intento de pago del mes actual (user_id + month_year)
    const upsertData = {
      user_id,
      month_year: currentMonthYear(),
      status: 'pending',
      amount: fullAmount,
      final_amount: finalAmount,
      discount_percent: discountPercent,
      coupon_code: normalizedCoupon,
      mp_preference_id: prefId,
      context: 'campus'
    };

    const { error: upErr } = await supabase
      .from('payments')
      .upsert(upsertData, { onConflict: 'user_id,month_year' });

    if (upErr) {
      console.error('[campus/create-payment] Error upsert payments:', upErr);
      // No rompemos el pago de MP, solo avisamos
    }

    return res.json({
      init_point: result.body.init_point,
      preference_id: prefId,
      full_amount: fullAmount,
      final_amount: finalAmount,
      discount_percent: discountPercent,
      coupon_code: normalizedCoupon
    });
  } catch (err) {
    console.error('[campus/create-payment] error', err);
    return res.status(500).json({ error: 'create_preference_failed' });
  }
});

// Webhook de Mercado Pago para el campus
app.post('/campus/webhook', async (req, res) => {
  try {
    if (req.query.secret !== WEBHOOK_SECRET) return res.status(401).send('Invalid secret');
    if (!supabase) return res.sendStatus(200);

    const paymentId = req.body?.data?.id || req.body?.id;
    if (!paymentId) return res.sendStatus(200);

    const payment = await mercadopago.payment.findById(paymentId);
    const status  = payment.body.status; // approved | rejected | pending
    const meta    = payment.body.metadata || {};
    const user_id = meta.user_id;

    if (user_id) {
      await supabase
        .from('payments')
        .update({
          status,
          mp_payment_id: String(paymentId)
        })
        .eq('user_id', user_id)
        .eq('month_year', currentMonthYear());
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error('[campus/webhook] error', err);
    return res.sendStatus(500);
  }
});

/* ============================================================
   PÚBLICO (flow de inscripción existente)
============================================================ */

// Listado público (para el formulario)
app.get('/horarios', async (_req, res) => {
  try {
    const q = `
      SELECT
        h.id AS horario_id,
        p.id AS profesor_id,
        p.nombre AS profesor,
        h.dia_semana,
        to_char(h.hora,'HH24:MI') AS hora,
        ${STATE_CASE} AS estado
      FROM horarios h
      JOIN profesores p ON p.id = h.profesor_id
      ORDER BY p.nombre, ${DAY_ORDER}, h.hora
    `;
    const { rows } = await pool.query(q);
    res.json(rows);
  } catch (e) {
    console.error('[GET /horarios]', e);
    res.status(500).json({ error: 'db_error' });
  }
});

// Hold simple (una reserva) — compatibilidad
app.post('/hold', async (req, res) => {
  const { horario_id, alumno_nombre, alumno_email } = req.body || {};
  if (!horario_id) return res.status(400).json({ error: 'bad_request', message: 'horario_id requerido' });

  const name  = (alumno_nombre && String(alumno_nombre).trim()) || 'N/A';
  const email = (alumno_email  && String(alumno_email).trim())  || 'noemail@paupau.local';

  try {
    await pool.query('BEGIN');
    const canQ = `
      SELECT 1
      FROM horarios h
      WHERE h.id=$1
        AND NOT EXISTS (
          SELECT 1 FROM reservas r
          WHERE r.horario_id=h.id
            AND (
              r.estado='pagado' OR
              r.estado='bloqueado' OR
              (r.estado='pendiente' AND r.reservado_hasta IS NOT NULL AND r.reservado_hasta>now())
            )
        )
    `;
    const can = await pool.query(canQ, [horario_id]);
    if (can.rowCount === 0) {
      await pool.query('ROLLBACK');
      return res.status(409).json({ error: 'not_available' });
    }

    const insQ = `
      INSERT INTO reservas (horario_id, alumno_nombre, alumno_email, estado, reservado_hasta)
      VALUES ($1,$2,$3,'pendiente', now() + interval '10 minutes')
      RETURNING id, reservado_hasta
    `;
    const { rows } = await pool.query(insQ, [horario_id, name, email]);
    await pool.query('COMMIT');
    res.json({ id: rows[0].id, reservado_hasta: rows[0].reservado_hasta });
  } catch (e) {
    await pool.query('ROLLBACK');
    console.error('[POST /hold]', e);
    res.status(500).json({ error: 'db_error' });
  }
});

// Crear preferencia — **individual** (con reservas) o **grupal** (sin reservas)
app.post('/crear-preferencia', async (req, res) => {
  const {
    title, price, currency='ARS', back_urls = {},
    metadata = {},
    horarios_ids, // array de IDs de horarios (solo individual)
    horario_id,   // compat: un solo horario
    alumno_nombre, alumno_email,
    form // JSON plano del formulario (lo guardamos en reservas.form_json en individual)
  } = req.body || {};

  if (!title || typeof title !== 'string') return res.status(400).json({ error: 'bad_request', message: 'title requerido' });
  if (typeof price !== 'number' || !(price > 0)) return res.status(400).json({ error: 'bad_request', message: 'price debe ser número > 0' });
  if (!/^[A-Z]{3}$/.test(currency)) return res.status(400).json({ error: 'bad_request', message: 'currency inválida' });
  if (!MP_TOKEN) return res.status(500).json({ error: 'server_config', message: 'MP_ACCESS_TOKEN no configurado' });

  const modalidad = (form && String(form.modalidad || 'individual').toLowerCase()) || 'individual';

  // normalizamos lista de horarios
  let list = Array.isArray(horarios_ids) ? horarios_ids.map(Number).filter(Boolean) : [];
  if (!list.length && Number(horario_id)) list = [Number(horario_id)];

  // Para INDIVIDUAL requerimos horarios; para GRUPAL no
  if (modalidad === 'individual' && !list.length) {
    return res.status(400).json({ error: 'bad_request', message: 'horarios_ids o horario_id requerido para modalidad individual' });
  }

  const name  = (alumno_nombre && String(alumno_nombre).trim()) || 'N/A';
  const email = (alumno_email  && String(alumno_email).trim())  || 'noemail@paupau.local';

  const groupRef = uuid();
  const reservasIds = [];

  if (modalidad === 'individual') {
    try {
      await pool.query('BEGIN');

      // verificar disponibilidad de TODOS
      const canQ = `
        SELECT h.id
        FROM horarios h
        WHERE h.id = ANY($1::int[])
          AND NOT EXISTS (
            SELECT 1 FROM reservas r
            WHERE r.horario_id=h.id
              AND (
                r.estado='pagado' OR
                r.estado='bloqueado' OR
                (r.estado='pendiente' AND r.reservado_hasta IS NOT NULL AND r.reservado_hasta>now())
              )
          )
      `;
      const can = await pool.query(canQ, [list]);
      if (can.rowCount !== list.length) {
        await pool.query('ROLLBACK');
        return res.status(409).json({ error: 'not_available' });
      }

      // insertar reservas pendientes (hold 10 min)
      const insQ = `
        INSERT INTO reservas (horario_id, alumno_nombre, alumno_email, estado, reservado_hasta, group_ref, form_json)
        VALUES ($1,$2,$3,'pendiente', now() + interval '10 minutes', $4, $5::jsonb)
        RETURNING id
      `;
      for (const hid of list) {
        const r = await pool.query(insQ, [
          hid,
          name,
          email,
          groupRef,
          form ? JSON.stringify(form) : JSON.stringify({})
        ]);
        reservasIds.push(r.rows[0].id);
      }

      await pool.query('COMMIT');
    } catch (e) {
      await pool.query('ROLLBACK');
      console.error('[crear-preferencia] DB error', e);
      return res.status(500).json({ error: 'db_error' });
    }
  }
  // Si es GRUPAL no insertamos reservas (no se manejan cupos en admin)

  // Construimos metadata para MP (webhook la va a leer)
  const form_preview = form ? {
    nombre:      String(form.nombre || ''),
    dni:         String(form.dni || ''),
    nacimiento:  String(form.nacimiento || ''),
    email:       String(form.email || ''),
    whatsapp:    String(form.whatsapp || ''),
    pais:        String(form.pais || ''),
    idioma:      String(form.idioma || ''),
    nivel:       String(form.nivel || ''),
    frecuencia:  String(form.frecuencia || ''),
    profesor:    String(form.profesor || ''),
    extra_info:  String(form.extra_info || ''),
  } : null;

  try {
    const pref = {
      items: [{ title, quantity: 1, unit_price: price, currency_id: currency }],
      back_urls,
      auto_return: 'approved',
      metadata: {
        ...metadata,
        group_ref: groupRef,
        reservas_ids: reservasIds,
        alumno_nombre: name,
        alumno_email: email,
        modalidad,
        teacher: form?.profesor || metadata?.teacher || null,
        grupo_label: form?.grupo_label || metadata?.grupo_label || null,
        form_preview
      }
    };
    const mpResp = await mercadopago.preferences.create(pref);
    const data = mpResp?.body || mpResp;

    return res.json({
      id: data.id,
      init_point: data.init_point,
      sandbox_init_point: data.sandbox_init_point,
      group_ref: groupRef,
      reservas_ids: reservasIds
    });
  } catch (e) {
    console.error('[MP error]', e?.message, '\n[MP error data]', e?.response?.body);
    return res.status(502).json({ error: 'mp_failed', message: e?.message || 'unknown', details: e?.response?.body || null });
  }
});

// Webhook: EXISTENTE para inscripciones (individual/grupal)
app.post('/webhook', async (req, res) => {
  const evento = req.body;
  try {
    // intentar ubicar metadata
    let pagoId = evento?.data?.id || evento?.data?.payment?.id || null;
    let meta = evento?.data?.metadata || evento?.data?.id?.metadata || null;

    if (!meta && pagoId) {
      const pay = await mercadopago.payment.findById(pagoId).catch(() => null);
      const body = pay?.response || pay?.body || {};
      meta = body?.metadata || null;
    }

    const isPayment = (evento?.type === 'payment') || (evento?.action?.includes('payment'));
    if (!isPayment) return res.sendStatus(200);

    if (evento?.data?.status && evento.data.status !== 'approved') return res.sendStatus(200);

    const modalidad = String(meta?.modalidad || 'individual').toLowerCase();

    // ===== Modalidad GRUPAL =====
    if (modalidad === 'grupal') {
      const alumnoNombre = meta?.alumno_nombre || 'Alumno';
      const alumnoEmail  = meta?.alumno_email  || '';
      const profesorName = meta?.teacher || 'Profesor';
      const horariosTxt  = meta?.grupo_label || '';
      const profEmail    = PROF_EMAILS[profesorName] || '';
      const pv           = meta?.form_preview || {};
      const extraInfo    = (pv?.extra_info || '').trim();

      const alumnoHtml = `<!doctype html>
<html lang="es" style="margin:0;padding:0;">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width"/>
  <title>Bienvenida PauPau Languages</title>
</head>
<body style="margin:0; padding:0; background:#f6f7fb;">
  <center style="width:100%; background:#f6f7fb; padding:24px 12px;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:640px; margin:0 auto;">
      <tr><td>
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" 
               style="background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 8px 24px rgba(0,0,0,.08);">
          <tr><td style="background:#3954A5; height:6px; font-size:0; line-height:0;">&nbsp;</td></tr>
          <tr><td style="padding:28px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; color:#222;">
            <h1 style="margin:0 0 14px; font-size:22px; line-height:1.35;">¡Hola ${alumnoNombre}!</h1>
            <p style="margin:0 0 10px; font-size:15px; line-height:1.6;">¡Qué alegría que seas parte de nuestra Escuela! Estoy feliz de recibirte y darte la bienvenida.</p>
            <p style="margin:0 0 18px; font-size:15px; line-height:1.6;">En Paupau Languages, conectamos personas con el mundo y desde hoy vos también sos parte de esa comunidad.</p>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"
                   style="background:#f7f8ff; border:1px solid #e4e7ff; border-radius:12px; padding:14px; margin:6px 0 16px;">
              <tr><td style="font-size:14px; line-height:1.6; color:#1d2340;">
                <div style="margin:0 0 8px;"><strong>Modalidad:</strong> Clases grupales</div>
                <div style="margin:0 0 8px;"><strong>Tu docente:</strong> ${profesorName}</div>
                <div style="margin:0 0 8px;"><strong>Grupo:</strong> ${horariosTxt} <span style="color:#5b64a5;">(hora Argentina)</span></div>
                <div style="margin:0 0 8px;"><strong>Profesor/tutor:</strong> ${profesorName}</div>
                <div style="margin:0;"><strong>Correo del profesor:</strong> ${profEmail || '(lo recibirás pronto)'}</div>
              </td></tr>
            </table>
            <p style="margin:0 0 10px; font-size:15px; line-height:1.6;">Te pedimos puntualidad y cámara/micrófono encendidos para una mejor experiencia.</p>
            <p style="margin:0 0 18px; font-size:15px; line-height:1.6;">Más cerca de la fecha de inicio tu docente te enviará los links de acceso.</p>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"
                   style="background:#fff8ee; border:1px solid #ffe2b9; border-radius:12px; padding:14px; margin:0 0 18px;">
              <tr><td style="font-size:14px; line-height:1.6; color:#8a4a00;">
                <strong>Aranceles:</strong> Se abonan del 1 al 7 de cada mes por transferencia bancaria.
                En caso de no abonar en tiempo y forma, las clases se suspenderán.
              </td></tr>
            </table>
            <p style="margin:0 0 4px; font-size:14px; line-height:1.6; color:#4b4f66;">Si surge cualquier duda, escribinos cuando quieras.</p>
          </td></tr>
          <tr><td style="padding:18px 28px 26px; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;">
            <div style="font-size:13px; color:#707797; line-height:1.6;">
              <div style="margin:0 0 4px;"><strong style="color:#3954A5;">PauPau Languages</strong></div>
              <div>Instagram: <strong>@paupaulanguages</strong></div>
            </div>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </center>
</body>
</html>`;

      function escapeHTML(s){
        const map = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' };
        return String(s ?? '').replace(/[&<>"]/g, ch => map[ch]);
      }

      const adminHtml = `
        <h2>Nueva inscripción confirmada</h2>
        <ul>
          <li><strong>Modalidad:</strong> grupal</li>
          <li><strong>Alumno:</strong> ${escapeHTML(alumnoNombre)} (${escapeHTML(alumnoEmail)})</li>
          <li><strong>Profesor:</strong> ${escapeHTML(profesorName)} ${profEmail ? `(${escapeHTML(profEmail)})` : ''}</li>
          <li><strong>Horarios:</strong> ${escapeHTML(horariosTxt)}</li>
          <li><strong>Reservas:</strong> (no aplica en grupales)</li>
          ${meta?.id ? `<li><strong>MP Payment ID:</strong> ${escapeHTML(meta.id)}</li>` : ''}
        </ul>

        <h3>Formulario</h3>
        <ul>
          <li><strong>nombre:</strong> ${escapeHTML((meta?.form_preview?.nombre) || alumnoNombre)}</li>
          <li><strong>DNI:</strong> ${escapeHTML(meta?.form_preview?.dni || '')}</li>
          <li><strong>fecha de nacimiento:</strong> ${escapeHTML(meta?.form_preview?.nacimiento || '')}</li>
          <li><strong>mail:</strong> ${escapeHTML(meta?.form_preview?.email || alumnoEmail)}</li>
          <li><strong>whatsapp:</strong> ${escapeHTML(meta?.form_preview?.whatsapp || '')}</li>
          <li><strong>país donde vive:</strong> ${escapeHTML(meta?.form_preview?.pais || '')}</li>
          <li><strong>idioma a inscribirse:</strong> ${escapeHTML(meta?.form_preview?.idioma || '')}</li>
          <li><strong>resultado test nivelatorio:</strong> ${escapeHTML(meta?.form_preview?.nivel || '')}</li>
          <li><strong>clases por semana:</strong> ${escapeHTML(meta?.form_preview?.frecuencia || '')}</li>
          <li><strong>profesor:</strong> ${escapeHTML(meta?.form_preview?.profesor || profesorName)}</li>
          <li><strong>horarios disponibles elegidos:</strong> ${escapeHTML(horariosTxt)}</li>
          ${(meta?.form_preview?.extra_info || '').trim() ? `<li><strong>¿Algo que debamos saber para acompañarte mejor?</strong> ${escapeHTML(meta.form_preview.extra_info)}</li>` : ''}
        </ul>
      `;

      try {
        if (alumnoEmail) {
          await transporter.sendMail({
            from: FROM_EMAIL,
            to: alumnoEmail,
            subject: '¡Bienvenido/a a PauPau Languages!',
            html: alumnoHtml
          });
        }
        const toList = [ACADEMY_EMAIL].filter(Boolean);
        const ccList = profEmail ? [profEmail] : [];
        await transporter.sendMail({
          from: FROM_EMAIL,
          to: toList.join(','),
          cc: ccList.join(',') || undefined,
          subject: `Nueva inscripción confirmada (grupal): ${alumnoNombre} con ${profesorName}`,
          html: adminHtml
        });
      } catch (e) {
        console.error('[mail webhook grupal] fallo envío', e?.message);
      }

      return res.sendStatus(200);
    }

    // ===== Modalidad INDIVIDUAL =====
    const reservasIds = Array.isArray(meta?.reservas_ids) ? meta.reservas_ids.map(Number).filter(Boolean) : [];
    const groupRef    = meta?.group_ref || null;

    let targetIds = reservasIds;
    if (!targetIds.length && groupRef) {
      const r = await pool.query(`SELECT id FROM reservas WHERE group_ref = $1`, [groupRef]);
      targetIds = r.rows.map(x => x.id);
    }
    if (!targetIds.length) return res.sendStatus(200);

    // Confirmar (pagado)
    await pool.query(
      `UPDATE reservas
         SET estado='pagado', reservado_hasta=NULL
       WHERE id = ANY($1::int[])`,
      [targetIds]
    );
    console.log(`[webhook] Confirmadas reservas: ${targetIds.join(', ')}`);

    // Emails
    if (transporter) {
      const infoQ = `
        SELECT r.id AS reserva_id,
               r.alumno_nombre, r.alumno_email,
               h.id AS horario_id, h.dia_semana, to_char(h.hora,'HH24:MI') AS hora,
               p.nombre AS profesor
        FROM reservas r
        JOIN horarios h ON h.id = r.horario_id
        JOIN profesores p ON p.id = h.profesor_id
        WHERE r.id = ANY($1::int[])
        ORDER BY p.nombre, ${DAY_ORDER}, h.hora
      `;
      const { rows } = await pool.query(infoQ, [targetIds]);
      if (!rows.length) return res.sendStatus(200);

      const alumnoNombre = rows[0].alumno_nombre || 'Alumno';
      const alumnoEmail  = rows[0].alumno_email  || '';
      const profesorName = rows[0].profesor || 'Profesor';
      const horariosTxt  = rows.map(r => `${r.dia_semana} ${r.hora}`).join('; ');
      const profEmail    = PROF_EMAILS[profesorName] || '';

      const alumnoHtml = `<!doctype html>
<html lang="es" style="margin:0;padding:0;">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width"/>
  <title>Bienvenida PauPau Languages</title>
  <style>
    @media (max-width:600px){
      .container{width:100% !important; margin:0 !important; border-radius:0 !important;}
      .inner{padding:20px !important;}
    }
  </style>
</head>
<body style="margin:0; padding:0; background:#f6f7fb; -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale;">
  <center style="width:100%; background:#f6f7fb; padding:24px 12px;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:640px; margin:0 auto;" class="container">
      <tr>
        <td style="padding:0;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" 
                 style="background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 8px 24px rgba(0,0,0,.08);">
            <tr><td style="background:#3954A5; height:6px; font-size:0; line-height:0;">&nbsp;</td></tr>
            <tr>
              <td class="inner" style="padding:28px 28px 10px 28px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Helvetica Neue', Arial, sans-serif; color:#222;">
                <h1 style="margin:0 0 14px; font-size:22px; line-height:1.35;">¡Hola ${alumnoNombre}!</h1>
                <p style="margin:0 0 10px; font-size:15px; line-height:1.6; color:#2a2f45;">¡Qué alegría que seas parte de nuestra Escuela! Estoy feliz de recibirte y darte la bienvenida.</p>
                <p style="margin:0 0 18px; font-size:15px; line-height:1.6; color:#2a2f45;">En Paupau Languages, conectamos personas con el mundo y desde hoy vos también sos parte de esa comunidad.</p>
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" 
                       style="background:#f7f8ff; border:1px solid #e4e7ff; border-radius:12px; padding:14px; margin:6px 0 16px;">
                  <tr>
                    <td style="font-size:14px; line-height:1.6; color:#1d2340;">
                      <div style="margin:0 0 8px;"><strong>Tu docente:</strong> ${profesorName}</div>
                      <div style="margin:0 0 8px;"><strong>Tus horarios:</strong> ${horariosTxt} <span style="color:#5b64a5;">(hora Argentina)</span></div>
                      <div style="margin:0 0 8px;"><strong>Profesor/tutor:</strong> ${profesorName}</div>
                      <div style="margin:0;"><strong>Correo del profesor:</strong> ${profEmail || '(lo recibirás pronto)'}</div>
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 10px; font-size:15px; line-height:1.6; color:#2a2f45;">Te pedimos puntualidad y cámara/micrófono encendidos para una mejor experiencia.</p>
                <p style="margin:0 0 18px; font-size:15px; line-height:1.6; color:#2a2f45;">Más cerca de la fecha de inicio tu docente te enviará los links de acceso.</p>
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" 
                       style="background:#fff8ee; border:1px solid #ffe2b9; border-radius:12px; padding:14px; margin:0 0 18px;">
                  <tr>
                    <td style="font-size:14px; line-height:1.6; color:#8a4a00;">
                      <strong>Aranceles:</strong> Se abonan del 1 al 7 de cada mes por transferencia bancaria. 
                      En caso de no abonar en tiempo y forma, las clases se suspenderán.
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 4px; font-size:14px; line-height:1.6; color:#4b4f66;">Si surge cualquier duda, escribinos cuando quieras.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 28px 26px; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
                <div style="font-size:13px; color:#707797; line-height:1.6;">
                  <div style="margin:0 0 4px;"><strong style="color:#3954A5;">PauPau Languages</strong></div>
                  <div>Instagram: <strong>@paupaulanguages</strong></div>
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </center>
</body>
</html>`;

      /* ========== FORMULARIO PARA ACADEMIA/PROFE (incluye extra_info) ========== */
      let formJson = {};
      try {
        const f = await pool.query(`SELECT form_json FROM reservas WHERE id = $1 LIMIT 1`, [targetIds[0]]);
        formJson = f?.rows?.[0]?.form_json || {};
      } catch (_) {}

      const pick = (obj, ...keys) => keys.map(k => (obj && obj[k] != null ? String(obj[k]) : ''));
      function formatDOB(f) {
        if (f.nacimiento) return String(f.nacimiento);
        const d = f['dob-dia'] ? String(f['dob-dia']).padStart(2, '0') : '';
        const m = f['dob-mes'] ? String(f['dob-mes']).padStart(2, '0') : '';
        const y = f['dob-anio'] ? String(f['dob-anio']) : '';
        if (y) return `${d || '01'}-${m || '01'}-${y}`;
        return '';
      }
      function formatPhone(f) {
        const cand = String(f.whatsapp || f.telefono || f.phone || '').trim();
        return cand.includes('@') ? '' : cand;
      }
      function escapeHTML(s){
        const map = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' };
        return String(s ?? '').replace(/[&<>"]/g, ch => map[ch]);
      }

      const [
        nombreForm,
        dniForm,
        emailForm,
        paisForm,
        idiomaForm,
        nivelForm,
        frecForm,
        profForm
      ] = pick(formJson, 'nombre','dni','email','pais','idioma','nivel','frecuencia','profesor');

      const fechaNacForm = formatDOB(formJson);
      const whatsappForm = formatPhone(formJson);
      const extraInfo    = String(formJson.extra_info || '').trim();

      const adminHtml = `
        <h2>Nueva inscripción confirmada</h2>
        <ul>
          <li><strong>Modalidad:</strong> individual</li>
          <li><strong>Alumno:</strong> ${escapeHTML(alumnoNombre)} (${escapeHTML(alumnoEmail)})</li>
          <li><strong>Profesor:</strong> ${escapeHTML(profesorName)} ${profEmail ? `(${escapeHTML(profEmail)})` : ''}</li>
          <li><strong>Horarios:</strong> ${escapeHTML(horariosTxt)}</li>
          <li><strong>Reservas:</strong> ${targetIds.join(', ')}</li>
          ${meta?.id ? `<li><strong>MP Payment ID:</strong> ${escapeHTML(meta.id)}</li>` : ''}
        </ul>
        <h3>Formulario</h3>
        <ul>
          <li><strong>nombre:</strong> ${escapeHTML(nombreForm || alumnoNombre)}</li>
          <li><strong>DNI:</strong> ${escapeHTML(dniForm)}</li>
          <li><strong>fecha de nacimiento:</strong> ${escapeHTML(fechaNacForm)}</li>
          <li><strong>mail:</strong> ${escapeHTML(emailForm || alumnoEmail)}</li>
          <li><strong>whatsapp:</strong> ${escapeHTML(whatsappForm)}</li>
          <li><strong>país donde vive:</strong> ${escapeHTML(paisForm)}</li>
          <li><strong>idioma a inscribirse:</strong> ${escapeHTML(idiomaForm)}</li>
          <li><strong>resultado test nivelatorio:</strong> ${escapeHTML(nivelForm)}</li>
          <li><strong>clases por semana:</strong> ${escapeHTML(frecForm)}</li>
          <li><strong>profesor:</strong> ${escapeHTML(profForm || profesorName)}</li>
          <li><strong>horarios disponibles elegidos:</strong> ${escapeHTML(horariosTxt)}</li>
          ${extraInfo ? `<li><strong>¿Algo que debamos saber para acompañarte mejor?</strong> ${escapeHTML(extraInfo)}</li>` : ''}
        </ul>
      `;

      try {
        if (alumnoEmail) {
          await transporter.sendMail({
            from: FROM_EMAIL,
            to: alumnoEmail,
            subject: '¡Bienvenido/a a PauPau Languages!',
            html: alumnoHtml
          });
        }
        const toList = [ACADEMY_EMAIL].filter(Boolean);
        const ccList = profEmail ? [profEmail] : [];
        await transporter.sendMail({
          from: FROM_EMAIL,
          to: toList.join(','),
          cc: ccList.join(',') || undefined,
          subject: `Nueva inscripción confirmada: ${alumnoNombre} con ${profesorName}`,
          html: adminHtml
        });
      } catch (e) {
        console.error('[mail webhook] fallo envío', e?.message);
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error('[webhook] error', e);
    res.sendStatus(200);
  }
});

// Cron: liberar holds vencidos
setInterval(async () => {
  try {
    const r = await pool.query(
      `UPDATE reservas
         SET estado='cancelado'
       WHERE estado='pendiente'
         AND reservado_hasta IS NOT NULL
         AND reservado_hasta < now()`
    );
    if (r.rowCount > 0) console.log(`[cron] Reservas liberadas: ${r.rowCount}`);
  } catch (e) {
    console.error('[cron error]', e);
  }
}, 60 * 1000);

/* ============================================================
   ADMIN (X-Admin-Key)
============================================================ */
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// Debug email
app.post('/debug/send-test-email', requireAdmin, async (req, res) => {
  try {
    if (!transporter) return res.status(500).json({ error: 'smtp_not_configured' });
    const { alumnoEmail, profesorEmail } = req.body || {};
    await transporter.sendMail({
      from: FROM_EMAIL,
      to: alumnoEmail || ACADEMY_EMAIL,
      cc: profesorEmail || undefined,
      subject: 'Prueba de correo - PauPau Languages',
      html: '<p>Esto es un test OK 👍</p>'
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('[debug/send-test-email]', e);
    res.status(500).json({ error: 'send_fail', message: e?.message });
  }
});

// Profesores
app.get('/admin/profesores', requireAdmin, async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, nombre FROM profesores ORDER BY nombre`);
    res.json(rows);
  } catch (e) {
    console.error('[GET /admin/profesores]', e);
    res.status(500).json({ error: 'db_error' });
  }
});

app.post('/admin/profesores', requireAdmin, async (req, res) => {
  const { nombre } = req.body || {};
  if (!nombre || !String(nombre).trim()) return res.status(400).json({ error: 'bad_request', message: 'nombre requerido' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO profesores (nombre) VALUES ($1) RETURNING id, nombre`,
      [String(nombre).trim()]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error('[POST /admin/profesores]', e);
    res.status(500).json({ error: 'db_error' });
  }
});

app.delete('/admin/profesores/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad_request' });
  try {
    const used = await pool.query(`SELECT 1 FROM horarios WHERE profesor_id=$1 LIMIT 1`, [id]);
    if (used.rowCount) return res.status(409).json({ error: 'in_use', message: 'El profesor tiene horarios' });
    await pool.query(`DELETE FROM profesores WHERE id=$1`, [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[DELETE /admin/profesores/:id]', e);
    res.status(500).json({ error: 'db_error' });
  }
});

// Horarios
app.get('/admin/horarios', requireAdmin, async (req, res) => {
  const profesor_id = Number(req.query.profesor_id) || null;
  try {
    const params = [];
    let where = '';
    if (profesor_id) { where = 'WHERE h.profesor_id=$1'; params.push(profesor_id); }
    const q = `
      SELECT h.id, h.profesor_id, p.nombre AS profesor, h.dia_semana, to_char(hora,'HH24:MI') AS hora,
             ${STATE_CASE} AS estado,
             ${HAS_PAGADO}, ${HAS_BLOQ}, ${HAS_PEND}
      FROM horarios h
      JOIN profesores p ON p.id = h.profesor_id
      ${where}
      ORDER BY p.nombre, ${DAY_ORDER}, h.hora
    `;
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (e) {
    console.error('[GET /admin/horarios]', e);
    res.status(500).json({ error: 'db_error' });
  }
});

app.post('/admin/horarios', requireAdmin, async (req, res) => {
  const { profesor_id, dia_semana, hora } = req.body || {};
  if (!profesor_id || !dia_semana || !hora) {
    return res.status(400).json({ error: 'bad_request', message: 'profesor_id, dia_semana, hora requeridos' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO horarios (profesor_id, dia_semana, hora)
       VALUES ($1,$2,$3::time)
       RETURNING id, profesor_id, dia_semana, to_char(hora,'HH24:MI') AS hora`,
      [profesor_id, dia_semana, hora]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error('[POST /admin/horarios]', e);
    res.status(500).json({ error: 'db_error' });
  }
});

app.delete('/admin/horarios/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad_request' });
  try {
    const paid = await pool.query(`SELECT 1 FROM reservas WHERE horario_id=$1 AND estado='pagado' LIMIT 1`, [id]);
    if (paid.rowCount) return res.status(409).json({ error: 'paid', message: 'No puede eliminarse: ya está pagado' });
    await pool.query(`DELETE FROM horarios WHERE id=$1`, [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[DELETE /admin/horarios/:id]', e);
    res.status(500).json({ error: 'db_error' });
  }
});

// Liberar cupo manual
app.post('/admin/horarios/:id/liberar', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad_request' });
  try {
    await pool.query(
      `UPDATE reservas SET estado='cancelado'
       WHERE horario_id=$1 AND estado IN ('pendiente','bloqueado','pagado')`,
      [id]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[POST /admin/horarios/:id/liberar]', e);
    res.status(500).json({ error: 'db_error' });
  }
});

// Cambiar estado manual
app.post('/admin/horarios/:id/estado', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { estado } = req.body || {};
  if (!id || !estado) return res.status(400).json({ error: 'bad_request' });

  try {
    const paid = await pool.query(`SELECT 1 FROM reservas WHERE horario_id=$1 AND estado='pagado' LIMIT 1`, [id]);
    if (paid.rowCount && estado !== 'disponible') {
      return res.status(409).json({ error: 'paid', message: 'Cupo pagado: primero usá "Liberar cupo".' });
    }

    if (estado === 'disponible') {
      await pool.query(
        `UPDATE reservas SET estado='cancelado'
         WHERE horario_id=$1 AND estado IN ('pendiente','bloqueado','pagado')`,
        [id]
      );
      return res.json({ ok: true });
    }

    if (estado === 'pendiente') {
      await pool.query(
        `UPDATE reservas SET estado='cancelado'
         WHERE horario_id=$1 AND estado IN ('pendiente','bloqueado')`,
        [id]
      );
      await pool.query(
        `INSERT INTO reservas (horario_id, alumno_nombre, alumno_email, estado, reservado_hasta)
         VALUES ($1,'ADMIN','admin@paupau.local','pendiente', now() + interval '24 hours')`,
        [id]
      );
      return res.json({ ok: true });
    }

    if (estado === 'bloqueado') {
      await pool.query(
        `UPDATE reservas SET estado='cancelado'
         WHERE horario_id=$1 AND estado IN ('pendiente','bloqueado')`,
        [id]
      );
      await pool.query(
        `INSERT INTO reservas (horario_id, alumno_nombre, alumno_email, estado, reservado_hasta)
         VALUES ($1,'ADMIN','admin@paupau.local','bloqueado', now() + interval '100 years')`,
        [id]
      );
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'bad_request', message: 'estado inválido' });
  } catch (e) {
    console.error('[POST /admin/horarios/:id/estado]', e);
    res.status(500).json({ error: 'db_error' });
  }
});

/* ===== 404 ===== */
app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

/* ===== START ===== */
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
