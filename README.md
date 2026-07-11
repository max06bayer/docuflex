<p align="center">
  <img src="github/LogoBranding.png" alt="Docuflex" width="720" />
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
- High-resolution main-page rendering
- Page-thumbnail sidebar with navigation
- Dynamic recent-document list
- Quick-tool sidebar with keyboard shortcuts
- Early Java/PDFBox editing backend

## Technology

- [SvelteKit](https://svelte.dev/docs/kit) and Svelte 5
- [Vite](https://vite.dev/)
- [PDF.js](https://mozilla.github.io/pdf.js/) for direct PDF rendering
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

Compile and run the PDFBox backend:

```bash
npm run backend:dev
```

## Project structure

```text
src/routes/              Main application shell and home workspace
src/lib/PdfEditor.svelte Direct PDF.js editor view
public/                  Product and interface assets
backend/src/             Java PDFBox service
backend/prototype/       Preserved prototype implementation
github/                  Repository branding and product notes
```

## Architecture direction

The frontend displays PDFs through PDF.js. Editing operations are intended to be described as structured changes and applied natively by the Java/PDFBox backend, preserving the PDF format rather than converting documents into HTML.

```text
PDF.js frontend
    -> structured page, rectangle, and content edits
    -> Java PDFBox service
    -> updated native PDF
```

## Near-term roadmap

- Editor-specific tool sidebar
- Native text editing and layout operations
- Redaction, blur, shapes, images, and signatures
- Page reordering, merging, and splitting
- Search, filtering, and recent-file persistence
- Desktop packaging for macOS and Windows
- Local export and save workflows

## Repository status

This repository is private during early development. Product concepts and implementation details are evolving quickly.
