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

## Siguiente fase

1. Automatización con Gemini para crear campañas a partir de instrucciones del negocio.
2. Mejoras de cupones: edición, activación/desactivación y redención.
3. Analítica de clientes y campañas.
4. Autenticación reforzada, planes y suscripciones.


## Conectar Google Wallet

Para activar la conexión real, configura estos valores como **Secrets/Environment Variables** en el entorno donde se ejecute el backend:

```text
GOOGLE_WALLET_ISSUER_ID
GOOGLE_WALLET_CLASS_ID
GOOGLE_SERVICE_ACCOUNT_EMAIL
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
```

No subas el archivo JSON de la cuenta de servicio al repositorio.

### Google Cloud / Google Wallet

Google requiere una cuenta de servicio para autenticar las llamadas REST a Google Wallet. La cuenta de servicio debe estar autorizada para el Issuer en Google Wallet Business Console. La clave privada es información sensible y debe permanecer solamente en el servidor o en el gestor de secretos del despliegue.

El flujo de este proyecto es:

```text
Cliente
  ↓
Panel Wallet Business AI
  ↓
/api/wallet/loyalty
  ↓
Google Wallet REST API
  ↓
Loyalty Class + Loyalty Object
  ↓
JWT RS256
  ↓
https://pay.google.com/gp/v/save/<JWT>
  ↓
Google Wallet del cliente
```

### Valores de ejemplo

El Class ID debe pertenecer al Issuer, por ejemplo:

```text
1234567890123456789.WalletBusinessAILoyalty
```

No copies este valor literalmente: usa tu Issuer ID real.

### Verificación

Después de configurar las credenciales, comprueba:

```bash
curl http://localhost:3000/health
curl -X POST http://localhost:3000/api/wallet/loyalty/class
curl -X POST http://localhost:3000/api/wallet/loyalty \
  -H "Content-Type: application/json" \
  -d '{"id":"cliente-001","name":"Cliente Demo","points":100}'
```

La última respuesta debe incluir `addToWalletUrl`. Al abrir ese enlace con una cuenta de Google autenticada, el usuario puede guardar la tarjeta en Google Wallet.


## Fase 3 — PostgreSQL + autenticación

La nueva API autenticada vive bajo `/api/v1`. Las rutas antiguas se mantienen temporalmente para compatibilidad.

### Variables nuevas

```env
DATABASE_URL=postgresql://USUARIO:CONTRASEÑA@HOST:5432/BASE
DATABASE_SSL=false
JWT_SECRET=una-clave-aleatoria-de-al-menos-32-caracteres
```

Para proveedores administrados que requieren TLS, usa:

```env
DATABASE_SSL=true
```

### Migrar la base de datos

Con `DATABASE_URL` configurado:

```bash
npm install
npm run db:migrate
```

La migración crea:

- `users`
- `businesses`
- `customers`

Los negocios quedan ligados a su propietario mediante `owner_user_id`. Las consultas de `/api/v1` filtran por ese propietario para evitar acceso cruzado entre empresas.

### Registrar el primer usuario

```bash
curl -X POST http://localhost:3000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"CAMBIA_ESTA_CONTRASEÑA"}'
```

La respuesta contiene un JWT. Úsalo como:

```text
Authorization: Bearer <TOKEN>
```

### Iniciar sesión

```bash
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"CAMBIA_ESTA_CONTRASEÑA"}'
```

### Consultar negocios del usuario

```bash
curl http://localhost:3000/api/v1/businesses \
  -H "Authorization: Bearer <TOKEN>"
```

### Crear un negocio

```bash
curl -X POST http://localhost:3000/api/v1/businesses \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name":"Mi Negocio","programName":"Club de Clientes","logoUrl":"https://ejemplo.com/logo.png"}'
```

Cuando se crea el negocio, el backend crea también su Loyalty Class en Google Wallet.

### Seguridad

- Las contraseñas se almacenan con bcrypt.
- Los JWT se firman con HS256 y `JWT_SECRET`.
- Las rutas de negocio verifican que el usuario autenticado sea el propietario.
- La private key de Google Wallet permanece fuera de Git.
- PostgreSQL sustituye el almacenamiento JSON para la API nueva.

La dependencia `pg` usa el cliente oficial node-postgres y soporta ESM, pooling y PostgreSQL moderno. `bcryptjs` proporciona hashing de contraseñas con soporte TypeScript. citeturn962751search1turn962751search5turn962751search0
