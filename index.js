import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const resend = new Resend(process.env.RESEND_API_KEY);

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3001;

// ─── Validar env ──────────────────────────────────────────────────────────────
if (!process.env.BOLD_SECRET_KEY) console.error("❌ Falta BOLD_SECRET_KEY");
if (!process.env.SUPABASE_URL) console.error("❌ Falta SUPABASE_URL");
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) console.error("❌ Falta SUPABASE_SERVICE_ROLE_KEY");
if (!process.env.AGENDAPRO_BOT_URL) console.error("❌ Falta AGENDAPRO_BOT_URL");
if (!process.env.AGENDAPRO_BOT_API_KEY) console.error("❌ Falta AGENDAPRO_BOT_API_KEY");
if (!process.env.RESEND_API_KEY) console.error("❌ Falta RESEND_API_KEY");
if (!process.env.EMAIL_FROM) console.error("❌ Falta EMAIL_FROM");
if (!process.env.ADMIN_EMAIL) console.error("⚠️ Falta ADMIN_EMAIL");

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatCOP(value) {
  return Number(value || 0).toLocaleString("es-CO");
}

function formatFecha(isoString) {
  return new Date(isoString).toLocaleDateString("es-CO", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

function extractBoldIds(payload) {
  const payment_id =
    payload?.data?.payment_id ||
    payload?.data?.id ||
    payload?.subject ||
    null;

  const order_id =
    payload?.data?.metadata?.reference ||
    payload?.data?.reference ||
    payload?.reference ||
    null;

  return { payment_id, order_id };
}

async function findOrder({ order_id, payment_id }) {
  if (order_id) {
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .eq("bold_order_id", order_id)
      .maybeSingle();

    if (error) {
      console.error("❌ Error buscando por bold_order_id:", error.message);
    }

    if (data) return data;
  }

  if (payment_id) {
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .eq("bold_transaction_id", payment_id)
      .maybeSingle();

    if (error) {
      console.error("❌ Error buscando por bold_transaction_id:", error.message);
    }

    if (data) return data;
  }

  return null;
}

// ─── Correos ──────────────────────────────────────────────────────────────────
function buildClienteHTML(pedido, order_id) {
  const fecha = formatFecha(pedido.created_at);

  const itemsHTML = (pedido.items || []).map(item => {
    const nombre = item.nombre ?? item.name;
    const cantidad = item.cantidad ?? item.quantity;
    const precio = (item.price ?? item.precio ?? 0) * cantidad;

    return `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;">${nombre}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;">${cantidad}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">&#36;${formatCOP(precio)}</td>
      </tr>`;
  }).join("");

  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#333;">
      <div style="background:#e91e8c;padding:24px;text-align:center;">
        <h1 style="color:#fff;margin:0;font-size:22px;">Gracias por tu compra!</h1>
        <p style="color:#fff;margin:8px 0 0;font-size:14px;">${fecha}</p>
      </div>

      <div style="padding:24px;">
        <p>Hola <strong>${pedido.nombre_completo}</strong>,</p>
        <p>Hemos recibido tu pago correctamente. Aqui estan los detalles de tu pedido:</p>

        <table style="width:100%;border-collapse:collapse;margin:16px 0;">
          <thead>
            <tr style="background:#f5f5f5;">
              <th style="padding:8px 12px;text-align:left;">Producto</th>
              <th style="padding:8px 12px;text-align:center;">Cant.</th>
              <th style="padding:8px 12px;text-align:right;">Subtotal</th>
            </tr>
          </thead>
          <tbody>${itemsHTML}</tbody>
        </table>

        <table style="width:100%;margin-top:8px;">
          <tr>
            <td style="padding:4px 12px;">Subtotal</td>
            <td style="padding:4px 12px;text-align:right;">&#36;${formatCOP(pedido.subtotal)}</td>
          </tr>
          <tr>
            <td style="padding:4px 12px;">Envio</td>
            <td style="padding:4px 12px;text-align:right;">&#36;${formatCOP(pedido.envio ?? 0)}</td>
          </tr>
          <tr style="font-weight:bold;font-size:16px;">
            <td style="padding:8px 12px;">Total pagado</td>
            <td style="padding:8px 12px;text-align:right;">&#36;${formatCOP(pedido.total)} COP</td>
          </tr>
        </table>

        ${pedido.direccion ? `
        <p style="margin-top:16px;">
          <strong>Direccion de entrega:</strong><br/>
          ${pedido.direccion}${pedido.barrio ? `, ${pedido.barrio}` : ""}
        </p>` : ""}

        <p style="margin-top:16px;font-size:13px;color:#666;">
          No. de orden: <code>${order_id}</code>
        </p>

        <p>Si tienes alguna pregunta, responde a este correo. Nos vemos pronto!</p>
      </div>

      <div style="background:#f5f5f5;padding:16px;text-align:center;font-size:12px;color:#999;">
        &copy; ${new Date().getFullYear()} Emarizos &middot; Todos los derechos reservados
      </div>
    </div>
  `;
}

function buildAdminHTML(pedido, order_id, payment_id) {
  const fecha = formatFecha(pedido.created_at);

  const itemsHTML = (pedido.items || []).map(item => {
    const nombre = item.nombre ?? item.name;
    const cantidad = item.cantidad ?? item.quantity;
    const precio = (item.price ?? item.precio ?? 0) * cantidad;

    return `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;">${nombre}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;">${cantidad}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">&#36;${formatCOP(precio)}</td>
      </tr>`;
  }).join("");

  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#333;">
      <div style="background:#222;padding:24px;text-align:center;">
        <h1 style="color:#fff;margin:0;font-size:22px;">Nuevo pedido pagado!</h1>
        <p style="color:#aaa;margin:8px 0 0;font-size:14px;">${fecha}</p>
      </div>

      <div style="padding:24px;">
        <p style="background:#fef08a;padding:8px 12px;border-radius:6px;font-weight:bold;color:#854d0e;display:inline-block;">
          ESTADO DE ENVIO: PENDIENTE
        </p>

        <h3 style="margin-top:20px;">Datos del cliente</h3>
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:4px 0;"><strong>Nombre:</strong></td><td>${pedido.nombre_completo}</td></tr>
          <tr><td style="padding:4px 0;"><strong>Email:</strong></td><td>${pedido.email ?? "No proporcionado"}</td></tr>
          <tr><td style="padding:4px 0;"><strong>Telefono:</strong></td><td>${pedido.telefono ?? "No proporcionado"}</td></tr>
          <tr><td style="padding:4px 0;"><strong>Direccion:</strong></td><td>${pedido.direccion ?? ""}${pedido.barrio ? `, ${pedido.barrio}` : ""}</td></tr>
        </table>

        <h3 style="margin-top:20px;">Detalle del pedido</h3>
        <table style="width:100%;border-collapse:collapse;margin:8px 0;">
          <thead>
            <tr style="background:#f5f5f5;">
              <th style="padding:8px 12px;text-align:left;">Producto</th>
              <th style="padding:8px 12px;text-align:center;">Cant.</th>
              <th style="padding:8px 12px;text-align:right;">Subtotal</th>
            </tr>
          </thead>
          <tbody>${itemsHTML}</tbody>
        </table>

        <table style="width:100%;margin-top:8px;">
          <tr>
            <td style="padding:4px 12px;">Subtotal</td>
            <td style="padding:4px 12px;text-align:right;">&#36;${formatCOP(pedido.subtotal)}</td>
          </tr>
          <tr>
            <td style="padding:4px 12px;">Envio</td>
            <td style="padding:4px 12px;text-align:right;">&#36;${formatCOP(pedido.envio ?? 0)}</td>
          </tr>
          <tr style="font-weight:bold;font-size:16px;">
            <td style="padding:8px 12px;">Total a despachar</td>
            <td style="padding:8px 12px;text-align:right;">&#36;${formatCOP(pedido.total)} COP</td>
          </tr>
        </table>

        <p style="margin-top:16px;font-size:13px;color:#666;">
          No. de orden: <code>${order_id}</code><br/>
          Transaccion Bold: <code>${payment_id ?? "N/A"}</code>
        </p>
      </div>

      <div style="background:#f5f5f5;padding:16px;text-align:center;font-size:12px;color:#999;">
        Sistema interno Emarizos
      </div>
    </div>
  `;
}

// ─── Webhook de Bold ──────────────────────────────────────────────────────────
// metadata.reference puede venir null en Bold, así que se debe manejar fallback. [web:2]
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const rawBody = req.body.toString("utf-8");
    const payload = JSON.parse(rawBody);

    console.log("📬 Webhook recibido:", payload.type);
    console.log("🧾 Payload Bold:", JSON.stringify(payload, null, 2));

    if (payload.type === "SALE_APPROVED") {
      const { payment_id, order_id } = extractBoldIds(payload);

      console.log("🔍 order_id:", order_id, "| payment_id:", payment_id);

      const pedido = await findOrder({ order_id, payment_id });

      if (!pedido) {
        console.error("❌ Pedido no encontrado:", {
          order_id,
          payment_id,
          boldReference: payload?.data?.metadata?.reference ?? null,
        });
        return res.status(200).send("OK");
      }

      const resolvedOrderId = pedido.bold_order_id;

      if (pedido.estado_pago === "pagado" || pedido.estado_pago === "sincronizado") {
        console.log(`⏭️ Pedido ${resolvedOrderId} ya procesado, se omite`);
        return res.status(200).send("OK");
      }

      const updatePayload = {
        estado_pago: "pagado",
        pagado_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      if (payment_id && !pedido.bold_transaction_id) {
        updatePayload.bold_transaction_id = payment_id;
      }

      const { error: updateError } = await supabase
        .from("orders")
        .update(updatePayload)
        .eq("id", pedido.id);

      if (updateError) {
        console.error("❌ Error actualizando orden:", updateError.message);
        return res.status(500).send("Error actualizando orden");
      }

      console.log(`✅ Orden ${resolvedOrderId} marcada como pagada. TX: ${payment_id}`);

      try {
        const emailFrom = process.env.EMAIL_FROM;
        const adminEmail = process.env.ADMIN_EMAIL;
        const correosAEnviar = [];

        if (pedido.email) {
          correosAEnviar.push(
            resend.emails.send({
              from: `Emarizos <${emailFrom}>`,
              to: pedido.email,
              subject: `Confirmacion de tu pedido en Emarizos - ${resolvedOrderId}`,
              html: buildClienteHTML(pedido, resolvedOrderId),
            }).then(({ data, error }) => {
              if (error) {
                console.error("❌ Error correo cliente:", error);
              } else {
                console.log(`✅ Correo cliente enviado a ${pedido.email} (ID: ${data?.id})`);
              }
            })
          );
        } else {
          console.log(`⚠️ Orden ${resolvedOrderId} sin email de cliente.`);
        }

        if (adminEmail) {
          correosAEnviar.push(
            resend.emails.send({
              from: `Sistema Emarizos <${emailFrom}>`,
              to: adminEmail,
              subject: `Nuevo pedido pagado - ${resolvedOrderId}`,
              html: buildAdminHTML(pedido, resolvedOrderId, payment_id),
            }).then(({ data, error }) => {
              if (error) {
                console.error("❌ Error correo admin:", error);
              } else {
                console.log(`✅ Correo admin enviado a ${adminEmail} (ID: ${data?.id})`);
              }
            })
          );
        }

        await Promise.all(correosAEnviar);
      } catch (emailErr) {
        console.error("❌ Error enviando correos:", emailErr.message);
      }

      try {
        const productos = (pedido.items || []).map(item => ({
          nombre: item.nombre ?? item.name,
          cantidad: item.cantidad ?? item.quantity,
        }));

        const agendaRes = await fetch(`${process.env.AGENDAPRO_BOT_URL}/venta`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": process.env.AGENDAPRO_BOT_API_KEY,
          },
          body: JSON.stringify({
            order_id: resolvedOrderId,
            payment_id,
            productos,
            cliente: {
              nombre_completo: pedido.nombre_completo,
              email: pedido.email,
              telefono: pedido.telefono,
            },
          }),
        });

        let agendaData = null;
        try {
          agendaData = await agendaRes.json();
        } catch {
          agendaData = null;
        }

        if (!agendaRes.ok) {
          throw new Error(`AgendaPro HTTP ${agendaRes.status}`);
        }

        console.log("✅ Respuesta AgendaPro:", agendaData);

        const agendaOk = agendaData?.ok === true;
        const agendaMensaje = String(agendaData?.mensaje || "").toLowerCase();
        const fueSoloEncolado = agendaMensaje.includes("encolada");

        if (agendaOk) {
          await supabase
            .from("orders")
            .update({
              r_agendapro: true,
              updated_at: new Date().toISOString(),
            })
            .eq("id", pedido.id);

          if (fueSoloEncolado) {
            console.log(`⏳ Pedido ${resolvedOrderId} enviado a cola de AgendaPro, pero no se marca como sincronizado aún`);
          } else {
            await supabase
              .from("orders")
              .update({
                estado_pago: "sincronizado",
                updated_at: new Date().toISOString(),
              })
              .eq("id", pedido.id);

            console.log(`✅ Pedido ${resolvedOrderId} sincronizado con AgendaPro`);
          }
        } else {
          throw new Error(agendaData?.mensaje || "Respuesta no válida de AgendaPro");
        }
      } catch (agendaErr) {
        console.error("❌ Error llamando AgendaPro:", agendaErr.message);

        await supabase
          .from("orders")
          .update({
            agendapro_error: agendaErr.message,
            updated_at: new Date().toISOString(),
          })
          .eq("id", pedido.id);
      }
    }

    if (payload.type === "SALE_REJECTED") {
      const { order_id } = extractBoldIds(payload);
      console.log("🔍 order_id rechazado:", order_id);

      if (order_id) {
        const { error } = await supabase
          .from("orders")
          .update({
            estado_pago: "error",
            updated_at: new Date().toISOString(),
          })
          .eq("bold_order_id", order_id);

        if (error) {
          console.error("❌ Error actualizando orden rechazada:", error.message);
        } else {
          console.log(`❌ Orden ${order_id} marcada como error.`);
        }
      } else {
        console.warn("⚠️ SALE_REJECTED sin order_id resoluble");
      }
    }

    return res.status(200).send("OK");
  } catch (err) {
    console.error("❌ Error en webhook:", err.message);
    return res.status(500).send("Error interno");
  }
});

