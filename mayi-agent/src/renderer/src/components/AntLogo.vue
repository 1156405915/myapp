<script setup lang="ts">
withDefaults(defineProps<{ size?: number }>(), { size: 42 })
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 48 48"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-label="蚂蚁标志"
  >
    <path d="M16 8L11 3M32 8L37 3" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" />
    <circle cx="24" cy="9" r="3.2" fill="currentColor" />
    <rect x="10" y="10" width="28" height="30" rx="14" stroke="currentColor" stroke-width="3.2" />
    <circle cx="19" cy="23" r="2.3" fill="currentColor" />
    <circle cx="29" cy="23" r="2.3" fill="currentColor" />
    <path d="M18 30C20 33 22 34 24 34C26 34 28 33 30 30" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
  </svg>
</template>
