# Ensayo de la demo, paso a paso

Para hacer la demo a mano, sin el script `escenario-mas-uno.js`: qué preparar, qué comando correr, qué abrir y qué tiene que verse en cada paso. Probado el 20/11/2026 en macOS. Dura unos 10 minutos.

Los comandos son de macOS (zsh) y se corren desde `reserva-cupos`. En Windows (PowerShell), ver la última sección.

## Antes (unos 10 minutos)

1. Abrir **Docker Desktop** y esperar a que diga que está corriendo.
2. En una terminal:
   ```shell
   cd ~/PDC-AGAIN/Funes/Final/final-pdc/reserva-cupos
   node scripts/sistema.js demo
   ```
   Tiene que terminar con **"Listo para la demo"**. Si algo falla, el comando dice qué; correrlo de nuevo no rompe nada.
   La primera vez después de abrir Docker puede tardar varios minutos (compila las imágenes y RabbitMQ arranca lento): esperar, el comando espera hasta 10.
3. **Confiar en la CA local** (una sola vez por equipo), para que el navegador no muestre advertencias:
   ```shell
   sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain seguridad/local/ca.crt
   ```
   Cerrar y volver a abrir el navegador.
4. **Credenciales:** abrir `seguridad/local/accesos-locales.txt`, anotar las de `admin`, `alumno1` y Grafana, y cerrarlo. No mostrarlo en pantalla.
5. **Navegador**, tres ventanas:
   - **A (normal):** https://localhost:3001 → iniciar sesión como `admin`.
   - **B (privada):** https://localhost:3001 → iniciar sesión como `alumno1`. Tiene que ser privada para que no comparta la sesión con el admin.
   - **C:** https://localhost:3002 (Grafana) → `admin` → *Dashboards* → **"Reserva de cupos — Entrega 6"**. Arriba a la derecha: *Last 15 minutes* y refresco cada *5s*.
6. **Terminal**, dos pestañas en `reserva-cupos`:
   - **Pestaña 1 (comandos):** cargar la clave del tenant Aula sin mostrarla:
     ```shell
     CLAVE=$(grep -o 'rc_aula_[0-9a-f]*' docker-compose.yml | head -1)
     ```
   - **Pestaña 2 (decisiones del worker en vivo):**
     ```shell
     docker compose logs -f --tail=0 worker
     ```
7. Agrandar la letra de la terminal y del navegador.

## La demo

### 1. El sistema sano (1 minuto)

- **Ventana A:** "Estado de las conexiones" → *Actualizar estado*. Se ve `postgresql: conectado`, `recuperacion: normal`, `api: conectada (instancia …)` y el contrato `openapi.yaml 1.3.0`.
- **Qué decir:** Aula es un cliente del servicio, con su propia base PostgreSQL; el servicio decide los cupos en MySQL.

### 2. Una inscripción normal (2 minutos)

- **Ventana A:** en "Crear materia", nombre `Taller`, cupo `1` → *Crear materia*. Aparece `HTTP 201` y la materia en la lista.
- **Ventana B:** *Ver materias* → *Seleccionar* en **Taller** → *Inscribirse*. Primero `HTTP 202 … "estado": "pendiente"` y enseguida **`confirmada`**.
- **Ventana B:** "Cupos e inscriptos" → *Actualizar*: `Cupos disponibles: 0 de 1`, `alumno-1` confirmado y, en "Según la base de Aula", `1`.
- **Pestaña 2:** aparece la decisión del worker (`reservar … confirmada`).
- **Qué decir:** la API responde 202 apenas guarda la solicitud; el worker decide con un UPDATE condicional y el webhook firmado actualiza la base de Aula.
- *(Opcional)* **Ventana B:** *Cancelar esta inscripción* → `cancelada`, y el cupo vuelve a `1 de 1`.

### 3. Se abre la materia del escenario +1 (30 segundos)

- **Ventana A:** nombre `Programación Distribuida`, cupo `10` → *Crear materia*.
- Copiar el **`"id"`** del JSON que aparece abajo (`HTTP 201`). En la **pestaña 1**:
  ```shell
  ACT=<pegar acá el id>
  ```

### 4. Se cae la base de Aula (1 minuto)

- **Pestaña 1:**
  ```shell
  docker compose stop aula-db
  ```
- **Ventana A:** *Actualizar estado* → **`postgresql: no disponible`**. (`recuperacion` pasa a `degradado` en el próximo ciclo, dentro de 30 s.)
- **Ventana A:** *Ver materias* → la lista sigue apareciendo: sin su base, Aula arma el catálogo desde el feed de la API.
- **Qué decir:** Aula no se cae; sigue operando contra la API, que nunca dependió de su base.

