const CONFIG = {
  // Pega aquí la URL /exec de tu despliegue de Google Apps Script.
  calendarApiUrl: "https://script.google.com/macros/s/AKfycbx15WaCNvIYEGHdEWDXMcMTU43iSBpXWJGLaun25BM-6zo5dukO3tU0P_AISENQBxpg/exec",
  timezone: "America/Santiago",
  pricePerHour: 15000,
  firstStartHour: 7,
  lastStartHour: 22,
  slotIntervalMinutes: 30,
  bookingWindowDays: 60,
};

const CAREERS = {
  "Ingeniería Civil": [
    "Introducción al Cálculo",
    "Introducción al Álgebra",
    "Álgebra",
    "Cálculo Diferencial",
    "Cálculo Integral",
    "Cálculo Multivariable",
    "Probabilidad y Estadística",
  ],
  "Ingeniería Comercial": [
    "Matemáticas Avanzadas I",
    "Matemáticas Avanzadas II",
    "Estadística y Data Science",
    "Introducción al Cálculo",
    "Introducción al Álgebra",
  ],
};

const state = {
  step: 1,
  month: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  selectedDate: "",
  selectedTime: "",
  busySlots: [],
  availabilitySource: "local",
  travelQuote: null,
  quotedAddress: "",
  sessions: [],
  universityDays: [0, 1, 2, 3, 4, 5, 6],
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const form = $("#bookingForm");
const money = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });

function dateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseDate(value) {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function minutes(time) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function timeFromMinutes(value) {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function formData() {
  return Object.fromEntries(new FormData(form).entries());
}

function selectedSubject(data = formData()) {
  return data.level === "Universidad" ? data.subject : data.schoolSubject;
}

function selectedCourse(data = formData()) {
  return data.level === "Universidad" ? data.career : data.schoolGrade;
}

function selectedLocation(data = formData()) {
  if (data.modality === "Online") return "Google Meet";
  if (data.modality === "Universidad") return data.universityLocation || "";
  return data.homeLocation || "";
}

async function loadBookingSettings() {
  try {
    const response = await fetch(`${CONFIG.calendarApiUrl}?action=bookingSettings`);
    const result = await response.json();
    if (result.success && Array.isArray(result.universityDays)) {
      state.universityDays = result.universityDays.map(Number);
      renderCalendar();
    }
  } catch (error) {
    console.error("No se pudo cargar la configuración de días.", error);
  }
}

function initializeCareers() {
  const select = $("#careerSelect");
  const existing = new Set([...select.options].map(option => option.value));
  Object.keys(CAREERS).forEach(career => {
    if (existing.has(career)) return;
    select.add(new Option(career, career));
  });
}

function updateSubjects() {
  const career = $("#careerSelect").value;
  const select = $("#subjectSelect");
  select.disabled = !career;
  select.innerHTML = career
    ? `<option value="">Selecciona un ramo</option>${CAREERS[career].map(subject => `<option>${subject}</option>`).join("")}`
    : `<option value="">Primero selecciona una carrera</option>`;
}

function updateLevelFields() {
  const level = formData().level;
  $("#schoolFields").hidden = level !== "Colegio";
  $("#universityFields").hidden = level !== "Universidad";
  $('[name="schoolGrade"]').required = level === "Colegio";
  $('[name="schoolSubject"]').required = level === "Colegio";
  $("#careerSelect").required = level === "Universidad";
  $("#subjectSelect").required = level === "Universidad";
}

function updateModality() {
  const modality = formData().modality;
  $("#universityLocationField").hidden = modality !== "Universidad";
  $("#homeLocationField").hidden = modality !== "A domicilio";
  form.universityLocation.required = modality === "Universidad";
  form.homeLocation.required = modality === "A domicilio";
  if (modality !== "A domicilio") {
    state.travelQuote = null;
    state.quotedAddress = "";
    $("#travelQuote").hidden = true;
    applyHomeDurationRule(60);
  }
}

function updateClassType() {
  const isGroup = formData().classType === "Grupal";
  $("#groupMembers").hidden = !isGroup;
  if (isGroup && !$(".member-email", $("#memberEmailList"))) addMemberEmail();
  if (!isGroup) $("#memberEmailsError").textContent = "";
}

function addMemberEmail(value = "") {
  const row = document.createElement("div");
  row.className = "member-email-row";
  row.innerHTML = `
    <div class="input-wrap">
      <svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/></svg>
      <input class="member-email" name="groupEmail[]" type="email" autocomplete="email" placeholder="integrante@gmail.com" value="${value}">
    </div>
    <button type="button" class="remove-member" aria-label="Eliminar correo">
      <svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>
    </button>`;
  $("#memberEmailList").append(row);
  syncMemberEmailRequirements();
}

function groupEmails() {
  const mainEmail = formData().email?.trim().toLowerCase();
  return [...new Set($$(".member-email", $("#memberEmailList"))
    .map(input => input.value.trim().toLowerCase())
    .filter(email => email && email !== mainEmail))];
}

function syncMemberEmailRequirements() {
  const inputs = $$(".member-email", $("#memberEmailList"));
  inputs.forEach((input, index) => {
    input.required = formData().classType === "Grupal" && index === 0;
    input.setAttribute("aria-label", index === 0 ? "Correo obligatorio del segundo integrante" : `Correo del integrante ${index + 2}`);
  });
}

async function ensureTravelQuote() {
  const data = formData();
  if (data.modality !== "A domicilio") return true;
  const destination = data.homeLocation.trim();
  if (state.travelQuote && state.quotedAddress === destination) return true;
  const button = $("#nextButton");
  $("#formAlert").textContent = "";
  button.disabled = true;
  button.textContent = "Calculando traslado...";
  try {
    const response = await fetch(CONFIG.calendarApiUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "travelQuote", destination }),
    });
    const result = await response.json();
    if (!result.success) throw new Error(result.error || "No fue posible calcular el traslado.");
    state.travelQuote = result;
    state.quotedAddress = destination;
    applyHomeDurationRule(result.minimumDuration || 60);
    updateDisplayedTravelPrice();
    $("#travelQuoteDetail").textContent = result.minimumDuration === 120
      ? "Por distancia y conectividad, esta dirección requiere una clase mínima de 2 horas."
      : "Calculado según distancia y tiempo requerido para realizar la clase.";
    $("#travelQuote").hidden = false;
    return true;
  } catch (error) {
    $("#formAlert").textContent = error.message;
    return false;
  } finally {
    button.disabled = false;
    button.innerHTML = `Continuar <svg viewBox="0 0 24 24"><path d="m9 5 7 7-7 7"/></svg>`;
  }
}

function applyHomeDurationRule(minimumDuration = 60) {
  $$('input[name="duration"]').forEach(input => {
    input.disabled = Number(input.value) < minimumDuration;
    input.closest("label").classList.toggle("disabled", input.disabled);
  });
  const selected = form.querySelector('input[name="duration"]:checked');
  if (!selected || selected.disabled) {
    form.querySelector(`input[name="duration"][value="${minimumDuration === 120 ? 120 : 60}"]`).checked = true;
  }
}

function updateDisplayedTravelPrice() {
  if (!state.travelQuote) return;
  const duration = Number(formData().duration || 60);
  const basePrice = CONFIG.pricePerHour * duration / 60;
  state.travelQuote.surcharge = Math.min(
    Number(state.travelQuote.rawSurcharge ?? state.travelQuote.surcharge ?? 0),
    basePrice,
  );
  $("#travelQuotePrice").textContent = money.format(state.travelQuote.surcharge);
}

