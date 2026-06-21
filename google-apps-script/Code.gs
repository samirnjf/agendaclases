/**
 * Backend de ClaseLista para Google Apps Script.
 *
 * 1. Crea un proyecto en https://script.google.com
 * 2. Copia este archivo y appsscript.json.
 * 3. Reemplaza OWNER_EMAIL y CALENDAR_ID.
 * 4. Implementa como aplicación web: ejecutar como "Yo" y acceso "Cualquier persona".
 * 5. Copia la URL terminada en /exec dentro de CONFIG.calendarApiUrl en app.js.
 */
const OWNER_EMAIL = "TU_CORREO@gmail.com";
const CALENDAR_ID = "primary";
const TIMEZONE = "America/Santiago";
const FIRST_START_HOUR = 7;
const LAST_START_HOUR = 22;
const EVALUATION_BUFFER_MINUTES = 60;
const EVALUATION_KEYWORDS = ["prueba", "evaluacion", "examen", "control", "certamen", "presentacion"];
// Cambia esta clave antes de desplegar. Se usará para entrar al panel privado.
const ADMIN_KEY = "CAMBIA-ESTA-CLAVE-PRIVADA";

function doGet(e) {
  try {
    if (e.parameter.action !== "availability") {
      return jsonResponse({ success: true, service: "ClaseLista Calendar API" });
    }
    const date = requireDate(e.parameter.date);
    const start = new Date(`${date}T00:00:00`);
    const searchStart = new Date(start.getTime() - 24 * 60 * 60 * 1000);
    const end = new Date(`${date}T23:59:59`);
    const events = CalendarApp.getCalendarById(CALENDAR_ID).getEvents(searchStart, end);
    const busy = buildBusySlots(events, date);
    return jsonResponse({ success: true, date, busy });
  } catch (error) {
    return jsonResponse({ success: false, error: error.message });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    const data = JSON.parse(e.postData.contents);
    if (data.action === "adminReport") {
      requireAdmin(data.adminKey);
      return jsonResponse(buildAdminReport());
    }
    if (data.action === "updatePayment") {
      requireAdmin(data.adminKey);
      updatePaymentStatus(data.eventId, data.paid);
      return jsonResponse({ success: true });
    }
    if (data.action === "setupPaymentReminders") {
      requireAdmin(data.adminKey);
      setupDailyPaymentReminder();
      return jsonResponse({ success: true, reminderEnabled: true });
    }
    validateBooking(data);

    const start = new Date(`${data.date}T${data.start}:00`);
    const end = new Date(`${data.date}T${data.end}:00`);
    const calendar = CalendarApp.getCalendarById(CALENDAR_ID);
    const dayStart = new Date(`${data.date}T00:00:00`);
    const searchStart = new Date(dayStart.getTime() - 24 * 60 * 60 * 1000);
    const dayEnd = new Date(`${data.date}T23:59:59`);
    const busySlots = buildBusySlots(calendar.getEvents(searchStart, dayEnd), data.date);
    const requestedStart = timeToMinutes(data.start);
    const requestedEnd = timeToMinutes(data.end);
    const hasConflict = busySlots.some(slot =>
      timeToMinutes(slot.start) < requestedEnd &&
      timeToMinutes(slot.end) > requestedStart
    );
    if (hasConflict) throw new Error("Ese horario no está disponible o está restringido por una evaluación.");

    const title = `Clase de ${data.subject} · ${data.name}`;
    const description = [
      `Estudiante: ${data.name}`,
      `Correo: ${data.email}`,
      data.phone ? `Teléfono: ${data.phone}` : "",
      data.referral ? `Recomendado por: ${data.referral}` : "",
      `Nivel: ${data.level}`,
      `Carrera/curso: ${data.course}`,
      `Ramo: ${data.subject}`,
      `Modalidad: ${data.modality}`,
      `Tipo de clase: ${data.classType || "Individual"}`,
      data.groupEmails && data.groupEmails.length ? `Integrantes: ${data.groupEmails.join(", ")}` : "",
      `Lugar: ${data.location}`,
      data.topic ? `Contenido: ${data.topic}` : "",
      `Valor: $${Number(data.price).toLocaleString("es-CL")}`,
    ].filter(Boolean).join("\n");

    const eventResource = {
      summary: title,
      description,
      location: data.location,
      start: { dateTime: start.toISOString(), timeZone: TIMEZONE },
      end: { dateTime: end.toISOString(), timeZone: TIMEZONE },
      attendees: [data.email].concat(data.groupEmails || []).map(email => ({ email })),
      guestsCanModify: false,
      guestsCanInviteOthers: false,
    };

    if (data.createMeet) {
      eventResource.conferenceData = {
        createRequest: {
          requestId: Utilities.getUuid(),
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      };
    }

    const event = Calendar.Events.insert(eventResource, CALENDAR_ID, {
      conferenceDataVersion: data.createMeet ? 1 : 0,
      sendUpdates: "all",
    });

    return jsonResponse({
      success: true,
      eventId: event.id,
      eventUrl: event.htmlLink,
      meetUrl: event.hangoutLink || "",
    });
  } catch (error) {
    return jsonResponse({ success: false, error: error.message });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Las pruebas y evaluaciones bloquean desde las 07:00 hasta una hora después
 * de terminar. Los demás eventos bloquean únicamente su duración real.
 */
function buildBusySlots(events, date) {
  const slots = [];
  events.forEach(event => {
    const isEvaluation = isEvaluationEvent(event.getTitle());
    const eventStart = event.getStartTime();
    const eventEnd = event.getEndTime();
    const eventStartDate = Utilities.formatDate(eventStart, TIMEZONE, "yyyy-MM-dd");
    const eventEndDate = Utilities.formatDate(eventEnd, TIMEZONE, "yyyy-MM-dd");

    if (event.isAllDayEvent()) {
      if (eventEndDate <= date) return;
      slots.push({ start: "00:00", end: "23:59", reason: isEvaluation ? "evaluation" : "event" });
      return;
    }

    if (isEvaluation) {
      const bufferedEnd = new Date(eventEnd.getTime() + EVALUATION_BUFFER_MINUTES * 60 * 1000);
      const bufferedEndDate = Utilities.formatDate(bufferedEnd, TIMEZONE, "yyyy-MM-dd");
      if (bufferedEndDate < date) return;
      slots.push({
        start: eventStartDate < date ? "00:00" : `${String(FIRST_START_HOUR).padStart(2, "0")}:00`,
        end: bufferedEndDate > date ? "23:59" : Utilities.formatDate(bufferedEnd, TIMEZONE, "HH:mm"),
        reason: "evaluation",
      });
      return;
    }

    if (eventEndDate < date) return;
    slots.push({
      start: eventStartDate < date ? "00:00" : Utilities.formatDate(eventStart, TIMEZONE, "HH:mm"),
      end: eventEndDate > date ? "23:59" : Utilities.formatDate(eventEnd, TIMEZONE, "HH:mm"),
      reason: "event",
    });
  });
  return mergeBusySlots(slots);
}

function isEvaluationEvent(title) {
  const normalized = String(title || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  return EVALUATION_KEYWORDS.some(keyword => normalized.indexOf(keyword) >= 0);
}

function timeToMinutes(time) {
  const parts = time.split(":").map(Number);
  return parts[0] * 60 + parts[1];
}

function mergeBusySlots(slots) {
  if (!slots.length) return [];
  const sorted = slots.slice().sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));
  return sorted.reduce((merged, slot) => {
    const previous = merged[merged.length - 1];
    if (previous && timeToMinutes(slot.start) <= timeToMinutes(previous.end)) {
      if (timeToMinutes(slot.end) > timeToMinutes(previous.end)) previous.end = slot.end;
      if (slot.reason === "evaluation") previous.reason = "evaluation";
    } else {
      merged.push({ start: slot.start, end: slot.end, reason: slot.reason });
    }
    return merged;
  }, []);
}

function requireAdmin(key) {
  if (ADMIN_KEY === "CAMBIA-ESTA-CLAVE-PRIVADA") {
    throw new Error("Primero configura ADMIN_KEY en Código.gs.");
  }
  if (!key || key !== ADMIN_KEY) throw new Error("Clave administrativa incorrecta.");
}

function buildAdminReport() {
  const now = new Date();
  const from = new Date(now);
  from.setFullYear(from.getFullYear() - 3);
  const until = new Date(now);
  until.setFullYear(until.getFullYear() + 2);

  const events = [];
  let pageToken;
  do {
    const result = Calendar.Events.list(CALENDAR_ID, {
      timeMin: from.toISOString(),
      timeMax: until.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 2500,
      pageToken,
    });
    (result.items || []).forEach(event => {
      if ((event.summary || "").indexOf("Clase de ") !== 0) return;
      events.push(adminEvent(event, now));
    });
    pageToken = result.nextPageToken;
  } while (pageToken);

  const clientsByEmail = {};
  events.forEach(event => {
    if (!event.email) return;
    if (!clientsByEmail[event.email]) {
      clientsByEmail[event.email] = {
        email: event.email,
        name: event.name,
        phone: event.phone,
        classes: 0,
        paidClasses: 0,
        totalExpected: 0,
        totalPaid: 0,
        lastClass: "",
        nextClass: "",
      };
    }
    const client = clientsByEmail[event.email];
    client.classes += 1;
    client.totalExpected += event.price;
    if (event.paid) {
      client.paidClasses += 1;
      client.totalPaid += event.price;
    }
    if (event.isPast && (!client.lastClass || event.start > client.lastClass)) client.lastClass = event.start;
    if (!event.isPast && (!client.nextClass || event.start < client.nextClass)) client.nextClass = event.start;
  });

  const clients = Object.keys(clientsByEmail).map(email => clientsByEmail[email]);
  const upcoming = events.filter(event => !event.isPast);
  const history = events.filter(event => event.isPast).reverse();
  const totalExpected = events.reduce((sum, event) => sum + event.price, 0);
  const totalPaid = events.filter(event => event.paid).reduce((sum, event) => sum + event.price, 0);
  const pendingPast = history.filter(event => !event.paid).reduce((sum, event) => sum + event.price, 0);

  return {
    success: true,
    generatedAt: now.toISOString(),
    metrics: {
      activeClients: clients.filter(client => client.nextClass).length,
      totalClients: clients.length,
      upcomingClasses: upcoming.length,
      completedClasses: history.length,
      totalExpected,
      totalPaid,
      totalPending: totalExpected - totalPaid,
      overdueAmount: pendingPast,
    },
    reminderEnabled: isPaymentReminderEnabled(),
    upcoming,
    history,
    frequent: clients.sort((a, b) => b.classes - a.classes || b.totalExpected - a.totalExpected).slice(0, 10),
  };
}

function adminEvent(event, now) {
  const details = parseDescription(event.description || "");
  const start = new Date(event.start.dateTime || event.start.date);
  const end = new Date(event.end.dateTime || event.end.date);
  const price = Number((details.Valor || "0").replace(/[^\d]/g, "")) || 0;
  const paid = PropertiesService.getScriptProperties().getProperty(`paid:${event.id}`) === "true";
  return {
    id: event.id,
    title: event.summary || "",
    name: details.Estudiante || "",
    email: (details.Correo || "").toLowerCase(),
    phone: details["Teléfono"] || "",
    subject: details.Ramo || "",
    course: details["Carrera/curso"] || "",
    modality: details.Modalidad || "",
    classType: details["Tipo de clase"] || "Individual",
    referral: details["Recomendado por"] || "",
    location: details.Lugar || event.location || "",
    created: event.created || "",
    start: start.toISOString(),
    end: end.toISOString(),
    price,
    paid,
    isPast: end < now,
    eventUrl: event.htmlLink || "",
  };
}

function parseDescription(description) {
  return description.split("\n").reduce((result, line) => {
    const separator = line.indexOf(":");
    if (separator < 0) return result;
    result[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    return result;
  }, {});
}

function updatePaymentStatus(eventId, paid) {
  if (!eventId) throw new Error("Falta el identificador de la clase.");
  PropertiesService.getScriptProperties().setProperty(`paid:${eventId}`, paid ? "true" : "false");
}

/**
 * Crea un único disparador diario. También puede ejecutarse manualmente
 * desde el editor de Apps Script.
 */
function setupDailyPaymentReminder() {
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === "sendDailyPaymentReminder")
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));

  ScriptApp.newTrigger("sendDailyPaymentReminder")
    .timeBased()
    .everyDays(1)
    .atHour(10)
    .create();
}

