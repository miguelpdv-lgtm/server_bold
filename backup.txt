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
if (!process.env.BOLD_API_KEY) console.error("❌ Falta BOLD_API_KEY (Necesaria para polling)");
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

    if (error) console.error("❌ Error buscando por bold_order_id:", error.message);
    if (data) return data;
  }

  if (payment_id) {
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .eq("bold_transaction_id", payment_id)
      .maybeSingle();

    if (error) console.error("❌ Error buscando por bold_transaction_id:", error.message);
    if (data) return data;
  }

  return null;
}

async function findOrderWithRetry({ order_id, payment_id }, maxWaitMs = 15_000) {
  const interval = 3_000;
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    const pedido = await findOrder({ order_id, payment_id });
    if (pedido) return pedido;

    console.log(`⏳ Orden ${order_id} no encontrada aún, reintentando en 3s...`);
    await new Promise((r) => setTimeout(r, interval));
  }

  return null;
}

// ─── Correos ──────────────────────────────────────────────────────────────────
function buildClienteHTML(pedido, order_id) {
  const fecha = formatFecha(pedido.created_at || new Date().toISOString());
  const itemsHTML = (pedido.items || []).map(item => {
    const nombre = item.nombre ?? item.name;
    const cantidad = item.cantidad ?? item.quantity;
    const precio = (item.price ?? item.precio ?? 0) * cantidad;
    const idProducto = item.id ?? item.product_id ?? "";
    const imgUrl = idProducto ? `https://emarizos.co/img/products/${idProducto}.png` : "https://emarizos.co/img/favicon.png";

    return `
      <tr style="background:#ffffff;">
        <td style="padding:12px 10px;border-bottom:1px solid #f0e0dc;">
          <img src="${imgUrl}" width="48" height="48" style="display:block;border-radius:8px;border:1px solid #f0e0dc;background:#ffffff;object-fit:cover;" alt="">
        </td>
        <td style="padding:12px 10px;border-bottom:1px solid #f0e0dc;font-size:14px;color:#333;font-family:Segoe UI,Helvetica,Arial,sans-serif;">${nombre}</td>
        <td align="center" style="padding:12px 10px;border-bottom:1px solid #f0e0dc;font-size:14px;color:#333;font-family:Segoe UI,Helvetica,Arial,sans-serif;">${cantidad}</td>
        <td align="right" style="padding:12px 10px;border-bottom:1px solid #f0e0dc;font-size:14px;color:rgb(97, 24, 11);font-weight:600;font-family:Segoe UI,Helvetica,Arial,sans-serif;">&#36;${formatCOP(precio)}</td>
      </tr>`;
  }).join("");

  return `
  <!DOCTYPE html>
  <html lang="es">
  <head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Confirmacion de pedido</title>
  <style>
  @media (prefers-color-scheme: dark) {
    body, table, td { background-color: #fafafa !important; }
    .card { background-color: #ffffff !important; }
    h1, p, td, th, strong { color: #333333 !important; }
  }
  </style>
  </head>
  <body style="margin:0;padding:0;background-color:#fafafa;" bgcolor="#fafafa">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table class="card" role="presentation" cellpadding="0" cellspacing="0" width="600" bgcolor="#ffffff" style="border-collapse:collapse;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.06);max-width:600px;width:100%;">
          
          <!-- Header -->
          <tr>
            <td align="center" bgcolor="#efd3d0" style="background:#efd3d0;padding:40px 24px 32px;text-align:center;">
              <img src="https://emarizos.co/img/favicon.png" alt="Emarizos" width="120" style="display:block;margin:0 auto 16px;border:0;">
              <h1 style="color:rgb(97, 24, 11);font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:24px;font-weight:600;margin:0;letter-spacing:0.3px;">Gracias por tu compra</h1>
              <p style="color:rgb(97, 24, 11);font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;margin:10px 0 0;">${fecha}</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 32px 28px;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#333;">
              <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">Hola <strong style="color:rgb(97, 24, 11);">${pedido.nombre_completo}</strong>,</p>
              <p style="margin:0 0 28px;font-size:15px;line-height:1.6;color:#555;">Hemos recibido tu pago correctamente y tu pedido esta siendo preparado.</p>

              <!-- Tabla de productos -->
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;margin-bottom:28px;border-radius:8px;overflow:hidden;border:1px solid #e8d5d1;">
                <thead>
                  <tr>
                    <th width="60" style="padding:14px 10px;background:rgb(97, 24, 11);font-size:11px;text-transform:uppercase;letter-spacing:0.6px;color:#ffffff;font-weight:600;font-family:Segoe UI,Helvetica,Arial,sans-serif;">&nbsp;</th>
                    <th align="left" width="auto" style="padding:14px 10px;background:rgb(97, 24, 11);font-size:12px;text-transform:uppercase;letter-spacing:0.6px;color:#ffffff;font-weight:600;font-family:Segoe UI,Helvetica,Arial,sans-serif;">Producto</th>
                    <th align="center" width="60" style="padding:14px 10px;background:rgb(97, 24, 11);font-size:12px;text-transform:uppercase;letter-spacing:0.6px;color:#ffffff;font-weight:600;font-family:Segoe UI,Helvetica,Arial,sans-serif;">Cant.</th>
                    <th align="right" width="100" style="padding:14px 10px;background:rgb(97, 24, 11);font-size:12px;text-transform:uppercase;letter-spacing:0.6px;color:#ffffff;font-weight:600;font-family:Segoe UI,Helvetica,Arial,sans-serif;">Subtotal</th>
                  </tr>
                </thead>
                <tbody>
                  ${itemsHTML}
                </tbody>
              </table>

              <!-- Totales -->
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;margin-bottom:28px;">
                <tr>
                  <td align="right" style="padding:0;">
                    <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:280px;">
                      <tr>
                        <td align="right" style="padding:8px 0;font-size:14px;color:#666;font-family:Segoe UI,Helvetica,Arial,sans-serif;">Subtotal:</td>
                        <td align="right" width="110" style="padding:8px 0;font-size:14px;color:#333;font-weight:500;font-family:Segoe UI,Helvetica,Arial,sans-serif;">&#36;${formatCOP(pedido.subtotal)}</td>
                      </tr>
                      <tr>
                        <td align="right" style="padding:8px 0;font-size:14px;color:#666;font-family:Segoe UI,Helvetica,Arial,sans-serif;">Envio:</td>
                        <td align="right" style="padding:8px 0;font-size:14px;color:#333;font-weight:500;font-family:Segoe UI,Helvetica,Arial,sans-serif;">&#36;${formatCOP(pedido.envio ?? 0)}</td>
                      </tr>
                      <tr>
                        <td align="right" style="padding:12px 0 8px;font-size:16px;color:rgb(97, 24, 11);font-weight:700;border-top:2px solid #efd3d0;font-family:Segoe UI,Helvetica,Arial,sans-serif;">Total:</td>
                        <td align="right" style="padding:12px 0 8px;font-size:16px;color:rgb(97, 24, 11);font-weight:700;border-top:2px solid #efd3d0;font-family:Segoe UI,Helvetica,Arial,sans-serif;">&#36;${formatCOP(pedido.total)} COP</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              ${pedido.direccion ? `
              <!-- Direccion -->
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;background:#fdf5f3;border-radius:8px;border:1px solid #efd3d0;">
                <tr>
                  <td style="padding:18px 20px;">
                    <p style="margin:0 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;color:rgb(97, 24, 11);font-weight:600;font-family:Segoe UI,Helvetica,Arial,sans-serif;">Direccion de envio</p>
                    <p style="margin:0;font-size:14px;color:#444;line-height:1.5;font-family:Segoe UI,Helvetica,Arial,sans-serif;">${pedido.direccion}${pedido.barrio ? `, ${pedido.barrio}` : ""}</p>
                  </td>
                </tr>
              </table>` : ""}

              <p style="margin:20px 0 0;font-size:12px;color:#999;font-family:Segoe UI,Helvetica,Arial,sans-serif;">No. de orden: <span style="color:#666;font-family:Consolas,monospace;">${order_id}</span></p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="background:#f8f9fa;padding:20px;text-align:center;font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:12px;color:#aaa;border-top:1px solid #eee;">
              <p style="margin:0 0 6px;">&copy; ${new Date().getFullYear()} Emarizos. Todos los derechos reservados.</p>
              <p style="margin:0;font-size:11px;">Barranquilla, Colombia</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
  </body>
  </html>`;
}

