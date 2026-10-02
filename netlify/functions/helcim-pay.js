// dist/helcim-pay.js
var HELCIM_API = "https://api.helcim.com/v2";
var json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body)
});
async function helcimFetch(path, { method = "GET", token, body } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25e3);
  try {
    const res = await fetch(`${HELCIM_API}${path}`, {
      method,
      signal: ctrl.signal,
      headers: {
        "accept": "application/json",
        "content-type": "application/json",
        "api-token": token
      },
      body: body ? JSON.stringify(body) : void 0
    });
    let data = {};
    try {
      data = await res.json();
    } catch (e) {
    }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(t);
  }
}
function helcimErrorMessage(data, status) {
  if (!data || typeof data !== "object") return `Helcim request failed (HTTP ${status})`;
  if (typeof data.errors === "string") return data.errors;
  if (Array.isArray(data.errors)) {
    return data.errors.map((e) => typeof e === "string" ? e : e.message || JSON.stringify(e)).join("; ");
  }
  if (typeof data.message === "string" && data.message.toLowerCase() !== "error") return data.message;
  return `Helcim request failed (HTTP ${status})`;
}
exports.handler = async (event) => {
  if (event.headers["x-manager-key"] !== process.env.MANAGER_KEY) {
    return json(401, { error: "unauthorized" });
  }
  const token = process.env.HELCIM_API_TOKEN;
  const subdomain = process.env.HELCIM_SUBDOMAIN;
  if (event.httpMethod === "GET") {
    return json(200, {
      ok: true,
      configured: Boolean(token && subdomain),
      message: token && subdomain ? "Helcim is configured. POST to create an invoice." : "Missing HELCIM_API_TOKEN and/or HELCIM_SUBDOMAIN env vars."
    });
  }
  if (event.httpMethod !== "POST") {
    return json(405, { error: "POST only" });
  }
  if (!token || !subdomain) {
    return json(500, { error: "Helcim is not configured (missing API token or subdomain)." });
  }
  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return json(400, { error: "Invalid JSON body." });
  }
  const {
    action,
    job_id,
    amount,
    client_name,
    client_email,
    description,
    invoice_number,
    movers_count,
    billable_hours,
    payment_method
  } = body;
  if (action === "cancel") {
    if (!invoice_number) return json(400, { error: "invoice_number is required for cancel." });
    const g = await helcimFetch(`/invoices?invoiceNumber=${encodeURIComponent(invoice_number)}`, { token });
    const list = Array.isArray(g.data) ? g.data : g.data.invoices || [];
    const inv2 = list.find((i) => i.invoiceNumber === invoice_number) || list[0];
    if (!g.ok || !inv2) {
      return json(404, { error: `Invoice ${invoice_number} not found in Helcim.` });
    }
    const u = await helcimFetch(`/invoices/${inv2.invoiceId}`, {
      method: "PUT",
      token,
      body: { status: "CANCELLED" }
    });
    if (!u.ok) {
      return json(502, { error: helcimErrorMessage(u.data, u.status) });
    }
    return json(200, { ok: true, invoice_number, invoice_id: inv2.invoiceId, status: "CANCELLED" });
  }
  if (!job_id) return json(400, { error: "job_id is required." });
  const total = Number(amount);
  if (!Number.isFinite(total) || total <= 0) {
    return json(400, { error: "amount must be a positive number (dollars)." });
  }
  const rounded = Math.round(total * 100) / 100;
  const invNumber = (invoice_number || `ICANDO-${job_id}`).toString().slice(0, 50);
  const movers = Number(movers_count) === 3 ? 3 : 2;
  const hourlyRate = movers === 3 ? 165 : 120;
  const travelFee = movers === 3 ? 165 : 120;
  const hours = Number(billable_hours) || 0;
  const movingAmount = Math.round((rounded - travelFee) * 100) / 100;
  const lineItems = [
    {
      sku: `MOVE-${movers}`,
      description: `Residential Move (${movers} Movers) \u2014 ${hours} hrs @ $${hourlyRate}/hr`,
      quantity: hours || 1,
      price: hours ? Math.round(movingAmount / hours * 100) / 100 : movingAmount,
      total: movingAmount
    },
    {
      sku: "TRAVEL",
      description: "Travel fee",
      quantity: 1,
      price: travelFee,
      total: travelFee
    }
  ];
  const taxableSubtotal = Math.round((movingAmount + travelFee) * 100) / 100;
  const notes = [`Icando Movers & Transportation \u2014 job ${job_id}`, client_name ? `Client: ${client_name}` : null, `E-transfer: info@icandomovers.ca`].filter(Boolean).join("\n");
  const gst = Math.round(taxableSubtotal * 0.05 * 100) / 100;
  lineItems.push({
    sku: "GST",
    description: "GST (5%)",
    quantity: 1,
    price: gst,
    total: gst
  });
  const invoiceBody = {
    invoiceNumber: invNumber,
    type: "INVOICE",
    status: "DUE",
    currency: "CAD",
    notes,
    lineItems
  };
  let r = await helcimFetch("/invoices", { method: "POST", token, body: invoiceBody });
  if (!r.ok && r.status === 400 && /already exist/i.test(helcimErrorMessage(r.data, r.status))) {
    const g = await helcimFetch(`/invoices?invoiceNumber=${encodeURIComponent(invNumber)}`, { token });
    const list = Array.isArray(g.data) ? g.data : g.data.invoices || [];
    const existing = list.find((inv2) => inv2.invoiceNumber === invNumber) || list[0];
    if (g.ok && existing && existing.token) {
      return json(200, {
        invoice_id: existing.invoiceId,
        invoice_number: existing.invoiceNumber,
        payment_url: `https://${subdomain}.myhelcim.com/order/?token=${existing.token}`,
        reused: true
      });
    }
  }
  if (!r.ok) {
    return json(502, { error: helcimErrorMessage(r.data, r.status) });
  }
  const inv = r.data || {};
  if (!inv.token) {
    return json(502, { error: "Helcim created the invoice but returned no payment token." });
  }
  return json(200, {
    invoice_id: inv.invoiceId,
    invoice_number: inv.invoiceNumber,
    payment_url: `https://${subdomain}.myhelcim.com/order/?token=${inv.token}`
  });
};
