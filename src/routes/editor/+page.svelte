<script>
  import { onMount } from 'svelte';
  import DocuflexApp from '#lib/DocuflexApp.svelte';
  import { trackPage } from '#lib/analytics.js';

  let mounted = false;
  onMount(() => {
    mounted = true;
    trackPage('/editor');
  });
</script>

<svelte:head>
  <title>Docuflex Editor — Edit PDFs Online, Free</title>
  <meta name="description" content="Edit PDF text, sign, merge, split, compress, convert, OCR and translate PDFs online with Docuflex. Free, open source, and no account needed." />
  <link rel="canonical" href="https://docuflex.eu/editor" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Docuflex" />
  <meta property="og:title" content="Docuflex Editor — Edit PDFs Online, Free" />
  <meta property="og:description" content="A free PDF editor with text editing, signatures, conversion, OCR and translation. No account needed." />
  <meta property="og:url" content="https://docuflex.eu/editor" />
  <meta property="og:image" content="https://docuflex.eu/landing-page/editor-rendering.webp" />
  <meta property="og:image:alt" content="Docuflex PDF editor with document pages and editing tools" />
  <meta name="twitter:card" content="summary_large_image" />
</svelte:head>

{#if mounted}
  <DocuflexApp />
{/if}
