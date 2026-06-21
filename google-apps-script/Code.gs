/**
 * Backend de ClasesSNF para Google Apps Script.
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
const BASE_HOURLY_RATE = 15000;
const TRAVEL_TIME_HOURLY_RATE = 6000;
const TRANSIT_WEIGHT = 0.7;
const CAR_WEIGHT = 0.3;
const DEFAULT_TRANSIT_FARE_PER_LEG = 900;
const CAR_COST_PER_KM = 220;
const EVALUATION_BUFFER_MINUTES = 60;
const EVALUATION_KEYWORDS = ["prueba", "evaluacion", "examen", "control", "certamen", "presentacion"];
const UNIVERSITY_AFTER_EVENT_KEYWORDS = ["banco"];
// Color 5 corresponde a amarillo ("Banana") en Google Calendar.
const CLASS_EVENT_COLOR_ID = "5";
// Cambia esta clave antes de desplegar. Se usará para entrar al panel privado.
const ADMIN_KEY = "CAMBIA-ESTA-CLAVE-PRIVADA";

function doGet(e) {
  try {
    if (e.parameter.action === "bookingSettings") {
      return jsonResponse({
        success: true,
        universityDays: getUniversityDays(),
      });
    }
    if (e.parameter.action !== "availability") {
      return jsonResponse({ success: true, service: "ClasesSNF Calendar API" });
    }
    const date = requireDate(e.parameter.date);
    const modality = String(e.parameter.modality || "");
    if (modality === "Universidad" && !isUniversityDayEnabled(date)) {
      return jsonResponse({
        success: true,
        date,
        busy: [{ start: "00:00", end: "23:59", reason: "university-disabled" }],
        universityDayEnabled: false,
      });
    }
    const start = new Date(`${date}T00:00:00`);
    const searchStart = new Date(start.getTime() - 24 * 60 * 60 * 1000);
    const end = new Date(`${date}T23:59:59`);
    const events = CalendarApp.getCalendarById(CALENDAR_ID).getEvents(searchStart, end);
    const busy = buildBusySlots(events, date, modality);
    return jsonResponse({ success: true, date, busy, universityDayEnabled: true });
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
    if (data.action === "setupRecordingDelivery") {
      requireAdmin(data.adminKey);
      setupRecordingDelivery();
      return jsonResponse({ success: true, recordingDeliveryEnabled: true });
    }
    if (data.action === "updateUniversityDays") {
      requireAdmin(data.adminKey);
      const universityDays = saveUniversityDays(data.days);
      return jsonResponse({ success: true, universityDays });
    }
    if (data.action === "travelQuote") {
      return jsonResponse({ success: true, ...calculateTravelQuote(data.destination) });
    }
    validateBooking(data);
    if (data.modality === "Universidad" && !isUniversityDayEnabled(data.date)) {
      throw new Error("Ese día no está habilitado para clases en la universidad.");
    }

    const basePrice = BASE_HOURLY_RATE * Number(data.duration) / 60;
    const travelQuote = data.modality === "A domicilio"
      ? calculateTravelQuote(data.location)
      : { rawSurcharge: 0, roundTripMinutes: 0, minimumDuration: 60 };
    if (Number(data.duration) < travelQuote.minimumDuration) {
      throw new Error("Para esta dirección la clase debe durar al menos 2 horas.");
    }
    data.travelSurcharge = Math.min(travelQuote.rawSurcharge, basePrice);
    data.travelMinutes = travelQuote.roundTripMinutes;
    data.price = basePrice + data.travelSurcharge;

    const start = new Date(`${data.date}T${data.start}:00`);
    const end = new Date(start.getTime() + Number(data.duration) * 60 * 1000);
    data.end = Utilities.formatDate(end, TIMEZONE, "HH:mm");
    const calendar = CalendarApp.getCalendarById(CALENDAR_ID);
    const dayStart = new Date(`${data.date}T00:00:00`);
    const searchStart = new Date(dayStart.getTime() - 24 * 60 * 60 * 1000);
    const dayEnd = new Date(`${data.date}T23:59:59`);
    const busySlots = buildBusySlots(calendar.getEvents(searchStart, dayEnd), data.date, data.modality);
    const oneWayTravelMinutes = data.modality === "A domicilio"
      ? Math.ceil(travelQuote.roundTripMinutes / 2)
      : 0;
    const requestedStart = timeToMinutes(data.start) - oneWayTravelMinutes;
    const requestedEnd = timeToMinutes(data.start) + Number(data.duration) + oneWayTravelMinutes;
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
      data.travelSurcharge ? `Costo adicional clase a domicilio: $${Number(data.travelSurcharge).toLocaleString("es-CL")}` : "",
      data.travelMinutes ? `Tiempo traslado estimado: ${data.travelMinutes} minutos ida y vuelta` : "",
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
      colorId: CLASS_EVENT_COLOR_ID,
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
    const notificationSent = sendNewBookingNotification(data, event);

    return jsonResponse({
      success: true,
      eventId: event.id,
      eventUrl: event.htmlLink,
      meetUrl: event.hangoutLink || "",
      notificationSent,
    });
  } catch (error) {
    return jsonResponse({ success: false, error: error.message });
  } finally {
    lock.releaseLock();
  }
}

function sendNewBookingNotification(data, event) {
  if (!OWNER_EMAIL || OWNER_EMAIL === "TU_CORREO@gmail.com") return false;
  try {
    const groupLine = data.groupEmails && data.groupEmails.length
      ? `Integrantes: ${data.groupEmails.join(", ")}`
      : "";
    const body = [
      "Se agendó una nueva clase en ClasesSNF.",
      "",
      `Estudiante: ${data.name}`,
      `Correo: ${data.email}`,
      data.phone ? `Teléfono: ${data.phone}` : "",
      groupLine,
      `Ramo: ${data.subject}`,
      `Carrera/curso: ${data.course}`,
      `Fecha: ${data.date}`,
      `Horario: ${data.start} a ${data.end}`,
      `Modalidad: ${data.modality}`,
      `Tipo: ${data.classType || "Individual"}`,
      `Lugar: ${data.location}`,
      data.topic ? `Contenido: ${data.topic}` : "",
      data.referral ? `Recomendado por: ${data.referral}` : "",
      `Valor total: $${Number(data.price).toLocaleString("es-CL")}`,
      "",
      event.htmlLink ? `Abrir en Google Calendar: ${event.htmlLink}` : "",
    ].filter(Boolean).join("\n");
    MailApp.sendEmail(
      OWNER_EMAIL,
      `Nueva clase: ${data.subject} con ${data.name} · ${data.date}`,
      body,
    );
    return true;
  } catch (error) {
    console.error(`No se pudo enviar la notificación de reserva: ${error.message}`);
    return false;
  }
}

/**
 * El domicilio privado se guarda en Propiedades del script con la clave
 * HOME_ADDRESS. Nunca se devuelve al navegador.
 */