function buildAdminHTML(pedido, order_id, payment_id) {
  const fecha = formatFecha(pedido.created_at || new Date().toISOString());
  const itemsHTML = (pedido.items || []).map(item => {
    const nombre = item.nombre ?? item.name;
    const cantidad = item.cantidad ?? item.quantity;
    const precio = (item.price ?? item.precio ?? 0) * cantidad;
    const idProducto = item.id ?? item.product_id ?? "";
    const imgUrl = idProducto ? `https://emarizos.co/img/products/${idProducto}.png` : "https://emarizos.co/img/favicon.png";

    return `
      <tr style="background:#ffffff;">
        <td style="padding:12px 10px;border-bottom:1px solid #f0e0dc;">
          <img src="${imgUrl}" width="48" height="48" style="display:block;border-radius:8px;border:1px solid #f0e0dc;background:#ffffff;object-fit:cover;" alt="">
        </td>
        <td style="padding:12px 10px;border-bottom:1px solid #f0e0dc;font-size:14px;color:#333;font-family:Segoe UI,Helvetica,Arial,sans-serif;">${nombre}</td>
        <td align="center" style="padding:12px 10px;border-bottom:1px solid #f0e0dc;font-size:14px;color:#333;font-family:Segoe UI,Helvetica,Arial,sans-serif;">${cantidad}</td>
        <td align="right" style="padding:12px 10px;border-bottom:1px solid #f0e0dc;font-size:14px;color:rgb(97, 24, 11);font-weight:600;font-family:Segoe UI,Helvetica,Arial,sans-serif;">&#36;${formatCOP(precio)}</td>
      </tr>`;
  }).join("");

  return `
  <!DOCTYPE html>
  <html lang="es">
  <head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nuevo pedido</title>
  <style>
  @media (prefers-color-scheme: dark) {
    body, table, td { background-color: #fafafa !important; }
    .card { background-color: #ffffff !important; }
    h1, p, td, th, strong { color: #333333 !important; }
  }
  </style>
  </head>
  <body style="margin:0;padding:0;background-color:#fafafa;" bgcolor="#fafafa">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table class="card" role="presentation" cellpadding="0" cellspacing="0" width="600" bgcolor="#ffffff" style="border-collapse:collapse;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.06);max-width:600px;width:100%;">
          
          <!-- Header -->
          <tr>
            <td align="center" bgcolor="rgb(97, 24, 11)" style="background:rgb(97, 24, 11);padding:40px 24px 32px;text-align:center;">
              <img src="https://emarizos.co/img/favicon.png" alt="Emarizos" width="120" style="display:block;margin:0 auto 16px;border:0;filter:brightness(0) invert(1);">
              <h1 style="color:#ffffff;font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:24px;font-weight:600;margin:0;letter-spacing:0.3px;">Nuevo pedido pagado!</h1>
              <p style="color:#efd3d0;font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;margin:10px 0 0;">${fecha}</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 32px 28px;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#333;">
              <span style="background:#fef08a;padding:6px 12px;border-radius:6px;font-size:12px;font-weight:bold;color:#854d0e;display:inline-block;margin-bottom:20px;text-transform:uppercase;letter-spacing:0.5px;">ESTADO DE ENVIO: PENDIENTE</span>
              
              <h3 style="margin:0 0 12px;color:rgb(97, 24, 11);font-size:16px;">Datos del cliente</h3>
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;background:#fdf5f3;border-radius:8px;border:1px solid #efd3d0;margin-bottom:28px;">
                <tr>
                  <td style="padding:16px;">
                    <p style="margin:0 0 8px;font-size:14px;"><strong>Nombre:</strong> ${pedido.nombre_completo}</p>
                    <p style="margin:0 0 8px;font-size:14px;"><strong>Email:</strong> ${pedido.email ?? "No proporcionado"}</p>
                    <p style="margin:0 0 8px;font-size:14px;"><strong>Telefono:</strong> ${pedido.telefono ?? "No proporcionado"}</p>
                    <p style="margin:0;font-size:14px;"><strong>Direccion:</strong> ${pedido.direccion ?? ""}${pedido.barrio ? `, ${pedido.barrio}` : ""}</p>
                  </td>
                </tr>
              </table>

              <h3 style="margin:0 0 12px;color:rgb(97, 24, 11);font-size:16px;">Detalle del pedido</h3>
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;margin-bottom:28px;border-radius:8px;overflow:hidden;border:1px solid #e8d5d1;">
                <thead>
                  <tr>
                    <th width="60" style="padding:14px 10px;background:rgb(97, 24, 11);font-size:11px;text-transform:uppercase;letter-spacing:0.6px;color:#ffffff;font-weight:600;font-family:Segoe UI,Helvetica,Arial,sans-serif;">&nbsp;</th>
                    <th align="left" width="auto" style="padding:14px 10px;background:rgb(97, 24, 11);font-size:12px;text-transform:uppercase;letter-spacing:0.6px;color:#ffffff;font-weight:600;font-family:Segoe UI,Helvetica,Arial,sans-serif;">Producto</th>
                    <th align="center" width="60" style="padding:14px 10px;background:rgb(97, 24, 11);font-size:12px;text-transform:uppercase;letter-spacing:0.6px;color:#ffffff;font-weight:600;font-family:Segoe UI,Helvetica,Arial,sans-serif;">Cant.</th>
                    <th align="right" width="100" style="padding:14px 10px;background:rgb(97, 24, 11);font-size:12px;text-transform:uppercase;letter-spacing:0.6px;color:#ffffff;font-weight:600;font-family:Segoe UI,Helvetica,Arial,sans-serif;">Subtotal</th>
                  </tr>
                </thead>
                <tbody>
                  ${itemsHTML}
                </tbody>
              </table>

              <!-- Totales -->
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;margin-bottom:20px;">
                <tr>
                  <td align="right" style="padding:0;">
                    <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:280px;">
                      <tr>
                        <td align="right" style="padding:8px 0;font-size:14px;color:#666;font-family:Segoe UI,Helvetica,Arial,sans-serif;">Subtotal:</td>
                        <td align="right" width="110" style="padding:8px 0;font-size:14px;color:#333;font-weight:500;font-family:Segoe UI,Helvetica,Arial,sans-serif;">&#36;${formatCOP(pedido.subtotal)}</td>
                      </tr>
                      <tr>
                        <td align="right" style="padding:8px 0;font-size:14px;color:#666;font-family:Segoe UI,Helvetica,Arial,sans-serif;">Envio:</td>
                        <td align="right" style="padding:8px 0;font-size:14px;color:#333;font-weight:500;font-family:Segoe UI,Helvetica,Arial,sans-serif;">&#36;${formatCOP(pedido.envio ?? 0)}</td>
                      </tr>
                      <tr>
                        <td align="right" style="padding:12px 0 8px;font-size:16px;color:rgb(97, 24, 11);font-weight:700;border-top:2px solid #efd3d0;font-family:Segoe UI,Helvetica,Arial,sans-serif;">Total a despachar:</td>
                        <td align="right" style="padding:12px 0 8px;font-size:16px;color:rgb(97, 24, 11);font-weight:700;border-top:2px solid #efd3d0;font-family:Segoe UI,Helvetica,Arial,sans-serif;">&#36;${formatCOP(pedido.total)} COP</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <p style="margin:20px 0 0;font-size:12px;color:#999;font-family:Segoe UI,Helvetica,Arial,sans-serif;">No. de orden: <span style="color:#666;font-family:Consolas,monospace;">${order_id}</span><br>Transaccion Bold: <span style="color:#666;font-family:Consolas,monospace;">${payment_id ?? "N/A"}</span></p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="background:#f8f9fa;padding:20px;text-align:center;font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:12px;color:#aaa;border-top:1px solid #eee;">
              <p style="margin:0;">Sistema interno Emarizos</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
  </body>
  </html>`;
}

