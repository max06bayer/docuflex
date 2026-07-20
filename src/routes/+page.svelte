<script>
  // @ts-ignore Fontsource exposes CSS through package exports without JS type declarations.
  import '@fontsource-variable/geist/wght.css';
  import SettingsPanel from '$lib/SettingsPanel.svelte';

  const landingAssets = '/landing-page';
  const featureCardAssets = `${landingAssets}/feature-cards`;
  const topFeatureCards = ['Merge', 'Convert', 'Sign', 'Translate', 'ORC'];
  const bottomFeatureCards = ['Split', 'Compress', 'Protect', 'Flatten', 'Watermark'];
  const emptyCards = Array(6).fill(`${landingAssets}/empty-card.png`);
  let legalPanelOpen = false;
  let legalPanelSection = 'top';

  function openLegalPanel(section = 'top') {
    legalPanelSection = section;
    legalPanelOpen = true;
  }
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
        <a
          class="download-button animated-button"
          href="https://github.com/max06bayer/docuflex/releases/latest"
          target="_blank"
          rel="noreferrer"
        >
          <span>Download</span>
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

  <section class="next-section" id="features" aria-labelledby="features-title">
    <div class="feature-marquee feature-marquee-fast" aria-hidden="true">
      <div class="feature-track">
        {#each Array(2) as _}
          <div class="feature-set">
            {#each topFeatureCards as card}
              <img src={`${featureCardAssets}/${card}.png`} alt="" />
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
                <img src={card} alt="" />
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
              <img src={`${featureCardAssets}/${card}.png`} alt="" />
            {/each}
          </div>
        {/each}
      </div>
    </div>

    <div class="video-placeholder" id="video" role="img" aria-label="Docuflex feature showcase video coming soon">
      <div class="video-topbar">
        <div class="video-channel">
          <span class="video-avatar" aria-hidden="true">D</span>
          <span>Docuflex Feature showcase</span>
        </div>
        <div class="video-utilities" aria-hidden="true">
          <span class="video-utility">
            <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"></circle><path d="M12 7v5l3 2"></path></svg>
            <span>Watch later</span>
          </span>
          <span class="video-utility">
            <svg viewBox="0 0 24 24" class="share-icon">
              <path d="M14 5l6 5-6 5v-3.2C9.5 11.8 6.7 13.2 4 17c.7-6.2 4.1-9.2 10-9.2V5Z"></path>
            </svg>
            <span>Share</span>
          </span>
        </div>
      </div>

      <span class="video-play" aria-hidden="true">
        <svg viewBox="0 0 28 22"><path d="m11 6 8 5-8 5Z"></path></svg>
      </span>

      <span class="youtube-label" aria-hidden="true">
        <span>Watch on</span>
        <svg class="youtube-logo" viewBox="0 0 28 20">
          <rect x="1" y="2" width="26" height="16" rx="4"></rect>
          <path d="m12 6.4 6.2 3.6-6.2 3.6Z"></path>
        </svg>
        <strong>YouTube</strong>
      </span>
    </div>
  </section>

  <footer class="site-footer">
    <div class="footer-main">
      <a class="footer-brand" href="/" aria-label="Docuflex home">
        <img src={`${landingAssets}/logo.svg`} alt="Docuflex" />
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

  {#if legalPanelOpen}
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

  .video-placeholder {
    position: relative;
    width: min(1190px, calc(100% - 80px));
    aspect-ratio: 16 / 9;
    margin: 100px auto 0;
    overflow: hidden;
    border: 1px solid #050505;
    background: #000;
    box-shadow: 0 26px 70px rgba(0, 0, 0, 0.25);
    color: #f1f1f1;
  }

  .video-topbar {
    position: absolute;
    top: 0;
    right: 0;
    left: 0;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding: 14px 16px;
    font-size: 16px;
  }

  .video-channel {
    display: flex;
    align-items: center;
    gap: 11px;
  }

  .video-avatar {
    display: grid;
    width: 38px;
    height: 38px;
    place-items: center;
    border-radius: 50%;
    background: #ececec;
    color: #0878f9;
    font-size: 18px;
    font-weight: 650;
  }

  .video-utilities {
    display: flex;
    gap: 24px;
  }

  .video-utility {
    display: grid;
    justify-items: center;
    gap: 3px;
    font-size: 12px;
  }

  .video-utility svg {
    width: 24px;
    height: 24px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .video-utility .share-icon {
    fill: currentColor;
    stroke: none;
  }

  .video-play {
    position: absolute;
    top: 50%;
    left: 50%;
    display: grid;
    width: 88px;
    height: 62px;
    place-items: center;
    border-radius: 15px;
    background: #ff0033;
    transform: translate(-50%, -50%);
  }

  .video-play svg {
    width: 38px;
    height: 30px;
    fill: #fff;
  }

  .youtube-label {
    position: absolute;
    bottom: 0;
    left: 0;
    display: flex;
    height: 48px;
    align-items: center;
    gap: 6px;
    padding: 0 14px;
    background: #181818;
    color: #f4f4f4;
    font-size: 13px;
  }

  .youtube-label .youtube-logo {
    width: 24px;
    height: 18px;
  }

  .youtube-logo rect {
    fill: #ff0033;
  }

  .youtube-logo path {
    fill: #fff;
  }

  .youtube-label strong {
    font-weight: 650;
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
      padding-block: 96px 120px;
    }

    .feature-set img,
    .feature-marquee-empty .feature-set img {
      width: 268px;
      height: 57px;
    }

    .feature-title-row {
      min-height: 88px;
      margin-block: 18px;
    }

    .feature-title-row h2 {
      width: calc(100% - 40px);
      font-size: clamp(35px, 10vw, 54px);
    }

    .video-placeholder {
      width: calc(100% - 32px);
      margin-top: 70px;
    }

    .video-topbar {
      padding: 10px;
      font-size: 12px;
    }

    .video-avatar {
      width: 30px;
      height: 30px;
      font-size: 14px;
    }

    .video-utilities {
      display: none;
    }

    .video-play {
      width: 66px;
      height: 46px;
      border-radius: 12px;
    }

    .youtube-label {
      height: 38px;
      font-size: 11px;
    }

    .footer-main {
      grid-template-columns: 1fr 1fr;
      width: calc(100% - 40px);
      min-height: 0;
      gap: 54px 32px;
      padding-block: 68px;
    }

    .footer-brand {
      grid-column: 1 / -1;
      width: 176px;
    }

    .footer-column {
      gap: 20px;
      font-size: 16px;
    }

    .footer-column h3 {
      font-size: 16px;
    }

    .footer-bottom {
      min-height: 0;
      align-items: flex-start;
      flex-direction: column;
      gap: 34px;
      padding: 34px 20px 44px;
    }

    .footer-legal-links {
      flex-wrap: wrap;
      gap: 18px 28px;
    }

    .footer-legal-links button,
    .footer-legal-links a,
    .footer-meta p {
      font-size: 16px;
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
