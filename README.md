# Wallet Business AI

SaaS para pequeñas empresas para crear programas de fidelización y cupones digitales integrados con Google Wallet.

## Estado actual

MVP backend listo para la primera integración real de Google Wallet:

- Backend Node.js + TypeScript
- Integración con Google Wallet REST API
- Loyalty Class reutilizable
- Loyalty Object individual por cliente
- Emisión idempotente: si el objeto ya existe, se reutiliza
- URL firmada de "Add to Google Wallet"
- Health check
- Variables de entorno para credenciales
- GitHub Actions para typecheck + build

## Arquitectura inicial

**Class**: plantilla compartida del programa de fidelización.

**Object**: tarjeta individual del cliente, con ID, nombre y puntos.

**Add to Google Wallet**: JWT firmado por la cuenta de servicio. El enlace referencia el objeto existente para evitar duplicar su definición dentro del JWT.

Google documenta que las Passes Classes contienen propiedades compartidas y los Passes Objects contienen los datos individuales. También documenta el flujo JWT para generar enlaces de "Add to Google Wallet".

## Configuración de Google Wallet

1. Crea o selecciona un proyecto en Google Cloud.
2. Habilita la Google Wallet API.
3. Crea una cuenta de servicio y una clave JSON.
4. En Google Pay & Wallet Console, autoriza el correo de la cuenta de servicio como usuario Developer del Issuer.
5. Obtén el **Issuer ID** de tu cuenta de Google Wallet.
6. Define un **Class ID** único con el formato recomendado por Google, por ejemplo:
   `ISSUER_ID.WalletBusinessAILoyalty`
7. Configura las variables del archivo `.env.example`.

Las credenciales privadas no deben almacenarse en Git.

## Desarrollo local

```bash
npm install
cp .env.example .env
npm run dev
```

Comprobación:

```bash
curl http://localhost:3000/health
```

Crear o recuperar la clase:

```bash
curl -X POST http://localhost:3000/api/wallet/loyalty/class
```

Crear o recuperar una tarjeta y obtener su enlace:

```bash
curl -X POST http://localhost:3000/api/wallet/loyalty \
  -H "Content-Type: application/json" \
  -d '{"id":"cliente-001","name":"Cliente Demo","points":100}'
```

## Variables

Consulta `.env.example`:

- `PORT`
- `GOOGLE_WALLET_ISSUER_ID`
- `GOOGLE_WALLET_CLASS_ID`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`

## CI

GitHub Actions ejecuta:

```bash
npm install
npm run typecheck
npm run build
```

También admite `workflow_dispatch` para ejecuciones manuales.

## Migraciones versionadas

Las migraciones SQL se ejecutan en orden por nombre y quedan registradas en `schema_migrations`. Cada archivo se aplica una sola vez dentro de una transacción.

Archivos actuales:

- `001_init.sql` — esquema inicial.
- `002_customer_status.sql` — estado `ACTIVE/INACTIVE` del cliente.

Ejecuta:

```bash
npm run db:migrate
```

El runner usa un bloqueo transaccional de PostgreSQL para evitar dos procesos de migración concurrentes.

## Búsqueda y filtrado de clientes

El dashboard permite buscar por nombre o ID y filtrar por estado. La búsqueda se ejecuta en el backend para no cargar toda la lista en el navegador.

```text
GET /api/v1/businesses/:businessId/customers?q=cliente&status=ACTIVE
Authorization: Bearer <TOKEN>
```

`status` acepta `ALL`, `ACTIVE` o `INACTIVE`.

## Fase 4 — Dashboard y gestión de clientes

La API autenticada ahora incluye un dashboard operativo para administrar clientes por negocio.

### Clientes y métricas

GET /api/v1/businesses/:businessId/customers
Authorization: Bearer <TOKEN>

La respuesta incluye:

- información del negocio seleccionado
- total de clientes
- total de puntos
- clientes con su ID, nombre, puntos y fecha de actualización
- identificador del objeto de Google Wallet cuando existe

El panel web permite:

1. seleccionar el negocio;
2. consultar métricas del negocio;
3. ver la lista de clientes;
4. generar el enlace de Google Wallet de un cliente;
5. cargar un cliente en el formulario de puntos;
6. actualizar los puntos y refrescar el dashboard.

El enlace de Google Wallet se genera bajo demanda en el servidor y la clave privada nunca llega al navegador.


### Editar un cliente

```text
PATCH /api/v1/businesses/:businessId/customers/:customerId
Authorization: Bearer <TOKEN>
Content-Type: application/json
```

Body:

```json
{"name":"Cliente actualizado","points":300,"status":"ACTIVE"}
```

El endpoint sincroniza nombre, puntos y estado con PostgreSQL y con el objeto existente de Google Wallet. El `customerId` no se cambia porque identifica de forma estable el objeto de Wallet.

## Fase 5 — Paginación y ordenamiento de clientes

El listado de clientes soporta paginación server-side y ordenamiento, manteniendo búsqueda y filtros.

```text
GET /api/v1/businesses/:businessId/customers
  ?q=cliente
  &status=ACTIVE
  &page=1
  &pageSize=25
  &sort=updatedAt
  &order=desc
