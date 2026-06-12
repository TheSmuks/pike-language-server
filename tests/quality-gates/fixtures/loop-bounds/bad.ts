export function pollForever(done: () => boolean): void {
  while (!done()) {
    doWork();
  }
}

function doWork(): void {}
