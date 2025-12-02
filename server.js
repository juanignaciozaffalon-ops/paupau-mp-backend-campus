/* ============================================
   SERVER.JS FINAL — PAUPAU CAMPUS + INSCRIPCIONES
   - Cupón + MP genérico
   - Campus (Supabase: pagos, comprobantes, facturas, chat, mails)
   - Inscripciones web (Postgres: horarios, reservas, webhook MP)
   ============================================ */

import express from "express";
import multer from "multer";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import mercadopago from "mercadopago";
import nodemailer from "nodemailer";
import { Pool } from "pg";
import crypto from "crypto";

dotenv.config();
const app = express();
app.use(express.json());

// ============================
// CORS
// ============================
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true); // Postman / mismo servidor
      try {
        const allowed = (process.env.ALLOWED_ORIGIN || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (allowed.includes(origin)) {
          return callback(null, true);
        }
        return callback(new Error("CORS error: origin not allowed"));
      } catch (e) {
        console.error("CORS parse error:", e);
        return callback(new Error("CORS error: bad config"));
      }
    },
  })
);

// ============================
// ENV & SUPABASE
// ============================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const PORT = process.env.PORT || 3000;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error(
    "❌ Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE en variables de entorno"
  );
  process.exit(1);
}

if (!MP_ACCESS_TOKEN) {
  console.warn("⚠️ No hay MP_ACCESS_TOKEN; las rutas de MP no funcionarán.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

// ============================
// POSTGRES (inscripciones web)
// ============================
const DATABASE_URL = process.env.DATABASE_URL;
let pool = null;

if (!DATABASE_URL) {
  console.warn(
    "⚠️ No se definió DATABASE_URL. Las rutas de inscripciones (horarios/reservas) no funcionarán."
  );
} else {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  pool
    .connect()
    .then(() => console.log("[DB] Conectado a Postgres ✅"))
    .catch((err) => console.error("[DB] Error de conexión ❌", err));
}

// ============================
// MERCADO PAGO CONFIG
// ============================
mercadopago.configure({
  access_token: MP_ACCESS_TOKEN,
});

// ============================
// MULTER (para comprobantes / facturas)
// ============================
const storage = multer.memoryStorage();
const upload = multer({ storage });

// ============================
// NODEMAILER (SMTP)
// ============================
const SMTP_FROM = process.env.SMTP_FROM || process.env.SMTP_USER;
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST, // ej: smtp.gmail.com
  port: Number(process.env.SMTP_PORT || 587),
  secure: false, // 587 = STARTTLS
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: {
    rejectUnauthorized: false,
  },
});

const FROM_EMAIL = SMTP_FROM;
const ACADEMY_EMAIL = process.env.ACADEMY_EMAIL || FROM_EMAIL;

// ============================
// HELPER EMAIL NOTIFICACIONES (texto simple)
// ============================
async function sendNotificationEmail(to, subject, text) {
  if (!to) return;
  try {
    await transporter.sendMail({
      from: FROM_EMAIL,
      to,
      subject,
      text,
    });
  } catch (err) {
    console.error("Error enviando mail de notificación:", err);
  }
}

// ============================
// HEALTHCHECK
// ============================
app.get("/health", (req, res) => {
  res.json({ ok: true, message: "PauPau backend OK" });
});

// =====================================================
// ================== CUPÓN / MP GENÉRICO ===============
// =====================================================

// CUPÓN — VERIFICAR
// Body: { code: "nachoprueba" }
app.post("/coupon/apply", async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) {
      return res.status(400).json({ ok: false, msg: "Falta código de cupón" });
    }

    const now = new Date().toISOString();

    const { data, error } = await supabase
      .from("coupons")
      .select("*")
      .eq("code", code)
      .eq("active", true)
      .lte("valid_from", now)
      .gte("valid_to", now)
      .limit(1)
      .single();

    if (error) {
      console.error("Error buscando cupón:", error);
      return res
        .status(500)
        .json({ ok: false, msg: "Error interno al buscar cupón" });
    }

    if (!data) {
      return res.json({ ok: false, msg: "Cupón no válido o inactivo" });
    }

    return res.json({
      ok: true,
      discount_percent: data.discount_percent || 0,
      coupon: data,
    });
  } catch (err) {
    console.error("Error /coupon/apply:", err);
    return res.status(500).json({ ok: false, msg: "Error interno" });
  }
});

// MP – CREAR PREFERENCIA GENÉRICA (NO INSCRIPCIONES)
const createGenericPreferenceHandler = async (req, res) => {
  try {
    const {
      title,
      quantity,
      unit_price,
      back_url_success,
      back_url_failure,
      coupon_code,
    } = req.body || {};

    if (!title || !quantity || !unit_price) {
      return res
        .status(400)
        .json({ ok: false, msg: "Faltan campos en la preferencia" });
    }

    let finalAmount = unit_price * quantity;
    let discountPercent = 0;
    let couponData = null;

    if (coupon_code) {
      const now = new Date().toISOString();
      const { data: coupon, error: couponErr } = await supabase
        .from("coupons")
        .select("*")
        .eq("code", coupon_code)
        .eq("active", true)
        .lte("valid_from", now)
        .gte("valid_to", now)
        .limit(1)
        .single();

      if (couponErr) {
        console.error("Error consultando cupón para preferencia:", couponErr);
      } else if (coupon) {
        discountPercent = coupon.discount_percent || 0;
        couponData = coupon;
        finalAmount = finalAmount * (1 - discountPercent / 100);
      }
    }

    const preference = {
      items: [
        {
          title,
          quantity,
          unit_price: Number(finalAmount.toFixed(2)),
          currency_id: "ARS",
        },
      ],
      back_urls: {
        success: back_url_success || "https://paupaulanguages.com",
        failure: back_url_failure || "https://paupaulanguages.com",
      },
      auto_return: "approved",
    };

    const result = await mercadopago.preferences.create(preference);

    return res.json({
      ok: true,
      id: result.body.id,
      init_point: result.body.init_point,
      sandbox_init_point: result.body.sandbox_init_point,
      final_amount: finalAmount,
      discount_percent: discountPercent,
      coupon: couponData,
    });
  } catch (err) {
    console.error("Error creando preferencia MP genérica:", err);
    return res.status(500).json({ ok: false, msg: "Error interno" });
  }
};

// Rutas genéricas (por compatibilidad con otras páginas)
app.post("/mp/create-preference", createGenericPreferenceHandler);

// =====================================================
// ========== PAGOS CAMPUS (COMPROBANTES / ADMIN) =======
// =====================================================

