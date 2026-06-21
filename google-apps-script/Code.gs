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

function doGet(e) {
  try {
    if (e.parameter.action !== "availability") {
      return jsonResponse({ success: true, service: "ClaseLista Calendar API" });
    }
    const date = requireDate(e.parameter.date);
    const start = new Date(`${date}T00:00:00`);
    const end = new Date(`${date}T23:59:59`);
    const events = CalendarApp.getCalendarById(CALENDAR_ID).getEvents(start, end);
    const busy = events.map(event => ({
      start: Utilities.formatDate(event.getStartTime(), TIMEZONE, "HH:mm"),
      end: Utilities.formatDate(event.getEndTime(), TIMEZONE, "HH:mm"),
    }));
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
    validateBooking(data);

    const start = new Date(`${data.date}T${data.start}:00`);
    const end = new Date(`${data.date}T${data.end}:00`);
    const calendar = CalendarApp.getCalendarById(CALENDAR_ID);
    const conflicts = calendar.getEvents(start, end);
    if (conflicts.length) throw new Error("Ese horario acaba de ser reservado. Elige otro bloque.");

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
