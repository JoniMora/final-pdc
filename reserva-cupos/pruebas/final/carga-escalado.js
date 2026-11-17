// Compatibilidad con el comando de CI anterior. La curva de E6 usa ahora
// 1/2/4 APIs y Redis. No escala dos workers sobre una misma particion,
// porque eso rompe la garantia de un consumidor y el orden por actividad.
// Evidencia: docs/entrega-6/evidencias/redis-escalado.json.
require('./redis');
