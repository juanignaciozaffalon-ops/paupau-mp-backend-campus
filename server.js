// server.js – Backend PauPau (Mercado Pago + Cupones + Webhooks)
// SIN multer – este backend no maneja uploads de archivos.
//
// Variables recomendadas en Render:
// MP_ACCESS_TOKEN=xxxxx
// SUPABASE_URL=https://...supabase.co
// SUPABASE_SERVICE_KEY=clave_service_role  (o SUPABASE_KEY=...)
// FRONTEND_URL=https://paupaulanguages.com

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mercadopago = require("mercadopago");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

/* ============================
   MERCADO PAGO
============================ */
mercadopago.configure({
  access_token: process.env.MP_ACCESS_TOKEN,
});

/* ============================
   SUPABASE (con fallback)
============================ */
const supabaseUrl = process.env.SUPABASE_URL || null;
// Usamos SERVICE_KEY si existe, si no SUPABASE_KEY (como lo tenías antes)
const supabaseKey =
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || null;

let supabase = null;

if (!supabaseUrl || !supabaseKey) {
  console.warn(
    "⚠️ Supabase no está completamente configurado (SUPABASE_URL o KEY faltante). " +
      "Las rutas que usan Supabase (cupones/webhook) funcionarán en modo limitado."
  );
} else {
  supabase = createClient(supabaseUrl, supabaseKey);
}

/* ============================
   EXPRESS + CORS
============================ */
const allowedOrigins = [
  "https://paupaulanguages.com",
  "https://www.paupaulanguages.com",
  "https://paupaulanguages.odoo.com",
  "http://localhost:3000",
  "http://localhost:5173",
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      console.log("CORS bloqueado para origen:", origin);
      return callback(null, false);
    },
  })
);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const monthStr = () => new Date().toISOString().slice(0, 7);

/* ============================
   RUTA PRINCIPAL
============================ */
app.get("/", (req, res) => {
  res.json({ ok: true, msg: "Backend PauPau funcionando" });
});

/* ============================
   CUPONES – /coupon/apply
============================ */
app.post("/coupon/apply", async (req, res) => {
  try {
    const { user_id, month, code } = req.body || {};

    if (!user_id || !code) {
      return res.json({
        ok: false,
        msg: "Faltan datos para aplicar cupón.",
      });
    }

    // Si no hay Supabase configurado, respondemos sin romper nada
    if (!supabase) {
      console.warn("⚠️ /coupon/apply llamado sin Supabase configurado.");
      return res.json({
        ok: false,
        msg: "El sistema de cupones no está disponible en este momento.",
      });
    }

    // Buscar cupón activo
    const { data: coupons, error: couponErr } = await supabase
      .from("coupons")
      .select("*")
      .eq("code", String(code).toLowerCase())
      .eq("active", true)
      .limit(1);

    if (couponErr) {
      console.error("Error leyendo cupón:", couponErr);
      return res.json({
        ok: false,
        msg: "Error al validar el cupón.",
      });
    }

    if (!coupons || coupons.length === 0) {
      return res.json({
        ok: false,
        msg: "Cupón inválido o inactivo.",
      });
    }

    const coupon = coupons[0];
    const discountPercent = Number(coupon.discount_percent || 0);

    // Registrar uso del cupón (no es obligatorio para que funcione)
    await supabase.from("coupon_uses").insert({
      coupon_id: coupon.id,
      user_id,
      month_year: month || monthStr(),
      discount_percent: discountPercent,
    });

    return res.json({
      ok: true,
      msg: "Cupón aplicado correctamente.",
      discount_percent: discountPercent,
    });
  } catch (err) {
    console.error("Error en /coupon/apply:", err);
    return res.json({
      ok: false,
      msg: "Error interno al aplicar el cupón.",
    });
  }
});

/* ============================
   CREAR PREFERENCIA MP
   /crear-preferencia
============================ */
app.post("/crear-preferencia", async (req, res) => {
  try {
    const { title, price, currency, back_urls, metadata = {} } = req.body || {};

    if (!title || !price) {
      return res.status(400).json({
        error: "bad_request",
        message: "title y price son requeridos",
      });
    }

    // NO exigimos horario_id / horarios_ids; si vienen, se pasan en metadata.
    const finalMetadata = {
      ...metadata,
    };

    const preference = {
      items: [
        {
          title: String(title),
          quantity: 1,
          unit_price: Number(price),
          currency_id: currency || "ARS",
        },
      ],
      back_urls:
        back_urls || {
          success: process.env.FRONTEND_URL || "https://paupaulanguages.com",
          failure: process.env.FRONTEND_URL || "https://paupaulanguages.com",
          pending: process.env.FRONTEND_URL || "https://paupaulanguages.com",
        },
      auto_return: "approved",
      metadata: finalMetadata,
    };

    const mpResp = await mercadopago.preferences.create(preference);

    return res.json({
      ok: true,
      id: mpResp.body.id,
      init_point: mpResp.body.init_point,
      sandbox_init_point: mpResp.body.sandbox_init_point,
    });
  } catch (err) {
    console.error("Error en /crear-preferencia:", err);
    return res.status(500).json({
      error: "server_error",
      message: "Error al crear la preferencia",
    });
  }
});

/* ============================
   WEBHOOK MP
   /webhook/mp
============================ */
app.post("/webhook/mp", async (req, res) => {
  try {
    const body = req.body || {};
    console.log("Webhook MP:", JSON.stringify(body));

    // Si no hay Supabase, solo logueamos y devolvemos 200 para que MP no insista
    if (!supabase) {
      console.warn("⚠️ Webhook MP recibido, pero Supabase no está configurado.");
      return res.status(200).send("ok");
    }

    const topic = body.type || body.topic;
    const paymentId = body.data && body.data.id ? body.data.id : null;

    if (!paymentId) {
      return res.status(200).send("ok");
    }

    if (topic === "payment") {
      const payment = await mercadopago.payment.findById(paymentId);
      const p = payment.body || {};

      const status = p.status || "pending";
      const metadata = p.metadata || {};
      const userId = metadata.user_id;
      const month = metadata.month || monthStr();
      const amount = Number(p.transaction_amount || 0);

      if (userId) {
        await supabase.from("payments").insert({
          user_id: userId,
          month_year: month,
          status,
          amount,
          mp_payment_id: p.id,
          mp_status_detail: p.status_detail || null,
        });
      }
    }

    return res.status(200).send("ok");
  } catch (err) {
    console.error("Error en webhook MP:", err);
    return res.status(200).send("ok"); // siempre 200 para MP
  }
});

/* ============================
   START
============================ */
app.listen(PORT, () => {
  console.log(`🚀 Backend PauPau escuchando en puerto ${PORT}`);
});