// SUBIR COMPROBANTE + registrar en payments
// Body (form-data): file, user_id, month: "YYYY-MM"
app.post(
  "/payments/upload-receipt",
  upload.single("file"),
  async (req, res) => {
    try {
      const { user_id, month } = req.body || {};
      const file = req.file;

      if (!user_id || !month) {
        return res.json({
          ok: false,
          msg: "Faltan user_id o month en el formulario.",
        });
      }

      if (!file) {
        return res.json({
          ok: false,
          msg: "No se recibió archivo para el comprobante.",
        });
      }

      const fileExt = file.originalname.split(".").pop();
      const fileName = `${user_id}/${month}-${Date.now()}.${fileExt}`;
      const bucket = "payment_receipts";

      const { error: uploadError } = await supabase.storage
        .from(bucket)
        .upload(fileName, file.buffer, {
          contentType: file.mimetype,
          upsert: true,
        });

      if (uploadError) {
        console.error("Error subiendo archivo Storage:", uploadError);
        return res.json({
          ok: false,
          msg: "No se pudo subir el archivo de comprobante.",
        });
      }

      const { data: publicData } = supabase.storage
        .from(bucket)
        .getPublicUrl(fileName);

      const publicUrl = publicData?.publicUrl || null;
      const monthYear = month;

      const { error: payErr } = await supabase.from("payments").upsert(
        {
          user_id,
          month_year: monthYear,
          status: "receipt_uploaded",
          receipt_url: publicUrl,
          amount: 0,
          receipt_uploaded_at: new Date().toISOString(),
          source: "receipt_upload",
        },
        {
          onConflict: "user_id,month_year",
        }
      );

      if (payErr) {
        console.error("Error guardando pago:", payErr);
        return res.json({
          ok: false,
          msg: "Recibo subido pero no se pudo registrar el pago en la tabla.",
        });
      }

      return res.json({ ok: true, url: publicUrl });
    } catch (err) {
      console.error("Error /payments/upload-receipt:", err);
      return res.json({ ok: false, msg: "Error interno" });
    }
  }
);

// ADMIN — pagos por usuario
// GET /admin/payments/user?user_id=...&month=YYYY-MM
app.get("/admin/payments/user", async (req, res) => {
  try {
    const { user_id, month } = req.query || {};
    if (!user_id) {
      return res.json({ ok: false, msg: "Falta user_id" });
    }

    let query = supabase.from("payments").select("*").eq("user_id", user_id);

    if (month) {
      query = query.eq("month_year", month);
    }

    const { data, error } = await query.order("month_year", {
      ascending: false,
    });

    if (error) {
      console.error("Error admin/payments/user:", error);
      return res.json({ ok: false, msg: "Error consultando pagos" });
    }

    return res.json({ ok: true, payments: data || [] });
  } catch (err) {
    console.error("Error general /admin/payments/user:", err);
    return res.json({ ok: false, msg: "Error interno" });
  }
});

// ADMIN — resumen pagos por mes
// GET /admin/payments/summary?month=YYYY-MM
app.get("/admin/payments/summary", async (req, res) => {
  try {
    const { month } = req.query || {};
    const monthYear = month || new Date().toISOString().slice(0, 7);

    const { data, error } = await supabase
      .from("payments")
      .select("*")
      .eq("month_year", monthYear)
      .order("updated_at", { ascending: false });

    if (error) {
      console.error("Error admin/payments/summary:", error);
      return res.json({ ok: false, msg: "Error consultando resumen" });
    }

    return res.json({ ok: true, payments: data || [] });
  } catch (err) {
    console.error("Error general /admin/payments/summary:", err);
    return res.json({ ok: false, msg: "Error interno" });
  }
});

// ADMIN — set manual estado de pago
app.post("/admin/payment/set", async (req, res) => {
  try {
    const { user_id, status, month } = req.body || {};

    if (!user_id || !status) {
      return res.json({ ok: false, msg: "Faltan user_id o status." });
    }

    const monthYear = month || new Date().toISOString().slice(0, 7);

    const { data: existing, error: fetchError } = await supabase
      .from("payments")
      .select("amount")
      .eq("user_id", user_id)
      .eq("month_year", monthYear)
      .maybeSingle();

    if (fetchError) {
      console.error("Error buscando pago existente:", fetchError);
      return res.json({ ok: false, msg: "Error buscando pago existente." });
    }

    const amount = existing?.amount ?? 0;

    const { error } = await supabase
      .from("payments")
      .upsert(
        {
          user_id,
          month_year: monthYear,
          status,
          amount,
        },
        {
          onConflict: "user_id,month_year",
        }
      );

    if (error) {
      console.error("Error admin/payment/set:", error);
      return res.json({ ok: false, msg: "Error actualizando estado de pago." });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("Exception en /admin/payment/set:", err);
    return res.json({ ok: false, msg: "Error inesperado." });
  }
});
// =====================================================
// ADMIN — USERS / TEACHERS (campus)
// =====================================================

app.get("/admin/users", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select(
        "id, email, first_name, last_name, role, teacher_id, zoom_link, class_modality, individual_frequency"
      );

    if (error) {
      console.error("Error /admin/users:", error);
      return res.json({ ok: false, msg: "Error cargando usuarios" });
    }

    return res.json({ ok: true, users: data || [] });
  } catch (err) {
    console.error("Error general /admin/users:", err);
    return res.json({ ok: false, msg: "Error interno" });
  }
});

app.get("/admin/teachers", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, email, first_name, last_name, role")
      .eq("role", "teacher");

    if (error) {
      console.error("Error /admin/teachers:", error);
      return res.json({ ok: false, msg: "Error cargando profesores" });
    }

    return res.json({ ok: true, teachers: data || [] });
  } catch (err) {
    console.error("Error general /admin/teachers:", err);
    return res.json({ ok: false, msg: "Error interno" });
  }
});

// =====================================================
// FACTURAS — subida por admin + consultas
// =====================================================

const INVOICES_BUCKET = "invoices";

