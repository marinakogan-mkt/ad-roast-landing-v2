export async function resolve(spec, ctx, next) {
  if (spec === '@upstash/redis') return { url: new URL('./upstash-stub.mjs', import.meta.url).href, shortCircuit: true };
  return next(spec, ctx);
}
