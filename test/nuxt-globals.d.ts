// The Nuxt example composables rely on Nuxt's auto-imports (ref, computed, onMounted, ...). The tests provide them
// as globals from Vue, so the examples can be type-checked and tested without a Nuxt installation.
declare const ref: typeof import('vue').ref;
declare const computed: typeof import('vue').computed;
declare const onMounted: typeof import('vue').onMounted;
declare const onBeforeUnmount: typeof import('vue').onBeforeUnmount;