function setStep(next) {
  state.step = Math.max(1, Math.min(5, next));
  $$(".form-step").forEach(section => section.classList.toggle("active", Number(section.dataset.step) === state.step));
  $$("[data-step-indicator]").forEach(item => {
    const number = Number(item.dataset.stepIndicator);
    item.classList.toggle("active", number === state.step);
    item.classList.toggle("complete", number < state.step);
  });
  const names = ["Tus datos", "Tu clase", "Modalidad", "Fecha y hora", "Confirmar"];
  $("#mobileStepLabel").textContent = `Paso ${state.step} de 5`;
  $("#mobileStepName").textContent = names[state.step - 1];
  $("#progressPercent").textContent = `${state.step * 20}%`;
  $("#progressBar").style.width = `${state.step * 20}%`;
  $("#backButton").hidden = state.step === 1;
  $("#nextButton").hidden = state.step === 5;
  $("#submitButton").hidden = state.step !== 5;
  $("#formAlert").textContent = "";
  if (state.step === 4) {
    renderCalendar();
    if (state.selectedDate) loadAvailability(state.selectedDate);
  }
  if (state.step === 5) renderSummary();
  window.scrollTo({ top: Math.max(0, $(".booking-shell").offsetTop - 15), behavior: "smooth" });
}

function clearErrors(section) {
  $$(".invalid", section).forEach(field => field.classList.remove("invalid"));
  $$(".field-error, .group-error, .schedule-error, .terms-error", section).forEach(error => error.textContent = "");
}

function markFieldError(input, message) {
  const field = input.closest(".field");
  if (field) {
    field.classList.add("invalid");
    $(".field-error", field).textContent = message;
  }
}

function validateStep(step) {
  const section = $(`[data-step="${step}"]`);
  clearErrors(section);
  let valid = true;
  const visibleRequired = $$("[required]", section).filter(input => !input.closest("[hidden]"));
  visibleRequired.forEach(input => {
    if (input.type === "radio" || input.type === "checkbox") return;
    if (!input.checkValidity()) {
      markFieldError(input, input.type === "email" ? "Ingresa un correo válido." : "Este campo es obligatorio.");
      valid = false;
    }
  });

  const radioNames = [...new Set(visibleRequired.filter(input => input.type === "radio").map(input => input.name))];
  radioNames.forEach(name => {
    if (!form.querySelector(`[name="${name}"]:checked`)) {
      const group = form.querySelector(`[name="${name}"]`).closest(".choice-group");
      $(".group-error", group).textContent = "Selecciona una opción.";
      valid = false;
    }
  });

  if (step === 3 && formData().classType === "Grupal") {
    const inputs = $$(".member-email", $("#memberEmailList"));
    const emails = groupEmails();
    const mainEmail = formData().email.trim().toLowerCase();
    const filledValues = inputs.map(input => input.value.trim().toLowerCase()).filter(Boolean);
    const invalidInput = inputs.find(input => input.value.trim() && !input.validity.valid);
    const repeatedMainEmail = filledValues.includes(mainEmail);
    const hasDuplicates = new Set(filledValues).size !== filledValues.length;
    if (!emails.length || invalidInput || repeatedMainEmail || hasDuplicates) {
      $("#memberEmailsError").textContent = !emails.length
        ? "Ingresa al menos el correo de otro integrante."
        : invalidInput
          ? "Revisa que el correo ingresado sea válido."
          : repeatedMainEmail
            ? "El correo principal no debe repetirse entre los integrantes."
            : "No repitas correos entre los integrantes.";
      (invalidInput || inputs[0])?.focus();
      valid = false;
    }
  }

  if (step === 4 && !getBookingSessions().length) {
    $("#scheduleError").textContent = "Selecciona al menos una fecha y un horario disponible.";
    valid = false;
  }
  if (step === 5 && !form.terms.checked) {
    $(".terms-error").textContent = "Debes confirmar los datos para reservar.";
    valid = false;
  }
  return valid;
}