// ─── Lógica principal de venta aprobada (reutilizable) ───────────────────────
async function processApprovedSale(pedido, payment_id, source = "Webhook") {
  const resolvedOrderId = pedido.bold_order_id;

  const updatePayload = {
    estado_pago: "pagado",
    pagado_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  if (payment_id && !pedido.bold_transaction_id) {
    updatePayload.bold_transaction_id = payment_id;
  }

  // Check y update atómico en la misma consulta para evitar Race Conditions
  const { data: updated, error: updateError } = await supabase
    .from("orders")
    .update(updatePayload)
    .eq("id", pedido.id)
    .in("estado_pago", ["pendiente", "error"]) 
    .select()
    .maybeSingle();

  if (updateError) {
    console.error("❌ Error actualizando orden:", updateError.message);
    return;
  }

  if (!updated) {
    console.log(`⏭️ [${source}] Pedido ${resolvedOrderId} ya fue procesado por otro request. Se omite.`);
    return;
  }

  // Calcular métrica de tiempo de llegada
  const demoraMs = Date.now() - new Date(pedido.created_at).getTime();
  const demoraMinutos = (demoraMs / 1000 / 60).toFixed(1);
  console.log(`⏱️ MÉTRICA: La confirmación vía ${source} tardó ${demoraMinutos} minutos.`);

  console.log(`✅ Orden ${resolvedOrderId} marcada como pagada vía ${source}. TX: ${payment_id}`);

  // ── Correos ────────────────────────────────────────────────────────────────
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
          if (error) console.error("❌ Error correo cliente:", error);
          else console.log(`✅ Correo cliente enviado a ${pedido.email} (ID: ${data?.id})`);
        })
      );
    }

    if (adminEmail) {
      correosAEnviar.push(
        resend.emails.send({
          from: `Sistema Emarizos <${emailFrom}>`,
          to: adminEmail,
          subject: `Nuevo pedido pagado - ${resolvedOrderId}`,
          html: buildAdminHTML(pedido, resolvedOrderId, payment_id),
        }).then(({ data, error }) => {
          if (error) console.error("❌ Error correo admin:", error);
          else console.log(`✅ Correo admin enviado a ${adminEmail} (ID: ${data?.id})`);
        })
      );
    }

    await Promise.all(correosAEnviar);
  } catch (emailErr) {
    console.error("❌ Error enviando correos:", emailErr.message);
  }

  // ── AgendaPro ──────────────────────────────────────────────────────────────
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
    try { agendaData = await agendaRes.json(); } catch { agendaData = null; }

    if (!agendaRes.ok) throw new Error(`AgendaPro HTTP ${agendaRes.status}`);

    console.log("✅ Respuesta AgendaPro:", agendaData);

    const agendaOk = agendaData?.ok === true;
    const agendaMensaje = String(agendaData?.mensaje || "").toLowerCase();
    const fueSoloEncolado = agendaMensaje.includes("encolada");

    if (agendaOk) {
      await supabase.from("orders").update({ r_agendapro: true, updated_at: new Date().toISOString() }).eq("id", pedido.id);

      if (fueSoloEncolado) {
        console.log(`⏳ Pedido ${resolvedOrderId} encolado en AgendaPro`);
      } else {
        await supabase.from("orders").update({ estado_pago: "sincronizado", updated_at: new Date().toISOString() }).eq("id", pedido.id);
        console.log(`✅ Pedido ${resolvedOrderId} sincronizado con AgendaPro`);
      }
    } else {
      throw new Error(agendaData?.mensaje || "Respuesta no válida de AgendaPro");
    }
  } catch (agendaErr) {
    console.error("❌ Error llamando AgendaPro:", agendaErr.message);
    await supabase.from("orders").update({ agendapro_error: agendaErr.message, updated_at: new Date().toISOString() }).eq("id", pedido.id);
  }
}