// POST /admin/invoices/upload (form-data: file, user_id, month, amount?)
app.post(
  "/admin/invoices/upload",
  upload.single("file"),
  async (req, res) => {
    try {
      const { user_id, month, amount } = req.body || {};
      const file = req.file;

      if (!user_id || !month) {
        return res.json({
          ok: false,
          msg: "Faltan user_id o month en el formulario.",
        });
      }

      if (!file) {
        return res.json({ ok: false, msg: "No se recibió archivo de factura." });
      }

      const fileExt = file.originalname.split(".").pop();
      const fileName = `${user_id}/${month}-invoice-${Date.now()}.${fileExt}`;

      const { error: uploadError } = await supabase.storage
        .from(INVOICES_BUCKET)
        .upload(fileName, file.buffer, {
          contentType: file.mimetype,
          upsert: true,
        });

      if (uploadError) {
        console.error("Error subiendo factura Storage:", uploadError);
        return res.json({
          ok: false,
          msg: "No se pudo subir el archivo de factura.",
        });
      }

      const { data: publicData } = supabase.storage
        .from(INVOICES_BUCKET)
        .getPublicUrl(fileName);

      const publicUrl = publicData?.publicUrl || null;
      const monthYear = month;
      const amountNumber =
        amount != null && amount !== "" ? Number(amount) : null;

      const { error: invErr } = await supabase
        .from("invoices")
        .upsert(
          {
            user_id,
            month_year: monthYear,
            amount: amountNumber,
            file_url: publicUrl,
            created_at: new Date().toISOString(),
          },
          {
            onConflict: "user_id,month_year",
          }
        );

      if (invErr) {
        console.error("Error guardando factura en tabla invoices:", invErr);
        return res.json({
          ok: false,
          msg: "Factura subida pero no se pudo guardar el registro.",
        });
      }

      // Notificar alumno
      try {
        const { data: student, error: stErr } = await supabase
          .from("profiles")
          .select("email, first_name, last_name")
          .eq("id", user_id)
          .maybeSingle();

        if (!stErr && student && student.email) {
          const subject = "Nueva factura disponible en el Campus PauPau";
          const text = `Hola ${student.first_name || ""} 👋

Se cargó una nueva factura de tu curso en el Campus PauPau.

Mes: ${monthYear}
${amountNumber != null ? `Importe: $${amountNumber}\n` : ""}

Podés verla y descargarla entrando a la sección de Pagos en el campus.

— Equipo PauPau`;

          await sendNotificationEmail(student.email, subject, text);
        }
      } catch (mailErr) {
        console.error("Error enviando mail de factura:", mailErr);
      }

      return res.json({ ok: true, url: publicUrl });
    } catch (err) {
      console.error("Error /admin/invoices/upload:", err);
      return res.json({ ok: false, msg: "Error interno" });
    }
  }
);

// GET /invoices/user?user_id=...&month=YYYY-MM
app.get("/invoices/user", async (req, res) => {
  try {
    const { user_id, month } = req.query || {};
    if (!user_id) {
      return res.json({ ok: false, msg: "Falta user_id" });
    }

    let query = supabase.from("invoices").select("*").eq("user_id", user_id);

    if (month) {
      query = query.eq("month_year", month);
    }

    const { data, error } = await query.order("created_at", {
      ascending: false,
    });

    if (error) {
      console.error("Error /invoices/user:", error);
      return res.json({
        ok: false,
        msg: "Error consultando facturas del usuario",
      });
    }

    return res.json({ ok: true, invoices: data || [] });
  } catch (err) {
    console.error("Error general /invoices/user:", err);
    return res.json({ ok: false, msg: "Error interno" });
  }
});

// GET /admin/invoices/summary?month=YYYY-MM
app.get("/admin/invoices/summary", async (req, res) => {
  try {
    const { month } = req.query || {};
    const monthYear = month || new Date().toISOString().slice(0, 7);

    const { data, error } = await supabase
      .from("invoices")
      .select("*")
      .eq("month_year", monthYear)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Error /admin/invoices/summary:", error);
      return res.json({
        ok: false,
        msg: "Error consultando facturas del mes",
      });
    }

    return res.json({ ok: true, invoices: data || [] });
  } catch (err) {
    console.error("Error general /admin/invoices/summary:", err);
    return res.json({ ok: false, msg: "Error interno" });
  }
});

// =====================================================
// CHAT — mensajes + notificaciones
// =====================================================

// GET /chat/messages?room=room_...&since=ISO_OPCIONAL
app.get("/chat/messages", async (req, res) => {
  try {
    const { room, since } = req.query || {};
    if (!room) {
      return res.json({ ok: false, msg: "Falta room" });
    }

    let query = supabase
      .from("messages")
      .select("*")
      .eq("room", room)
      .order("created_at", { ascending: true });

    if (since) {
      query = query.gt("created_at", since);
    }

    const { data, error } = await query;

    if (error) {
      console.error("Error /chat/messages:", error);
      return res.json({
        ok: false,
        msg: "Error consultando mensajes de chat",
      });
    }

    return res.json({ ok: true, messages: data || [] });
  } catch (err) {
    console.error("Error general /chat/messages:", err);
    return res.json({ ok: false, msg: "Error interno" });
  }
});

// NOTIFICACIÓN: MENSAJE NUEVO
// Body: { recipient_id, sender_id, content }
app.post("/notify/chat", async (req, res) => {
  try {
    const { recipient_id, sender_id, content } = req.body || {};
    if (!recipient_id || !sender_id || !content) {
      return res.json({
        ok: false,
        msg: "Faltan recipient_id, sender_id o content",
      });
    }

    const { data: recipient, error: recErr } = await supabase
      .from("profiles")
      .select("email, first_name, last_name")
      .eq("id", recipient_id)
      .maybeSingle();

    if (recErr || !recipient || !recipient.email) {
      console.error("Error buscando destinatario chat:", recErr);
      return res.json({
        ok: false,
        msg: "No se encontró email del destinatario",
      });
    }

    const { data: sender } = await supabase
      .from("profiles")
      .select("first_name, last_name, email")
      .eq("id", sender_id)
      .maybeSingle();

    const senderName =
      (sender
        ? `${sender.first_name || ""} ${sender.last_name || ""}`.trim()
        : "") || "tu profesora";

    const subject = "Nuevo mensaje en el chat del Campus PauPau";
    const text = `Hola ${recipient.first_name || ""} 👋

${senderName} te envió un mensaje nuevo en el chat del campus:

"${content}"

Ingresá al Campus PauPau para continuar la conversación.

— Equipo PauPau`;

    await sendNotificationEmail(recipient.email, subject, text);

    return res.json({ ok: true });
  } catch (err) {
    console.error("Error /notify/chat:", err);
    return res.json({ ok: false, msg: "Error interno" });
  }
});

// NOTIFICACIÓN: TAREA NUEVA
// Body: { student_id, teacher_id, title, description }
app.post("/notify/assignment", async (req, res) => {
  try {
    const { student_id, teacher_id, title, description } = req.body || {};
    if (!student_id || !title) {
      return res.json({ ok: false, msg: "Faltan student_id o title" });
    }

    const { data: student, error: stErr } = await supabase
      .from("profiles")
      .select("email, first_name, last_name")
      .eq("id", student_id)
      .maybeSingle();

    if (stErr || !student || !student.email) {
      console.error("Error buscando alumno para mail tarea:", stErr);
      return res.json({
        ok: false,
        msg: "No se encontró email del alumno",
      });
    }

    let senderName = "tu profesora";
    if (teacher_id) {
      const { data: teacher } = await supabase
        .from("profiles")
        .select("first_name, last_name")
        .eq("id", teacher_id)
        .maybeSingle();
      if (teacher) {
        const n =
          `${teacher.first_name || ""} ${
            teacher.last_name || ""
          }`.trim() || null;
        if (n) senderName = n;
      }
    }

    const subject = "Nueva tarea en el Campus PauPau";
    const text = `Hola ${student.first_name || ""} 👋

${senderName} te asignó una nueva tarea en el Campus PauPau.

Título: ${title}
${description ? `Descripción: ${description}\n` : ""}

Ingresá al campus para verla y subir tu entrega.

— Equipo PauPau`;

    await sendNotificationEmail(student.email, subject, text);

    return res.json({ ok: true });
  } catch (err) {
    console.error("Error /notify/assignment:", err);
    return res.json({ ok: false, msg: "Error interno" });
  }
});

