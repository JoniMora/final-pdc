# Ensayo de la demo, paso a paso

Para hacer la demo a mano, sin el script `escenario-mas-uno.js`: qué preparar, qué comando correr, qué abrir y qué tiene que verse en cada paso. La Parte 1 (se cae la base del cliente, unos 10 minutos) se probó el 20/11/2026; la Parte 2 (se cae nuestro servidor, unos 6 minutos) el 22/11/2026, en macOS.

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

## Parte 2: se cae nuestro servidor (unos 6 minutos)

La Parte 1 tira abajo el servidor del **cliente**. Esta tira abajo piezas del **servicio**, con una ráfaga en curso. Se necesitan dos pestañas de terminal en `reserva-cupos`: en la **pestaña 1** corre la ráfaga y en la **pestaña 3** se provoca la falla. La pestaña 2 (logs del worker) puede seguir abierta.

En la pestaña 1, cargar la clave del tenant de la demo:

```shell
DEMO=$(cat seguridad/local/tenant-demo.key)
```

Ventanas para mirar: **Grafana** (ventana C) y el **panel de Traefik**, https://localhost:8080/dashboard/ → *HTTP Services* → `api@docker`.

### A. Se cae una instancia de la API

- **Pestaña 3:** pasar a dos instancias de la API.
  ```shell
  docker compose up -d --scale api=2 --no-recreate api
  ```
  En el panel de Traefik, `api@docker` muestra **dos servidores**.
- **Pestaña 1:** lanzar la ráfaga.
  ```shell
  docker compose run --rm k6 run -e API_KEY="$DEMO" -e REINTENTOS=8 /pruebas/carga/rafaga.js
  ```
- **Pestaña 3, a los 3 o 4 segundos:** matar una de las dos.
  ```shell
  docker kill $(docker compose ps -q api | head -1)
  ```
- **Qué se ve:**
  - Traefik deja de mandarle tráfico (queda un servidor).
  - Algunos clientes reciben 502 o 504 y reintentan con la misma `Idempotency-Key`.
  - k6 termina con `confirmadas=10 rechazadas=490 pendientes=0`.
- **Volver a una instancia:**
  ```shell
  docker compose up -d --scale api=1 api
  ```

### B. Se cae el worker

- **Pestaña 1:** la misma ráfaga.
  ```shell
  docker compose run --rm k6 run -e API_KEY="$DEMO" -e REINTENTOS=8 /pruebas/carga/rafaga.js
  ```
- **Pestaña 3, a los 3 o 4 segundos:**
  ```shell
  docker compose stop worker
  ```
- **Qué se ve:**
  - Las 500 solicitudes siguen recibiendo 202.
  - En Grafana, "RabbitMQ: mensajes por cola" sube (`reservas.comandos.0`) y "Decisiones" queda en cero.
- **Pestaña 3, unos 15 segundos después:**
  ```shell
  docker compose start worker
  ```
  La cola se vacía y k6 termina con `confirmadas=10 rechazadas=490 pendientes=0`.
- **Qué decir:** la cola es durable y el worker confirma cada comando después del commit. Si cae, los comandos esperan; si cae a mitad de uno, se reentrega y la idempotencia evita descontar dos veces.

### C. Se cae el MySQL primario (va última)

- **Pestaña 1:** la ráfaga, con más reintentos porque el failover es a mano.
  ```shell
  docker compose run --rm k6 run -e API_KEY="$DEMO" -e REINTENTOS=30 /pruebas/carga/rafaga.js
  ```
- **Pestaña 3, a los 3 o 4 segundos:** matar el primario.
  ```shell
  docker compose kill mysql-primary
  ```
  Las escrituras fallan: la API responde 503 y los clientes reintentan (en Grafana, el panel de Traefik muestra los 503).
- **Pestaña 3, enseguida:** promover la réplica.
  ```shell
  node scripts/sistema.js failover
  ```
  Muestra cada paso:
  - la réplica aplicó todo lo recibido;
  - quedó promovida;
  - responde como `mysql-primary`;
  - **cuánto tardó la escritura en volver** (en el ensayo: 5 s desde el failover, 11 s desde la caída).
- **Qué se ve:** k6 termina con `confirmadas=10 rechazadas=490 pendientes=0`: ninguna reserva admitida ni confirmada se perdió.
- **Qué decir:**
  - La replicación es semisincrónica: el primario no confirma un commit hasta que la réplica lo tiene, por eso no se pierde nada (RPO 0).
  - La API, el worker y el relay no cambian su configuración: el nombre `mysql-primary` ahora apunta a la réplica.
  - El failover es manual a propósito: con dos nodos, decidir solo que el primario murió puede terminar en dos primarios; haría falta un tercero que decida.
- **Después de la demo**, para volver a primario + réplica (**borra los datos del entorno**; los certificados y las claves se conservan):
  ```shell
  node scripts/sistema.js restaurar
  ```
  Mientras no se restaure, `demo` y `levantar` se niegan a arrancar: avisan que la réplica fue promovida.

## Después del ensayo

- Anotarlo en la Wiki, página **"Ensayos de la demo"**: fecha, quiénes, duración, qué salió y qué ajustar.
- No hace falta limpiar nada: cada ensayo crea materias nuevas. Si `aula-db` quedó detenida, `docker compose start aula-db`.
- Si se hizo la Parte 2 C, correr `node scripts/sistema.js restaurar` antes del próximo ensayo (tarda lo mismo que `demo`).
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

Parte 2:

```powershell
$DEMO = Get-Content seguridad\local\tenant-demo.key
docker compose up -d --scale api=2 --no-recreate api
docker compose run --rm k6 run -e API_KEY="$DEMO" -e REINTENTOS=8 /pruebas/carga/rafaga.js
docker kill (docker compose ps -q api | Select-Object -First 1)
docker compose up -d --scale api=1 api
docker compose stop worker
docker compose start worker
docker compose run --rm k6 run -e API_KEY="$DEMO" -e REINTENTOS=30 /pruebas/carga/rafaga.js
docker compose kill mysql-primary
node scripts/sistema.js failover
node scripts/sistema.js restaurar
```

Para confiar en la CA: doble clic en `seguridad\local\ca.crt` → *Instalar certificado* → *Usuario actual* → *Colocar todos los certificados en el siguiente almacén* → **Entidades de certificación raíz de confianza**.
