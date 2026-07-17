<script>
  // @ts-ignore Fontsource exposes CSS through package exports without JS type declarations.
  import '@fontsource-variable/geist/wght.css';
</script>

<svelte:head>
  <title>Docuflex</title>
  <meta name="description" content="Docuflex document tools and PDF editor." />
</svelte:head>

<main class="landing-page">
  <section aria-labelledby="landing-title">
    <h1 id="landing-title">Hello World</h1>
    <a href="/editor">Editor</a>
  </section>
</main>

<style>
  :global(*) { box-sizing: border-box; }
  :global(html, body) { margin: 0; min-width: 320px; min-height: 100%; background: #fff; }
  :global(body) { min-height: 100dvh; }
  .landing-page { display: grid; min-height: 100dvh; place-items: center; padding: 24px; background: #fff; color: #111; font-family: Geist, Inter, system-ui, sans-serif; }
  section { display: grid; justify-items: center; gap: 22px; }
  h1 { margin: 0; font-size: clamp(42px, 7vw, 78px); font-weight: 520; line-height: 1; letter-spacing: -.055em; }
  a { display: grid; min-width: 150px; height: 52px; place-items: center; padding: 0 25px; border-radius: 12px; background: #0878f9; color: #fff; font-size: 19px; font-weight: 480; line-height: 1; text-decoration: none; box-shadow: 0 8px 22px rgba(8, 120, 249, .2); transition: background-color 160ms ease, transform 160ms ease, box-shadow 160ms ease; }
  a:hover { background: #006ff0; box-shadow: 0 10px 26px rgba(8, 120, 249, .26); transform: translateY(-1px); }
  a:active { transform: translateY(0) scale(.98); }
  a:focus-visible { outline: 3px solid rgba(8, 120, 249, .28); outline-offset: 3px; }
</style>