// NOTIFICACIÓN: CLASE GRABADA NUEVA
// Body: { student_id, teacher_id, title }
app.post("/notify/recording", async (req, res) => {
  try {
    const { student_id, teacher_id, title } = req.body || {};
    if (!student_id || !title) {
      return res.json({ ok: false, msg: "Faltan student_id o title" });
    }

    const { data: student, error: stErr } = await supabase
      .from("profiles")
      .select("email, first_name, last_name")
      .eq("id", student_id)
      .maybeSingle();

    if (stErr || !student || !student.email) {
      console.error("Error buscando alumno para mail grabación:", stErr);
      return res.json({
        ok: false,
        msg: "No se encontró email del alumno",
      });
    }

    let senderName = "tu profesora";
    if (teacher_id) {
      const { data: teacher } = await supabase
        .from("profiles")
        .select("first_name, last_name")
        .eq("id", teacher_id)
        .maybeSingle();
      if (teacher) {
        const n =
          `${teacher.first_name || ""} ${
            teacher.last_name || ""
          }`.trim() || null;
        if (n) senderName = n;
      }
    }

    const subject = "Nueva clase grabada en el Campus PauPau";
    const text = `Hola ${student.first_name || ""} 👋

${senderName} subió una nueva clase grabada para vos.

Título: ${title}

Ingresá al Campus PauPau para verla.

— Equipo PauPau`;

    await sendNotificationEmail(student.email, subject, text);

    return res.json({ ok: true });
  } catch (err) {
    console.error("Error /notify/recording:", err);
    return res.json({ ok: false, msg: "Error interno" });
  }
});

// =====================================================
// TEST EMAIL
// =====================================================
app.get("/test-email", async (req, res) => {
  try {
    await transporter.sendMail({
      from: FROM_EMAIL,
      to: "paupaulanguagesadmi@gmail.com",
      subject: "Test PauPau Notificaciones",
      text: "Este es un test de nodemailer funcionando en Render 🚀",
    });

    return res.json({ ok: true, msg: "Correo enviado" });
  } catch (err) {
    console.error("Error test-email:", err);
    return res.status(500).json({ ok: false, msg: "Error enviando test" });
  }
});
// =====================================================
// =========== INSCRIPCIONES WEB (Postgres) ============
// ====== /horarios, /hold, /crear-preferencia, webhook
// =====================================================

// Solo si hay DB
const ADMIN_KEY = process.env.ADMIN_KEY || "cambia-esta-clave";

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
  if (crypto.randomUUID) return crypto.randomUUID();
  // fallback (no debería usarse en Node moderno)
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, (c) =>
    (c ^ (crypto.randomBytes(1)[0] & 15 >> c / 4)).toString(16)
  );
}

// mails de profes conocidos (fallback)
const PROF_EMAILS = {
  Lourdes: "paupaulanguages2@gmail.com",
  Santiago: "paupaulanguages10@gmail.com",
  Milena: "paupaulanguages13@gmail.com",
  Gissel: "paupaulanguages3@gmail.com",
  Heliana: "paupaulanguages9@gmail.com",
};

// ----------- PÚBLICO /horarios ----------
app.get("/horarios", async (_req, res) => {
  if (!pool) return res.status(500).json({ error: "db_not_configured" });
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
    console.error("[GET /horarios]", e);
    res.status(500).json({ error: "db_error" });
  }
});

// ----------- HOLD simple ----------
app.post("/hold", async (req, res) => {
  if (!pool) return res.status(500).json({ error: "db_not_configured" });

  const { horario_id, alumno_nombre, alumno_email } = req.body || {};
  if (!horario_id)
    return res
      .status(400)
      .json({ error: "bad_request", message: "horario_id requerido" });

  const name =
    (alumno_nombre && String(alumno_nombre).trim()) || "N/A";
  const email =
    (alumno_email && String(alumno_email).trim()) ||
    "noemail@paupau.local";

  try {
    await pool.query("BEGIN");
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
      await pool.query("ROLLBACK");
      return res.status(409).json({ error: "not_available" });
    }

    const insQ = `
      INSERT INTO reservas (horario_id, alumno_nombre, alumno_email, estado, reservado_hasta)
      VALUES ($1,$2,$3,'pendiente', now() + interval '10 minutes')
      RETURNING id, reservado_hasta
    `;
    const { rows } = await pool.query(insQ, [horario_id, name, email]);
    await pool.query("COMMIT");
    res.json({
      id: rows[0].id,
      reservado_hasta: rows[0].reservado_hasta,
    });
  } catch (e) {
    await pool.query("ROLLBACK");
    console.error("[POST /hold]", e);
    res.status(500).json({ error: "db_error" });
  }
});