// ─── POLLING ACTIVO: Consulta a la API de Bold ────────────────────────────────
async function checkPendingOrders() {
  if (!process.env.BOLD_API_KEY) return; // Evitar que rompa si no configuras el API Key
  
  try {
    // Buscar órdenes pendientes de la última hora
    const haceUnaHora = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    
    const { data: ordenesPendientes, error } = await supabase
      .from("orders")
      .select("*")
      .eq("estado_pago", "pendiente")
      .gt("created_at", haceUnaHora);

    if (error || !ordenesPendientes || ordenesPendientes.length === 0) return;

    for (const pedido of ordenesPendientes) {
      const orderId = pedido.bold_order_id;
      
      try {
        const res = await fetch(`https://payments.api.bold.co/v2/payment-voucher/${orderId}?is_external_reference=true`, {
          method: "GET",
          headers: {
            "Authorization": `x-api-key ${process.env.BOLD_API_KEY}` 
          }
        });

        if (!res.ok) continue; // Puede ser 404 si el usuario nunca pagó o abandonó la página

        const boldData = await res.json();
        
        if (boldData.payment_status === "APPROVED") {
          console.log(`[POLLING] ¡Orden ${orderId} aprobada identificada por API directa!`);
          await processApprovedSale(pedido, boldData.transaction_id, "Polling API");
        } else if (boldData.payment_status === "REJECTED" || boldData.payment_status === "FAILED") {
          console.log(`[POLLING] Orden ${orderId} rechazada. Cancelando...`);
          await supabase.from("orders").update({ estado_pago: "error" }).eq("id", pedido.id);
        }
      } catch (err) {
        console.error(`❌ Error consultando API para ${orderId}:`, err.message);
      }
    }
  } catch (err) {
    console.error("❌ Error general en cron job de polling:", err.message);
  }
}

