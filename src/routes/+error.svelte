<script lang="ts">
	import { page } from '$app/state';
</script>

<div class="flex min-h-screen items-center justify-center">
	<div class="text-center">
		<p class="eyebrow">{page.status}</p>
		<h1 class="mt-2 text-2xl font-bold">{page.error?.message}</h1>
		<a href="/" class="mt-6 btn-primary">Back to the Hub</a>
	</div>
</div>
