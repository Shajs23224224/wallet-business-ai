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