// ─── Worker recursivo de seguridad ─────────────────────────────────────────────
async function processPendingWebhooks() {
  try {
    const { data: pending } = await supabase
      .from("pending_webhooks")
      .select("*")
      .lte("next_retry_at", new Date().toISOString())
      .lt("intentos", 10)
      .order("created_at", { ascending: true })
      .limit(5);

    if (!pending?.length) return;

    for (const row of pending) {
      const { payment_id, order_id } = extractBoldIds(row.payload);
      const pedido = await findOrder({ order_id, payment_id });

      if (!pedido) {
        const delay = Math.min(30_000 * Math.pow(2, row.intentos), 30 * 60_000);
        await supabase.from("pending_webhooks").update({
          intentos: row.intentos + 1,
          ultimo_error: `Intento ${row.intentos + 1}: pedido aún no existe`,
          next_retry_at: new Date(Date.now() + delay).toISOString(),
        }).eq("id", row.id);
        console.warn(`⏳ Reintento ${row.intentos + 1} fallido para ${order_id}, próximo en ${delay / 1000}s`);
        continue;
      }

      console.log(`🔄 Reprocesando webhook encolado: ${order_id}`);
      try {
        await processApprovedSale(pedido, payment_id, "Worker");
        await supabase.from("pending_webhooks").delete().eq("id", row.id);
        console.log(`✅ Webhook encolado procesado y eliminado: ${order_id}`);
      } catch (err) {
        const delay = Math.min(30_000 * Math.pow(2, row.intentos), 30 * 60_000);
        await supabase.from("pending_webhooks").update({
          intentos: row.intentos + 1,
          ultimo_error: err.message,
          next_retry_at: new Date(Date.now() + delay).toISOString(),
        }).eq("id", row.id);
      }
    }
  } catch (err) {
    console.error("❌ Error en worker pending_webhooks:", err.message);
  }
}

