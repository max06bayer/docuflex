# Docuflex search audit — 2026-10-25

The production checks below were made against `https://docuflex.eu`. Source fixes are included in the 0.9.4 pull request. The audit distinguishes code changes from the separate hosting configuration fix.

## Verified on the live site

- `/` returns HTTP 200 and includes its title, description, canonical URL, H1, body content and JSON-LD in the initial HTML. It is not dependent on JavaScript for the landing page content.
- The homepage serves identical HTML for an ordinary request and a request using the Googlebot user agent. Neither response sets `noindex`.
- `/robots.txt` returns HTTP 200, permits public pages and favicon assets, blocks `/api/`, and points to the correct sitemap.
- `/sitemap.xml` returns HTTP 200 with valid XML containing the canonical homepage and editor URLs. Both URLs return HTTP 200. Its previous last-modified dates were October 13.
- `/favicon.ico` returns HTTP 200 with `image/x-icon`. The 96px and 512px PNGs match the checked-in assets byte for byte. The linked PNG icons are square and use the blue macOS app artwork. Google may need to recrawl before updating its displayed icon.
- The social preview image returns HTTP 200. The page has responsive WebP images, explicit image dimensions and lazy loading for secondary imagery.
- `/editor/` permanently redirects to `/editor` with HTTP 308. A nonexistent page correctly returns HTTP 404.
- HTTP on the bare domain permanently redirects to HTTPS with HTTP 301 after the hosting configuration fix.

## Fixed in source

- `/editor` previously returned a client-only shell without a title, description, canonical or body content. It now prerenders metadata. The interactive PDF editor still mounts only in the browser. Metadata now belongs to the route instead of the browser-only app component, preventing duplicate tags.
- The landing page's visible content, scripts and CSS are unchanged.
- Added WebSite structured data and updated the software platform list to include Linux. Added social-image alternative text.
- Updated sitemap last-modified dates to reflect these substantive changes. Keep these dates tied to real content changes; do not update them on every build.

## Hosting configuration — resolved separately

The initial audit found that `www.docuflex.eu` received Traefik's default self-signed certificate. The domain was subsequently configured in Coolify. Live verification confirmed a valid Let's Encrypt certificate for `www.docuflex.eu`, HTTP 301 redirects to `https://docuflex.eu/`, and preservation of paths and query parameters. The main domain returns HTTP 200. This was a hosting configuration change, not part of the code diff.

## Validation

- Production build passed.
- Local production HTTP checks passed for both pages: exactly one title, description, canonical and no noindex; the landing page has an H1; homepage JSON-LD parsed successfully.
- Local robots, sitemap, ICO, PNG, touch icon and manifest endpoints returned HTTP 200 with the expected types; PNG dimensions are square. Redirect and 404 checks passed.
- The editor mounted successfully in the browser after its rendering change. The landing markup and styles were verified identical to the original outside head metadata.
- `npm run check` still reports the five existing PDF.js `PDFDocumentProxy.destroy` type errors in PdfEditor/HtmlPdfEditor. No new errors were introduced.

## What this audit cannot establish

Crawlability does not prove indexing or explain rankings. No Search Console account or field Core Web Vitals data was inspected. After deployment, submit/confirm the sitemap in Search Console and inspect `/` and `/editor` for indexing status, Google's chosen canonical, crawl failures and rendered HTML. Review search impressions, queries, positions and Core Web Vitals there before attributing weak performance to a particular cause.

References:

- https://developers.google.com/search/docs/appearance/favicon-in-search
- https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap
- https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics
