# node-red-plugin-paautin-ai

AI Assistant sidebar para Node-RED, powered by Claude.

Chat directamente desde el editor de Node-RED para crear, modificar, debuggear y entender flujos.

## Modos de operacion

| Modo | Descripcion | Requisitos |
|------|-------------|------------|
| **API Directa** | Llama a la API de Anthropic desde el browser. Claude recibe el flow activo como contexto. | API Key de Anthropic |
| **Claude Code** | Conecta a un companion server local que ejecuta el CLI `claude`. Tiene acceso completo al proyecto (skills, CLAUDE.md, flow_bricks, deploy). | `claude` CLI instalado + companion server corriendo |

## Instalacion

### Desde npm (cuando este publicado)

```bash
cd ~/.node-red
npm install node-red-plugin-paautin-ai
```

### Desde GitHub

```bash
cd ~/.node-red
npm install git+https://github.com/MauricioQuezadaHaintech/node-red-plugin-paautin-ai.git
```

### Desde directorio local (desarrollo)

```bash
cd ~/.node-red
npm install /ruta/a/node-red-plugin-paautin-ai
```

Despues de instalar, **reiniciar Node-RED**. El tab "AI" aparecera en el sidebar derecho.

## Configuracion

La configuracion se maneja desde el sidebar. Click en el icono de engranaje para abrir el panel de settings:

- **Mode**: API Directa o Claude Code
- **API Key**: Tu API key de Anthropic (solo para API Directa)
- **Model**: Modelo a usar (solo para API Directa, default: claude-sonnet-4-20250514)
- **Companion URL**: URL del companion server (solo para Claude Code, default: http://localhost:3100)

Los settings se guardan en `localStorage` del browser.

## Companion Server (modo Claude Code)

Para usar el modo Claude Code, necesitas correr el companion server en tu maquina local (donde tienes el CLI `claude` instalado):

```bash
# Opcion 1: Si instalaste el plugin globalmente
npx paautin-ai-companion --project /ruta/a/tu/proyecto

# Opcion 2: Desde el directorio del plugin
node companion-server.js --project /ruta/a/tu/proyecto

# Opciones
#   --port, -p <port>       Puerto HTTP (default: 3100)
#   --project, -d <path>    Directorio del proyecto para claude CLI (default: cwd)
```

El companion server:
- Corre en tu maquina local (no en el servidor de Node-RED)
- Ejecuta el CLI `claude` como subproceso
- Streaming via SSE (Server-Sent Events)
- CORS habilitado para permitir conexiones desde el browser

## Uso

1. Abrir el sidebar derecho y seleccionar el tab **AI**
2. Configurar el modo en Settings (icono de engranaje)
3. El boton de sitemap (azul) incluye el flow activo como contexto — desactivar si no es necesario
4. Escribir tu mensaje y presionar Enter o el boton de enviar

### Ejemplos de prompts

```
Agrega un Catch group a este flow siguiendo las convenciones de Paautin
```

```
Explica que hace el function node "Parse SOAP Response"
```

```
Crea un flujo que lea un archivo Excel de Azure Blob y guarde los registros en SQL Server
```

## Contexto del flow

Cuando el boton de contexto esta activo (azul), el plugin envia automaticamente los nodos del flow activo como contexto. Esto permite a Claude entender la estructura actual y hacer sugerencias especificas.

En modo **Claude Code**, el contexto se agrega al prompt pero Claude tambien tiene acceso directo a los archivos del proyecto via el CLI.

## Arquitectura

```
Browser (Node-RED Editor)
┌────────────────────────────────┐
│  Sidebar Plugin (.html)        │
│  ┌──────────┐  ┌────────────┐  │
│  │ API Mode │  │ Claude Code│  │
│  │          │  │   Mode     │  │
│  └────┬─────┘  └─────┬──────┘  │
│       │               │        │
└───────┼───────────────┼────────┘
        │               │
        ▼               ▼
   Anthropic API    Companion Server
   (api.anthropic    (localhost:3100)
    .com)                  │
                           ▼
                      claude CLI
                    (local machine)
```

## Licencia

MIT
