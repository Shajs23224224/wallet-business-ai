# Wallet Business AI

SaaS para pequeñas empresas para crear programas de fidelización y cupones digitales integrados con Google Wallet.

## MVP
- Backend Node.js + TypeScript
- Integración segura con Google Wallet API
- Creación de Loyalty Class/Object
- Generación de JWT para "Add to Google Wallet"
- Health check
- Configuración por variables de entorno
- GitHub Actions para CI

## Seguridad
Las credenciales de Google Wallet nunca se almacenan en el repositorio. Usa variables de entorno o GitHub Secrets.

## Desarrollo
```bash
npm install
cp .env.example .env
npm run dev
```

## Variables
Consulta `.env.example`.
