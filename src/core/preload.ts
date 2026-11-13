export async function preloadImages(urls: string[], onProgress?: (done: number, total: number) => void) {
  const unique = Array.from(new Set(urls.filter(Boolean)));
  let done = 0;
  await Promise.all(unique.map((url) => new Promise<void>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      done += 1;
      onProgress?.(done, unique.length);
      resolve();
    };
    img.onerror = () => reject(new Error(`Image failed to preload: ${url}`));
    img.src = url;
  })));
}
