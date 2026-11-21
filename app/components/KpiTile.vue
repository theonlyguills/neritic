<script setup lang="ts">
/** Headline number that eases to each new value, so live counters visibly tick. */
const props = defineProps<{
  label: string
  value: number
  sub?: string
  unit?: string
  digits?: number
  accent?: string
}>()
const shown = ref(props.value)
let frame = 0
watch(
  () => props.value,
  (to) => {
    cancelAnimationFrame(frame)
    const from = shown.value
    const begin = performance.now()
    const step = () => {
      const t = Math.min(1, (performance.now() - begin) / 700)
      shown.value = from + (to - from) * (1 - (1 - t) ** 3)
      if (t < 1) frame = requestAnimationFrame(step)
    }
    step()
  },
)
onBeforeUnmount(() => cancelAnimationFrame(frame))
const text = computed(() =>
  shown.value.toLocaleString('en-CA', {
    maximumFractionDigits: props.digits ?? 0,
    minimumFractionDigits: props.digits ?? 0,
  }),
)
</script>
<template>
  <div class="kpi">
    <span class="kpi-label"><i v-if="accent" :style="{ background: accent }" />{{ label }}</span>
    <strong
      >{{ text }}<em v-if="unit"> {{ unit }}</em></strong
    >
    <small v-if="sub">{{ sub }}</small>
  </div>
</template>
