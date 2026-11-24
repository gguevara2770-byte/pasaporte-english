# Pasaporte English · app

Curso de inglés para hispanohablantes (A1 → B1+), instalable en el celular (PWA):

- Test de nivel con recomendación de módulo.
- 6 módulos con lecciones, 240 ejercicios explicados, audio y pronunciación.
- **Tutor IA incluido**: el usuario no configura nada. Usa tu clave, guardada en el servidor.
- 21 temas con personajes propios. Fútbol tiene 12 situaciones (Messi vs. Cristiano, Balón de Oro, Mundial…) y cada tema tiene una casilla libre para escribir otro asunto.
- Perfil (nombres, apellidos, celular, correo) y karaoke con enlaces a YouTube.

## Carpetas

| Carpeta / archivo | Qué es |
|---|---|
| `subir-a-github/` | **Lo que se sube a GitHub.** Contiene solo lo necesario, sin claves. |
| `publicar/` | La app (página, datos, íconos). Netlify la publica desde aquí. |
| `netlify/functions/tutor.mjs` | El tutor incluido: el servidor que habla con Gemini o Claude usando tu clave. |
| `netlify.toml`, `package.json` | Configuración para Netlify. |
| `index.html`, `data/` … | Archivos de trabajo. Después de cada cambio se copian a `publicar/`. |
| `dev_server.py`, `api/` | Pruebas locales antiguas. No se usan en Netlify. |

## Publicar con el tutor incluido (una sola vez)

1. **GitHub:** crea una cuenta en https://github.com → **New repository** → nombre `pasaporte-english` → **Create repository**.
   En la página del repositorio pulsa **uploading an existing file** y arrastra **todo el contenido** de `subir-a-github`, incluidas las carpetas. Pulsa **Commit changes**.
2. **Netlify:** en https://app.netlify.com → **Import from Git** → **GitHub** → elige `pasaporte-english` → **Deploy**.
3. **Tu clave:** en el proyecto nuevo → **Manage** → **Environment variables** → añade:
   - `GEMINI_API_KEY` = tu clave de Google AI Studio (gratis, con límite diario), **o**
   - `ANTHROPIC_API_KEY` = tu clave de Claude (de pago y más estable). Si pones las dos, se usa Claude.
4. Vuelve a publicar: **Deploys → Trigger deploy**.
5. Opcional: cambia el nombre del enlace en **Name and address** y haz el proyecto **Public** en **Who can see it**.

## Actualizar la app más adelante

Cambia los archivos dentro de `subir-a-github/` en GitHub (o súbelos de nuevo). Netlify publica solo en cada cambio.
Sube el número de `CACHE` en `publicar/sw.js` (por ejemplo `pasaporte-v8`) para que los celulares descarguen la versión nueva.

## Cuentas de usuario

Botón **Iniciar sesión** (o **Perfil → Tu cuenta**): el usuario crea una cuenta con correo y contraseña. El progreso, el nivel y el perfil se guardan en **Netlify Blobs** (almacenamiento incluido en Netlify) y se recuperan en cualquier dispositivo.
- La función está en `netlify/functions/cuenta.mjs`. Las contraseñas se guardan con hash PBKDF2, nunca en texto.
- Antes de abrir la app al público, publica una **política de privacidad**, porque guardas correo, nombre y celular. Más adelante conviene añadir un límite de intentos de inicio de sesión y la opción de recuperar la contraseña.

## Costos y límites

- **Gemini gratis:** el límite diario se reparte entre todos tus usuarios. Si se agota o el modelo está saturado, el tutor avisa y reintenta solo.
- **Claude:** pagas por uso (`claude-opus-5-5` por defecto, el más capaz). Para gastar mucho menos, añade la variable `CLAUDE_MODEL=claude-haiku-5-5`.
- Pon siempre un **límite de gasto** en la consola de tu proveedor. Antes de abrir la app al público, añade cuentas de usuario para controlar el uso por persona.

## Antes de venderla

- **Datos personales:** el perfil se guarda solo en el celular. Si algún día lo envías a un servidor, necesitas una política de privacidad.
- **Tiendas:** con https://www.pwabuilder.com empaquetas la app para Google Play (25 USD, pago único). La App Store pide 99 USD al año y una Mac.
- **Contenido de terceros:** los temas hablan *sobre* futbolistas y artistas reales, pero los personajes del tutor son inventados y nunca se hacen pasar por ellos. Del karaoke solo se muestran título, artista y enlace a YouTube, nunca la letra.
