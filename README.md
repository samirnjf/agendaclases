# ClaseLista — reserva de clases

Flujo público para que estudiantes reserven una clase según nivel, carrera, ramo, modalidad, duración y disponibilidad.

## Ejecutar localmente

```bash
python3 -m http.server 8000 --bind 127.0.0.1
```

Abre `http://127.0.0.1:8000`.

## Configurar Google Calendar

La interfaz funciona en modo demostración hasta conectar una cuenta:

1. Entra a [Google Apps Script](https://script.google.com) y crea un proyecto.
2. Copia `google-apps-script/Code.gs` y `google-apps-script/appsscript.json`.
3. En `Code.gs`, cambia `OWNER_EMAIL` por tu correo. `CALENDAR_ID = "primary"` utiliza tu calendario principal.
4. En Apps Script, abre **Servicios** y confirma que **Google Calendar API** esté habilitada.
5. Selecciona **Implementar → Nueva implementación → Aplicación web**.
6. Configura **Ejecutar como: Yo** y **Quién tiene acceso: Cualquier persona**.
7. Autoriza el acceso y copia la URL que termina en `/exec`.
8. Pega esa URL en `CONFIG.calendarApiUrl` al inicio de `app.js`.

## Panel administrativo privado

El panel se encuentra en `/admin.html` y muestra clientes, próximas clases, historial,
frecuencia, pagos e ingresos esperados.

Antes de utilizarlo:

1. Cambia `ADMIN_KEY` en `google-apps-script/Code.gs` por una clave larga y privada.
2. Copia nuevamente `Code.gs` en Google Apps Script.
3. Crea una nueva versión de la implementación.
4. Entra al panel con esa clave. La clave solo se conserva durante la sesión del navegador.
5. Pulsa **Activar recordatorio diario** una sola vez. Apps Script pedirá los permisos
   necesarios y enviará cada 24 horas un correo con todas las transferencias pendientes.

### Dirección privada para clases a domicilio

En **Configuración del proyecto → Propiedades del script**, crea:

- Propiedad: `HOME_ADDRESS`
- Valor: tu dirección completa

La dirección queda únicamente en Apps Script. No se envía al navegador ni se publica en GitHub.

Con la integración activa:

- La disponibilidad excluye eventos existentes de tu Google Calendar.
- Los eventos cuyo título incluya prueba, evaluación, examen, control, certamen
  o presentación bloquean desde las 07:00 hasta una hora después de su término.
  La detección ignora mayúsculas, minúsculas y tildes.
- Una reserva vuelve a comprobar conflictos antes de guardarse.
- Se crea el evento en tu calendario.
- Se invita automáticamente al correo del alumno.
- Para clases online se crea un enlace de Google Meet.
- Todas las clases nuevas se crean con color amarillo en Google Calendar.
- Las clases a domicilio agregan un recargo calculado por tiempo y costo de traslado.
- En clases grupales se invita al correo principal y a todos los integrantes.
- La reserva puede registrar opcionalmente quién recomendó la clase.

> Para una publicación abierta a gran escala conviene añadir CAPTCHA y límites de solicitudes
> para evitar reservas automatizadas. La versión actual está planteada como un MVP funcional.

## Ajustes principales

Al inicio de `app.js`, edita:

- `pricePerHour`: precio por hora en CLP.
- `firstStartHour`: primera hora ofrecida.
- `lastStartHour`: última hora permitida para comenzar.
- `bookingWindowDays`: cantidad de días futuros disponibles.
- `CAREERS`: carreras y ramos ofrecidos.
