# CI: respuesta 502 en la prueba de limite de tasa

El job Integracion de la corrida 55, commit `070b7a4`, fallo en el paso
Limite de tasa por tenant. La rafaga de 500 y los contratos habian aprobado.
La prueba de tasa registro 13.700 solicitudes, un 502 en el tenant saturado,
13.559 respuestas 429 y ningun rechazo del tenant vecino. Seguridad y el job
de escalabilidad de E6 aprobaron. CI completo fallo por esa dependencia.

[Corrida de GitHub Actions](https://github.com/JoniMora/final-pdc/actions/runs/44104977683).

La configuracion anterior usaba el keep-alive por defecto de Node (5 s),
pero no fijaba el retiro de conexiones ociosas en Traefik (90 s por defecto).
Ese desajuste permite una carrera al reutilizar una conexion que el servidor
esta cerrando. Es una hipotesis compatible con un 502 aislado; los registros
existentes no muestran la causa de transporte exacta y no la prueban.

Se fija `keepAliveTimeout=65000` y `headersTimeout=66000` en la API, y
`idleConnTimeout=60s` en su transporte de Traefik. El proxy deja de conservar
la conexion antes del cierre ocioso del backend. No se modifican los tiempos
de Redis, la verificacion TLS, el limite de tasa ni los criterios de k6.
No se agregan reintentos para disimular respuestas incorrectas.

La sintaxis y las pruebas unitarias se verificaron localmente. La corrida 56
del commit ec1cecf aprobo los doce jobs, incluida Integracion y CI completo:
https://github.com/JoniMora/final-pdc/actions/runs/44107729654
El resultado valida esta corrida; no prueba por si solo la causa exacta del
502 anterior ni elimina la necesidad de vigilar recurrencias.

Referencias: [Node HTTP](https://nodejs.org/api/http.html#serverkeepalivetimeout)
y [Traefik ServersTransport](https://doc.traefik.io/traefik/reference/routing-configuration/http/load-balancing/serverstransport/).
