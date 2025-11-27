/* ============================================
   SERVER.JS FINAL — PAUPAU CAMPUS BACKEND
   Cupón + MP + comprobantes + upsert pagos
   + endpoints admin + facturas + chat
   + notificaciones + emails
   ============================================ */

import express from "express";
import multer from "multer";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import mercadopago from "mercadopago";
import nodemailer from "nodemailer";

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
// MULTER (para comprobantes / facturas)
// ============================
const storage = multer.memoryStorage();
const upload = multer({ storage });

// ============================
// MERCADO PAGO CONFIG
// ============================
mercadopago.configure({
  access_token: MP_ACCESS_TOKEN,
});

// ============================
// NODEMAILER (SMTP Gmail)
// ============================
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST, // smtp.gmail.com
  port: Number(process.env.SMTP_PORT || 587), // 587 = STARTTLS
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: {
    rejectUnauthorized: false,
  },
});

// ============================
// HELPERS EMAIL + NOTIFICACIONES
// ============================
async function sendNotificationEmail(to, subject, text) {
  if (!to) return;
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to,
      subject,
      text,
    });
  } catch (err) {
    console.error("Error enviando mail de notificación:", err);
  }
}

async function createNotification({ user_id, type, message, ref_id }) {
  if (!user_id || !type) return;
  try {
    const { error } = await supabase.from("notifications").insert({
      user_id,
      type,
      message: message || null,
      ref_id: ref_id || null,
    });
    if (error) {
      console.error("Error creando notificación:", error);
    }
  } catch (err) {
    console.error("Error general creando notificación:", err);
  }
}

// ============================
// HEALTHCHECK
// ============================
app.get("/health", (req, res) => {
  res.json({ ok: true, message: "PauPau backend OK" });
});

// ============================
// CUPÓN — VERIFICAR
// ============================
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

// ============================
// MERCADO PAGO – CREAR PREFERENCIA
// ============================

const createPreferenceHandler = async (req, res) => {
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
    console.error("Error creando preferencia MP:", err);
    return res.status(500).json({ ok: false, msg: "Error interno" });
  }
};

// Rutas MP
app.post("/mp/create-preference", createPreferenceHandler);
app.post("/crear-preferencia", createPreferenceHandler);

// =====================================================
// PAGOS — SUBIR COMPROBANTE Y REGISTRAR PAGO EN TABLA
// =====================================================
// Body (form-data):
// - file: (archivo)
// - user_id: uuid del alumno
// - month: "YYYY-MM" (ej: "2025-11")
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

      // 1) Subir archivo a Supabase Storage
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

      // 2) Obtener la URL pública
      const { data: publicData } = supabase.storage
        .from(bucket)
        .getPublicUrl(fileName);

      const publicUrl = publicData?.publicUrl || null;

      // 3) Upsert en la tabla payments (user_id + month_year único)
      const monthYear = month; // "YYYY-MM"
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

      // (Opcional) Notificación a admin: la dejamos para más adelante si querés.

      return res.json({ ok: true, url: publicUrl });
    } catch (err) {
      console.error("Error /payments/upload-receipt:", err);
      return res.json({ ok: false, msg: "Error interno" });
    }
  }
);