// ----------- CREAR PREFERENCIA INSCRIPCIONES ----------
// * Soporta:
//   - Modalidad "individual" (usa horarios / reservas como siempre)
//   - Otras modalidades/web (grupal, Intensivo 90 días, etc.) SIN tocar reservas
app.post("/crear-preferencia", async (req, res) => {
  if (!pool) return res.status(500).json({ error: "db_not_configured" });

  const {
    title,
    price,
    currency = "ARS",
    back_urls = {},
    metadata = {},
    horarios_ids,
    horario_id,
    alumno_nombre,
    alumno_email,
    form,
  } = req.body || {};

  if (!title || typeof title !== "string")
    return res
      .status(400)
      .json({ error: "bad_request", message: "title requerido" });
  if (typeof price !== "number" || !(price > 0))
    return res.status(400).json({
      error: "bad_request",
      message: "price debe ser número > 0",
    });
  if (!/^[A-Z]{3}$/.test(currency))
    return res
      .status(400)
      .json({ error: "bad_request", message: "currency inválida" });
  if (!MP_ACCESS_TOKEN)
    return res.status(500).json({
      error: "server_config",
      message: "MP_ACCESS_TOKEN no configurado",
    });

  // modalides:
  // - "individual"  -> requiere horarios / reservas
  // - "grupal"      -> NO requiere horarios (ej: cursos grupales)
  // - "intensivo90" -> NO requiere horarios (nuevo curso Intensivo 90 días)
  const modalidad =
    (form && String(form.modalidad || "individual").toLowerCase()) ||
    "individual";

  // Detectamos tipo de curso especial si viene desde el form o metadata
  const tipo_curso =
    (form && form.tipo_curso && String(form.tipo_curso).toLowerCase()) ||
    (metadata && metadata.tipo_curso && String(metadata.tipo_curso).toLowerCase()) ||
    null;

  let list = Array.isArray(horarios_ids)
    ? horarios_ids.map(Number).filter(Boolean)
    : [];
  if (!list.length && Number(horario_id)) list = [Number(horario_id)];

  // Para INDIVIDUAL requerimos horarios; para GRUPAL / INTENSIVO90 no
  const requiereHorarios = modalidad === "individual";

  if (requiereHorarios && !list.length) {
    return res.status(400).json({
      error: "bad_request",
      message: "horarios_ids o horario_id requerido para modalidad individual",
    });
  }

  const name =
    (alumno_nombre && String(alumno_nombre).trim()) || "N/A";
  const email =
    (alumno_email && String(alumno_email).trim()) ||
    "noemail@paupau.local";

  const groupRef = uuid();
  const reservasIds = [];

  // Solo creamos reservas en DB cuando es modalidad INDIVIDUAL
  if (requiereHorarios) {
    try {
      await pool.query("BEGIN");

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
        await pool.query("ROLLBACK");
        return res.status(409).json({ error: "not_available" });
      }

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
          form ? JSON.stringify(form) : JSON.stringify({}),
        ]);
        reservasIds.push(r.rows[0].id);
      }

      await pool.query("COMMIT");
    } catch (e) {
      await pool.query("ROLLBACK");
      console.error("[crear-preferencia] DB error", e);
      return res.status(500).json({ error: "db_error" });
    }
  }

  const form_preview = form
  ? {
      nombre: String(form.nombre || ""),
      dni: String(form.dni || ""),
      nacimiento: String(form.nacimiento || ""),
      email: String(form.email || ""),
      whatsapp: String(form.whatsapp || ""),
      pais: String(form.pais || ""),
      idioma: String(form.idioma || ""),
      nivel: String(form.nivel || ""),
      frecuencia: String(form.frecuencia || ""),
      profesor: String(form.profesor || ""),
      extra_info: String(form.extra_info || ""),
      // Acá guardamos lo que venga del front para identificar el programa
      programa: String(form.programa || form.program || ""),
    }
  : null;

