const ADMIN_CONFIG = {
  apiUrl: "https://script.google.com/macros/s/AKfycbx15WaCNvIYEGHdEWDXMcMTU43iSBpXWJGLaun25BM-6zo5dukO3tU0P_AISENQBxpg/exec",
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const currency = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const dateFormat = new Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "short", year: "numeric" });
const dateTimeFormat = new Intl.DateTimeFormat("es-CL", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const UNIVERSITY_LOCATIONS = ["Biblioteca Edificio A", "Biblioteca Edificio F", "Biblioteca Edificio C"];
let report = null;
let adminKey = sessionStorage.getItem("claseListaAdminKey") || "";

async function api(payload) {
  const response = await fetch(ADMIN_CONFIG.apiUrl, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ ...payload, adminKey }),
  });
  const result = await response.json();
  if (!result.success) throw new Error(result.error || "No fue posible consultar el panel.");
  return result;
}

async function loadReport() {
  $("#loading").hidden = false;
  $("#content").hidden = true;
  try {
    report = await api({ action: "adminReport" });
    sessionStorage.setItem("claseListaAdminKey", adminKey);
    $("#loginScreen").hidden = true;
    $("#dashboard").hidden = false;
    renderAll();
    $("#loading").hidden = true;
    $("#content").hidden = false;
  } catch (error) {
    sessionStorage.removeItem("claseListaAdminKey");
    $("#dashboard").hidden = true;
    $("#loginScreen").hidden = false;
    $("#loginError").textContent = error.message;
  }
}

function renderAll() {
  renderReminderStatus();
  renderRecordingStatus();
  renderUniversityDays();
  renderMetrics();
  renderOverview();
  renderTable("upcomingTable", report.upcoming);
  renderTable("historyTable", report.history);
  renderClients(report.frequent);
}

function renderRecordingStatus() {
  const button = $("#recordingButton");
  button.classList.toggle("enabled", report.recordingDeliveryEnabled);
  button.disabled = report.recordingDeliveryEnabled;
  $("#recordingLabel").textContent = report.recordingDeliveryEnabled
    ? "Envío de grabaciones activo"
    : "Activar envío de grabaciones";
}

function renderUniversityDays() {
  const enabled = new Set((report.universityDays || []).map(Number));
  $$('#universityDays input[type="checkbox"]').forEach(input => {
    input.checked = enabled.has(Number(input.value));
  });
  $("#universityDaysState").textContent = `${enabled.size} de 7 días activos`;
}

function renderReminderStatus() {
  const button = $("#reminderButton");
  button.classList.toggle("enabled", report.reminderEnabled);
  button.disabled = report.reminderEnabled;
  $("#reminderLabel").textContent = report.reminderEnabled
    ? "Recordatorio diario activo"
    : "Activar recordatorio diario";
}

function renderMetrics() {
  const m = report.metrics;
  const items = [
    ["Clientes actuales", m.activeClients, `${m.totalClients} clientes históricos`, "", ""],
    ["Próximas clases", m.upcomingClasses, `${m.completedClasses} clases realizadas`, "", ""],
    ["Ingresos esperados", currency.format(m.totalExpected), "Total de todas las reservas", "money", ""],
    ["Ingresos pagados", currency.format(m.totalPaid), "Ver quiénes pagaron", "money", "paid"],
    ["Ingresos por cobrar", currency.format(m.totalPending), `${currency.format(m.overdueAmount)} vencidos`, m.totalPending ? "warning" : "money", "pending"],
  ];
  $("#metrics").innerHTML = items.map(([label, value, note, type, detail]) => detail
    ? `<button class="metric clickable ${type}" type="button" data-payment-detail="${detail}"><span>${label}</span><strong>${value}</strong><small>${note}</small></button>`
    : `<article class="metric ${type}"><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`
  ).join("");
}

function renderOverview() {
  $("#overviewUpcoming").innerHTML = report.upcoming.length
    ? report.upcoming.slice(0, 5).map(classRow).join("")
    : empty("No hay próximas clases.");
  $("#overviewFrequent").innerHTML = report.frequent.length
    ? report.frequent.slice(0, 5).map((client, index) => `<div class="frequent-row"><span class="rank">${index + 1}</span><div class="client-copy"><strong>${escapeHtml(client.name)}</strong><span>${escapeHtml(client.email)}</span></div><strong>${client.classes} clases</strong></div>`).join("")
    : empty("Todavía no hay clientes.");
}