async function scheduleWorker() {
  await processPendingWebhooks();
  await checkPendingOrders(); // 🔥 Ejecuta el polling junto al ciclo de mantenimiento
  setTimeout(scheduleWorker, 60_000); // 1 minuto entre ejecuciones
}
scheduleWorker();

// ─── GET /webhook — verificación de Bold ─────────────────────────────────────
app.get("/webhook", (_req, res) => {
  res.status(200).send("OK");
});

// ─── Webhook de Bold ──────────────────────────────────────────────────────────
app.post("/webhook", express.raw({ type: "*/*" }), async (req, res) => {
  // Responder 200 inmediatamente
  res.status(200).send("OK");

  try {
    if (!req.body || !Buffer.isBuffer(req.body)) {
      console.error("❌ req.body vacío o inválido");
      return;
    }

    const rawBody = req.body.toString("utf-8");
    const signature = req.headers["x-bold-signature"] || req.headers["bold-signature"];

    if (!signature) {
      console.warn("⚠️ Webhook ignorado: Falta el header de firma.");
      return;
    }

    const encodedBody = Buffer.from(rawBody, "utf-8").toString("base64");
    const expected = crypto
      .createHmac("sha256", process.env.BOLD_SECRET_KEY)
      .update(encodedBody)
      .digest("hex");

    if (signature !== expected) {
      console.warn("⚠️ Webhook ignorado: Firma inválida.");
      return;
    }

    const payload = JSON.parse(rawBody);

    console.log("📬 Webhook recibido y validado:", payload.type);

    // ── SALE_APPROVED ────────────────────────────────────────────────────────
    if (payload.type === "SALE_APPROVED") {
      const { payment_id, order_id } = extractBoldIds(payload);

      if (!order_id || !String(order_id).startsWith("ORDER_")) return;

      const pedido = await findOrderWithRetry({ order_id, payment_id }, 15_000);

      if (!pedido) {
        await supabase.from("pending_webhooks").insert({
          payload,
          intentos: 0,
          ultimo_error: "Pedido no encontrado tras 15s de reintentos",
          next_retry_at: new Date(Date.now() + 30_000).toISOString(),
        });
        return;
      }

      await processApprovedSale(pedido, payment_id, "Webhook");
    }

    // ── SALE_REJECTED ────────────────────────────────────────────────────────
    if (payload.type === "SALE_REJECTED") {
      const { order_id } = extractBoldIds(payload);
      if (!order_id || !String(order_id).startsWith("ORDER_")) return;

      await supabase
        .from("orders")
        .update({ estado_pago: "error", updated_at: new Date().toISOString() })
        .eq("bold_order_id", order_id);
    }
  } catch (err) {
    console.error("❌ Error en webhook:", err.message);
  }
});

// ─── Parser JSON (debe ir DESPUÉS del webhook) ────────────────────────────────
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
    const { nombre_completo, email, telefono, direccion, barrio, ciudad, departamento, notas, items, envio } = req.body;

    if (!items || items.length === 0) return res.status(400).json({ error: "No hay productos" });

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

    if (dbError) return res.status(500).json({ error: "No se pudo guardar la orden" });
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

    if (error || !data) return res.status(404).json({ error: "Orden no encontrada" });

    return res.json(data);
  } catch (err) {
    return res.status(500).json({ error: "Error interno" });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.send("🚀 Servidor Emarizos corriendo");
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});