try {
  // Detectamos tipo_curso a partir de "programa"
  let tipoCurso = null;
  const prog = form_preview?.programa?.toLowerCase() || "";

  // Ajustá este if al valor REAL que mandás desde el front.
  // Ejemplos posibles de prog:
  //  - "intensivo90"
  //  - "curso intensivo 90 días"
  if (prog === "intensivo90" || prog.includes("intensivo 90")) {
    tipoCurso = "intensivo90";
  }

  const prefMetadata = {
    ...metadata,
    group_ref: groupRef,
    reservas_ids: reservasIds,
    alumno_nombre: name,
    alumno_email: email,
    modalidad,
    tipo_curso: tipoCurso,              // 👈 ahora siempre se setea bien
    teacher: form?.profesor || metadata?.teacher || null,
    grupo_label: form?.grupo_label || metadata?.grupo_label || null,
    form_preview,
  };

    const pref = {
      items: [
        {
          title,
          quantity: 1,
          unit_price: price,
          currency_id: currency,
        },
      ],
      back_urls,
      auto_return: "approved",
      metadata: prefMetadata,
    };

    const mpResp = await mercadopago.preferences.create(pref);
    const data = mpResp?.body || mpResp;

    return res.json({
      id: data.id,
      init_point: data.init_point,
      sandbox_init_point: data.sandbox_init_point,
      group_ref: groupRef,
      reservas_ids: reservasIds,
      modalidad,
      tipo_curso,
    });
  } catch (e) {
    console.error("[MP error]", e?.message, "\n[MP error data]", e?.response?.body);
    return res.status(502).json({
      error: "mp_failed",
      message: e?.message || "unknown",
      details: e?.response?.body || null,
    });
  }
});// ----------- WEBHOOK MP (inscripciones) ----------
app.post("/webhook", async (req, res) => {
  if (!pool) {
    res.sendStatus(200);
    return;
  }

  const evento = req.body;

  try {
    // ==========================
    // 1) Leemos pago y metadata
    // ==========================
    let pagoId =
      evento?.data?.id || evento?.data?.payment?.id || null;
    let meta = evento?.data?.metadata || evento?.data?.id?.metadata || null;

    if (!meta && pagoId) {
      const pay = await mercadopago.payment
        .findById(pagoId)
        .catch(() => null);
      const body = pay?.response || pay?.body || {};
      meta = body?.metadata || null;
    }

    const isPayment =
      evento?.type === "payment" || evento?.action?.includes("payment");
    if (!isPayment) return res.sendStatus(200);

    if (evento?.data?.status && evento.data.status !== "approved") {
      return res.sendStatus(200);
    }

    // -----------------------------------------------
    // 2) DETECTAMOS MODALIDAD / TIPO CURSO
    // -----------------------------------------------
    const modalidad = String(meta?.modalidad || "individual").toLowerCase();

    const tipo_curso =
      meta?.tipo_curso && typeof meta.tipo_curso === "string"
        ? meta.tipo_curso.toLowerCase()
        : null;

    // Para debug: ver qué viene realmente
    console.log(
      "[WEBHOOK] modalidad:", modalidad,
      "tipo_curso:", tipo_curso,
      "meta:", JSON.stringify(meta || {}, null, 2)
    );

    // Datos comunes del meta
    const alumnoNombre = meta?.alumno_nombre || "Alumno";
    const alumnoEmail  = meta?.alumno_email  || "";
    const profesorName = meta?.teacher       || "Profesor";
    const horariosTxt  = meta?.grupo_label   || "";

    const profEmail =
      PROF_EMAILS[profesorName] ||
      (profesorName === "Paula Toledo" ? "paauutooledo@gmail.com" : "");

    const pv        = meta?.form_preview || {};
    const extraInfo = (pv?.extra_info || "").trim();

    // ==================================================
    // HELPERS DE PLANTILLAS HTML (alumno / admin)
    // ==================================================

    // Template “lindo” para alumno (como tu captura)
    const buildAlumnoHtml = (nombre, profesor, horarios) => `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <title>Bienvenida PauPau</title>
</head>
<body style="margin:0;padding:0;background:#0b0b10;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0b0b10;padding:24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#111827;border-radius:16px;border:1px solid #1f2937;overflow:hidden;">
          <tr>
            <td style="padding:24px 24px 16px 24px;background:linear-gradient(135deg,#4f46e5,#6366f1);">
              <h1 style="margin:0;color:#f9fafb;font-size:24px;font-weight:700;">
                ¡Hola ${nombre.split(" ")[0] || ""}!
              </h1>
            </td>
          </tr>

          <tr>
            <td style="padding:24px;color:#e5e7eb;font-size:15px;line-height:1.6;">
              <p style="margin:0 0 12px 0;">
                ¡Qué alegría que seas parte de nuestra Escuela! Estoy feliz de recibirte y darte la bienvenida.
              </p>
              <p style="margin:0 0 20px 0;">
                En Paupau Languages conectamos personas con el mundo y desde hoy vos también sos parte de esa comunidad.
              </p>

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-radius:14px;border:1px solid #374151;background:#111827;padding:16px 18px;margin-bottom:20px;">
                <tr>
                  <td style="font-size:14px;color:#e5e7eb;">
                    <p style="margin:0 0 8px 0;">
                      <strong>Tu docente:</strong> ${profesor}
                    </p>
                    <p style="margin:0 0 8px 0;">
                      <strong>Tus horarios:</strong> ${horarios || "A confirmar"}
                    </p>
                    <p style="margin:0 0 8px 0;">
                      <strong>Profesor/tutor:</strong> ${profesor}
                    </p>
                    ${
                      profEmail
                        ? `<p style="margin:0;">
                             <strong>Correo del profesor:</strong>
                             <a href="mailto:${profEmail}" style="color:#60a5fa;text-decoration:none;">
                               ${profEmail}
                             </a>
                           </p>`
                        : ""
                    }
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 16px 0;">
                Te pedimos puntualidad y cámara/micrófono encendidos para una mejor experiencia.
              </p>
              <p style="margin:0 0 20px 0;">
                Más cerca de la fecha de inicio tu docente te enviará los links de acceso.
              </p>

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-radius:14px;border:1px solid #92400e;background:#451a03;padding:14px 16px;margin-bottom:20px;">
                <tr>
                  <td style="font-size:14px;color:#fed7aa;">
                    <strong>Aranceles:</strong>
                    Se abonan del 1 al 7 de cada mes por transferencia bancaria.
                    En caso de no abonar en tiempo y forma, las clases se suspenderán.
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 6px 0;">
                Si surge cualquier duda, escribinos cuando quieras.
              </p>

              <p style="margin:16px 0 0 0;font-size:14px;color:#9ca3af;">
                <strong style="color:#e5e7eb;">PauPau Languages</strong><br/>
                Instagram:
                <a href="https://www.instagram.com/paupaulanguages" style="color:#60a5fa;text-decoration:none;">
                  @paupaulanguages
                </a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();

    // Template para admin/profe (con formulario)
    const buildAdminHtml = ({
      modalidad,
      alumnoNombre,
      alumnoEmail,
      profesorName,
      profEmail,
      horariosTxt,
      reservasIds,
      pv,
    }) => {
      const rowsForm = [];

      if (pv?.nombre)      rowsForm.push(`<li><strong>nombre:</strong> ${pv.nombre}</li>`);
      if (pv?.dni)         rowsForm.push(`<li><strong>DNI:</strong> ${pv.dni}</li>`);
      if (pv?.nacimiento)  rowsForm.push(`<li><strong>fecha de nacimiento:</strong> ${pv.nacimiento}</li>`);
      if (pv?.email)       rowsForm.push(`<li><strong>mail:</strong> <a href="mailto:${pv.email}">${pv.email}</a></li>`);
      if (pv?.whatsapp)    rowsForm.push(`<li><strong>whatsapp:</strong> ${pv.whatsapp}</li>`);
      if (pv?.pais)        rowsForm.push(`<li><strong>país donde vive:</strong> ${pv.pais}</li>`);
      if (pv?.idioma)      rowsForm.push(`<li><strong>idioma a inscribirse:</strong> ${pv.idioma}</li>`);
      if (pv?.nivel)       rowsForm.push(`<li><strong>resultado test nivelatorio:</strong> ${pv.nivel}</li>`);
      if (pv?.frecuencia)  rowsForm.push(`<li><strong>clases por semana:</strong> ${pv.frecuencia}</li>`);
      if (pv?.profesor)    rowsForm.push(`<li><strong>profesor:</strong> ${pv.profesor}</li>`);
      if (pv?.programa)    rowsForm.push(`<li><strong>programa:</strong> ${pv.programa}</li>`);
      if (pv?.extra_info)  rowsForm.push(`<li><strong>extra_info:</strong> ${pv.extra_info}</li>`);

      return `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <title>Nueva inscripción confirmada</title>
</head>
<body style="margin:0;padding:16px;background:#111827;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e5e7eb;">
  <h2 style="margin-top:0;margin-bottom:8px;">Nueva <span style="background:#facc15;color:#111827;padding:2px 6px;border-radius:4px;">inscripción</span> confirmada</h2>
  <p style="margin-top:0;margin-bottom:18px;font-size:14px;color:#9ca3af;">
    Modalidad: <strong>${modalidad}</strong>
  </p>

  <ul style="margin:0 0 18px 18px;padding:0;font-size:14px;line-height:1.6;">
    <li><strong>Modalidad:</strong> ${modalidad}</li>
    <li><strong>Alumno:</strong> ${alumnoNombre}${
      alumnoEmail
        ? ` (<a href="mailto:${alumnoEmail}" style="color:#60a5fa;">${alumnoEmail}</a>)`
        : ""
    }</li>
    <li><strong>Profesor:</strong> ${profesorName}${
      profEmail
        ? ` (<a href="mailto:${profEmail}" style="color:#60a5fa;">${profEmail}</a>)`
        : ""
    }</li>
    ${horariosTxt ? `<li><strong>Horarios:</strong> ${horariosTxt}</li>` : ""}
    ${
      reservasIds && reservasIds.length
        ? `<li><strong>Reservas:</strong> ${reservasIds.join(", ")}</li>`
        : ""
    }
  </ul>

  ${
    rowsForm.length
      ? `
  <h3 style="margin:12px 0 6px 0;">Formulario</h3>
  <ul style="margin:0 0 8px 18px;padding:0;font-size:14px;line-height:1.6;">
    ${rowsForm.join("\n    ")}
  </ul>`
      : ""
  }
</body>
</html>`.trim();
    };

    // ===========================================
    // 3) CASO ESPECIAL: INTENSIVO 90 DÍAS
    // ===========================================
    // ===========================================
// 3) CASO ESPECIAL: INTENSIVO 90 DÍAS
// ===========================================
if (tipo_curso === "intensivo90" || modalidad === "intensivo") {
  // Armamos un texto de horarios “humano” para el intensivo
  const horariosIntensivo =
    pv?.grupo_label ||
    meta?.grupo_label ||
    "Intensivo 90 Días – horarios a coordinar con Paula";

  // 🌈 MISMO FORMATO LINDO QUE INDIVIDUAL/GRUPAL (para el alumno)
  const htmlAlumno = buildAlumnoHtml(
    alumnoNombre,
    "Paula Toledo",
    horariosIntensivo
  );

  // 🧾 MISMO FORMATO LINDO DE ADMIN (con formulario completo)
  const htmlAdmin = buildAdminHtml({
    modalidad: "intensivo 90 días",
    alumnoNombre,
    alumnoEmail,
    profesorName: "Paula Toledo",
    profEmail: "paauutooledo@gmail.com",
    horariosTxt: horariosIntensivo,
    reservasIds: [],   // no usamos reservas en este curso
    pv,                // acá vienen dni, mail, whatsapp, programa, etc.
  });

  try {
    // Mail alumno
    if (alumnoEmail) {
      await transporter.sendMail({
        from: FROM_EMAIL,
        to: alumnoEmail,
        subject: "¡Bienvenido al Intensivo 90 Días!",
        html: htmlAlumno,
      });
    }

    // Mail admin + Paula
    await transporter.sendMail({
      from: FROM_EMAIL,
      to: ACADEMY_EMAIL,
      cc: "paauutooledo@gmail.com",
      subject: `Nueva inscripción Intensivo 90 Días — ${alumnoNombre}`,
      html: htmlAdmin,
    });
  } catch (e) {
    console.error("[mail intensivo90] error envío", e);
  }

  return res.sendStatus(200);
}

    // ===========================================
    // 4) MODALIDAD GRUPAL
    // ===========================================
    if (modalidad === "grupal") {
      const alumnoHtml = buildAlumnoHtml(
        alumnoNombre,
        profesorName,
        horariosTxt
      );

      const adminHtml = buildAdminHtml({
        modalidad: "grupal",
        alumnoNombre,
        alumnoEmail,
        profesorName,
        profEmail,
        horariosTxt,
        reservasIds: [],
        pv,
      });

      try {
        if (alumnoEmail) {
          await transporter.sendMail({
            from: FROM_EMAIL,
            to: alumnoEmail,
            subject: "¡Tu inscripción fue confirmada!",
            html: alumnoHtml,
          });
        }

        await transporter.sendMail({
          from: FROM_EMAIL,
          to: ACADEMY_EMAIL,
          cc: profEmail || undefined,
          subject: `Nueva inscripción grupal — ${alumnoNombre}`,
          html: adminHtml,
        });
      } catch (e) {
        console.error("[mail grupal] error envío", e);
      }

      return res.sendStatus(200);
    }

    // ===========================================
    // 5) MODALIDAD INDIVIDUAL (NORMAL)
    // ===========================================
    const reservasIdsMeta = Array.isArray(meta?.reservas_ids)
      ? meta.reservas_ids.map(Number).filter(Boolean)
      : [];
    const groupRef = meta?.group_ref || null;

    let targetIds = reservasIdsMeta;

    if (!targetIds.length && groupRef) {
      const r = await pool.query(
        `SELECT id FROM reservas WHERE group_ref = $1`,
        [groupRef]
      );
      targetIds = r.rows.map((x) => x.id);
    }

    if (!targetIds.length) {
      return res.sendStatus(200);
    }

    await pool.query(
      `UPDATE reservas
         SET estado='pagado', reservado_hasta=NULL
       WHERE id = ANY($1::int[])`,
      [targetIds]
    );

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
    if (!rows.length) {
      return res.sendStatus(200);
    }

    const alumnoNombre2 = rows[0].alumno_nombre || "Alumno";
    const alumnoEmail2  = rows[0].alumno_email || "";
    const profesorName2 = rows[0].profesor || "Profesor";
    const horariosTxt2  = rows.map((r) => `${r.dia_semana} ${r.hora}`).join("; ");

    const profEmail2 =
      PROF_EMAILS[profesorName2] ||
      (profesorName2 === "Paula Toledo" ? "paauutooledo@gmail.com" : "");

    const htmlAlumno = buildAlumnoHtml(
      alumnoNombre2,
      profesorName2,
      horariosTxt2
    );

    const adminHtml = buildAdminHtml({
      modalidad: "individual",
      alumnoNombre: alumnoNombre2,
      alumnoEmail: alumnoEmail2,
      profesorName: profesorName2,
      profEmail: profEmail2,
      horariosTxt: horariosTxt2,
      reservasIds: targetIds,
      pv,
    });

    try {
      if (alumnoEmail2) {
        await transporter.sendMail({
          from: FROM_EMAIL,
          to: alumnoEmail2,
          subject: "¡Inscripción confirmada!",
          html: htmlAlumno,
        });
      }

      await transporter.sendMail({
        from: FROM_EMAIL,
        to: ACADEMY_EMAIL,
        cc: profEmail2 || undefined,
        subject: `Nueva inscripción confirmada: ${alumnoNombre2} con ${profesorName2}`,
        html: adminHtml,
      });
    } catch (err) {
      console.error("[mail individual] error envío", err);
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error("[webhook] error", e);
    return res.sendStatus(200);
  }
});

// ----------- CRON: liberar holds vencidos ----------
setInterval(async () => {
  if (!pool) return;
  try {
    const r = await pool.query(
      `UPDATE reservas
         SET estado='cancelado'
       WHERE estado='pendiente'
         AND reservado_hasta IS NOT NULL
         AND reservado_hasta < now()`
    );
    if (r.rowCount > 0)
      console.log(`[cron] Reservas liberadas: ${r.rowCount}`);
  } catch (e) {
    console.error("[cron error]", e);
  }
}, 60 * 1000);

// ============================
// ADMIN (X-Admin-Key)
// ============================
function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"] || req.query.key;
  if (!key || key !== ADMIN_KEY)
    return res.status(401).json({ error: "unauthorized" });
  next();
}

// GET /admin/profesores
app.get("/admin/profesores", requireAdmin, async (_req, res) => {
  if (!pool) return res.status(500).json({ error: "db_not_configured" });
  try {
    const { rows } = await pool.query(
      `SELECT id, nombre FROM profesores ORDER BY nombre`
    );
    res.json(rows);
  } catch (e) {
    console.error("[GET /admin/profesores]", e);
    res.status(500).json({ error: "db_error" });
  }
});

// POST /admin/profesores
app.post("/admin/profesores", requireAdmin, async (req, res) => {
  if (!pool) return res.status(500).json({ error: "db_not_configured" });
  const { nombre } = req.body || {};
  if (!nombre || !String(nombre).trim())
    return res
      .status(400)
      .json({ error: "bad_request", message: "nombre requerido" });
  try {
    const { rows } = await pool.query(
      `INSERT INTO profesores (nombre) VALUES ($1) RETURNING id, nombre`,
      [String(nombre).trim()]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error("[POST /admin/profesores]", e);
    res.status(500).json({ error: "db_error" });
  }
});
// ============================
// ADMIN / HORARIOS (para admin-panel de Odoo)
// ============================

// GET /admin/horarios
// Lista TODOS los horarios (el panel después filtra por día / profe)
app.get("/admin/horarios", requireAdmin, async (req, res) => {
  if (!pool) return res.status(500).json({ error: "db_not_configured" });

  try {
    const { rows } = await pool.query(
      `
      SELECT
        h.id,
        h.dia_semana,
        to_char(h.hora,'HH24:MI') AS hora,
        h.profesor_id,
        p.nombre AS profesor
      FROM horarios h
      JOIN profesores p ON p.id = h.profesor_id
      ORDER BY ${DAY_ORDER}, h.hora, p.nombre
      `
    );
    res.json(rows);
  } catch (e) {
    console.error("[GET /admin/horarios]", e);
    res.status(500).json({ error: "db_error" });
  }
});

// POST /admin/horarios
// Crea un horario nuevo desde el panel (día, hora, profe)
app.post("/admin/horarios", requireAdmin, async (req, res) => {
  if (!pool) return res.status(500).json({ error: "db_not_configured" });

  const { profesor_id, dia_semana, hora } = req.body || {};

  if (!profesor_id || !dia_semana || !hora) {
    return res.status(400).json({
      error: "bad_request",
      message: "profesor_id, dia_semana y hora son obligatorios",
    });
  }

  try {
    const { rows } = await pool.query(
      `
      INSERT INTO horarios (profesor_id, dia_semana, hora)
      VALUES ($1, $2, $3::time)
      RETURNING id, profesor_id, dia_semana, to_char(hora,'HH24:MI') AS hora
      `,
      [Number(profesor_id), String(dia_semana), String(hora)]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error("[POST /admin/horarios]", e);
    res.status(500).json({ error: "db_error" });
  }
});

// DELETE /admin/horarios/:id
// Borrar horario desde el botón "Borrar" del panel
app.delete("/admin/horarios/:id", requireAdmin, async (req, res) => {
  if (!pool) return res.status(500).json({ error: "db_not_configured" });

  const id = Number(req.params.id || 0);
  if (!id) {
    return res.status(400).json({
      error: "bad_request",
      message: "id de horario requerido",
    });
  }

  try {
    await pool.query(`DELETE FROM horarios WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error("[DELETE /admin/horarios/:id]", e);
    res.status(500).json({ error: "db_error" });
  }
});