function calculateTravelQuote(destination) {
  if (!destination || destination.trim().length < 6) throw new Error("Ingresa una dirección válida.");
  const homeAddress = PropertiesService.getScriptProperties().getProperty("HOME_ADDRESS");
  if (!homeAddress) throw new Error("Falta configurar la dirección privada de origen.");

  const departure = new Date(Date.now() + 24 * 60 * 60 * 1000);
  departure.setHours(12, 0, 0, 0);
  const driving = getRouteEstimate(homeAddress, destination, Maps.DirectionFinder.Mode.DRIVING, departure);
  let transit;
  try {
    transit = getRouteEstimate(homeAddress, destination, Maps.DirectionFinder.Mode.TRANSIT, departure);
  } catch (error) {
    transit = {
      minutes: Math.round(driving.minutes * 1.35),
      distanceKm: driving.distanceKm,
      fare: DEFAULT_TRANSIT_FARE_PER_LEG,
      hasMetro: false,
    };
  }

  const transitCostRoundTrip = (transit.fare || DEFAULT_TRANSIT_FARE_PER_LEG) * 2;
  const carCostRoundTrip = driving.distanceKm * 2 * CAR_COST_PER_KM;
  const transportCost = transitCostRoundTrip * TRANSIT_WEIGHT + carCostRoundTrip * CAR_WEIGHT;
  const oneWayMinutes = transit.minutes * TRANSIT_WEIGHT + driving.minutes * CAR_WEIGHT;
  const roundTripMinutes = Math.round(oneWayMinutes * 2);
  const timeCost = roundTripMinutes / 60 * TRAVEL_TIME_HOURLY_RATE;
  const rawSurcharge = Math.max(0, Math.round((transportCost + timeCost) / 500) * 500);
  const isFarWithoutMetro = !transit.hasMetro && (driving.distanceKm >= 12 || oneWayMinutes >= 45);

  return {
    rawSurcharge,
    surcharge: rawSurcharge,
    roundTripMinutes,
    minimumDuration: isFarWithoutMetro ? 120 : 60,
    requiresTwoHours: isFarWithoutMetro,
    transportCost: Math.round(transportCost / 100) * 100,
    timeCost: Math.round(timeCost / 100) * 100,
  };
}

