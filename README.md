<p align="center">
  <img src="github/LogoBranding.png" alt="Docuflex" width="800" />
</p>

<h1 align="center">Docuflex</h1>

<p align="center">
  A modern PDF editor and document toolkit, available now as a public beta.
</p>

<p align="center">
  <a href="https://docuflex.eu"><strong>Try Docuflex at docuflex.eu</strong></a>
</p>

> [!IMPORTANT]
> Docuflex is already usable, but it is still a beta. Please keep backups of important documents and report reproducible issues through GitHub.

## What already works

- Open, view, organize, and export PDFs
- Reorder, rotate, duplicate, extract, and delete pages
- Add text, images, links, shapes, drawings, highlights, and other annotations
- Fill forms, add signatures, redact content, crop pages, measure, and add watermarks
- Search documents and run OCR on scanned PDFs
- Merge, split, convert, compress, protect, translate, flatten, sign, and OCR documents from the home screen
- Edit detected document text while preserving the surrounding page layout where the PDF allows it
- Reopen recent documents stored by the browser

## Privacy

Docuflex is designed to minimize document exposure. Files are processed only as needed to perform the action requested by the user. The application does not use advertising trackers or behavioral analytics, and document-processing routes do not send uploaded files to third-party conversion or OCR services.

Some operations run entirely in the browser. Operations that need server-side PDF or Office tooling are processed by Docuflex infrastructure and use temporary working files. Do not use the public beta for irreplaceable or exceptionally sensitive documents without first assessing whether it meets your requirements.

See the in-app **Settings → Legal & Privacy** panel for current operator and privacy information.

## Technology

- [SvelteKit](https://svelte.dev/docs/kit) and Svelte 5
- [PDF.js](https://mozilla.github.io/pdf.js/) for PDF rendering and text layers
- Java and [Apache PDFBox](https://pdfbox.apache.org/) for native PDF operations
- Local document utilities for conversion, OCR, compression, and translation workflows
- Self-hosted Geist typography

## Development

Requirements:

- Node.js 20 or newer
- npm
- A JDK for PDF backend work
- Optional local document utilities for conversion and OCR features

Install dependencies and start the application:

```bash
npm install
npm run dev
```

Run the PDF backend in a second terminal when working on backend-powered tools:

```bash
npm run backend:dev
```

Validate a change before submitting it:

```bash
npm run check
npm run build
```

## Status and contributions

Docuflex is under active development. Bug reports and focused improvements are welcome. Because the project is evolving quickly, please open an issue before starting a large change.

## License

Docuflex is **source-available**, not OSI-approved open-source software. The code is published under the [PolyForm Noncommercial License 1.0.0](LICENSE): personal and other non-commercial use, modification, forks, and redistribution are permitted under its terms. Commercial use requires separate permission from the copyright holder.

Copyright 2026 Maximilian Bayer.