// Por compatibilidad extra (por si el panel usa POST en vez de DELETE)
app.post("/admin/horarios/delete", requireAdmin, async (req, res) => {
  if (!pool) return res.status(500).json({ error: "db_not_configured" });

  const id = Number((req.body && req.body.id) || 0);
  if (!id) {
    return res.status(400).json({
      error: "bad_request",
      message: "id de horario requerido",
    });
  }

  try {
    await pool.query(`DELETE FROM horarios WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error("[POST /admin/horarios/delete]", e);
    res.status(500).json({ error: "db_error" });
  }
});
// ============================
// ADMIN HORARIOS (panel Odoo)
// ============================

// helper para liberar reservas de un horario
async function liberarCupoHorario(horarioId) {
  if (!pool) throw new Error("db_not_configured");

  console.log('[liberarCupoHorario] Liberando cupo de horario', horarioId);

  await pool.query(
    `
      UPDATE reservas
         SET estado = 'cancelado',
             reservado_hasta = NULL
       WHERE horario_id = $1
         AND estado IN ('pendiente','bloqueado','pagado')
    `,
    [horarioId]
  );
}

// GET /admin/horarios  -> listado para el panel con filtro opcional
app.get('/admin/horarios', requireAdmin, async (req, res) => {
   console.log('*** NUEVO HANDLER /admin/horarios ***', req.query);   // 👈 AGREGÁ ESTO
   
  if (!pool) {
    return res.status(500).json({ error: 'db_not_configured' });
  }

  try {
    // aceptamos tanto profesor_id como profesorId por las dudas
    const { profesor_id, profesorId } = req.query || {};
    const pid = profesor_id || profesorId || null;

    let where = '';
    const params = [];

    if (pid) {
      where = 'WHERE h.profesor_id = $1';
      params.push(Number(pid));
    }

    const q = `
      SELECT
        h.id,
        h.profesor_id,
        p.nombre AS profesor,
        h.dia_semana,
        to_char(h.hora,'HH24:MI') AS hora,
        ${STATE_CASE} AS estado,
        ${HAS_PAGADO},
        ${HAS_BLOQ},
        ${HAS_PEND}
      FROM horarios h
      JOIN profesores p ON p.id = h.profesor_id
      ${where}
      ORDER BY p.nombre, ${DAY_ORDER}, h.hora
    `;

    const { rows } = await pool.query(q, params);
    return res.json(rows);
  } catch (e) {
    console.error('[GET /admin/horarios]', e);
    return res.status(500).json({ error: 'db_error' });
  }
});

// POST /admin/horarios  -> crear nuevo horario desde el panel
app.post("/admin/horarios", requireAdmin, async (req, res) => {
  if (!pool) return res.status(500).json({ error: "db_not_configured" });

  const { profesor_id, dia_semana, hora } = req.body || {};
  if (!profesor_id || !dia_semana || !hora) {
    return res.status(400).json({
      error: "bad_request",
      message: "profesor_id, dia_semana y hora son requeridos",
    });
  }

  try {
    const { rows } = await pool.query(
      `
        INSERT INTO horarios (profesor_id, dia_semana, hora)
        VALUES ($1, $2, $3::time)
        RETURNING id AS horario_id,
                  profesor_id,
                  dia_semana,
                  to_char(hora,'HH24:MI') AS hora
      `,
      [Number(profesor_id), String(dia_semana).trim(), hora]
    );
    return res.json(rows[0]);
  } catch (e) {
    console.error("[POST /admin/horarios]", e);
    return res.status(500).json({ error: "db_error" });
  }
});

// POST /admin/horarios/:id/liberar  -> botón "Liberar cupo" del panel
app.post("/admin/horarios/:id/liberar", requireAdmin, async (req, res) => {
  try {
    const horarioId = Number(req.params.id);
    if (!horarioId) {
      return res.status(400).json({ error: "bad_request", message: "id inválido" });
    }

    await liberarCupoHorario(horarioId);
    return res.json({ ok: true });
  } catch (e) {
    console.error("[POST /admin/horarios/:id/liberar]", e);
    return res.status(500).json({ error: "db_error" });
  }
});

// Alias por compatibilidad: algunos JS del panel llaman /horarios/:id/liberar
app.post("/horarios/:id/liberar", requireAdmin, async (req, res) => {
  try {
    const horarioId = Number(req.params.id);
    if (!horarioId) {
      return res.status(400).json({ error: "bad_request", message: "id inválido" });
    }

    await liberarCupoHorario(horarioId);
    return res.json({ ok: true });
  } catch (e) {
    console.error("[POST /horarios/:id/liberar]", e);
    return res.status(500).json({ error: "db_error" });
  }
});

// ============================
// START SERVER
// ============================
app.listen(PORT, () => {
  console.log(`🚀 Backend PauPau corriendo en puerto ${PORT}`);
});
