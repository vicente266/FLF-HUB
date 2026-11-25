<script lang="ts" module>
	/** Open modals, innermost last: only the top one answers Esc and Tab. */
	const stack: symbol[] = [];
</script>

<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import X from '@lucide/svelte/icons/x';
	import { FOCUSABLE, trapTab } from '$lib/utils';

	let {
		open = $bindable(false),
		title,
		width = 'max-w-lg',
		dirty = false,
		children,
		footer
	}: {
		open: boolean;
		title: string;
		width?: string;
		/** Unsaved changes: closing by Esc, backdrop or X asks before discarding them. */
		dirty?: boolean;
		children: Snippet;
		footer?: Snippet;
	} = $props();

	const uid = $props.id();
	const titleId = `${uid}-title`;
	const self = Symbol();
	const FIELD =
		'[autofocus], input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled)';

	let panel = $state<HTMLDivElement>();
	let body = $state<HTMLDivElement>();
	let keepButton = $state<HTMLButtonElement>();
	let confirming = $state(false);
	let opener: HTMLElement | null = null;
	/** Where the last mouse press started: a drag from a field onto the backdrop must not close. */
	let pressedBackdrop = false;

	$effect(() => {
		if (!open) return;
		opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		confirming = false;
		stack.push(self);
		untrack(() => {
			const first =
				body?.querySelector<HTMLElement>(FIELD) ??
				body?.querySelector<HTMLElement>(FOCUSABLE) ??
				panel?.querySelector<HTMLElement>(FOCUSABLE);
			(first ?? panel)?.focus();
		});
		return () => {
			stack.splice(stack.indexOf(self), 1);
			// The opener may be gone (a row deleted by the dialog): then focus stays where it is.
			if (opener?.isConnected) opener.focus();
			opener = null;
		};
	});

	function close() {
		confirming = false;
		open = false;
	}

	/** Esc, backdrop and X: ask first when there are unsaved changes. */
	function requestClose() {
		if (!dirty) return close();
		confirming = true;
		queueMicrotask(() => keepButton?.focus());
	}

	function keepEditing() {
		confirming = false;
		panel?.focus();
	}

	function onkeydown(e: KeyboardEvent) {
		if (!open || stack.at(-1) !== self || !panel) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			if (confirming) keepEditing();
			else requestClose();
		} else if (e.key === 'Tab') {
			trapTab(panel, e);
		}
	}
</script>

<svelte:window {onkeydown} />

{#if open}
	<!-- The backdrop is mouse-only; keyboard users close with Esc or the X. -->
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-navy/40 p-8"
		onmousedown={(e) => (pressedBackdrop = e.target === e.currentTarget)}
		onclick={(e) => {
			if (pressedBackdrop && e.target === e.currentTarget) requestClose();
			pressedBackdrop = false;
		}}
	>
		<div
			bind:this={panel}
			class="relative w-full card {width} shadow-xl outline-none"
			role="dialog"
			aria-modal="true"
			aria-labelledby={titleId}
			tabindex="-1"
		>
			<div class="flex items-center justify-between border-b border-line/60 px-5 py-3">
				<h2 id={titleId} class="font-bold">{title}</h2>
				<button
					type="button"
					class="rounded text-ink-soft hover:text-ink"
					aria-label="Close"
					onclick={requestClose}
				>
					<X class="h-4 w-4" />
				</button>
			</div>
			<div bind:this={body} class="px-5 py-4">{@render children()}</div>
			{#if confirming}
				<div
					class="flex items-center justify-between gap-3 border-t border-warning/30 bg-warning/10 px-5 py-2.5"
					role="alert"
				>
					<p class="text-sm font-semibold text-ink">Discard your changes?</p>
					<div class="flex gap-2">
						<button type="button" class="btn-ghost" onclick={close}>Discard</button>
						<button type="button" class="btn-primary" bind:this={keepButton} onclick={keepEditing}>
							Keep editing
						</button>
					</div>
				</div>
			{/if}
			{#if footer}
				<div class="flex justify-end gap-2 border-t border-line/60 px-5 py-3">
					{@render footer()}
				</div>
			{/if}
		</div>
	</div>
{/if}
