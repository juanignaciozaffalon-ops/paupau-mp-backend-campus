// server.js – Backend central PauPau (Mercado Pago + Campus)
// Requisitos de env (.env):
// MP_ACCESS_TOKEN=xxxxxxxx
// SUPABASE_URL=https://xxxx.supabase.co
// SUPABASE_SERVICE_KEY=xxxxxxxx (service_role)
// FRONTEND_URL=https://paupaulanguages.com

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mercadopago = require("mercadopago");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------- MERCADO PAGO ----------------
mercadopago.configure({
  access_token: process.env.MP_ACCESS_TOKEN,
});

// ---------------- SUPABASE ----------------
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn(
    "⚠️ SUPABASE_URL o SUPABASE_SERVICE_KEY no configurados. Algunas funciones no van a andar."
  );
}

const supabase = createClient(supabaseUrl, supabaseKey);

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
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      console.warn("CORS bloqueado para origen:", origin);
      return callback(null, false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    credentials: true,
  })
);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// Para subir comprobantes (memoria, después se manda a Supabase Storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

// ---------------- HELPERS ----------------
function monthStr() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

// Misma lógica que en el front para la cuota
function computeMonthlyFeeFromProfile(profile) {
  if (!profile || profile.role !== "student") return 0;

  if (profile.class_modality === "group") {
    return 75000;
  }

  if (profile.class_modality === "individual") {
    const freq = Number(profile.individual_frequency || 1);
    if (freq === 1) return 65000;
    if (freq === 2) return 95000;
    if (freq === 3) return 130000;
  }

  return 0;
}

// ---------------- RUTA RAÍZ ----------------
app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "Backend PauPau MP funcionando",
  });
});

// ---------------------------------------------------------
//  CUPÓN: /coupon/apply
//  Body: { user_id, month, code }
//  Respuesta mínima: { ok, msg, discount_percent? , final_amount? }
// ---------------------------------------------------------
app.post("/coupon/apply", async (req, res) => {
  try {
    const { user_id, month, code } = req.body || {};

    if (!user_id || !code) {
      return res.status(400).json({
        ok: false,
        msg: "user_id y code son requeridos",
      });
    }

    if (!supabase) {
      return res.json({
        ok: true,
        msg: "Cupón aplicado (modo simple, sin Supabase).",
      });
    }

    // 1) Buscar cupón
    const { data: coupons, error: couponErr } = await supabase
      .from("coupons")
      .select("*")
      .eq("code", code.toLowerCase())
      .eq("active", true)
      .limit(1);

    if (couponErr) {
      console.error("Error leyendo cupón:", couponErr);
      return res.status(500).json({
        ok: false,
        msg: "Error al validar el cupón.",
      });
    }

    const coupon = coupons && coupons[0];

    if (!coupon) {
      return res.json({
        ok: false,
        msg: "Cupón inválido o inactivo.",
      });
    }

    const discountPercent = Number(coupon.discount_percent || 0);

    // 2) Buscar perfil del alumno para calcular el monto base
    const { data: profiles, error: profileErr } = await supabase
      .from("profiles")
      .select(
        "id, role, class_modality, individual_frequency, first_name, last_name, email"
      )
      .eq("id", user_id)
      .limit(1);

    if (profileErr) {
      console.error("Error leyendo perfil para cupón:", profileErr);
      return res.status(500).json({
        ok: false,
        msg: "Error al validar el cupón.",
      });
    }

    const profile = profiles && profiles[0];

    if (!profile) {
      return res.json({
        ok: false,
        msg: "No se encontró el alumno para aplicar el cupón.",
      });
    }

    const baseAmount = computeMonthlyFeeFromProfile(profile);
    if (!baseAmount) {
      return res.json({
        ok: false,
        msg: "No hay cuota configurada para este alumno.",
      });
    }

    const finalAmount = Math.max(
      0,
      Math.round(baseAmount * (1 - discountPercent / 100))
    );

    // 3) (Opcional) registrar uso del cupón
    await supabase.from("coupon_uses").insert({
      coupon_id: coupon.id,
      user_id,
      month_year: month || monthStr(),
      base_amount: baseAmount,
      final_amount: finalAmount,
      discount_percent: discountPercent,
    });

    return res.json({
      ok: true,
      msg: "Cupón aplicado correctamente.",
      code: coupon.code,
      discount_percent: discountPercent,
      final_amount: finalAmount,
    });
  } catch (err) {
    console.error("Error en /coupon/apply:", err);
    return res.status(500).json({
      ok: false,
      msg: "Error interno al aplicar el cupón.",
    });
  }
});