function getRouteEstimate(origin, destination, mode, departure) {
  const finder = Maps.newDirectionFinder()
    .setOrigin(origin)
    .setDestination(destination)
    .setMode(mode)
    .setRegion("cl")
    .setLanguage("es");
  if (mode === Maps.DirectionFinder.Mode.TRANSIT) finder.setDepart(departure);
  const directions = finder.getDirections();
  if (!directions.routes || !directions.routes.length) throw new Error("No encontramos una ruta hacia esa dirección.");
  const route = directions.routes[0];
  const leg = route.legs && route.legs[0];
  if (!leg || !leg.duration || !leg.distance) throw new Error("No pudimos calcular el traslado.");
  return {
    minutes: Math.max(1, Math.round(leg.duration.value / 60)),
    distanceKm: leg.distance.value / 1000,
    fare: route.fare && route.fare.value ? Number(route.fare.value) : 0,
    hasMetro: routeUsesMetro(leg),
  };
}

function routeUsesMetro(leg) {
  const steps = leg.steps || [];
  let lastMetroStep = -1;
  steps.forEach((step, index) => {
    const vehicle = step.transit_details &&
      step.transit_details.line &&
      step.transit_details.line.vehicle;
    const type = String(vehicle && vehicle.type || "").toUpperCase();
    const name = String(vehicle && (vehicle.name || vehicle.short_name) || "").toLowerCase();
    const isMetro = ["SUBWAY", "METRO_RAIL", "HEAVY_RAIL", "RAIL"].indexOf(type) >= 0 ||
      name.indexOf("metro") >= 0;
    if (isMetro) lastMetroStep = index;
  });
  if (lastMetroStep < 0) return false;

  const minutesFromLastMetroToDestination = steps
    .slice(lastMetroStep + 1)
    .reduce((total, step) => total + Number(step.duration && step.duration.value || 0) / 60, 0);

  return minutesFromLastMetroToDestination <= 20;
}

/**
 * Las pruebas y evaluaciones bloquean desde las 07:00 hasta una hora después
 * de terminar. Los demás eventos bloquean únicamente su duración real.
 */
