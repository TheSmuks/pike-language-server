export function tooNested(flag: boolean): void {
  if (flag) {
    for (const item of [1]) {
      if (item > 0) {
        while (flag) {
          if (item === 1) {
            break;
          }
        }
      }
    }
  }
}