// ---------------------------------------------------------
//  CREAR PREFERENCIA MP: /crear-preferencia
//  Body: { title, price, currency, back_urls, metadata, horario_id?, horarios_ids? }
//  IMPORTANTE: YA NO OBLIGA horario_id / horarios_ids
// ---------------------------------------------------------
app.post("/crear-preferencia", async (req, res) => {
  try {
    const {
      title,
      price,
      currency,
      back_urls,
      metadata = {},
      horario_id,
      horarios_ids,
    } = req.body || {};

    if (!title || !price || !currency) {
      return res.status(400).json({
        error: "bad_request",
        message: "title, price y currency son requeridos",
      });
    }

    // Dejamos los horarios como OPCIONALES
    const finalMetadata = {
      ...metadata,
      horario_id: horario_id ?? metadata.horario_id ?? null,
      horarios_ids: horarios_ids ?? metadata.horarios_ids ?? null,
    };

    const preference = {
      items: [
        {
          title: String(title),
          quantity: 1,
          unit_price: Number(price),
          currency_id: String(currency).toUpperCase(),
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
      message: "Error al crear la preferencia de pago",
    });
  }
});

// ---------------------------------------------------------
//  WEBHOOK MP: /webhook/mp
//  Configurá esta URL en Mercado Pago.
//  Marca payments en Supabase según metadata.user_id y metadata.month
// ---------------------------------------------------------
app.post("/webhook/mp", async (req, res) => {
  try {
    const body = req.body || {};
    console.log("Webhook MP recibido:", JSON.stringify(body));

    // Hay varios formatos posibles; este es el más común con v1
    const topic = body.type || body.topic || body.action;
    const dataId =
      body.data && (body.data.id || body.data.resource) ? body.data.id : null;

    if (!topic || !dataId) {
      // Igual devolvemos 200 para que MP no siga pegando
      return res.status(200).send("ok");
    }

    if (!supabase) {
      console.warn("Webhook MP sin Supabase configurado.");
      return res.status(200).send("ok");
    }

    if (topic === "payment" || topic === "payment.created") {
      // Traemos info completa del pago
      const payment = await mercadopago.payment.findById(dataId);
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

// ---------------------------------------------------------
//  SUBIR COMPROBANTE DE PAGO: /payments/upload-receipt
//  Body (multipart/form-data): user_id, month, file
// ---------------------------------------------------------
app.post(
  "/payments/upload-receipt",
  upload.single("file"),
  async (req, res) => {
    try {
      const { user_id, month } = req.body || {};
      const file = req.file;

      if (!user_id || !file) {
        return res.status(400).json({
          ok: false,
          msg: "user_id y archivo son requeridos",
        });
      }

      if (!supabase) {
        return res.json({
          ok: true,
          msg: "Comprobante recibido (modo simple, sin guardar en Supabase).",
        });
      }

      const bucket = "payment_receipts";
      const fileExt =
        file.originalname && file.originalname.includes(".")
          ? file.originalname.split(".").pop()
          : "bin";
      const fileName = `user_${user_id}/${(month || monthStr())}_${Date.now()}.${
        fileExt || "bin"
      }`;

      // Subir a Supabase Storage
      const { error: uploadErr } = await supabase.storage
        .from(bucket)
        .upload(fileName, file.buffer, {
          upsert: false,
          contentType: file.mimetype || "application/octet-stream",
        });

      if (uploadErr) {
        console.error("Error subiendo comprobante a Storage:", uploadErr);
        return res.status(500).json({
          ok: false,
          msg: "No se pudo guardar el comprobante.",
        });
      }

      const { data: pub } = supabase.storage
        .from(bucket)
        .getPublicUrl(fileName);

      const publicUrl = pub && pub.publicUrl ? pub.publicUrl : null;

      // Guardar registro en tabla payment_receipts (opcional)
      await supabase.from("payment_receipts").insert({
        user_id,
        month_year: month || monthStr(),
        file_path: fileName,
        public_url: publicUrl,
      });

      return res.json({
        ok: true,
        msg: "Comprobante subido correctamente.",
        url: publicUrl,
      });
    } catch (err) {
      console.error("Error en /payments/upload-receipt:", err);
      return res.status(500).json({
        ok: false,
        msg: "Error al subir el comprobante.",
      });
    }
  }
);

// ---------------------------------------------------------
//  START
// ---------------------------------------------------------
app.listen(PORT, () => {
  console.log(`🚀 Backend PauPau escuchando en puerto ${PORT}`);
});
