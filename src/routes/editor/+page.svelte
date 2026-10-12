<script>
  import { onMount } from 'svelte';
  import DocuflexApp from '$lib/DocuflexApp.svelte';
  import { trackPage } from '$lib/analytics.js';

  onMount(() => trackPage('/editor'));
</script>

<DocuflexApp />