function renderCalendar() {
  const title = new Intl.DateTimeFormat("es-CL", { month: "long", year: "numeric" }).format(state.month);
  $("#monthTitle").textContent = title;
  const first = new Date(state.month.getFullYear(), state.month.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  const gridStart = addDays(first, -offset);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const lastBookable = addDays(today, CONFIG.bookingWindowDays);
  let html = "";

  for (let index = 0; index < 42; index += 1) {
    const day = addDays(gridStart, index);
    const key = dateKey(day);
    const isPast = day < today;
    const tooLate = day > lastBookable;
    const otherMonth = day.getMonth() !== state.month.getMonth();
    const universityBlocked =
      formData().modality === "Universidad" &&
      !state.universityDays.includes(day.getDay());
    const available = !isPast && !tooLate && !universityBlocked;
    html += `<button type="button" class="calendar-day ${otherMonth ? "other-month" : ""} ${available ? "available" : ""} ${dateKey(today) === key ? "today" : ""} ${state.selectedDate === key ? "selected" : ""}" data-date="${key}" ${available ? "" : "disabled"}>${day.getDate()}</button>`;
  }
  $("#calendarDays").innerHTML = html;
}

async function loadAvailability(date) {
  state.selectedDate = date;
  state.selectedTime = "";
  $("#addSessionButton").disabled = true;
  renderCalendar();
  const panel = $("#timeSlots");
  panel.innerHTML = `<div class="slot-loading">Consultando agenda...</div>`;
  $("#selectedDateLabel").textContent = new Intl.DateTimeFormat("es-CL", { weekday: "long", day: "numeric", month: "long" }).format(parseDate(date));
  $("#scheduleError").textContent = "";

  state.busySlots = [];
  state.availabilitySource = "local";
  if (CONFIG.calendarApiUrl) {
    try {
      const modality = encodeURIComponent(formData().modality || "");
      const response = await fetch(`${CONFIG.calendarApiUrl}?action=availability&date=${date}&modality=${modality}&timezone=${encodeURIComponent(CONFIG.timezone)}`);
      if (!response.ok) throw new Error("No fue posible consultar Calendar");
      const result = await response.json();
      state.busySlots = result.busy || [];
      state.availabilitySource = "calendar";
      if (result.universityDayEnabled === false) {
        $("#availabilityStatus").textContent = "Este día no está habilitado para clases en la universidad.";
      }
    } catch (error) {
      console.error(error);
      showToast("No se pudo consultar Google Calendar. Revisa la configuración.");
    }
  }
  renderTimeSlots();
}

function renderTimeSlots() {
  const duration = Number(formData().duration || 60);
  const now = new Date();
  const travelBuffer = formData().modality === "A domicilio"
    ? Math.ceil(Number(state.travelQuote?.roundTripMinutes || 0) / 2)
    : 0;
  const slots = [];
  for (let start = CONFIG.firstStartHour * 60; start <= CONFIG.lastStartHour * 60; start += CONFIG.slotIntervalMinutes) {
    const end = start + duration;
    const startTime = timeFromMinutes(start);
    const endTime = timeFromMinutes(end);
    const isTooSoon = dateKey(now) === state.selectedDate && start <= now.getHours() * 60 + now.getMinutes() + 60;
    const blocked = state.busySlots.some(busy =>
      minutes(busy.start) < end + travelBuffer &&
      minutes(busy.end) > start - travelBuffer
    );
    const overlapsSelected = state.sessions.some(session =>
      session.date === state.selectedDate &&
      minutes(session.start) < end + travelBuffer &&
      minutes(session.end) > start - travelBuffer
    );
    if (!isTooSoon && !blocked && !overlapsSelected) slots.push({ start: startTime, end: endTime });
  }
  const universityDisabled = state.busySlots.some(slot => slot.reason === "university-disabled");
  $("#availabilityStatus").className = `availability-status ${state.availabilitySource === "calendar" && !universityDisabled ? "live" : ""}`;
  $("#availabilityStatus").textContent = universityDisabled
    ? "Este día no está habilitado para clases en la universidad."
    : state.availabilitySource === "calendar"
      ? "● Disponibilidad sincronizada con Google Calendar"
      : CONFIG.calendarApiUrl ? "Disponibilidad local de respaldo" : "Vista previa · conecta Google Calendar para bloquear horas ocupadas";

  $("#timeSlots").innerHTML = slots.length
    ? slots.map(slot => {
        const added = state.sessions.some(session => session.date === state.selectedDate && session.start === slot.start);
        return `<button class="time-slot ${added ? "added" : ""}" type="button" data-time="${slot.start}" data-end="${slot.end}">${slot.start}${added ? " ✓" : ""}</button>`;
      }).join("")
    : `<div class="no-slots"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg><span>No quedan horas disponibles este día.<br>Prueba con otra fecha.</span></div>`;
}

function currentSession() {
  if (!state.selectedDate || !state.selectedTime) return null;
  const duration = Number(formData().duration || 60);
  return {
    date: state.selectedDate,
    start: state.selectedTime,
    end: timeFromMinutes(minutes(state.selectedTime) + duration),
  };
}

function getBookingSessions() {
  const current = currentSession();
  const sessions = [...state.sessions];
  if (current && !sessions.some(session => session.date === current.date && session.start === current.start)) {
    sessions.push(current);
  }
  return sessions.sort((a, b) => `${a.date}${a.start}`.localeCompare(`${b.date}${b.start}`));
}

function addCurrentSession() {
  const session = currentSession();
  if (!session) return;
  if (!state.sessions.some(item => item.date === session.date && item.start === session.start)) {
    state.sessions.push(session);
  }
  state.selectedTime = "";
  $("#addSessionButton").disabled = true;
  renderSelectedSessions();
  renderTimeSlots();
  $("#scheduleError").textContent = "";
}

function renderSelectedSessions() {
  const container = $("#selectedSessions");
  container.hidden = !state.sessions.length;
  $("#selectedSessionsCount").textContent = `${state.sessions.length} ${state.sessions.length === 1 ? "clase" : "clases"}`;
  $("#selectedSessionsList").innerHTML = state.sessions.map((session, index) => `
    <div class="selected-session">
      <div><strong>${new Intl.DateTimeFormat("es-CL", { weekday: "long", day: "numeric", month: "long" }).format(parseDate(session.date))}</strong><span>${session.start} a ${session.end}</span></div>
      <span>${formData().duration} min</span>
      <button type="button" data-remove-session="${index}" aria-label="Eliminar clase"><svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg></button>
    </div>`).join("");
}

function renderSummary() {
  const data = formData();
  const sessions = getBookingSessions();
  const firstSession = sessions[0];
  const date = parseDate(firstSession.date);
  const duration = Number(data.duration);
  const end = firstSession.end;
  $("#summaryDay").textContent = date.getDate();
  $("#summaryMonth").textContent = new Intl.DateTimeFormat("es-CL", { month: "short" }).format(date).replace(".", "");
  $("#summarySubject").textContent = `${data.level} · ${selectedCourse(data)}`;
  $("#summaryTitle").textContent = selectedSubject(data);
  $("#summaryDateTime").textContent = sessions.length === 1
    ? `${new Intl.DateTimeFormat("es-CL", { weekday: "long", day: "numeric", month: "long" }).format(date)} · ${firstSession.start} a ${end}`
    : `${sessions.length} clases seleccionadas`;
  $("#summarySessions").hidden = sessions.length === 1;
  $("#summarySessions").innerHTML = sessions.map(session => `<div class="summary-session"><span>${new Intl.DateTimeFormat("es-CL", { weekday: "long", day: "numeric", month: "long" }).format(parseDate(session.date))}</span><strong>${session.start}–${session.end}</strong></div>`).join("");
  $("#summaryDuration").textContent = duration === 60 ? "1 hora" : duration === 90 ? "1 hora 30 min" : "2 horas";
  $("#summaryModality").textContent = data.modality === "Online" ? "Online · Google Meet" : `${data.modality} · ${selectedLocation(data)}`;
  $("#summaryStudent").textContent = data.name;
  $("#summaryClassType").textContent = data.classType === "Grupal"
    ? `Grupal · ${groupEmails().length + 1} integrantes`
    : "Individual";
  $("#summaryEmail").textContent = data.classType === "Grupal"
    ? `${data.email} y ${groupEmails().length} más`
    : data.email;
  $("#noticeEmail").textContent = data.email;
  const basePrice = CONFIG.pricePerHour * duration / 60;
  const travelSurcharge = data.modality === "A domicilio" ? Number(state.travelQuote?.surcharge || 0) : 0;
  $("#summaryTravelBreakdown").hidden = !travelSurcharge;
  $("#summaryBasePrice").textContent = money.format(basePrice * sessions.length);
  $("#summaryTravelPrice").textContent = money.format(travelSurcharge * sessions.length);
  $("#summaryPrice").textContent = money.format((basePrice + travelSurcharge) * sessions.length);
}

function buildPayload(session = currentSession()) {
  const data = formData();
  const duration = Number(data.duration);
  return {
    name: data.name,
    email: data.email,
    phone: data.phone || "",
    referral: data.referral || "",
    level: data.level,
    course: selectedCourse(data),
    subject: selectedSubject(data),
    topic: data.topic || "",
    modality: data.modality,
    classType: data.classType,
    groupEmails: data.classType === "Grupal" ? groupEmails() : [],
    location: selectedLocation(data),
    date: session.date,
    start: session.start,
    end: session.end,
    duration,
    price: CONFIG.pricePerHour * duration / 60 + Number(state.travelQuote?.surcharge || 0),
    travelSurcharge: Number(state.travelQuote?.surcharge || 0),
    timezone: CONFIG.timezone,
    createMeet: data.modality === "Online",
  };
}

async function submitBooking() {
  if (!validateStep(5)) return;
  const sessions = getBookingSessions();
  const button = $("#submitButton");
  button.disabled = true;
  button.textContent = "Confirmando...";
  $("#formAlert").textContent = "";

  try {
    const results = [];
    let completed = 0;
    for (const session of sessions) {
      const payload = buildPayload(session);
      if (CONFIG.calendarApiUrl) {
        const response = await fetch(CONFIG.calendarApiUrl, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({ action: "book", ...payload }),
        });
        const result = await response.json();
        if (!response.ok || !result.success) {
          state.sessions = sessions.slice(completed);
          state.selectedDate = "";
          state.selectedTime = "";
          renderSelectedSessions();
          const prefix = completed
            ? `${completed} ${completed === 1 ? "clase fue creada" : "clases fueron creadas"}. `
            : "";
          throw new Error(`${prefix}${session.date} a las ${session.start}: ${result.error || "no fue posible crear la reserva."}`);
        }
        results.push(result);
        completed += 1;
      } else {
        await new Promise(resolve => setTimeout(resolve, 250));
        completed += 1;
      }
    }
    showSuccess(buildPayload(sessions[0]), results[0] || { success: true, demo: true }, sessions);
  } catch (error) {
    $("#formAlert").textContent = `${error.message} Actualiza la disponibilidad e intenta nuevamente.`;
  } finally {
    button.disabled = false;
    button.innerHTML = `Confirmar reserva <svg viewBox="0 0 24 24"><path d="m5 12.5 4 4 10-10"/></svg>`;
  }
}