function classRow(item) {
  const date = new Date(item.start);
  return `<div class="class-row"><span class="date-block"><strong>${date.getDate()}</strong><span>${new Intl.DateTimeFormat("es-CL",{month:"short"}).format(date)}</span></span><div class="class-copy"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.subject)} · ${escapeHtml(item.modality)}</span></div><span class="class-meta">${new Intl.DateTimeFormat("es-CL",{hour:"2-digit",minute:"2-digit"}).format(date)}</span><span class="status ${item.paid ? "paid" : ""}">${item.paid ? "✓ Pagada" : "✕ Pendiente"}</span></div>`;
}

function renderTable(target, items) {
  const container = $(`#${target}`);
  if (!items.length) {
    container.innerHTML = empty("No hay clases para mostrar.");
    return;
  }
  container.innerHTML = `<table><thead><tr><th>Fecha</th><th>Cliente</th><th>Clase</th><th>Modalidad</th><th>Valor</th><th>Transferencia</th><th>Acciones</th></tr></thead><tbody>${items.map(item => `<tr data-searchable="${escapeHtml(`${item.name} ${item.email} ${item.subject}`.toLowerCase())}"><td><strong>${dateTimeFormat.format(new Date(item.start))}</strong><small>${item.classType}</small></td><td><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.email)}</small></td><td><strong>${escapeHtml(item.subject)}</strong><small>${escapeHtml(item.course)}</small></td><td>${escapeHtml(item.modality)}</td><td><strong>${currency.format(item.price)}</strong></td><td><div class="payment-controls"><button class="payment-button pay-yes ${item.paid ? "active" : ""}" data-payment-id="${item.id}" data-paid-value="true" title="Transferencia recibida"><svg viewBox="0 0 24 24"><path d="m5 12.5 4 4 10-10"/></svg></button><button class="payment-button pay-no ${!item.paid ? "active" : ""}" data-payment-id="${item.id}" data-paid-value="false" title="Transferencia pendiente"><svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div></td><td><div class="row-actions"><button type="button" class="edit-link" data-edit-id="${escapeHtml(item.id)}">Editar</button>${item.eventUrl ? `<a class="event-link" href="${item.eventUrl}" target="_blank">Abrir ↗</a>` : ""}</div></td></tr>`).join("")}</tbody></table>`;
}

function renderClients(clients) {
  $("#clientGrid").innerHTML = clients.length
    ? clients.map((client, index) => `<article class="client-card" data-searchable="${escapeHtml(`${client.name} ${client.email}`.toLowerCase())}"><div class="client-top"><span class="avatar">${initials(client.name)}</span><div class="client-copy"><strong>${escapeHtml(client.name)}</strong><span>${escapeHtml(client.email)}</span></div><span class="rank">#${index + 1}</span></div><div class="client-stats"><div><span>Clases</span><strong>${client.classes}</strong></div><div><span>Pagadas</span><strong>${client.paidClasses}</strong></div><div><span>Esperado</span><strong>${currency.format(client.totalExpected)}</strong></div></div></article>`).join("")
    : empty("Todavía no hay clientes.");
}

function showSection(section) {
  const titles = { overview: "Resumen", upcoming: "Próximas clases", history: "Historial", clients: "Clientes frecuentes" };
  $$(".page-section").forEach(page => page.classList.toggle("active", page.dataset.page === section));
  $$("[data-section]").forEach(button => button.classList.toggle("active", button.dataset.section === section));
  $("#sectionTitle").textContent = titles[section];
}

