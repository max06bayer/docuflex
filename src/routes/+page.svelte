<script>
  // @ts-ignore Fontsource exposes CSS through package exports without JS type declarations.
  import '@fontsource-variable/geist/wght.css';
  // @ts-ignore Same as above; Roboto is only used by the YouTube look-alike.
  import '@fontsource/roboto/latin-400.css';
  // @ts-ignore
  import '@fontsource/roboto/latin-500.css';
  // @ts-ignore
  import '@fontsource/roboto/latin-700.css';
  import { onMount } from 'svelte';
  import { trackPage } from '$lib/analytics.js';
  // Landing images live in src so Vite fingerprints them and they are served
  // with a one-year immutable cache. public/landing-page keeps the originals
  // for the og:image URL and the editor.
  import logo from '$lib/assets/landing/logo.svg';
  import arrowRight from '$lib/assets/landing/arrow-right.svg';
  import background1280 from '$lib/assets/landing/background-1280.webp';
  import background1920 from '$lib/assets/landing/background-1920.webp';
  import background2560 from '$lib/assets/landing/background-2560.webp';
  import editor800 from '$lib/assets/landing/editor-800.webp';
  import editor1280 from '$lib/assets/landing/editor-1280.webp';
  import editor1440 from '$lib/assets/landing/editor-1440.webp';
  import editor1920 from '$lib/assets/landing/editor-1920.webp';
  import editor2560 from '$lib/assets/landing/editor-2560.webp';
  import emptyCard from '$lib/assets/landing/card-empty.webp';
  import video640 from '$lib/assets/landing/video-640.webp';
  import video1280 from '$lib/assets/landing/video-1280.webp';
  import videoAvatar from '$lib/assets/landing/video-avatar.webp';

  onMount(() => trackPage('/'));

  /** @type {Record<string, string>} */
  const featureCardImages = Object.fromEntries(
    Object.entries(import.meta.glob('$lib/assets/landing/card-*.webp', { eager: true, import: 'default' })).map(
      ([path, url]) => [path.replace(/^.*card-(.+)\.webp$/, '$1'), /** @type {string} */ (url)]
    )
  );
  const backgroundSrcset = `${background1280} 1280w, ${background1920} 1920w, ${background2560} 2560w`;
  const editorSrcset = `${editor800} 800w, ${editor1280} 1280w, ${editor1440} 1440w, ${editor1920} 1920w, ${editor2560} 2560w`;
  const topFeatureCards = ['Merge', 'Convert', 'Sign', 'Translate', 'ORC'];
  const bottomFeatureCards = ['Split', 'Compress', 'Protect', 'Flatten', 'Watermark'];
  const emptyCards = Array(6).fill(emptyCard);
  /** @type {typeof import('$lib/SettingsPanel.svelte').default | null} */
  let SettingsPanel = null;
  let legalPanelOpen = false;
  let legalPanelSection = 'top';

  // The settings panel is only needed after a click, so keep it (and its CSS)
  // out of the landing page's initial load.
  async function openLegalPanel(section = 'top') {
    SettingsPanel ??= (await import('$lib/SettingsPanel.svelte')).default;
    legalPanelSection = section;
    legalPanelOpen = true;
  }
</script>

<svelte:head>
  <title>Docuflex: Free PDF Editor Online & Desktop (Open Source)</title>
  <meta
    name="description"
    content="No account needed: a free, private, open-source PDF editor that runs locally or online. Edit text, sign, merge, compress, convert, OCR and translate PDFs."
  />
  <link rel="canonical" href="https://docuflex.eu/" />
  <link
    rel="preload"
    as="image"
    type="image/webp"
    href={background1920}
    imagesrcset={backgroundSrcset}
    imagesizes="(max-width: 760px) 640px, 100vw"
    fetchpriority="high"
  />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Docuflex" />
  <meta property="og:url" content="https://docuflex.eu/" />
  <meta property="og:title" content="Docuflex: Free PDF Editor Online &amp; Desktop (Open Source)" />
  <meta
    property="og:description"
    content="No account needed. Edit, sign, merge, compress, convert and translate PDFs locally or online. Free forever, private, open source."
  />
  <meta property="og:image" content="https://docuflex.eu/landing-page/editor-rendering.webp" />
  <meta property="og:image:alt" content="Docuflex PDF editor with document pages and editing tools" />
  <meta property="og:locale" content="en_US" />
  <meta name="twitter:card" content="summary_large_image" />
  {@html `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        '@id': 'https://docuflex.eu/#website',
        name: 'Docuflex',
        url: 'https://docuflex.eu/'
      },
      {
        '@type': 'Organization',
        name: 'Docuflex',
        url: 'https://docuflex.eu/',
        logo: 'https://docuflex.eu/favicon-512.png',
        sameAs: ['https://github.com/max06bayer/docuflex']
      },
      {
        '@type': 'SoftwareApplication',
        name: 'Docuflex',
        url: 'https://docuflex.eu/',
        description:
          'Free, private, open-source PDF editor with no account needed, running locally as a desktop app or online in the browser.',
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Web, macOS, Windows, Linux',
        isAccessibleForFree: true,
        screenshot: 'https://docuflex.eu/landing-page/editor-rendering.webp',
        license: 'https://www.gnu.org/licenses/agpl-3.0.html',
        featureList: [
          'Edit PDF text',
          'Merge PDFs',
          'Split PDFs',
          'Compress PDFs',
          'Convert PDF to and from Word',
          'Sign PDFs',
          'Password-protect PDFs',
          'Translate PDFs',
          'OCR scanned PDFs',
          'Flatten PDFs',
          'Add watermarks',
          'Comments and annotations'
        ],
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' }
      }
    ]
  })}</script>`}