function showSuccess(payload, result, sessions) {
  $("#successMessage").textContent = result.demo
    ? "La interfaz funciona correctamente. Conecta Google Calendar para que la reserva se cree y envíe de forma real."
    : `Enviamos ${sessions.length === 1 ? "la invitación" : `${sessions.length} invitaciones`} a ${payload.email}. Revisa también la carpeta de spam.`;
  $("#successDetails").innerHTML = `<strong>${payload.subject}</strong><br>${sessions.length === 1 ? new Intl.DateTimeFormat("es-CL", { dateStyle: "full" }).format(parseDate(payload.date)) : `${sessions.length} clases agendadas`}<br>${sessions.length === 1 ? `${payload.start} · ` : ""}${payload.modality}`;
  const link = $("#calendarLink");
  link.hidden = !result.eventUrl;
  if (result.eventUrl) link.href = result.eventUrl;
  $("#successDialog").showModal();
}

function resetBooking() {
  form.reset();
  state.selectedDate = "";
  state.selectedTime = "";
  state.travelQuote = null;
  state.quotedAddress = "";
  state.sessions = [];
  state.month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  updateLevelFields();
  updateModality();
  updateClassType();
  $("#memberEmailList").innerHTML = "";
  $("#successDialog").close();
  renderSelectedSessions();
  setStep(1);
}

let toastTimer;
function showToast(message) {
  $("#toast").textContent = message;
  $("#toast").classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.remove("visible"), 3200);
}

$("#nextButton").addEventListener("click", async () => {
  if (!validateStep(state.step)) return;
  if (state.step === 3 && !(await ensureTravelQuote())) return;
  setStep(state.step + 1);
});
$("#backButton").addEventListener("click", () => setStep(state.step - 1));
form.addEventListener("submit", event => {
  event.preventDefault();
  submitBooking();
});
form.addEventListener("change", event => {
  if (event.target.name === "level") updateLevelFields();
  if (event.target.name === "career") updateSubjects();
  if (event.target.name === "modality") {
    updateModality();
    if (state.selectedDate) loadAvailability(state.selectedDate);
  }
  if (event.target.name === "classType") updateClassType();
  if (event.target.name === "duration") {
    state.sessions = [];
    state.selectedTime = "";
    renderSelectedSessions();
    $("#addSessionButton").disabled = true;
    if (state.selectedDate) loadAvailability(state.selectedDate);
    if (state.travelQuote) updateDisplayedTravelPrice();
  }
  const field = event.target.closest(".field");
  if (field) {
    field.classList.remove("invalid");
    const error = $(".field-error", field);
    if (error) error.textContent = "";
  }
});
$$('input[name="level"]').forEach(input => input.addEventListener("change", updateLevelFields));
$("#careerSelect").addEventListener("change", updateSubjects);
form.homeLocation.addEventListener("input", () => {
  state.travelQuote = null;
  state.quotedAddress = "";
  $("#travelQuote").hidden = true;
  applyHomeDurationRule(60);
});
$("#addMemberButton").addEventListener("click", () => addMemberEmail());
$("#memberEmailList").addEventListener("click", event => {
  const remove = event.target.closest(".remove-member");
  if (!remove) return;
  remove.closest(".member-email-row").remove();
  if (!$(".member-email", $("#memberEmailList"))) addMemberEmail();
  syncMemberEmailRequirements();
  $("#memberEmailsError").textContent = "";
});
$("#memberEmailList").addEventListener("input", () => {
  $("#memberEmailsError").textContent = "";
});
$("#calendarDays").addEventListener("click", event => {
  const day = event.target.closest("[data-date]");
  if (day && !day.disabled) loadAvailability(day.dataset.date);
});
$("#timeSlots").addEventListener("click", event => {
  const slot = event.target.closest("[data-time]");
  if (!slot) return;
  $$(".time-slot").forEach(item => item.classList.remove("selected"));
  slot.classList.add("selected");
  state.selectedTime = slot.dataset.time;
  $("#addSessionButton").disabled = false;
  $("#scheduleError").textContent = "";
});
$("#addSessionButton").addEventListener("click", addCurrentSession);
$("#selectedSessionsList").addEventListener("click", event => {
  const remove = event.target.closest("[data-remove-session]");
  if (!remove) return;
  state.sessions.splice(Number(remove.dataset.removeSession), 1);
  renderSelectedSessions();
  if (state.selectedDate) renderTimeSlots();
});
$("#previousMonth").addEventListener("click", () => {
  const currentMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const previous = new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1);
  if (previous >= currentMonth) state.month = previous;
  renderCalendar();
});
$("#nextMonth").addEventListener("click", () => {
  state.month = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1);
  renderCalendar();
});
$("#refreshAvailability").addEventListener("click", () => {
  if (state.selectedDate) loadAvailability(state.selectedDate);
  else showToast("Primero selecciona una fecha.");
});
$("#newBookingButton").addEventListener("click", resetBooking);

initializeCareers();
updateLevelFields();
updateModality();
updateClassType();
renderCalendar();
loadBookingSettings();