function showPaymentDetail(type) {
  const allEvents = [...report.upcoming, ...report.history]
    .filter(item => type === "paid" ? item.paid : !item.paid)
    .sort((a, b) => new Date(b.start) - new Date(a.start));
  const isPaid = type === "paid";
  const total = allEvents.reduce((sum, item) => sum + item.price, 0);
  $("#paymentDialogEyebrow").textContent = isPaid ? "Transferencias recibidas" : "Cobros pendientes";
  $("#paymentDialogTitle").textContent = isPaid ? "Quiénes ya pagaron" : "Quiénes faltan por pagar";
  $("#paymentDialogCount").textContent = `${allEvents.length} ${allEvents.length === 1 ? "clase" : "clases"}`;
  $("#paymentDialogTotal").textContent = currency.format(total);
  $("#paymentDetailList").innerHTML = allEvents.length
    ? allEvents.map(item => {
        const date = new Date(item.start);
        return `<div class="payment-detail-row ${isPaid ? "" : "pending"}">
          <span class="date-block"><strong>${date.getDate()}</strong><span>${new Intl.DateTimeFormat("es-CL",{month:"short"}).format(date)}</span></span>
          <div class="payment-person"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.email)}</span></div>
          <div class="payment-class"><strong>${escapeHtml(item.subject)}</strong>${dateTimeFormat.format(date)}</div>
          <strong class="payment-amount">${currency.format(item.price)}</strong>
        </div>`;
      }).join("")
    : empty(isPaid ? "Todavía no has registrado transferencias." : "No hay pagos pendientes.");
  $("#paymentDialog").showModal();
}

function findClass(eventId) {
  return [...(report?.upcoming || []), ...(report?.history || [])].find(item => item.id === eventId);
}

function dateInputValue(item) {
  if (item.date) return item.date;
  const date = new Date(item.start);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function timeInputValue(item) {
  if (item.startTime) return item.startTime;
  const date = new Date(item.start);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function openEditClass(eventId) {
  const item = findClass(eventId);
  if (!item) {
    toast("No encontré esa clase en el reporte.");
    return;
  }
  const form = $("#editClassForm");
  form.reset();
  form.eventId.value = item.id;
  form.name.value = item.name || "";
  form.email.value = item.email || "";
  form.level.value = item.level || (item.course && item.course.toLowerCase().includes("ingeniería") ? "Universidad" : "Colegio");
  form.course.value = item.course || "";
  form.subject.value = item.subject || "";
  form.classType.value = item.classType || "Individual";
  form.groupEmails.value = (item.groupEmails || []).join(", ");
  form.date.value = dateInputValue(item);
  form.start.value = timeInputValue(item);
  form.duration.value = String(item.duration || Math.round((new Date(item.end) - new Date(item.start)) / 60000) || 60);
  form.modality.value = item.modality || "Online";
  form.location.value = item.location || "";
  form.topic.value = item.topic || "";
  form.phone.value = item.phone || "";
  form.referral.value = item.referral || "";
  $("#editDialogTitle").textContent = `${item.name} · ${item.subject}`;
  $("#editClassError").textContent = "";
  applyEditModalityDefaults(false);
  $("#editClassDialog").showModal();
}

function applyEditModalityDefaults(force = true) {
  const form = $("#editClassForm");
  const location = form.location;
  if (form.modality.value === "Online") {
    location.placeholder = "Google Meet";
    if (force || !location.value) location.value = "Google Meet";
  } else if (form.modality.value === "Universidad") {
    location.placeholder = UNIVERSITY_LOCATIONS.join(" / ");
    if (force || !UNIVERSITY_LOCATIONS.includes(location.value)) location.value = UNIVERSITY_LOCATIONS[0];
  } else {
    location.placeholder = "Dirección completa del cliente";
    if (force && (location.value === "Google Meet" || UNIVERSITY_LOCATIONS.includes(location.value))) location.value = "";
  }
}

async function saveEditedClass(event) {
  event.preventDefault();
  const form = $("#editClassForm");
  const button = $("#saveEditClass");
  $("#editClassError").textContent = "";
  button.disabled = true;
  button.textContent = "Guardando...";
  const data = Object.fromEntries(new FormData(form).entries());
  const payload = {
    action: "updateClass",
    eventId: data.eventId,
    name: data.name.trim(),
    email: data.email.trim().toLowerCase(),
    phone: data.phone.trim(),
    referral: data.referral.trim(),
    level: data.level,
    course: data.course.trim(),
    subject: data.subject.trim(),
    topic: data.topic.trim(),
    classType: data.classType,
    groupEmails: data.classType === "Grupal"
      ? data.groupEmails.split(/[\n,;]/).map(email => email.trim().toLowerCase()).filter(Boolean)
      : [],
    date: data.date,
    start: data.start,
    duration: Number(data.duration),
    modality: data.modality,
    location: data.location.trim(),
  };

  try {
    await api(payload);
    $("#editClassDialog").close();
    toast("Clase actualizada y cliente notificado");
    await loadReport();
  } catch (error) {
    $("#editClassError").textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "Guardar cambios";
  }
}

function empty(message) {
  return `<div class="empty">${message}</div>`;
}

function escapeHtml(value = "") {
  return value.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
}

function initials(name = "") {
  return name.split(/\s+/).slice(0,2).map(part => part[0]).join("").toUpperCase() || "CL";
}

let toastTimer;
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.remove("visible"), 2400);
}

