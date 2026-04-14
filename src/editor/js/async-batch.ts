// Run async work against a list of inputs with a concurrency cap. Same result
// shape as Promise.allSettled — useful for bulk catalog fetches where blasting
// hundreds of parallel requests at localhost causes sporadic "Failed to fetch"
// errors under HTTP/1.1 connection limits.

export async function allSettledWithLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await worker(items[i]!, i) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(runners);
  return results;
}
