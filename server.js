// server.js – Backend PauPau (Mercado Pago + Cupones + Webhooks)
// SIN multer – sin subir comprobantes por este backend
// El campus sube comprobantes directo a Supabase (no por Node)
//
// Requisitos .env:
// MP_ACCESS_TOKEN=xxxx
// SUPABASE_URL=xxxx
// SUPABASE_SERVICE_KEY=xxxx
// FRONTEND_URL=https://paupaulanguages.com

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mercadopago = require("mercadopago");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------- MERCADOPAGO ----------------
mercadopago.configure({
  access_token: process.env.MP_ACCESS_TOKEN,
});

// ---------------- SUPABASE ----------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ---------------- EXPRESS / CORS ----------------
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
      console.log("Bloqueado por CORS:", origin);
      return callback(null, false);
    },
  })
);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// Helper
const monthStr = () => new Date().toISOString().slice(0, 7);

// ===============================
//     RUTA PRINCIPAL
// ===============================
app.get("/", (req, res) => {
  res.json({ ok: true, msg: "Backend PauPau funcionando" });
});

// ===============================
//    CUPONES – /coupon/apply
// ===============================
app.post("/coupon/apply", async (req, res) => {
  try {
    const { user_id, month, code } = req.body;

    if (!user_id || !code) {
      return res.json({ ok: false, msg: "Faltan datos para aplicar cupón." });
    }

    // Buscar cupón
    const { data: coupons } = await supabase
      .from("coupons")
      .select("*")
      .eq("code", code.toLowerCase())
      .eq("active", true)
      .limit(1);

    if (!coupons || coupons.length === 0) {
      return res.json({ ok: false, msg: "Cupón inválido o inactivo." });
    }

    const coupon = coupons[0];
    const discountPercent = Number(coupon.discount_percent || 0);

    // Registrar uso
    await supabase.from("coupon_uses").insert({
      coupon_id: coupon.id,
      user_id,
      month_year: month || monthStr(),
      discount_percent: discountPercent,
    });

    return res.json({
      ok: true,
      msg: "Cupón aplicado correctamente",
      discount_percent: discountPercent,
    });
  } catch (err) {
    console.error("Error cupón:", err);
    return res.json({ ok: false, msg: "Error aplicando cupón" });
  }
});

// ===============================
//  CREAR PREFERENCIA MP
// ===============================
app.post("/crear-preferencia", async (req, res) => {
  try {
    const { title, price, currency, back_urls, metadata = {} } = req.body;

    if (!title || !price) {
      return res.status(400).json({
        error: "bad_request",
        message: "title y price requeridos",
      });
    }

    // NO exigimos horario_id ni horarios_ids
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
          success: process.env.FRONTEND_URL,
          failure: process.env.FRONTEND_URL,
          pending: process.env.FRONTEND_URL,
        },
      auto_return: "approved",
      metadata: finalMetadata,
    };

    const mpResp = await mercadopago.preferences.create(preference);

    return res.json({
      ok: true,
      init_point: mpResp.body.init_point,
      id: mpResp.body.id,
    });
  } catch (err) {
    console.error("Error crear-preferencia:", err);
    return res.status(500).json({
      error: "server_error",
      message: "Error al crear preferencia",
    });
  }
});

// ===============================
//  WEBHOOK MP
// ===============================
app.post("/webhook/mp", async (req, res) => {
  try {
    const body = req.body || {};
    const topic = body.type || body.topic;
    const paymentId = body.data?.id;

    if (!paymentId) return res.status(200).send("ok");

    if (topic === "payment") {
      const payment = await mercadopago.payment.findById(paymentId);
      const p = payment.body;

      const status = p.status;
      const metadata = p.metadata || {};
      const userId = metadata.user_id;
      const month = metadata.month;

      if (userId) {
        await supabase.from("payments").insert({
          user_id: userId,
          month_year: month || monthStr(),
          status,
          mp_payment_id: p.id,
          amount: p.transaction_amount,
        });
      }
    }

    return res.status(200).send("ok");
  } catch (err) {
    console.error("Error webhook:", err);
    return res.status(200).send("ok");
  }
});

// ===============================
//  START SERVER
// ===============================
app.listen(PORT, () => {
  console.log("🚀 Backend PauPau en puerto " + PORT);
});
