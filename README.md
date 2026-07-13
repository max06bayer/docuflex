<p align="center">
  <img src="github/LogoBranding.png" alt="Docuflex" width="800" />
</p>

<h1 align="center">Docuflex</h1>

<p align="center">
  A clean, local-first PDF workspace focused on straightforward document editing without the complexity of traditional PDF suites.
</p>

> [!NOTE]
> Docuflex is currently under active development. The repository contains the working editor UI, direct PDF rendering, an early PDF editing backend, and a preserved prototype used during exploration.

## Vision

Docuflex aims to make everyday PDF work feel as direct and approachable as editing in a modern design tool. The long-term product is intended to support private, local document workflows on the web and desktop, with an optional low-cost European business edition and trusted cloud integrations.

Core product principles:

- Simple, modern interaction design
- Local-first and privacy-conscious workflows
- Direct PDF rendering and editing
- Useful document tools without interface clutter
- A clear path from personal use to European business collaboration

## Current functionality

- Responsive Docuflex application shell and home dashboard
- PDF-only file picker and drag-and-drop import
- Animated document preparation flow
- Real filenames and multi-document navbar tabs
- Direct PDF.js canvas rendering without HTML conversion
- PDFBox export of marker and pen annotations through the editor Download button
- High-resolution main-page rendering
- Page-thumbnail sidebar with navigation
- Dynamic recent-document list
- Quick-tool sidebar with keyboard shortcuts
- Early Java/PDFBox editing backend

## Technology

- [SvelteKit](https://svelte.dev/docs/kit) and Svelte 5
- [Vite](https://vite.dev/)
- [PDF.js](https://mozilla.github.io/pdf.js/) for direct PDF rendering
- [Tauri](https://v1.tauri.app) for later offline Desktop App
- Java with [Apache PDFBox](https://pdfbox.apache.org/) for native PDF operations
- Geist variable font, self-hosted through Fontsource

## Local development

Requirements:

- Node.js 20 or newer
- npm
- A JDK when working on the Java backend

Install dependencies and start the frontend:

```bash
npm install
npm run dev
```

The development server is available at `http://127.0.0.1:5173`.

Validate and build the application:

```bash
npm run check
npm run build
```

Run the PDFBox backend in a second terminal when testing downloads locally:

```bash
npm run backend:dev
```

The frontend sends export requests to its same-origin `/api/pdf/export` route, which proxies to
`http://127.0.0.1:8080/export` by default. The existing `/edit` and `/fonts` PDFBox endpoints remain
available for the later text-editing workflow; the current editor does not call them.

To test the production processes together:

```bash
npm run build
npm run backend:compile
npm start
```

`npm start` launches the SvelteKit server and the private Java PDFBox service in the same process
group. Stop it once with `Ctrl+C` to stop both.

## Coolify deployment

This repository includes `nixpacks.toml`. It adds a headless JDK, builds both runtimes, and starts
the SvelteKit and Java processes together. Configure the Coolify application as follows:

- Build pack: **Nixpacks**
- Base directory: `/`
- Static site: **off**
- Exposed port: `3000`
- Health-check path: `/`
- Recommended container memory: at least `1 GB`

Useful runtime environment variables:

```text
PORT=3000
HOST=0.0.0.0
ORIGIN=https://your-docuflex-domain.example
JAVA_TOOL_OPTIONS=-Xms64m -Xmx512m -XX:+ExitOnOutOfMemoryError
```

The Java service listens only inside the container on `127.0.0.1:8080`; do not expose port 8080
in Coolify. `PDF_BACKEND_URL` is only needed if the Java service is moved to a separate container.

Java does need memory, but it does not need the whole container. For ordinary PDFs, a `1 GB`
container with a `512 MB` Java heap leaves room for Node and operating-system overhead. For large
or image-heavy PDFs, use a `2 GB` container and consider raising `-Xmx` to `1g`. Coolify's resource
memory limit is the hard ceiling; `-Xmx` limits only the Java heap inside that ceiling.

## Repository status

This repository is private during early development. Product concepts and implementation details are evolving quickly.