function buildBusySlots(events, date, modality) {
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

    if (modality === "Universidad" && isUniversityAfterEvent(event.getTitle())) {
      if (eventEndDate < date || eventStartDate > date) return;
      slots.push({
        start: eventStartDate < date ? "00:00" : Utilities.formatDate(eventStart, TIMEZONE, "HH:mm"),
        end: "23:59",
        reason: "university-after-event",
      });
      return;
    }

    const classTravelMinutes = getHomeClassTravelMinutes(event);
    if (classTravelMinutes > 0) {
      const oneWayMinutes = Math.ceil(classTravelMinutes / 2);
      const blockedStart = new Date(eventStart.getTime() - oneWayMinutes * 60 * 1000);
      const blockedEnd = new Date(eventEnd.getTime() + oneWayMinutes * 60 * 1000);
      const blockedStartDate = Utilities.formatDate(blockedStart, TIMEZONE, "yyyy-MM-dd");
      const blockedEndDate = Utilities.formatDate(blockedEnd, TIMEZONE, "yyyy-MM-dd");
      if (blockedEndDate < date || blockedStartDate > date) return;
      slots.push({
        start: blockedStartDate < date ? "00:00" : Utilities.formatDate(blockedStart, TIMEZONE, "HH:mm"),
        end: blockedEndDate > date ? "23:59" : Utilities.formatDate(blockedEnd, TIMEZONE, "HH:mm"),
        reason: "home-class-travel",
      });
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

function getHomeClassTravelMinutes(event) {
  if (String(event.getTitle() || "").indexOf("Clase de ") !== 0) return 0;
  const details = parseDescription(event.getDescription() || "");
  if (details.Modalidad !== "A domicilio") return 0;
  return Number(String(details["Tiempo traslado estimado"] || "").replace(/[^\d]/g, "")) || 0;
}

function isEvaluationEvent(title) {
  const normalized = normalizeCalendarTitle(title);
  return EVALUATION_KEYWORDS.some(keyword => normalized.indexOf(keyword) >= 0);
}

function isUniversityAfterEvent(title) {
  const normalized = normalizeCalendarTitle(title);
  return UNIVERSITY_AFTER_EVENT_KEYWORDS.some(keyword => normalized.indexOf(keyword) >= 0);
}

function normalizeCalendarTitle(title) {
  return String(title || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
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

function getUniversityDays() {
  const saved = PropertiesService.getScriptProperties().getProperty("UNIVERSITY_DAYS");
  if (!saved) return [1, 2, 3, 4, 5, 6, 0];
  try {
    const parsed = JSON.parse(saved);
    return Array.isArray(parsed) ? parsed.map(Number).filter(day => day >= 0 && day <= 6) : [];
  } catch (error) {
    return [1, 2, 3, 4, 5, 6, 0];
  }
}

function saveUniversityDays(days) {
  if (!Array.isArray(days)) throw new Error("La configuración de días no es válida.");
  const normalized = [...new Set(days.map(Number).filter(day => day >= 0 && day <= 6))];
  PropertiesService.getScriptProperties().setProperty("UNIVERSITY_DAYS", JSON.stringify(normalized));
  return normalized;
}

function isUniversityDayEnabled(date) {
  const noon = new Date(`${date}T12:00:00`);
  const weekday = noon.getDay();
  return getUniversityDays().indexOf(weekday) >= 0;
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
    universityDays: getUniversityDays(),
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
    recordingDeliveryEnabled: isRecordingDeliveryEnabled(),
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

  const subject = `ClasesSNF: ${unpaid.length} ${unpaid.length === 1 ? "pago pendiente" : "pagos pendientes"}`;
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

/**
 * Revisa cada cinco minutos si Google terminó de procesar grabaciones de Meet.
 * La grabación debe haberse iniciado durante la reunión y la cuenta debe tener
 * habilitada esta función de Google Workspace.
 */
function setupRecordingDelivery() {
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === "deliverProcessedMeetRecordings")
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));

  ScriptApp.newTrigger("deliverProcessedMeetRecordings")
    .timeBased()
    .everyMinutes(5)
    .create();
}

function isRecordingDeliveryEnabled() {
  return ScriptApp.getProjectTriggers()
    .some(trigger => trigger.getHandlerFunction() === "deliverProcessedMeetRecordings");
}

function deliverProcessedMeetRecordings() {
  const now = new Date();
  const from = new Date(now.getTime() - 36 * 60 * 60 * 1000);
  const events = [];
  let pageToken;
  do {
    const result = Calendar.Events.list(CALENDAR_ID, {
      timeMin: from.toISOString(),
      timeMax: now.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 250,
      pageToken,
    });
    (result.items || []).forEach(event => events.push(event));
    pageToken = result.nextPageToken;
  } while (pageToken);

  events
    .filter(event => (event.summary || "").indexOf("Clase de ") === 0)
    .filter(event => parseDescription(event.description || "").Modalidad === "Online")
    .forEach(event => deliverEventRecordings(event));
}

function deliverEventRecordings(event) {
  const details = parseDescription(event.description || "");
  const recipients = [details.Correo]
    .concat(String(details.Integrantes || "").split(","))
    .map(email => email.trim().toLowerCase())
    .filter((email, index, all) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && all.indexOf(email) === index);
  if (!recipients.length) return;

  const files = getEventRecordingFiles(event);
  files.forEach(file => {
    const sentKey = `recording-sent:${event.id}:${file.getId()}`;
    if (PropertiesService.getScriptProperties().getProperty(sentKey) === "true") return;
    try {
      file.addViewers(recipients);
      recipients.forEach(email => {
        MailApp.sendEmail({
          to: email,
          subject: `Grabación de tu clase: ${details.Ramo || event.summary}`,
          body: [
            `Hola${details.Estudiante ? ` ${details.Estudiante}` : ""},`,
            "",
            "La grabación de tu clase online ya está disponible.",
            "",
            `Clase: ${details.Ramo || event.summary}`,
            `Ver grabación: ${file.getUrl()}`,
            "",
            "Este enlace es privado y fue compartido con los participantes registrados.",
            "",
            "ClasesSNF",
          ].join("\n"),
        });
      });
      PropertiesService.getScriptProperties().setProperty(sentKey, "true");
    } catch (error) {
      console.error(`No se pudo compartir la grabación ${file.getId()}: ${error.message}`);
    }
  });
}

function getEventRecordingFiles(event) {
  const files = [];
  (event.attachments || []).forEach(attachment => {
    const title = normalizeCalendarTitle(attachment.title || "");
    const mimeType = String(attachment.mimeType || "").toLowerCase();
    const looksLikeRecording =
      mimeType.indexOf("video") >= 0 ||
      title.indexOf("recording") >= 0 ||
      title.indexOf("grabacion") >= 0;
    if (!looksLikeRecording || !attachment.fileId) return;
    try {
      files.push(DriveApp.getFileById(attachment.fileId));
    } catch (error) {
      console.error(`No se pudo abrir la grabación ${attachment.fileId}: ${error.message}`);
    }
  });
  return files;
}

function validateBooking(data) {
  const required = ["name", "email", "date", "start", "end", "subject", "modality", "duration"];
  required.forEach(field => {
    if (!data[field]) throw new Error(`Falta el campo ${field}.`);
  });
  requireDate(data.date);
  const duration = Number(data.duration);
  if ([60, 90, 120].indexOf(duration) < 0) {
    throw new Error("La duración de la clase no es válida.");
  }
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