function isPaymentReminderEnabled() {
  return ScriptApp.getProjectTriggers()
    .some(trigger => trigger.getHandlerFunction() === "sendDailyPaymentReminder");
}

/**
 * Envía al propietario un resumen diario de todas las clases que continúan
 * impagas. El correo se repite cada 24 horas hasta marcarlas como pagadas.
 */
function sendDailyPaymentReminder() {
  if (!OWNER_EMAIL || OWNER_EMAIL === "TU_CORREO@gmail.com") {
    throw new Error("Configura OWNER_EMAIL antes de activar recordatorios.");
  }

  const now = new Date();
  const from = new Date(now);
  from.setDate(from.getDate() - 30);
  const until = new Date(now);
  until.setFullYear(until.getFullYear() + 1);
  const result = Calendar.Events.list(CALENDAR_ID, {
    timeMin: from.toISOString(),
    timeMax: until.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 2500,
  });

  const unpaid = (result.items || [])
    .filter(event => (event.summary || "").indexOf("Clase de ") === 0)
    .map(event => adminEvent(event, now))
    .filter(event => {
      if (event.paid) return false;
      if (!event.created) return true;
      return now.getTime() - new Date(event.created).getTime() >= 24 * 60 * 60 * 1000;
    });

  if (!unpaid.length) return;

  const total = unpaid.reduce((sum, event) => sum + event.price, 0);
  const rows = unpaid.map(event => {
    const date = Utilities.formatDate(new Date(event.start), TIMEZONE, "dd-MM-yyyy HH:mm");
    return [
      `${date} · ${event.name}`,
      `${event.subject} · $${event.price.toLocaleString("es-CL")}`,
      `Correo: ${event.email}${event.phone ? ` · Teléfono: ${event.phone}` : ""}`,
    ].join("\n");
  });

  const subject = `ClaseLista: ${unpaid.length} ${unpaid.length === 1 ? "pago pendiente" : "pagos pendientes"}`;
  const body = [
    "Recordatorio diario de transferencias pendientes",
    "",
    rows.join("\n\n"),
    "",
    `Total pendiente: $${total.toLocaleString("es-CL")}`,
    "",
    "Cuando recibas una transferencia, márcala con ✓ en tu panel privado:",
    "https://samirnjf.github.io/agendaclases/admin.html",
  ].join("\n");

  MailApp.sendEmail(OWNER_EMAIL, subject, body);
}

function validateBooking(data) {
  const required = ["name", "email", "date", "start", "end", "subject", "modality"];
  required.forEach(field => {
    if (!data[field]) throw new Error(`Falta el campo ${field}.`);
  });
  requireDate(data.date);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) throw new Error("El correo no es válido.");
  if (data.classType === "Grupal") {
    if (!Array.isArray(data.groupEmails) || !data.groupEmails.length) {
      throw new Error("La clase grupal requiere al menos un correo adicional.");
    }
    data.groupEmails.forEach(email => {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new Error(`El correo ${email} no es válido.`);
      }
    });
  }
  const startHour = Number(data.start.split(":")[0]);
  if (startHour < FIRST_START_HOUR || startHour > LAST_START_HOUR) {
    throw new Error("La hora de inicio debe estar entre las 07:00 y las 22:00.");
  }
}

function requireDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) throw new Error("La fecha no es válida.");
  return value;
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