</svelte:head>

<main class="landing-page">
  <section class="hero" aria-labelledby="landing-title">
    <header class="site-header">
      <a class="brand" href="/" aria-label="Docuflex home">
        <img src={logo} alt="Docuflex" width="187" height="41" />
      </a>

      <nav aria-label="Primary navigation">
        <a class="nav-link" href="#features">Features</a>
        <a
          class="nav-link github-link"
          href="https://github.com/max06bayer/docuflex"
          target="_blank"
          rel="noreferrer"
        >
          Github<span aria-hidden="true">↗</span>
        </a>
        <a class="nav-link" href="#video">Tutorial</a>
        <span class="nav-link login-link" aria-disabled="true">Log In</span>
        <a class="web-editor-button animated-button" href="/editor">
          <span>Web Editor</span>
          <img src={arrowRight} alt="" aria-hidden="true" width="17" height="17" />
        </a>
      </nav>
    </header>

    <div class="hero-background" aria-hidden="true">
      <img
        src={background1920}
        srcset={backgroundSrcset}
        sizes="(max-width: 760px) 640px, 100vw"
        alt=""
        width="3840"
        height="2160"
        fetchpriority="high"
      />
    </div>

    <div class="hero-content">
      <h1 id="landing-title">Next Generation PDF editor.<br />Free Forever. Private. Open.</h1>
      <p>
        A powerful, modern PDF toolkit with AI integration for editing, signing, protecting, and<br
          class="desktop-break"
        />
        exporting documents. Hosted in EU. Available as local desktop client or web editor.
      </p>

      <div class="hero-actions">
        <a
          class="download-button animated-button"
          href="/download"
          target="_blank"
          rel="noreferrer"
        >
          <span>Download</span>
        </a>
        <a class="watch-link" href="#video">Watch Video</a>
      </div>
    </div>

    <div class="editor-showcase">
      <!-- On phones the image is 185vw wide but mostly off-screen; the smaller
           sizes hint keeps the download proportional to what is visible. -->
      <img
        src={editor1920}
        srcset={editorSrcset}
        sizes="(max-width: 760px) 120vw, min(1780px, 104vw)"
        alt="The Docuflex PDF editor editing text in a PDF document"
        width="3682"
        height="1839"
        fetchpriority="low"
        decoding="async"
      />
    </div>
  </section>

  <section class="next-section" id="features" aria-labelledby="features-title">
    <div class="feature-marquee feature-marquee-fast" aria-hidden="true">
      <div class="feature-track">
        {#each Array(2) as _}
          <div class="feature-set">
            {#each topFeatureCards as card}
              <img src={featureCardImages[card]} alt="" width="325" height="69" loading="lazy" decoding="async" />
            {/each}
          </div>
        {/each}
      </div>
    </div>

    <div class="feature-title-row">
      <div class="feature-marquee feature-marquee-empty" aria-hidden="true">
        <div class="feature-track">
          {#each Array(2) as _}
            <div class="feature-set">
              {#each emptyCards as card}
                <img src={card} alt="" width="325" height="69" loading="lazy" decoding="async" />
              {/each}
            </div>
          {/each}
        </div>
      </div>
      <h2 id="features-title">Explore all the Features</h2>
    </div>

    <div class="feature-marquee feature-marquee-slow" aria-hidden="true">
      <div class="feature-track">
        {#each Array(2) as _}
          <div class="feature-set">
            {#each bottomFeatureCards as card}
              <img src={featureCardImages[card]} alt="" width="325" height="69" loading="lazy" decoding="async" />
            {/each}
          </div>
        {/each}
      </div>
    </div>

    <div class="video-embed" id="video">
      <!-- A look-alike of the YouTube player instead of the real iframe: the
           embed sets third-party cookies and loads ~1 MB of script. -->
      <a
        class="video-facade"
        href="https://www.youtube.com/watch?v=hxAxo_cPU1M"
        target="_blank"
        rel="noreferrer"
        aria-label="Docuflex Feature Showcase, Maximilian Bayer. Watch on YouTube"
      >
        <img
          class="video-thumbnail"
          src={video1280}
          srcset={`${video640} 640w, ${video1280} 1280w`}
          sizes="min(1190px, 100vw)"
          alt=""
          width="1280"
          height="720"
          loading="lazy"
          decoding="async"
        />
        <span class="video-shade" aria-hidden="true"></span>
        <img class="video-avatar" src={videoAvatar} alt="" width="36" height="36" loading="lazy" />
        <span class="video-title">Docuflex Feature Showcase</span>
        <span class="video-channel">Maximilian Bayer</span>
        <svg class="video-play" viewBox="0 0 68 48" aria-hidden="true">
          <path
            d="M66.52,7.74c-0.78-2.93-2.49-5.41-5.42-6.19C55.79,.13,34,0,34,0S12.21,.13,6.9,1.55 C3.97,2.33,2.27,4.81,1.48,7.74C0.06,13.05,0,24,0,24s0.06,10.95,1.48,16.26c0.78,2.93,2.49,5.41,5.42,6.19 C12.21,47.87,34,48,34,48s21.79-0.13,27.1-1.55c2.93-0.78,4.64-3.26,5.42-6.19C67.94,34.95,68,24,68,24S67.94,13.05,66.52,7.74z"
            fill="#f03"
          ></path>
          <path d="M 45,24 27,14 27,34" fill="#fff"></path>
        </svg>
        <span class="video-share" aria-hidden="true">
          <svg viewBox="0 0 24 24"
            ><path
              fill-rule="evenodd"
              d="M10 3.158V7.51c-5.428.223-8.27 3.75-8.875 11.199-.04.487.567.744.894.38C3.8 16.1 6.71 14.88 10 14.69v4.162a.75.75 0 0 0 1.226.58l10.06-8.208a.75.75 0 0 0 0-1.162L11.226 2.58A.75.75 0 0 0 10 3.158Zm1.5 1.583 7.906 6.452-7.906 6.452v-3.73l-1.552.04C7.24 13.79 5.193 14.48 3.383 16.083c.825-5.217 3.312-7.07 6.669-7.07h1.448V4.741Z"
            ></path></svg
          >
        </span>
        <span class="video-watch" aria-hidden="true">
          <span>Watch on</span>
          <svg viewBox="0 0 110 26"
            ><path
              fill-rule="evenodd"
              d="M 16.68,.99 C 13.55,1.03 7.02,1.16 4.99,1.68 c -1.49,.4 -2.59,1.6 -2.99,3 -0.69,2.7 -0.68,8.31 -0.68,8.31 0,0 -0.01,5.61 .68,8.31 .39,1.5 1.59,2.6 2.99,3 2.690,.7 13.40,.68 13.40,.68 0,0 10.70,.01 13.40,-0.68 1.5,-0.4 2.59,-1.6 2.99,-3 .69,-2.7 .68,-8.31 .68,-8.31 0,0 .11,-5.61 -0.68,-8.31 -0.4,-1.5 -1.59,-2.6 -2.99,-3 C 29.11,.98 18.40,.99 18.40,.99 c 0,0 -0.67,-0.01 -1.71,0 z m 72.21,.90 0,21.28 2.78,0 .31,-1.37 .09,0 c .3,.5 .71,.88 1.21,1.18 .5,.3 1.08,.40 1.68,.40 1.1,0 1.99,-0.49 2.49,-1.59 .5,-1.1 .81,-2.70 .81,-4.90 l 0,-2.40 c 0,-1.6 -0.11,-2.90 -0.31,-3.90 -0.2,-0.89 -0.5,-1.59 -1,-2.09 -0.5,-0.4 -1.10,-0.59 -1.90,-0.59 -0.59,0 -1.18,.19 -1.68,.49 -0.49,.3 -1.01,.80 -1.21,1.40 l 0,-7.90 -3.28,0 z m -49.99,.78 3.90,13.90 .18,6.71 3.31,0 0,-6.71 3.87,-13.90 -3.37,0 -1.40,6.31 c -0.4,1.89 -0.71,3.19 -0.81,3.99 l -0.09,0 c -0.2,-1.1 -0.51,-2.4 -0.81,-3.99 l -1.37,-6.31 -3.40,0 z m 29.59,0 0,2.71 3.40,0 0,17.90 3.28,0 0,-17.90 3.40,0 c 0,0 .00,-2.71 -0.09,-2.71 l -9.99,0 z m -53.49,5.12 8.90,5.18 -8.90,5.09 0,-10.28 z m 89.40,.09 c -1.7,0 -2.89,.59 -3.59,1.59 -0.69,.99 -0.99,2.60 -0.99,4.90 l 0,2.59 c 0,2.2 .30,3.90 .99,4.90 .7,1.1 1.8,1.59 3.5,1.59 1.4,0 2.38,-0.3 3.18,-1 .7,-0.7 1.09,-1.69 1.09,-3.09 l 0,-0.5 -2.90,-0.21 c 0,1 -0.08,1.6 -0.28,2 -0.1,.4 -0.5,.62 -1,.62 -0.3,0 -0.61,-0.11 -0.81,-0.31 -0.2,-0.3 -0.30,-0.59 -0.40,-1.09 -0.1,-0.5 -0.09,-1.21 -0.09,-2.21 l 0,-0.78 5.71,-0.09 0,-2.62 c 0,-1.6 -0.10,-2.78 -0.40,-3.68 -0.2,-0.89 -0.71,-1.59 -1.31,-1.99 -0.7,-0.4 -1.48,-0.59 -2.68,-0.59 z m -50.49,.09 c -1.09,0 -2.01,.18 -2.71,.68 -0.7,.4 -1.2,1.12 -1.49,2.12 -0.3,1 -0.5,2.27 -0.5,3.87 l 0,2.21 c 0,1.5 .10,2.78 .40,3.78 .2,.9 .70,1.62 1.40,2.12 .69,.5 1.71,.68 2.81,.78 1.19,0 2.08,-0.28 2.78,-0.68 .69,-0.4 1.09,-1.09 1.49,-2.09 .39,-1 .49,-2.30 .49,-3.90 l 0,-2.21 c 0,-1.6 -0.2,-2.87 -0.49,-3.87 -0.3,-0.89 -0.8,-1.62 -1.49,-2.12 -0.7,-0.5 -1.58,-0.68 -2.68,-0.68 z m 12.18,.09 0,11.90 c -0.1,.3 -0.29,.48 -0.59,.68 -0.2,.2 -0.51,.31 -0.81,.31 -0.3,0 -0.58,-0.10 -0.68,-0.40 -0.1,-0.3 -0.18,-0.70 -0.18,-1.40 l 0,-10.99 -3.40,0 0,11.21 c 0,1.4 .18,2.39 .68,3.09 .49,.7 1.21,1 2.21,1 1.4,0 2.48,-0.69 3.18,-2.09 l .09,0 .31,1.78 2.59,0 0,-14.99 c 0,0 -3.40,.00 -3.40,-0.09 z m 17.31,0 0,11.90 c -0.1,.3 -0.29,.48 -0.59,.68 -0.2,.2 -0.51,.31 -0.81,.31 -0.3,0 -0.58,-0.10 -0.68,-0.40 -0.1,-0.3 -0.21,-0.70 -0.21,-1.40 l 0,-10.99 -3.40,0 0,11.21 c 0,1.4 .21,2.39 .71,3.09 .5,.7 1.18,1 2.18,1 1.39,0 2.51,-0.69 3.21,-2.09 l .09,0 .28,1.78 2.62,0 0,-14.99 c 0,0 -3.40,.00 -3.40,-0.09 z m 20.90,2.09 c .4,0 .58,.11 .78,.31 .2,.3 .30,.59 .40,1.09 .1,.5 .09,1.21 .09,2.21 l 0,1.09 -2.5,0 0,-1.09 c 0,-1 -0.00,-1.71 .09,-2.21 0,-0.4 .11,-0.8 .31,-1 .2,-0.3 .51,-0.40 .81,-0.40 z m -50.49,.12 c .5,0 .8,.18 1,.68 .19,.5 .28,1.30 .28,2.40 l 0,4.68 c 0,1.1 -0.08,1.90 -0.28,2.40 -0.2,.5 -0.5,.68 -1,.68 -0.5,0 -0.79,-0.18 -0.99,-0.68 -0.2,-0.5 -0.31,-1.30 -0.31,-2.40 l 0,-4.68 c 0,-1.1 .11,-1.90 .31,-2.40 .2,-0.5 .49,-0.68 .99,-0.68 z m 39.68,.09 c .3,0 .61,.10 .81,.40 .2,.3 .27,.67 .37,1.37 .1,.6 .12,1.51 .12,2.71 l .09,1.90 c 0,1.1 .00,1.99 -0.09,2.59 -0.1,.6 -0.19,1.08 -0.49,1.28 -0.2,.3 -0.50,.40 -0.90,.40 -0.3,0 -0.51,-0.08 -0.81,-0.18 -0.2,-0.1 -0.39,-0.29 -0.59,-0.59 l 0,-8.5 c .1,-0.4 .29,-0.7 .59,-1 .3,-0.3 .60,-0.40 .90,-0.40 z"
            ></path></svg
          >
        </span>
      </a>
    </div>
  </section>

  <footer class="site-footer">
    <div class="footer-main">
      <a class="footer-brand" href="/" aria-label="Docuflex home">
        <img src={logo} alt="Docuflex" width="187" height="41" loading="lazy" />
      </a>

      <div class="footer-column">
        <h3>Features</h3>
        <a href="#features">Text Editing</a>
        <a href="#features">Protection</a>
        <a href="#features">Annotating</a>
        <a href="#features">Converting</a>
      </div>

      <div class="footer-column">
        <h3>Resources</h3>
        <a href="#video">Tutorial</a>
        <a href="mailto:max06.bayer@gmail.com">Contact</a>
        <a href="https://github.com/max06bayer/docuflex" target="_blank" rel="noreferrer">GitHub</a>
      </div>

      <div class="footer-column">
        <h3>Account</h3>
        <span aria-disabled="true">Login</span>
        <span aria-disabled="true">Sign Up</span>
      </div>
    </div>

    <div class="footer-bottom">
      <div class="footer-meta">
        <div class="footer-legal-links">
          <button type="button" onclick={() => openLegalPanel('terms')}>Legal Notice</button>
          <button type="button" onclick={() => openLegalPanel('privacy')}>Privacy</button>
          <button type="button" onclick={() => openLegalPanel('cookies')}>Cookies</button>
          <a href="mailto:max06.bayer@gmail.com">Contact</a>
        </div>
        <p>© 2026 Maximilian Bayer</p>
      </div>

      <div class="footer-socials" aria-label="Social media">
        <a href="#video" aria-label="YouTube">
          <svg viewBox="0 0 28 20" aria-hidden="true"><rect x="1" y="2" width="26" height="16" rx="4"></rect><path d="m12 6.4 6.2 3.6-6.2 3.6Z"></path></svg>
        </a>
        <a href="https://github.com/max06bayer/docuflex" target="_blank" rel="noreferrer" aria-label="GitHub">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.9c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 0 1.6 1.1 1.6 1.1.9 1.6 2.4 1.1 2.9.9.1-.7.4-1.1.7-1.4-2.3-.3-4.6-1.1-4.6-4.9 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.8 1a9.6 9.6 0 0 1 5 0c1.9-1.3 2.8-1 2.8-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.8-2.3 4.6-4.6 4.9.4.3.7 1 .7 1.9V21c0 .3.2.6.7.5A10 10 0 0 0 12 2Z"></path></svg>
        </a>
      </div>
    </div>
  </footer>

  {#if legalPanelOpen && SettingsPanel}
    <SettingsPanel legalOnly={true} legalSection={legalPanelSection} onClose={() => (legalPanelOpen = false)} />
  {/if}
</main>

<style>
  :global(*) {
    box-sizing: border-box;
  }

  :global(html) {
    min-width: 320px;
    min-height: 100%;
    margin: 0;
    background: #000;
    scroll-behavior: smooth;
  }

  :global(body) {
    min-height: 100dvh;
    margin: 0;
    background: #000;
  }

  :global(button),
  :global(a) {
    font: inherit;
  }

  .landing-page {
    min-height: 100dvh;
    overflow: hidden;
    background: #000;
    color: #f7f7f7;
    font-family: Geist, Inter, system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    text-rendering: geometricPrecision;
  }

  .hero {
    position: relative;
    min-height: 1200px;
    overflow: hidden;
    background: #030303;
  }

  .site-header {
    position: relative;
    z-index: 10;
    display: flex;
    width: 100%;
    height: 64px;
    align-items: center;
    justify-content: space-between;
    padding: 0 max(145px, calc((100vw - 1280px) / 2));
    border-bottom: 1px solid rgba(255, 255, 255, 0.075);
    background: #000;
  }

  .brand {
    display: flex;
    width: 168px;
    align-items: center;
  }

  .brand img {
    display: block;
    width: 100%;
    height: auto;
    transform: translateY(2px);
  }

  nav {
    display: flex;
    align-items: center;
    gap: clamp(26px, 2.5vw, 48px);
    font-size: 16px;
    font-weight: 400;
    line-height: 1;
  }

  .nav-link,
  .watch-link {
    color: #858585;
    text-decoration: none;
    transition: color 220ms ease;
  }

  a.nav-link:hover,
  .watch-link:hover {
    color: #f5f5f5;
  }

  .github-link {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }

  .github-link span {
    font-size: 16px;
  }

  .login-link {
    cursor: not-allowed;
    opacity: 0.48;
    user-select: none;
  }

  .animated-button {
    position: relative;
    overflow: hidden;
    text-decoration: none;
  }

  .animated-button::before {
    content: '';
    position: absolute;
    inset: 0;
    z-index: 0;
    background: #000;
    transform: scaleX(0);
    transform-origin: left;
    transition: transform 0.2s ease;
  }

  .animated-button > * {
    position: relative;
    z-index: 1;
  }

  .animated-button:hover::before {
    transform: scaleX(1);
  }

  .web-editor-button {
    display: inline-flex;
    min-height: 36px;
    align-items: center;
    gap: 8px;
    padding: 0 13px;
    border: 1px solid transparent;
    border-radius: 12px;
    background:
      linear-gradient(180deg, #f7f7f7 0%, #e4e4e4 100%) padding-box,
      linear-gradient(135deg, #c4c4c4 0%, #d6d6d6 100%) border-box;
    color: #000;
    transition: color 0.18s ease, transform 0.18s ease;
  }

  .web-editor-button:hover {
    color: #fff;
  }

  .web-editor-button:active,
  .download-button:active {
    transform: scale(0.975);
  }

  .web-editor-button img {
    width: 17px;
    height: 17px;
    transition: filter 0.18s ease, transform 0.18s ease;
  }

  .web-editor-button:hover img {
    filter: invert(1);
    transform: translateX(2px);
  }

  .hero-background {
    position: absolute;
    z-index: 0;
    inset: 64px 0 0;
    overflow: hidden;
    pointer-events: none;
  }

  .hero-background img {
    display: block;
    width: 100%;
    height: auto;
  }

  .hero-background::after {
    position: absolute;
    inset: 0;
    background: linear-gradient(to bottom, transparent 72%, rgba(0, 0, 0, 0.72) 94%, #000 100%);
    content: '';
  }

  .hero-content {
    position: relative;
    z-index: 3;
    width: min(1280px, calc(100% - 290px));
    margin: 0 auto;
    padding-top: clamp(118px, 8.5vw, 164px);
  }

  h1 {
    max-width: 1040px;
    margin: 0;
    color: #fafafa;
    font-size: clamp(48px, 3.72vw, 71px);
    font-weight: 470;
    letter-spacing: -0.058em;
    line-height: 1.08;
  }

  .hero-content p {
    max-width: 930px;
    margin: 30px 0 0;
    color: #777;
    font-size: 16px;
    font-weight: 400;
    letter-spacing: -0.012em;
    line-height: 1.7;
  }

  .hero-actions {
    display: flex;
    align-items: center;
    gap: 25px;
    margin-top: 34px;
  }

  .download-button {
    display: inline-flex;
    width: 120px;
    min-height: 38px;
    align-items: center;
    justify-content: center;
    padding: 0 10px;
    border: 1px solid transparent;
    border-radius: 12px;
    background:
      linear-gradient(180deg, #222 0%, #171717 100%) padding-box,
      linear-gradient(135deg, #4d4d4d 0%, #242424 100%) border-box;
    color: #f0f0f0;
    font-size: 16px;
    font-weight: 400;
    transition: color 0.18s ease, transform 0.18s ease;
  }

  .download-button::before {
    background: #f1f1f1;
  }

  .download-button:hover {
    color: #111;
  }

  .watch-link {
    position: relative;
    font-size: 16px;
    font-weight: 400;
  }

  .watch-link::after {
    position: absolute;
    right: 0;
    bottom: -2px;
    left: 0;
    height: 1px;
    background: currentColor;
    content: '';
    transform: scaleX(0);
    transform-origin: left;
    transition: transform 0.18s ease;
  }

  .watch-link:hover::after {
    transform: scaleX(1);
  }

  .editor-showcase {
    position: absolute;
    z-index: 2;
    top: 315px;
    left: 50%;
    width: min(1780px, 104vw);
    aspect-ratio: 3682 / 1839;
    transform: translateX(-50%);
    pointer-events: none;
  }

  .editor-showcase img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .next-section {
    position: relative;
    z-index: 20;
    min-height: 760px;
    margin-top: -330px;
    padding: 126px 0 150px;
    overflow: hidden;
    border-top: 1px solid #262626;
    background: linear-gradient(180deg, #0b0b0b 0%, #141414 100%);
  }

  .feature-marquee {
    width: 100%;
    overflow: hidden;
  }

  .feature-track {
    display: flex;
    width: max-content;
    will-change: transform;
    animation: marquee-right 26s linear infinite;
  }

  .feature-set {
    display: flex;
    flex: none;
    gap: 22px;
    padding-right: 22px;
  }

  .feature-set img {
    display: block;
    width: 325px;
    height: 69px;
    flex: none;
    object-fit: contain;
  }

  .feature-marquee-fast .feature-track {
    animation-duration: 17s;
  }

  .feature-title-row {
    position: relative;
    display: grid;
    min-height: 102px;
    place-items: center;
    margin: 24px 0;
  }

  .feature-title-row .feature-marquee {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
  }

  .feature-marquee-empty .feature-track {
    animation-duration: 38s;
  }

  .feature-marquee-empty .feature-set {
    gap: 22px;
  }

  .feature-marquee-empty .feature-set img {
    width: 325px;
    height: 69px;
  }

  .feature-title-row h2 {
    position: relative;
    z-index: 2;
    margin: 0;
    color: #f8f8f8;
    font-size: clamp(42px, 4vw, 72px);
    font-weight: 470;
    letter-spacing: -0.058em;
    line-height: 1;
    text-align: center;
  }

  .feature-marquee-slow .feature-track {
    animation-duration: 29s;
  }

  @keyframes marquee-right {
    from {
      transform: translateX(-50%);
    }
    to {
      transform: translateX(0);
    }
  }

  .video-embed {
    position: relative;
    width: min(1190px, calc(100% - 80px));
    aspect-ratio: 16 / 9;
    margin: 100px auto 0;
    overflow: hidden;
    border: 1px solid #050505;
    background: #000;
    box-shadow: 0 26px 70px rgba(0, 0, 0, 0.25);
    color: #f1f1f1;
    /* Not rendered until it nears the viewport, so its Roboto font and
       thumbnail stay out of the first paint. */
    content-visibility: auto;
  }

  .video-facade {
    position: absolute;
    inset: 0;
    display: block;
    color: #fff;
    font-family: Roboto, Arial, sans-serif;
    text-decoration: none;
    -webkit-font-smoothing: auto;
  }

  .video-thumbnail {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  /* Sizes and colours measured from the real embed at desktop size. */
  .video-shade {
    position: absolute;
    top: 0;
    right: 0;
    left: 0;
    height: 76px;
    background: linear-gradient(
      180deg,
      rgba(0, 0, 0, 0.82) 0,
      rgba(0, 0, 0, 0.7) 22px,
      rgba(0, 0, 0, 0.55) 40px,
      rgba(0, 0, 0, 0.3) 54px,
      rgba(0, 0, 0, 0.12) 65px,
      transparent 76px
    );
  }

  .video-avatar {
    position: absolute;
    top: 17px;
    left: 31px;
    width: 36px;
    height: 36px;
    border-radius: 50%;
  }

  .video-title,
  .video-channel {
    position: absolute;
    left: 78px;
    right: 31px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-shadow: 0 0 2px rgba(0, 0, 0, 0.5);
  }

  .video-title {
    top: 13px;
    font-size: 20px;
    font-weight: 700;
    line-height: 22px;
  }

  .video-channel {
    top: 36px;
    font-size: 12px;
    font-weight: 500;
    line-height: 16px;
  }

  .video-play {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 68px;
    height: 48px;
    margin: -24px 0 0 -34px;
  }

  .video-share,
  .video-watch {
    position: absolute;
    bottom: 12px;
    display: flex;
    height: 48px;
    align-items: center;
    border-radius: 24px;
    background: rgba(0, 0, 0, 0.3);
  }

  .video-share {
    left: 30px;
    width: 56px;
    justify-content: center;
  }

  .video-share svg {
    width: 26px;
    height: 26px;
    margin-top: 3px;
    fill: #fff;
  }

  .video-watch {
    right: 31px;
    width: 214px;
    gap: 3px;
    padding-left: 25px;
    font-size: 18px;
    font-weight: 500;
  }

  .video-watch svg {
    width: 86px;
    height: 20.3px;
    fill: #fff;
  }

  .site-footer {
    position: relative;
    z-index: 21;
    border-top: 1px solid #262626;
    background:
      radial-gradient(circle at 20% 42%, rgba(255, 255, 255, 0.035), transparent 32%),
      linear-gradient(180deg, #141414 0%, #101010 72%, #090909 100%);
    color: #858585;
  }

  .footer-main {
    display: grid;
    grid-template-columns: minmax(250px, 1.45fr) repeat(3, minmax(150px, 1fr));
    width: 100%;
    min-height: 382px;
    margin: 0 auto;
    padding: 72px max(145px, calc((100vw - 1280px) / 2)) 62px;
  }

  .footer-brand {
    display: block;
    width: 168px;
    align-self: start;
    margin-top: 2px;
  }

  .footer-brand img {
    display: block;
    width: 100%;
    height: auto;
  }

  .footer-column {
    display: flex;
    align-items: flex-start;
    flex-direction: column;
    gap: 22px;
    font-size: 16px;
  }

  .footer-column h3 {
    margin: 0 0 2px;
    color: #f0f0f0;
    font-size: 16px;
    font-weight: 520;
  }

  .footer-column a,
  .footer-column span {
    color: #858585;
    text-decoration: none;
    transition: color 180ms ease;
  }

  .footer-column a:hover {
    color: #f0f0f0;
  }

  .footer-column span {
    cursor: not-allowed;
    opacity: 0.7;
  }

  .footer-bottom {
    display: flex;
    min-height: 126px;
    align-items: flex-start;
    justify-content: space-between;
    padding: 30px max(145px, calc((100vw - 1280px) / 2));
    border-top: 1px solid #262626;
    background: rgba(5, 5, 5, 0.54);
  }

  .footer-meta {
    display: grid;
    gap: 20px;
  }

  .footer-legal-links {
    display: flex;
    align-items: center;
    gap: clamp(28px, 4vw, 72px);
  }

  .footer-legal-links button,
  .footer-legal-links a {
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: #858585;
    font-size: 16px;
    text-decoration: none;
    cursor: pointer;
    transition: color 180ms ease;
  }

  .footer-legal-links button:hover,
  .footer-legal-links a:hover {
    color: #f0f0f0;
  }

  .footer-meta p {
    margin: 0;
    font-size: 16px;
  }

  .footer-socials {
    display: flex;
    align-items: center;
    gap: 30px;
    padding-top: 1px;
  }

  .footer-socials a {
    display: grid;
    width: 28px;
    height: 28px;
    place-items: center;
    color: #898989;
    transition: color 180ms ease, transform 180ms ease;
  }

  .footer-socials a:hover {
    color: #f0f0f0;
    transform: translateY(-1px);
  }

  .footer-socials svg {
    display: block;
    width: 25px;
    height: 25px;
    fill: currentColor;
  }

  .footer-socials a:first-child svg path {
    fill: #090909;
  }

  :global(a:focus-visible),
  :global(button:focus-visible) {
    outline: 2px solid #fff;
    outline-offset: 4px;
  }

  @media (max-width: 1100px) {
    .site-header {
      padding-inline: 120px;
    }

    nav {
      gap: 25px;
    }

    .hero-content {
      width: calc(100% - 240px);
      padding-top: 130px;
    }

    .editor-showcase {
      top: 350px;
      width: 1240px;
    }

    .footer-main {
      padding-inline: 120px;
    }

    .footer-bottom {
      padding-inline: 120px;
    }

  }

  @media (max-width: 760px) {
    .hero {
      min-height: 780px;
    }

    .site-header {
      height: calc(74px + env(safe-area-inset-top, 0px));
      align-items: flex-end;
      padding: env(safe-area-inset-top, 0px) 22px 16px;
      border-bottom-color: rgba(255, 255, 255, 0.09);
    }

    .brand {
      width: 176px;
    }

    .site-header nav,
    .web-editor-button {
      display: none;
    }

    .hero-background {
      inset-block-start: calc(74px + env(safe-area-inset-top, 0px));
    }

    .hero-background img {
      width: auto;
      max-width: none;
      height: 690px;
      margin-left: 50%;
      transform: translateX(-50%);
    }

    .hero-background::after {
      background: linear-gradient(to bottom, transparent 70%, rgba(0, 0, 0, 0.72) 94%, #000 100%);
    }

    .hero-content {
      width: min(100% - 44px, 520px);
      padding-top: 70px;
      text-align: left;
    }

    h1 {
      max-width: 440px;
      margin: 0;
      font-size: clamp(40px, 11.5vw, 52px);
      letter-spacing: -0.052em;
      line-height: 1.04;
    }

    .hero-content p {
      max-width: 430px;
      margin: 24px 0 0;
      color: #969696;
      font-size: 16px;
      line-height: 1.58;
    }

    .desktop-break {
      display: none;
    }

    .hero-actions {
      justify-content: flex-start;
      gap: 26px;
      margin-top: 30px;
    }

    .download-button {
      width: 126px;
      min-height: 42px;
    }

    .watch-link {
      color: #b2b2b2;
    }

    .editor-showcase {
      top: 505px;
      left: -16%;
      width: 185%;
      transform: rotate(-1deg);
      filter: drop-shadow(0 24px 36px rgba(0, 0, 0, 0.38));
    }

    .next-section {
      min-height: 0;
      margin-top: 0;
      padding-block: 58px 62px;
    }

    .feature-set img,
    .feature-marquee-empty .feature-set img {
      width: 210px;
      height: 45px;
    }

    .feature-set,
    .feature-marquee-empty .feature-set {
      gap: 12px;
      padding-right: 12px;
    }

    .feature-title-row {
      min-height: 78px;
      margin-block: 12px;
    }

    .feature-title-row h2 {
      width: calc(100% - 48px);
      font-size: clamp(34px, 9.5vw, 44px);
      line-height: 1.04;
    }

    .video-embed {
      width: calc(100% - 24px);
      margin-top: 52px;
      border-color: #292929;
      border-radius: 12px;
      box-shadow: 0 20px 48px rgba(0, 0, 0, 0.36);
    }

    /* The real embed switches to its compact mobile layout on phones. */
    .video-avatar {
      left: 17px;
    }

    .video-title,
    .video-channel {
      left: 64px;
      right: 13px;
    }

    .video-title {
      top: 11.5px;
      font-size: 18px;
    }

    .video-channel {
      top: 34.5px;
    }

    .video-share {
      bottom: 1.4px;
      left: 13px;
    }

    .video-watch {
      right: 13px;
      bottom: 5.4px;
      width: 206px;
      height: 40px;
      padding-left: 21px;
      border-radius: 20px;
    }

    .site-footer {
      border-top: 0;
      background: linear-gradient(180deg, #111 0%, #0b0b0b 100%);
    }

    .footer-main {
      grid-template-columns: 1fr 1fr;
      width: 100%;
      min-height: 0;
      gap: 30px 28px;
      padding: 40px 22px 30px;
    }

    .footer-brand {
      grid-column: 1 / -1;
      width: 182px;
      margin: 0;
    }

    .footer-column {
      gap: 12px;
      font-size: 13px;
    }

    .footer-column h3 {
      margin-bottom: 4px;
      font-size: 14px;
    }

    .footer-column:last-child {
      display: none;
    }

    .footer-bottom {
      min-height: 0;
      flex-direction: column;
      gap: 18px;
      padding: 10px 22px 28px;
      border-top: 0;
      background: transparent;
    }

    .footer-socials {
      order: -1;
      gap: 18px;
      padding: 0;
    }

    .footer-socials a {
      width: 24px;
      height: 24px;
    }

    .footer-socials svg {
      width: 22px;
      height: 22px;
    }

    .footer-meta {
      width: 100%;
      gap: 16px;
    }

    .footer-legal-links {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-start;
      gap: 10px 20px;
    }

    .footer-legal-links button,
    .footer-legal-links a,
    .footer-meta p {
      font-size: 13px;
    }

    .footer-meta p {
      color: #666;
      font-size: 12px;
    }
  }

  @media (max-width: 390px) {
    .hero {
      min-height: 750px;
    }

    .hero-content {
      width: calc(100% - 36px);
      padding-top: 58px;
    }

    h1 {
      font-size: 39px;
    }

    .hero-content p {
      font-size: 15px;
    }

    .editor-showcase {
      top: 495px;
    }

    .footer-main {
      gap: 34px 18px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    :global(html) {
      scroll-behavior: auto;
    }

    .animated-button::before,
    .animated-button,
    .web-editor-button img,
    .nav-link,
    .watch-link {
      transition: none;
    }

    .feature-track {
      animation-play-state: paused;
    }
  }
</style>
