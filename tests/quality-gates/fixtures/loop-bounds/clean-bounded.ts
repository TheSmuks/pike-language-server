export function bounded(items: number[]): number {
  let sum = 0;
  for (const item of items) {
    sum += item;
  }
  for (let index = 0; index < items.length; index += 1) {
    sum += items[index] ?? 0;
  }
  return sum;
}
