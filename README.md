# node-red-plugin-paautin-ai

AI Assistant sidebar para Node-RED, powered by Claude.

Chat directamente desde el editor de Node-RED para crear, modificar, debuggear y entender flujos.

## Modos de operacion

| Modo | Descripcion | Requisitos |
|------|-------------|------------|
| **API Directa** | Llama a la API de Anthropic. Claude recibe el flow activo como contexto. | API Key de Anthropic |
| **Claude Code Local** | Ejecuta el CLI `claude` como subproceso. Tiene acceso completo al proyecto (skills, CLAUDE.md, flow_bricks, deploy). | `claude` CLI instalado |
| **Servidor Remoto** | Conecta a un endpoint remoto que ejecuta Claude Code. Para cuando Node-RED y Claude Code corren en maquinas distintas. | Servidor con endpoint `/chat` |

## Instalacion

### Desde GitLab (recomendado)

```bash
# Desde el directorio de Node-RED (o el directorio del proyecto)
cd ~/.node-red
npm install git+https://gitlab.com/haintech/node-red-plugin-paautin-ai.git
```

### Desde directorio local (desarrollo)

```bash
cd ~/.node-red
npm install /ruta/a/node-red-plugin-paautin-ai
```

### Para un Node-RED Project (como Paautin)

```bash
cd /ruta/a/Paautin_node-red
npm install /ruta/a/node-red-plugin-paautin-ai
```

Despues de instalar, **reiniciar Node-RED**. El tab "AI" aparecera en el sidebar derecho.

## Configuracion

1. En el editor de Node-RED, ir a **Menu > Configuration Nodes**
2. Agregar un nodo **paautin-ai-config**
3. Configurar:
   - **Mode**: Seleccionar el modo de operacion
   - **API Key**: Tu API key de Anthropic (`sk-ant-...`)
   - **Model**: Modelo a usar (solo para modo API Directa)
   - **Project Path**: Ruta al proyecto (solo para modo Claude Code)
   - **Server URL**: URL del servidor (solo para modo Servidor Remoto)
4. Deploy

## Uso

1. Abrir el sidebar derecho y seleccionar el tab **AI**
2. Seleccionar el modo en el dropdown superior
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

En modo **Claude Code**, el contexto se agrega al prompt pero Claude tambien tiene acceso directo a los archivos del proyecto.

## Arquitectura

```
┌─────────────────────────────────┐
│     Node-RED Editor (Browser)   │
│  ┌───────────────────────────┐  │
│  │   Sidebar Chat Plugin     │  │
│  │  (paautin-ai-sidebar.html)│  │
│  └──────────┬────────────────┘  │
│             │ fetch POST        │
│             │ /paautin-ai/chat  │
│  ┌──────────▼────────────────┐  │
│  │   Config Node (Runtime)   │  │
│  │  (paautin-ai-config.js)   │  │
│  └──────────┬────────────────┘  │
└─────────────┼───────────────────┘
              │
    ┌─────────┼──────────┐
    │         │          │
    ▼         ▼          ▼
 Anthropic  claude     Remote
   API       CLI       Server
 (simple) (claude-code) (server)
```

## Desarrollo

```bash
git clone https://gitlab.com/haintech/node-red-plugin-paautin-ai.git
cd node-red-plugin-paautin-ai

# Instalar en Node-RED local para desarrollo
cd ~/.node-red
npm install /ruta/a/node-red-plugin-paautin-ai

# Reiniciar Node-RED despues de cada cambio
node-red-restart  # o el metodo que uses
```

## Licencia

MIT