$("#loginForm").addEventListener("submit", event => {
  event.preventDefault();
  adminKey = $("#adminKey").value;
  $("#loginError").textContent = "";
  loadReport();
});
$("#refreshButton").addEventListener("click", loadReport);
$("#recordingButton").addEventListener("click", async () => {
  const button = $("#recordingButton");
  button.disabled = true;
  $("#recordingLabel").textContent = "Activando...";
  try {
    await api({ action: "setupRecordingDelivery" });
    toast("Envío automático de grabaciones activado");
    await loadReport();
  } catch (error) {
    toast(error.message);
    button.disabled = false;
    $("#recordingLabel").textContent = "Activar envío de grabaciones";
  }
});
$("#saveUniversityDays").addEventListener("click", async () => {
  const button = $("#saveUniversityDays");
  const days = $$('#universityDays input:checked').map(input => Number(input.value));
  button.disabled = true;
  button.textContent = "Guardando...";
  try {
    const result = await api({ action: "updateUniversityDays", days });
    report.universityDays = result.universityDays;
    renderUniversityDays();
    toast("Días de universidad actualizados");
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Guardar días";
  }
});
$("#reminderButton").addEventListener("click", async () => {
  const button = $("#reminderButton");
  button.disabled = true;
  $("#reminderLabel").textContent = "Activando...";
  try {
    await api({ action: "setupPaymentReminders" });
    toast("Recordatorio diario activado");
    await loadReport();
  } catch (error) {
    toast(error.message);
    button.disabled = false;
    $("#reminderLabel").textContent = "Activar recordatorio diario";
  }
});
$("#logoutButton").addEventListener("click", () => {
  sessionStorage.removeItem("claseListaAdminKey");
  location.reload();
});
document.addEventListener("click", async event => {
  const section = event.target.closest("[data-section]")?.dataset.section || event.target.closest("[data-go]")?.dataset.go;
  if (section) showSection(section);
  const paymentDetail = event.target.closest("[data-payment-detail]")?.dataset.paymentDetail;
  if (paymentDetail) showPaymentDetail(paymentDetail);
  const editButton = event.target.closest("[data-edit-id]");
  if (editButton) openEditClass(editButton.dataset.editId);
  const payment = event.target.closest("[data-payment-id]");
  if (payment) {
    payment.disabled = true;
    try {
      await api({ action: "updatePayment", eventId: payment.dataset.paymentId, paid: payment.dataset.paidValue === "true" });
      toast("Estado de pago actualizado");
      await loadReport();
    } catch (error) {
      toast(error.message);
      payment.disabled = false;
    }
  }
});
$("#closePaymentDialog").addEventListener("click", () => $("#paymentDialog").close());
$("#paymentDialog").addEventListener("click", event => {
  if (event.target === $("#paymentDialog")) $("#paymentDialog").close();
});
$("#closeEditDialog").addEventListener("click", () => $("#editClassDialog").close());
$("#cancelEditClass").addEventListener("click", () => $("#editClassDialog").close());
$("#editClassDialog").addEventListener("click", event => {
  if (event.target === $("#editClassDialog")) $("#editClassDialog").close();
});
$("#editClassForm").addEventListener("submit", saveEditedClass);
$("#editClassForm").modality.addEventListener("change", () => applyEditModalityDefaults(true));
$$("[data-search]").forEach(input => input.addEventListener("input", event => {
  const query = event.target.value.toLowerCase().trim();
  const page = event.target.dataset.search;
  const root = $(`[data-page="${page}"]`);
  $$("[data-searchable]", root).forEach(item => item.hidden = !item.dataset.searchable.includes(query));
}));

if (adminKey) loadReport();
