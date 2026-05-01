<script setup lang="ts">
// Thin component wrapper around `useAidpContent` for template-style
// usage. Equivalent to calling the composable in <script setup>; the
// component form is offered for low-code templates and codegen-driven
// pages where setup-script injection is awkward.
//
//   <AidpDirective :content-id="article.id" />
//
// Composable form (preferred when you can use setup script):
//
//   useAidpContent({ id: article.id })
//
// Renders nothing — this component exists purely for its side effect
// of registering the `<link rel="aidp-content">` tag in <head>.

import { useAidpContent } from '../composables/useAidpContent'

const props = defineProps<{
  contentId: string
}>()

useAidpContent({ id: props.contentId })
</script>

<template>
  <!-- Side-effect-only component. Renders nothing. -->
</template>