Authorization: Bearer <TOKEN>
```

Parámetros:

- `page`: página desde 1.
- `pageSize`: `25`, `50` o `100`.
- `q`: búsqueda por nombre o ID.
- `status`: `ALL`, `ACTIVE` o `INACTIVE`.
- `sort`: `name`, `points`, `updatedAt` o `createdAt`.
- `order`: `asc` o `desc`.

La respuesta incluye `pagination` con total de resultados, total de páginas y flags para navegación anterior/siguiente. PostgreSQL aplica `LIMIT/OFFSET` y existen índices específicos para las consultas habituales del dashboard.

## Fase 6 — Gestión de negocios y logos

La gestión de negocios permite editar nombre, programa y branding desde el dashboard. El logo puede venir de una URL HTTPS o de un archivo JPG, PNG o WebP de hasta 5 MB.

### Logo por archivo

El formulario usa `multipart/form-data` y el backend guarda la imagen en `public/uploads/logos/`, una ruta excluida de Git. Para que Google Wallet pueda descargar un logo subido, el despliegue debe exponer esos archivos mediante una URL pública HTTPS.

Configura:

```env
PUBLIC_BASE_URL=https://tu-dominio-publico.example.com
```

En producción, el almacenamiento local de archivos debe montarse sobre un volumen persistente o reemplazarse por almacenamiento de objetos/CDN.

La edición del negocio usa:

```text
PATCH /api/v1/businesses/:businessId
Authorization: Bearer <TOKEN>
```

Puede recibir `name`, `programName`, `logoUrl` o un archivo multipart llamado `logo`. Después de guardar los cambios, la Loyalty Class se sincroniza con Google Wallet.

## Fase 7 — Cupones y Offers

Wallet Business AI incorpora campañas de cupones como **Offer Class** y cupones individuales como **Offer Object** de Google Wallet.

La API autenticada incluye:

```text
GET  /api/v1/businesses/:businessId/offers
POST /api/v1/businesses/:businessId/offers
POST /api/v1/businesses/:businessId/offers/:offerId/customers/:customerId
Authorization: Bearer <TOKEN>
```

Una campaña permite definir:

- título y descripción;
- condiciones;
- código de cupón;
- canal de redención: `INSTORE`, `ONLINE` o `BOTH`;
- fecha de inicio y fecha de finalización.

Al emitir un cupón a un cliente, el backend crea o recupera el `OfferObject`, lo relaciona con la tarjeta de fidelización del cliente y devuelve un enlace firmado de **Añadir a Google Wallet**.

La persistencia se encuentra en:

- `offers`;
- `offer_objects`.

La migración correspondiente es `004_offers.sql`.

Google Wallet usa `OfferClass` para definir el contenido compartido de una oferta y `OfferObject` para la instancia individual.

## Fase 8 — Gestión y ciclo de vida de cupones

La gestión de ofertas permite editar campañas existentes y sincronizar los cambios con Google Wallet, incluyendo los Offer Objects que ya fueron emitidos.

La API autenticada ahora incluye:

```text
PATCH /api/v1/businesses/:businessId/offers/:offerId
POST  /api/v1/businesses/:businessId/offers/:offerId/sync
```

Una campaña puede estar administrativamente `ACTIVE` o `INACTIVE`. El backend calcula además su estado operativo:

- `ACTIVE` — puede emitirse.
- `SCHEDULED` — todavía no comienza por su fecha de inicio.
- `INACTIVE` — campaña pausada.
- `EXPIRED` — la fecha de finalización ya pasó.

Al editar una campaña, Wallet Business AI actualiza la `OfferClass` y sincroniza los `OfferObject` existentes para reflejar código, fechas, estado y contenido.

Los objetos con `validTimeInterval` utilizan fechas ISO 8601 y Google Wallet puede moverlos a la sección de pases vencidos cuando termina el intervalo o cuando el objeto se marca como `EXPIRED`.

Desde el dashboard se puede:

1. editar una campaña;
2. activar o pausar una campaña;
3. sincronizar manualmente una campaña;
4. ver si está activa, programada, inactiva o expirada;
5. emitir únicamente campañas actualmente disponibles.

## Fase 9 — Redención y trazabilidad de cupones

Wallet Business AI permite registrar la redención de un cupón por cliente y sincronizar el estado del Offer Object con Google Wallet.

La API autenticada incluye:

```text
POST /api/v1/businesses/:businessId/offers/:offerId/customers/:customerId/redeem
GET  /api/v1/businesses/:businessId/offer-redemptions
```

Para redimir, el backend valida el negocio, la campaña, el estado temporal, el código del cupón y que el cupón haya sido emitido al cliente. Cada combinación oferta/cliente solo puede redimirse una vez.

Al completar una redención, el backend marca el Offer Object como `COMPLETED` en Google Wallet y registra fecha y notas en PostgreSQL. Google documenta `COMPLETED` como uno de los estados de ciclo de vida de un Offer Object junto con `EXPIRED` e `INACTIVE`. citeturn931229search1

El dashboard incluye:

1. formulario de redención;
2. validación del código;
3. historial de las últimas 200 redenciones;
4. contador de emitidos/redimidos por campaña.

La migración correspondiente es `005_offer_redemptions.sql`.

## Fase 10 — Escáner QR para redención

El dashboard incorpora un escáner QR para que el negocio pueda redimir una oferta directamente desde el teléfono.

El flujo es:

1. el `OfferObject` genera un QR único basado en su `wallet_object_id`;
2. el navegador solicita la cámara trasera;
3. `BarcodeDetector` detecta el QR;
4. el backend identifica automáticamente oferta, cliente y objeto Wallet;
5. se valida el ciclo de vida y que la oferta no haya sido redimida;
6. el `OfferObject` pasa a `COMPLETED` y la redención queda registrada.

La API incluye:

```text
POST /api/v1/businesses/:businessId/offer-scans/redeem
```

El escáner utiliza la API nativa `BarcodeDetector` para evitar una dependencia pesada. Esta API requiere un contexto seguro y su compatibilidad entre navegadores todavía es limitada, por lo que el dashboard mantiene el formulario manual de redención como alternativa. citeturn388412search0turn388412search3

Los cupones emitidos antes de la Fase 10 pueden conservar el QR anterior. Para ellos se debe utilizar una vez la acción **Sincronizar** de la campaña desde el dashboard para actualizar sus Offer Objects con el nuevo QR único.

## Fase 11 — Analítica de clientes y campañas

Wallet Business AI incorpora analítica derivada de las operaciones reales del negocio, sin duplicar eventos en una tabla paralela.

Endpoint:

```text
GET /api/v1/businesses/:businessId/analytics?days=7|30|90
Authorization: Bearer <TOKEN>
```

El dashboard muestra:

- clientes totales y clientes activos disponibles para la operación;
- campañas totales y campañas activas;
- cupones emitidos;
- cupones redimidos;
- tasa de redención;
- clientes que han redimido al menos un cupón;
- clientes recurrentes con dos o más redenciones;
- rendimiento individual de cada campaña;
- clientes con mayor actividad de cupones;
- actividad diaria de emisión y redención para 7, 30 o 90 días.

La analítica utiliza `customers`, `offers`, `offer_objects` y `offer_redemptions` como fuente de verdad. No añade una migración porque todas las métricas pueden derivarse de los datos transaccionales existentes.

## Siguiente fase

1. Automatización con Gemini para crear y administrar campañas.
2. Autenticación reforzada, roles y seguridad operativa.
3. Planes, suscripciones y límites SaaS.
4. Despliegue de producción y observabilidad.
