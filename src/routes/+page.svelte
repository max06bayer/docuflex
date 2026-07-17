<script>
  // @ts-ignore Fontsource exposes CSS through package exports without JS type declarations.
  import '@fontsource-variable/geist/wght.css';

  const landingAssets = '/landing-page';
</script>

<svelte:head>
  <title>Docuflex — Next Generation PDF Editor</title>
  <meta
    name="description"
    content="A powerful, modern PDF toolkit with AI integration for editing, signing, protecting, and exporting documents."
  />
</svelte:head>

<main class="landing-page">
  <section class="hero" aria-labelledby="landing-title">
    <header class="site-header">
      <a class="brand" href="/" aria-label="Docuflex home">
        <img src={`${landingAssets}/logo.svg`} alt="Docuflex" />
      </a>

      <nav aria-label="Primary navigation">
        <a class="nav-link" href="#features">Features</a>
        <a class="nav-link github-link" href="#github">
          Github<span aria-hidden="true">↗</span>
        </a>
        <a class="nav-link" href="#tutorial">Tutorial</a>
        <span class="nav-link login-link" aria-disabled="true">Log In</span>
        <a class="web-editor-button animated-button" href="/editor">
          <span>Web Editor</span>
          <img src={`${landingAssets}/arrow right.svg`} alt="" aria-hidden="true" />
        </a>
      </nav>
    </header>

    <div class="hero-background" aria-hidden="true"></div>

    <div class="hero-content">
      <h1 id="landing-title">Next Generation PDF editor.<br />Free Forever. Private. Open.</h1>
      <p>
        A powerful, modern PDF toolkit with AI integration for editing, signing, protecting, and<br
          class="desktop-break"
        />
        exporting documents. Hosted in EU. Available as local desktop client or web editor.
      </p>

      <div class="hero-actions">
        <a class="download-button animated-button" href="#download">
          <svg class="apple-mark" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M18.7 12.7c0-3.2 2.6-4.7 2.7-4.8a5.8 5.8 0 0 0-4.5-2.4c-1.9-.2-3.7 1.1-4.7 1.1-1 0-2.5-1.1-4.1-1.1a6.1 6.1 0 0 0-5.2 3.1c-2.2 3.8-.6 9.5 1.6 12.6 1.1 1.5 2.3 3.2 4 3.1 1.6-.1 2.2-1 4.1-1s2.5 1 4.2 1c1.7 0 2.8-1.5 3.8-3 1.2-1.8 1.7-3.6 1.8-3.7-.1 0-3.7-1.4-3.7-4.9ZM15.6 3.5A5.2 5.2 0 0 0 16.8 0a5.3 5.3 0 0 0-3.4 1.7 4.9 4.9 0 0 0-1.3 3.4 4.4 4.4 0 0 0 3.5-1.6Z"
            />
          </svg>
          <span>Download for mac</span>
        </a>
        <a class="watch-link" href="#video">Watch Video</a>
      </div>

      <button class="business-button" type="button" disabled>
        <span>Business Version</span><span aria-hidden="true">→</span>
      </button>
    </div>

    <div class="editor-showcase" aria-hidden="true">
      <img src={`${landingAssets}/editor-rendering.webp`} alt="" />
    </div>
  </section>

  <section class="next-section" aria-label="More Docuflex features"></section>
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
    background-image: linear-gradient(to bottom, transparent 72%, rgba(0, 0, 0, 0.72) 94%, #000 100%),
      url('/landing-page/background.jpg');
    background-position: center top;
    background-size: 100% auto;
    background-repeat: no-repeat;
    pointer-events: none;
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
    width: 192px;
    min-height: 38px;
    align-items: center;
    justify-content: flex-start;
    gap: 11px;
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

  .apple-mark {
    width: 19px;
    height: 19px;
    align-self: center;
    fill: currentColor;
    transform: translateY(-1px);
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

  .business-button {
    display: inline-flex;
    height: 39px;
    align-items: center;
    gap: 10px;
    margin-top: 20px;
    padding: 0 16px;
    border: 1px solid #454545;
    border-radius: 12px;
    background: linear-gradient(180deg, #252525, #1d1d1d);
    color: #8c8c8c;
    font-size: 16px;
    cursor: not-allowed;
    opacity: 0.84;
  }

  .business-button span:last-child {
    font-size: 25px;
    font-weight: 280;
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
    min-height: 420px;
    margin-top: -330px;
    border-top: 1px solid #262626;
    background: linear-gradient(180deg, #0b0b0b 0%, #141414 100%);
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

  }

  @media (max-width: 760px) {
    .hero {
      min-height: 980px;
    }

    .site-header {
      height: 60px;
      padding-inline: 20px;
    }

    .brand {
      width: 148px;
    }

    .nav-link {
      display: none;
    }

    nav {
      gap: 0;
    }

    .web-editor-button {
      height: 43px;
      font-size: 16px;
    }

    .hero-background {
      inset-block-start: 60px;
      background-position: center top;
      background-size: 100% auto;
    }

    .hero-content {
      width: calc(100% - 40px);
      padding-top: 112px;
    }

    h1 {
      font-size: clamp(43px, 13vw, 64px);
      line-height: 1.02;
    }

    .hero-content p {
      margin-top: 30px;
      font-size: 17px;
      line-height: 1.55;
    }

    .desktop-break {
      display: none;
    }

    .hero-actions {
      flex-wrap: wrap;
      margin-top: 34px;
    }

    .editor-showcase {
      top: 540px;
      width: 1020px;
      transform: translateX(-50%) rotate(-1deg);
    }


    .next-section {
      margin-top: -330px;
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
  }
</style>
