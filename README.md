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

## Siguiente fase

1. Panel web para negocios.
2. Persistencia multiempresa.
3. Branding por negocio.
4. Cupones/Offers.
5. Integración de Gemini para convertir instrucciones del negocio en campañas estructuradas.
6. Autenticación, planes y suscripciones.


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