// ─── Parser JSON ──────────────────────────────────────────────────────────────
app.use(express.json());

// ─── Generar firma de integridad ──────────────────────────────────────────────
function generateSignature(orderId, amount, currency) {
  const secret = process.env.BOLD_SECRET_KEY;
  const raw = `${orderId}${amount}${currency}${secret}`;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

// ─── Crear orden ──────────────────────────────────────────────────────────────
app.post("/create-order", async (req, res) => {
  try {
    const {
      nombre_completo,
      email,
      telefono,
      direccion,
      barrio,
      ciudad,
      departamento,
      notas,
      items,
      envio
    } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: "No hay productos" });
    }

    const subtotal = items.reduce((acc, item) => acc + (item.price * item.quantity), 0);
    const total = subtotal + (envio || 0);
    const orderId = `ORDER_${Date.now()}`;
    const amount = String(total);
    const signature = generateSignature(orderId, amount, "COP");

    const { error: dbError } = await supabase.from("orders").insert({
      bold_order_id: orderId,
      nombre_completo,
      email,
      telefono,
      direccion: direccion || "",
      barrio: barrio || "",
      ciudad: ciudad || "",
      departamento: departamento || "",
      notas: notas || "",
      items,
      subtotal,
      envio: envio || 0,
      total,
      estado_pago: "pendiente",
      r_agendapro: false,
    });

    if (dbError) {
      console.error("❌ Error guardando orden:", dbError.message);
      return res.status(500).json({ error: "No se pudo guardar la orden" });
    }

    console.log("💾 Orden guardada:", orderId);

    return res.json({
      orderId,
      amount,
      currency: "COP",
      integritySignature: signature,
      description: `Compra En Ema Rizos - ${nombre_completo}`,
      reference: orderId,
    });
  } catch (error) {
    console.error("❌ Error creando orden:", error.message);
    return res.status(500).json({ error: "Error creando orden" });
  }
});

// ─── Consultar estado de orden ────────────────────────────────────────────────
app.get("/order-status/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;

    const { data, error } = await supabase
      .from("orders")
      .select("estado_pago, nombre_completo, email, items, subtotal, envio, total, direccion, barrio, bold_transaction_id, r_agendapro, agendapro_error, pagado_at")
      .eq("bold_order_id", orderId)
      .maybeSingle();

    if (error) {
      console.error("❌ Error consultando orden:", error.message);
      return res.status(500).json({ error: "Error consultando orden" });
    }

    if (!data) {
      return res.status(404).json({ error: "Orden no encontrada" });
    }

    return res.json(data);
  } catch (err) {
    console.error("❌ Error en order-status:", err.message);
    return res.status(500).json({ error: "Error interno" });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.send("🚀 Servidor Emarizos corriendo");
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});