### 5. 500 alumnos a la vez (1 minuto)

- **Pestaña 1:**
  ```shell
  docker compose run --rm k6 run -e API_KEY="$CLAVE" -e ACTIVIDAD_ID="$ACT" -e REINTENTOS=8 /pruebas/carga/rafaga.js
  ```
  k6 hace de 500 alumnos que piden la misma materia a la vez, con la clave de Aula, como lo haría su backend.
- **Mirar mientras corre:**
  - **Pestaña 2:** pasan las decisiones: 10 `confirmada` y el resto `rechazada`.
  - **Ventana C (Grafana):** suben "Reservas admitidas por segundo", "Decisiones de reserva por segundo" y "RabbitMQ: mensajes por cola".
- **Al terminar, k6 muestra** `Resultado (…): confirmadas=10 rechazadas=490 pendientes=0 cupos_disponibles=0` y los checks con ✓.
- **Qué decir:**
  - Las 500 reciben 202 rápido.
  - La decisión es de a una, con un UPDATE condicional en MySQL, y por eso nunca hay más de 10.
  - Si una respuesta se pierde, k6 reintenta con la misma `Idempotency-Key` y no se duplica.

### 6. Lo que ve Aula sin su base (1 minuto)

- **Ventana A:** *Seleccionar* en **Programación Distribuida** → "Cupos e inscriptos" → *Actualizar*:
  - `Cupos disponibles: 0 de 10`;
  - 10 inscriptos confirmados según la API;
  - "Según la base de Aula, actualizada por webhooks: **Base de Aula no disponible**".
- **Ventana B:** *Ver materias* → *Seleccionar* **Programación Distribuida** → *Inscribirse* → `pendiente` y después **`rechazada`**: no quedan cupos.
- **Qué decir:** con la base caída, Aula sigue mostrando el estado real y sigue inscribiendo, porque la fuente de verdad es el servicio.

### 7. Vuelve la base y se reconcilia (1 minuto)

- **Pestaña 1:**
  ```shell
  docker compose start aula-db
  ```
- Esperar unos 10 segundos.
- **Ventana A:** *Actualizar estado* → `postgresql: conectado`, `recuperacion: normal`.
- **Ventana A:** "Cupos e inscriptos" → *Actualizar* → "Según la base de Aula": **10**, los mismos que confirmó la API.
- **Qué decir:** Aula leyó `/v1/cambios` desde su último punto de control y quedó igual al servicio. Es el criterio del plan: 10 confirmadas, 0 duplicadas, 0 cupos negativos y la base de Aula idéntica al servicio.

### 8. Cierre (1 minuto)

- **Ventana C:** recorrer el dashboard: la ráfaga, las decisiones, las colas.
- Mencionar las evidencias de carga y fallos de la [Entrega 6](../entrega-6/README.md) y la matriz de fallos de la [Entrega 5](../entrega-5/evidencias/fallos/resumen.md).

## Después del ensayo

- Anotarlo en la Wiki, página **"Ensayos de la demo"**: fecha, quiénes, duración, qué salió y qué ajustar.
- No hace falta limpiar nada: cada ensayo crea materias nuevas. Si `aula-db` quedó detenida, `docker compose start aula-db`.
- Para dejar de confiar en la CA: abrir *Acceso a Llaveros*, buscar la CA de reserva-cupos y borrarla.

## Si algo falla en vivo

Ver el **Plan B** de [demo.md](demo.md): video de respaldo, el último registro de `docs/final/ensayos/` y las evidencias con su fecha.

## En Windows (PowerShell)

Desde `reserva-cupos`, en la terminal de IntelliJ:

```powershell
node scripts/sistema.js demo
$CLAVE = (Select-String -Path docker-compose.yml -Pattern 'rc_aula_[0-9a-f]+').Matches[0].Value
$ACT = "<pegar acá el id>"
docker compose stop aula-db
docker compose run --rm k6 run -e API_KEY="$CLAVE" -e ACTIVIDAD_ID="$ACT" -e REINTENTOS=8 /pruebas/carga/rafaga.js
docker compose start aula-db
```

Para confiar en la CA: doble clic en `seguridad\local\ca.crt` → *Instalar certificado* → *Usuario actual* → *Colocar todos los certificados en el siguiente almacén* → **Entidades de certificación raíz de confianza**.