// =====================================================
// ADMIN — OBTENER PAGOS DE UN ALUMNO (COMPROBANTES)
// =====================================================
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

    const { data, error } = await query.order("created_at", {
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

// =====================================================
// ADMIN — RESUMEN PAGOS MES (CON FILTRO POR MES)
// =====================================================
app.get("/admin/payments/summary", async (req, res) => {
  try {
    const { month } = req.query || {};
    const monthYear = month || new Date().toISOString().slice(0, 7);

    const { data, error } = await supabase
      .from("payments")
      .select("*")
      .eq("month_year", monthYear)
      .order("created_at", { ascending: false });

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

// =====================================================
// ADMIN — Cambiar estado de pago manualmente (UPSERT)
// =====================================================
app.post("/admin/payment/set", async (req, res) => {
  try {
    const { user_id, status, month } = req.body || {};

    if (!user_id || !status) {
      return res.json({ ok: false, msg: "Faltan user_id o status." });
    }

    const monthYear = month || new Date().toISOString().slice(0, 7); // YYYY-MM

    // 1) Buscar registro existente para recuperar amount
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

    // 2) Upsert con amount incluido (no puede ser NULL)
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

    // 3) Notificación + email al alumno
    try {
      const { data: student, error: stErr } = await supabase
        .from("profiles")
        .select("email, first_name, last_name")
        .eq("id", user_id)
        .maybeSingle();
      if (stErr) {
        console.error("Error buscando alumno para notificación pago:", stErr);
      } else if (student && student.email) {
        const fullName =
          `${student.first_name || ""} ${student.last_name || ""}`.trim() ||
          "";
        const statusText =
          status === "approved"
            ? "aprobado"
            : status === "pending"
            ? "pendiente"
            : status;
        const msg = `Tu pago del mes ${monthYear} fue marcado como "${statusText}".`;

        await createNotification({
          user_id,
          type: "payment",
          message: msg,
        });

        const subject = "Actualización de pago en PauPau Campus";
        const text = `Hola ${fullName || "alumno/a"} 👋\n\n${msg}\n\nPodés ver el detalle en la sección Pagos del Campus PauPau.\n\n— Equipo PauPau`;
        await sendNotificationEmail(student.email, subject, text);
      }
    } catch (e) {
      console.error("Error creando notificación de pago:", e);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("Exception en /admin/payment/set:", err);
    return res.json({ ok: false, msg: "Error inesperado." });
  }
});

// =====================================================
// ADMIN — LISTA DE USUARIOS Y PROFES
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
// FACTURAS — SUBIDA POR ADMIN Y CONSULTA (HISTORIAL)
// =====================================================

const INVOICES_BUCKET = "invoices";

// Body (form-data):
// - file   (archivo factura PDF/JPG/PNG)
// - user_id
// - month  = "YYYY-MM"
// - amount (opcional, número)
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

      const { error: invErr, data: invData } = await supabase
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
        )
        .select()
        .single();

      if (invErr) {
        console.error("Error guardando factura en tabla invoices:", invErr);
        return res.json({
          ok: false,
          msg: "Factura subida pero no se pudo guardar el registro.",
        });
      }

      // Notificación + email al alumno
      try {
        const { data: student, error: stErr } = await supabase
          .from("profiles")
          .select("email, first_name, last_name")
          .eq("id", user_id)
          .maybeSingle();

        if (stErr) {
          console.error("Error buscando alumno para factura:", stErr);
        } else if (student && student.email) {
          const fullName =
            `${student.first_name || ""} ${student.last_name || ""}`.trim() ||
            "";
          const msg = `Se cargó una nueva factura para el mes ${monthYear}.`;

          await createNotification({
            user_id,
            type: "invoice",
            message: msg,
            ref_id: invData?.id || null,
          });

          const subject = "Nueva factura disponible en PauPau Campus";
          const text = `Hola ${fullName || "alumno/a"} 👋\n\n${msg}\n\nPodés descargarla desde la sección Pagos del Campus PauPau.\n\n— Equipo PauPau`;
          await sendNotificationEmail(student.email, subject, text);
        }
      } catch (e) {
        console.error("Error creando notificación de factura:", e);
      }

      return res.json({ ok: true, url: publicUrl });
    } catch (err) {
      console.error("Error /admin/invoices/upload:", err);
      return res.json({ ok: false, msg: "Error interno" });
    }
  }
);

// Obtener historial de facturas por usuario
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

// Resumen de facturas por mes
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
// CHAT — ENDPOINTS
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

// POST /chat/messages  Body: { room, sender_id, recipient_id, content }
app.post("/chat/messages", async (req, res) => {
  try {
    const { room, sender_id, recipient_id, content } = req.body || {};
    if (!room || !sender_id || !content) {
      return res.json({
        ok: false,
        msg: "Faltan room, sender_id o content",
      });
    }

    const { data: msg, error } = await supabase
      .from("messages")
      .insert({
        room,
        sender_id,
        content,
      })
      .select()
      .single();

    if (error) {
      console.error("Error insertando mensaje de chat:", error);
      return res.json({
        ok: false,
        msg: "No se pudo guardar el mensaje",
      });
    }

    // Notificación + email al destinatario
    if (recipient_id) {
      try {
        const { data: recipient, error: recErr } = await supabase
          .from("profiles")
          .select("email, first_name, last_name")
          .eq("id", recipient_id)
          .maybeSingle();

        if (recErr) {
          console.error("Error buscando destinatario chat:", recErr);
        } else if (recipient && recipient.email) {
          const { data: sender } = await supabase
            .from("profiles")
            .select("first_name, last_name, email")
            .eq("id", sender_id)
            .maybeSingle();

          const senderName =
            (sender
              ? `${sender.first_name || ""} ${
                  sender.last_name || ""
                }`.trim()
              : "") || "tu profesora";

          const baseMsg = `Tenés un mensaje nuevo en el chat del Campus PauPau.`;
          const notifMsg = `${baseMsg} Remitente: ${senderName}.`;

          await createNotification({
            user_id: recipient_id,
            type: "chat",
            message: notifMsg,
            ref_id: msg.id,
          });

          const subject = "Nuevo mensaje en el chat de PauPau Campus";
          const text = `Hola ${
            recipient.first_name || ""
          } 👋\n\n${senderName} te envió un mensaje nuevo en el chat del campus.\n\nMensaje:\n"${content}"\n\nIngresá al Campus PauPau para responder.\n\n— Equipo PauPau`;
          await sendNotificationEmail(recipient.email, subject, text);
        }
      } catch (e) {
        console.error("Error creando notificación de chat:", e);
      }
    }

    return res.json({ ok: true, message: msg });
  } catch (err) {
    console.error("Error general POST /chat/messages:", err);
    return res.json({ ok: false, msg: "Error interno" });
  }
});

// =====================================================
// ASSIGNMENTS — CREAR (prof/admin)
// =====================================================
// Body: { teacher_id, student_id, title, description, file_url }
app.post("/assignments/create", async (req, res) => {
  try {
    const { teacher_id, student_id, title, description, file_url } =
      req.body || {};
    if (!teacher_id || !student_id || !title) {
      return res.json({
        ok: false,
        msg: "Faltan teacher_id, student_id o title",
      });
    }

    const { data, error } = await supabase
      .from("assignments")
      .insert({
        teacher_id,
        student_id,
        title,
        description: description || null,
        file_url: file_url || null,
      })
      .select()
      .single();

    if (error) {
      console.error("Error creando assignment:", error);
      return res.json({ ok: false, msg: "No se pudo crear la tarea." });
    }

    // Notificación + email al alumno
    try {
      const { data: student, error: stErr } = await supabase
        .from("profiles")
        .select("email, first_name, last_name")
        .eq("id", student_id)
        .maybeSingle();

      if (stErr) {
        console.error("Error buscando alumno assignment:", stErr);
      } else if (student && student.email) {
        const fullName =
          `${student.first_name || ""} ${student.last_name || ""}`.trim() ||
          "";
        const msg = `Se te asignó una nueva tarea: "${title}".`;

        await createNotification({
          user_id: student_id,
          type: "assignment",
          message: msg,
          ref_id: data.id,
        });

        const subject = "Nueva tarea en PauPau Campus";
        const text = `Hola ${fullName || "alumno/a"} 👋\n\n${msg}\n\nPodés verla y subir tu respuesta en la sección Tareas del Campus PauPau.\n\n— Equipo PauPau`;
        await sendNotificationEmail(student.email, subject, text);
      }
    } catch (e) {
      console.error("Error creando notificación assignment:", e);
    }

    return res.json({ ok: true, assignment: data });
  } catch (err) {
    console.error("Error general /assignments/create:", err);
    return res.json({ ok: false, msg: "Error interno" });
  }
});

// =====================================================
// RECORDINGS — CREAR (prof/admin)
// =====================================================
// Body: { teacher_id, student_id, title, description, video_url }
app.post("/recordings/create", async (req, res) => {
  try {
    const { teacher_id, student_id, title, description, video_url } =
      req.body || {};
    if (!teacher_id || !student_id || !title || !video_url) {
      return res.json({
        ok: false,
        msg: "Faltan teacher_id, student_id, title o video_url",
      });
    }

    const { data, error } = await supabase
      .from("recordings")
      .insert({
        teacher_id,
        student_id,
        title,
        description: description || null,
        video_url,
      })
      .select()
      .single();

    if (error) {
      console.error("Error creando recording:", error);
      return res.json({ ok: false, msg: "No se pudo guardar la grabación." });
    }

    // Notificación + email al alumno
    try {
      const { data: student, error: stErr } = await supabase
        .from("profiles")
        .select("email, first_name, last_name")
        .eq("id", student_id)
        .maybeSingle();

      if (stErr) {
        console.error("Error buscando alumno recording:", stErr);
      } else if (student && student.email) {
        const fullName =
          `${student.first_name || ""} ${student.last_name || ""}`.trim() ||
          "";
        const msg = `Tu profesora cargó una nueva clase grabada: "${title}".`;

        await createNotification({
          user_id: student_id,
          type: "recording",
          message: msg,
          ref_id: data.id,
        });

        const subject = "Nueva clase grabada en PauPau Campus";
        const text = `Hola ${fullName || "alumno/a"} 👋\n\n${msg}\n\nPodés verla en la sección Clases grabadas del Campus PauPau.\n\n— Equipo PauPau`;
        await sendNotificationEmail(student.email, subject, text);
      }
    } catch (e) {
      console.error("Error creando notificación recording:", e);
    }

    return res.json({ ok: true, recording: data });
  } catch (err) {
    console.error("Error general /recordings/create:", err);
    return res.json({ ok: false, msg: "Error interno" });
  }
});

// =====================================================
// TEST EMAIL — para probar Nodemailer
// =====================================================
app.get("/test-email", async (req, res) => {
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM,
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

// ============================
// START SERVER
// ============================
app.listen(PORT, () => {
  console.log(`🚀 Backend PauPau corriendo en puerto ${PORT}`);
});
